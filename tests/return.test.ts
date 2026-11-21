/**
 * return 测试。
 *
 * 核心设计只有一句：**函数体里有带值的 return，调用结果就是 `any`；
 * 没有就是 `unit`**（参数本来就不写类型，返回类型同理）。下面这些用例
 * 把这条规则和它与 cycle / try / 列表的交互都钉住。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourceFile, parseProgram } from '../src/index';
import { astShape, captureError, checkText, errorCodes, runText, wrap } from './support';

/** 顶层写函数声明（不进 main），作用域与文件模式一致 */
function program(body: string): string {
  return `__init__ {\n${body}\n}\n`;
}

describe('return：基本用法', () => {
  it('带值返回，调用结果可以参与运算', () => {
    const out = runText(
      program('    def 加(a, b) {\n        return a + b\n    }\n\n    main() { say(加(2, 3))\n say(加(1, 1) * 10) }'),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '5\n20\n');
  });

  it('if 里提前返回，其余分支照常走', () => {
    const out = runText(
      program(
        '    def 绝对值(x) {\n        if x < 0 {\n            return 0 - x\n        }\n        return x\n    }\n\n    main() { say(绝对值(0 - 7))\n say(绝对值(7)) }',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '7\n7\n');
  });

  it('递归可以用返回值把结果带出来', () => {
    const out = runText(
      program(
        '    def 阶乘(n) {\n        if n <= 1 {\n            return 1\n        }\n        return n * 阶乘(n - 1)\n    }\n\n    main() { say(阶乘(5)) }',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '120\n');
  });

  it('不带值的 return 提前收工，后面的语句不执行', () => {
    const out = runText(
      program(
        '    def 只说话() {\n        say("第一句")\n        return\n        say("不该出现")\n    }\n\n    main() { 只说话() }',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '第一句\n');
  });

  it('没有 return 的函数结果仍是 unit', () => {
    const out = runText(program('    def f() { say("只有副作用") }\n\n    main() { say(f()) }'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '只有副作用\nunit\n');
  });

  it('返回值可以是列表，取值也照常', () => {
    const out = runText(
      program(
        '    def 造列表() {\n        list(值) {\n            1\n            2\n        }\n        return 值\n    }\n\n    main() {\n        list(拿到) { 造列表() }\n        say(拿到)\n    }',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[[1, 2]]\n');
  });
});

describe('return：与循环和错误处理的交互', () => {
  it('cycle 里的 return 跳出整个函数，而不只是跳出循环', () => {
    const out = runText(
      program(
        [
          '    def 首个大于(数字, 阈值) {',
          '        cycle(len(数字)) {',
          '            if 数字[i] > 阈值 {',
          '                return 数字[i]',
          '            }',
          '        }',
          '        return 没有更大的',
          '    }',
          '',
          '    main() {',
          '        list(数) {',
          '            1',
          '            5',
          '            9',
          '        }',
          '        say(首个大于(数, 6))',
          '        say(首个大于(数, 100))',
          '    }',
        ].join('\n'),
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '9\n没有更大的\n');
  });

  it('return 不会被 try / catch 当成错误抓走', () => {
    const out = runText(
      program(
        [
          '    def f(x) {',
          '        try {',
          '            return 10 / x',
          '        } catch (错误) {',
          '            return 错误.code',
          '        }',
          '    }',
          '',
          '    main() {',
          '        say(f(5))',
          '        say(f(0))',
          '    }',
        ].join('\n'),
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '2\nE0405\n');
  });
});

describe('return：类型规则', () => {
  it('有返回值的函数是 any：赋给 int 静态通过、运行期才判', () => {
    // 静态通过
    const checked = checkText(program('    def f() { return 你好 }\n\n    main() { int a = f() }'));
    assert.deepEqual(errorCodes(checked.diagnostics), []);

    // 运行期报 E0402（text 存不进 int）
    const ran = runText(program('    def f() { return 你好 }\n\n    main() { int a = f()\n say(a) }'));
    assert.equal(ran.ok, false);
    assert.equal(ran.error?.code, 'E0402');
  });

  it('没有返回值的函数是 unit：赋给 int 静态就拦下', () => {
    const checked = checkText(program('    def f() { say(1) }\n\n    main() { int a = f() }'));
    assert.deepEqual(errorCodes(checked.diagnostics), ['E0307']);
  });

  it('返回值可以直接当条件', () => {
    const out = runText(
      program(
        '    def 相等(a, b) { return a == b }\n\n    main() {\n        if 相等(1, 1) {\n            say("成立")\n        }\n        if 相等(1, 2) {\n            say("不该出现")\n        }\n    }',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '成立\n');
  });
});

describe('return：错误场景', () => {
  it('写在函数外报 E0204', () => {
    const result = checkText(program('    return\n    main() {}'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0204']);
  });

  it('写在函数外且带值也报 E0204', () => {
    const result = checkText(program('    return 1\n    main() {}'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0204']);
  });

  it('main() 里带值返回报 E0328', () => {
    const result = checkText(program('    main() { return 1 }'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0328']);
    assert.match(result.diagnostics[0].hint ?? '', /提前结束/);
  });

  it('main() 里光秃秃的 return 合法，表示提前结束', () => {
    const out = runText(program('    main() {\n        say("先说话")\n        return\n        say("不该出现")\n    }'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '先说话\n');
  });

  it('return 是语句不是表达式，赋不了值', () => {
    const error = captureError(() =>
      parseProgram(new SourceFile('<test>', program('    main() { int a = return 1 }'))),
    );
    assert.equal(error.code, 'E0201');
  });

  it('值必须和 return 写在同一行，跨行会被当成独立语句', () => {
    // 这不是"静默忽略"：孤立的表达式语句本身就会报 E0304
    const result = checkText(program('    def f() {\n        return\n        1\n    }\n\n    main() { say(f()) }'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0304']);
  });
});

describe('return：语法树', () => {
  it('带值与不带值解析成不同的 ReturnStmt', () => {
    const parsed = parseProgram(
      new SourceFile('<test>', program('    def f() { return 1 + 2 }\n    def g() { return }')),
    );
    const f = parsed.statements[0];
    const g = parsed.statements[1];
    assert.equal(f.kind, 'FuncDecl');
    assert.equal(g.kind, 'FuncDecl');

    const fBody = f.kind === 'FuncDecl' ? f.body[0] : null;
    const gBody = g.kind === 'FuncDecl' ? g.body[0] : null;
    assert.equal(fBody?.kind, 'ReturnStmt');
    assert.equal(gBody?.kind, 'ReturnStmt');
    assert.deepEqual(fBody?.kind === 'ReturnStmt' && fBody.value !== null ? astShape(fBody.value) : null, [
      '+',
      1,
      2,
    ]);
    assert.equal(gBody?.kind === 'ReturnStmt' ? gBody.value : 'missing', null);
  });

  it('不带值的 return 不会把下一行吞成返回值', () => {
    // 函数里的裸 return 之后另起一行，那一行是本函数的独立语句；
    // 函数外的语句照常执行，证明 return 确实什么都没吃
    const out = runText(program('    def f() {\n        return\n    }\n\n    main() {\n        say(f())\n        say("函数外的语句照常跑")\n    }'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, 'unit\n函数外的语句照常跑\n');
  });
});
