/**
 * 文件读写块 read{...} / save{...} 的解析、静态检查与运行期测试。
 *
 * 运行期测试用系统临时目录放真实文件，跑完即删，不污染仓库。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseProgram, runSource, SourceFile, type RunResult } from '../src/index';
import type { FileReadStmt, FileSaveStmt, Stmt } from '../src/lang/ast';
import { checkText } from './support';

/** 把片段包进 __init__/main 外壳 */
function inMain(snippet: string): string {
  return `__init__ {\nmain() {\n${snippet}\n}\n}\n`;
}

/** 取 main 体里的第一条语句 */
function firstStmt(src: string): Stmt {
  const program = parseProgram(new SourceFile('<test>', inMain(src)));
  assert.ok(program.main, '应有 main');
  return program.main.body[0];
}

/** 在临时目录里写一个文件，返回用正斜杠的路径（避免 Windows 反斜杠转义） */
function writeTempFile(dir: string, name: string, content: string): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, content, 'utf-8');
  return full.replace(/\\/g, '/');
}

describe('read{...} / save{...}：解析', () => {
  test('read 块解析出文件名、落点、交互式开关', () => {
    const stmt = firstStmt(
      'read {\n  name = "1.txt"\n  according = "utf-8"\n  read in list(1)\n  read in say\n  read in answer\n}',
    ) as FileReadStmt;
    assert.equal(stmt.kind, 'FileRead');
    assert.equal(stmt.interactive, true);
    assert.equal(stmt.encoding !== null, true);
    assert.equal(stmt.targets.length, 2);
    assert.equal(stmt.targets[0].kind, 'list');
    if (stmt.targets[0].kind === 'list') assert.equal(stmt.targets[0].ref.slot, 1);
    assert.equal(stmt.targets[1].kind, 'say');
  });

  test('save 块解析出文件名与源列表', () => {
    const stmt = firstStmt('save {\n  name = "1.txt"\n  save in list(2)\n}') as FileSaveStmt;
    assert.equal(stmt.kind, 'FileSave');
    assert.ok(stmt.source);
    assert.equal(stmt.source!.slot, 2);
  });

  test('read / save 是上下文关键字，不当变量名用时照常工作', () => {
    const out = runSource('<test>', inMain('text read = "ok"\ntext save = "no"\nsay(read)'), {
      write: () => {},
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  });
});

describe('read{...} / save{...}：静态检查', () => {
  test('read 缺 name → E0331', () => {
    const result = parseAndCheck('read {\n  read in say\n}');
    assert.deepEqual(errorCodesOf(result), ['E0331']);
  });

  test('read 没有任何落点 → E0332', () => {
    const result = parseAndCheck('read {\n  name = "x"\n}');
    assert.deepEqual(errorCodesOf(result), ['E0332']);
  });

  test('read in answer  alone 也算没有落点 → E0332', () => {
    const result = parseAndCheck('read {\n  name = "x"\n  read in answer\n}');
    assert.deepEqual(errorCodesOf(result), ['E0332']);
  });

  test('save 缺源列表 → E0334', () => {
    const result = parseAndCheck('save {\n  name = "x"\n}');
    assert.deepEqual(errorCodesOf(result), ['E0334']);
  });

  test('save 缺 name → E0333', () => {
    const result = parseAndCheck('save {\n  save in list(1)\n}');
    assert.deepEqual(errorCodesOf(result), ['E0333']);
  });

  test('合法的 read / save 不报错', () => {
    const result = parseAndCheck(
      'read {\n  name = "x"\n  read in list(1)\n  read in say\n}\nsave {\n  name = "y"\n  save in list(1)\n}',
    );
    assert.deepEqual(errorCodesOf(result), []);
  });
});

describe('read{...} / save{...}：运行期', () => {
  test('整文件读进列表 + 写回 + 读回，round-trip 一致', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-io-'));
    try {
      const inPath = writeTempFile(dir, 'in.txt', '甲\n乙\n丙\n');
      const outPath = path.join(dir, 'out.txt').replace(/\\/g, '/');

      const code = inMain(
        `read {\n  name = "${inPath}"\n  read in list(1)\n}\n` +
          `save {\n  name = "${outPath}"\n  save in list(1)\n}\n` +
          `read {\n  name = "${outPath}"\n  read in list(2)\n}\n` +
          `say(list(2))`,
      );
      let stdout = '';
      const result = runSource('<test>', code, { write: (c) => (stdout += c) });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(stdout, '[甲, 乙, 丙]\n');

      // 落盘内容确实每个元素一行
      assert.equal(fs.readFileSync(outPath, 'utf-8'), '甲\n乙\n丙\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('read in say 打印整文件内容', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-io-'));
    try {
      const inPath = writeTempFile(dir, 'in.txt', 'a\nb\nc\n');
      let stdout = '';
      const result = runSource(
        '<test>',
        inMain(`read {\n  name = "${inPath}"\n  read in say\n}`),
        { write: (c) => (stdout += c) },
      );
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(stdout, 'a\nb\nc\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('read in answer 交互式选段：只取用户指定的行', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-io-'));
    try {
      const inPath = writeTempFile(dir, 'in.txt', 'L1\nL2\nL3\nL4\n');
      let stdout = '';
      let prompt = '';
      const result = runSource(
        '<test>',
        inMain(
          `read {\n  name = "${inPath}"\n  read in list(1)\n  read in say\n  read in answer\n}`,
        ),
        {
          write: (c) => (stdout += c),
          readLine: (p) => {
            prompt = p;
            return '2-3';
          },
        },
      );
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      // 选中的第 2、3 行
      assert.equal(stdout, 'L2\nL3\n');
      assert.match(prompt, /行号/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('交互式选段支持逗号列举与单行混用', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-io-'));
    try {
      const inPath = writeTempFile(dir, 'in.txt', 'L1\nL2\nL3\nL4\nL5\n');
      let stdout = '';
      const result = runSource(
        '<test>',
        inMain(`read {\n  name = "${inPath}"\n  read in say\n  read in answer\n}`),
        {
          write: (c) => (stdout += c),
          readLine: () => '1,3-4',
        },
      );
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(stdout, 'L1\nL3\nL4\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('read in answer 在非终端（无 readLine）报 E0410', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-io-'));
    try {
      const inPath = writeTempFile(dir, 'in.txt', 'x\n');
      const result = runSource(
        '<test>',
        inMain(`read {\n  name = "${inPath}"\n  read in say\n  read in answer\n}`),
        { write: () => {} },
      );
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, 'E0410');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('读不存在的文件报 E0902', () => {
    const result = runSource(
      '<test>',
      inMain('read {\n  name = "不存在的文件.txt"\n  read in say\n}'),
      { write: () => {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'E0902');
  });

  test('save 接受变量作文件名', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-io-'));
    try {
      const outPath = path.join(dir, 'v.txt').replace(/\\/g, '/');
      let stdout = '';
      const result = runSource(
        '<test>',
        inMain(
          `text 文件名 = "${outPath}"\nlist(1) { 一\n 二 }\n` +
            `save {\n  name = 文件名\n  save in list(1)\n}`,
        ),
        { write: (c) => (stdout += c) },
      );
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(fs.readFileSync(outPath, 'utf-8'), '一\n二\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* --------------------------- 小工具 --------------------------- */

function parseAndCheck(src: string): { diagnostics: { severity: string; code: string }[] } {
  // 只做静态检查（parse + check），不执行，避免文件名不存在触发运行期错误
  const analysis = checkText(inMain(src));
  return { diagnostics: analysis.diagnostics as { severity: string; code: string }[] };
}

function errorCodesOf(result: { diagnostics: { severity: string; code: string }[] }): string[] {
  return result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
}

// 保留类型引用，避免未使用告警
export type { RunResult };
