/**
 * ask(...) 与 output 测试。
 *
 * ask 需要一个行输入源（真实终端里由 CLI 提供），这里用注入的 readLine 模拟。
 * output 按开头标记分流：error / warning 走 stderr，log 走 stdout。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runSource } from '../src/index';
import { errorCodes } from './support';

interface RunResult {
  ok: boolean;
  out: string;
  err: string;
  diagnostics: ReturnType<typeof runSource>['diagnostics'];
}

function run(text: string, readLine?: (prompt: string) => string | null): RunResult {
  let out = '';
  let err = '';
  const result = runSource('<test>', text, {
    write: (chunk) => {
      out += chunk;
    },
    writeError: (chunk) => {
      err += chunk;
    },
    readLine,
  });
  return { ok: result.ok, out, err, diagnostics: result.diagnostics };
}

const wrap = (body: string): string => `__init__ {\n    main() {\n${body}\n    }\n}\n`;

describe('ask：读取用户输入', () => {
  it('把用户输入的一行写进变量（提示词会先打印）', () => {
    const prompts: string[] = [];
    const result = run(wrap('        text a = ask(你是谁)\n        say(a)'), (prompt) => {
      prompts.push(prompt);
      return '小搓';
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.out, '小搓\n');
    // 提示词作为参数传下去（终端里由 CLI 打印）
    assert.deepEqual(prompts, ['你是谁']);
  });

  it('ask() 不带提示词也能读', () => {
    const result = run(wrap('        text a = ask()\n        say(a)'), () => 'hello');
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.out, 'hello\n');
  });

  it('拿不到输入源时报 E0410', () => {
    const result = run(wrap('        text a = ask(喂)'));
    assert.equal(result.ok, false);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0410']);
    assert.match(result.diagnostics[0].message, /ask 需要真实终端/);
  });

  it('输入源返回 null（非终端 / 输入结束）时报 E0410', () => {
    const result = run(wrap('        text a = ask(喂)'), () => null);
    assert.equal(result.ok, false);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0410']);
    assert.match(result.diagnostics[0].message, /读不到用户输入/);
  });
});

describe('output：带级别的输出', () => {
  it('[error] / [warning] 走 stderr，[log] 走 stdout', () => {
    const result = run(
      wrap(
        '        output "[error]这是一个错误"\n        output "[warning]这是一个警告"\n        output "[log]这是一个日志"',
      ),
    );
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.out, '[log]这是一个日志\n');
    assert.equal(result.err, '[error]这是一个错误\n[warning]这是一个警告\n');
  });

  it('没有标记的输出走 stdout', () => {
    const result = run(wrap('        output "普通信息"'));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.out, '普通信息\n');
    assert.equal(result.err, '');
  });

  it('大小写不敏感：ERROR / Warning 都算', () => {
    const result = run(wrap('        output "[ERROR]大写"\n        output "[Warning]大小写"'));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.out, '');
    assert.equal(result.err, '[ERROR]大写\n[Warning]大小写\n');
  });

  it('非文本参数：E0307', () => {
    const result = run(wrap('        output 123'));
    assert.equal(result.ok, false);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].message, /output 需要一段文本/);
  });

  it('output 可写在 if / cycle 等块里', () => {
    const result = run(wrap('        if 1 < 2 {\n            output "[log]分支里"\n        }'));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.out, '[log]分支里\n');
  });
});
