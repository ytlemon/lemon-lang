/**
 * 列表测试。
 *
 * 语法是块式的（`list(名字) { 元素 换行 元素 }`），`list` 是上下文关键字——
 * 所以既有的 `text list = ...` / `say(list)` 必须照常工作，这几条也在下面盯着。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourceFile, parseProgram } from '../src/index';
import { astShape, captureError, checkText, errorCodes, runText, wrap } from './support';

/** 顶层写列表声明（不进 main），用于验证顶层作用域与函数体内的可见性 */
function top(text: string): string {
  return `__init__ {\n${text}\n    main() { say("完") }\n}\n`;
}

describe('列表：声明与输出', () => {
  it('块式声明，say 输出整个列表', () => {
    const out = runText(wrap('list(分数) {\n    1\n    2\n    3\n}\nsay(分数)'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[1, 2, 3]\n');
  });

  it('显式写成 list(name = 名字) 与 list(名字) 完全等价', () => {
    const explicit = runText(wrap('list(name = 分数) {\n    1\n    2\n}\nsay(分数)'));
    const plain = runText(wrap('list(分数) {\n    1\n    2\n}\nsay(分数)'));
    assert.equal(explicit.ok, true, JSON.stringify(explicit.diagnostics));
    assert.equal(explicit.stdout, plain.stdout);
    assert.equal(explicit.stdout, '[1, 2]\n');
  });

  it('空列表输出 []', () => {
    const out = runText(wrap('list(空) {}\nsay(空)\nsay(len(空))'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[]\n0\n');
  });

  it('元素类型可以混合', () => {
    const out = runText(wrap('list(杂) {\n    1\n    你好\n    true\n}\nsay(杂)'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[1, 你好, true]\n');
  });

  it('元素是表达式，按书写顺序求值', () => {
    const out = runText(wrap('int 基准 = 10\nlist(值) {\n    基准 + 1\n    基准 * 2\n}\nsay(值)'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[11, 20]\n');
  });

  it('列表可以嵌套，下标能链式连写', () => {
    const out = runText(
      wrap('list(内) {\n    1\n    2\n}\nlist(外) {\n    内\n    内\n}\nsay(外)\nsay(外[0][1])'),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[[1, 2], [1, 2]]\n2\n');
  });

  it('同名列表与外层变量互不干扰（块内声明遮蔽外层）', () => {
    const out = runText(
      wrap('int x = 1\nif x > 0 {\n    list(x) {\n        9\n    }\n    say(x)\n}\nsay(x)'),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    // 块内 x 是列表，出了块恢复成 int
    assert.equal(out.stdout, '[9]\n1\n');
  });
});

describe('列表：下标', () => {
  it('取首尾元素', () => {
    const out = runText(wrap('list(名单) {\n    甲\n    乙\n    丙\n}\nsay(名单[0])\nsay(名单[2])'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '甲\n丙\n');
  });

  it('下标可以是变量与表达式', () => {
    const out = runText(wrap('list(值) {\n    10\n    20\n    30\n}\nint i = 1\nsay(值[i])\nsay(值[i + 1])'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '20\n30\n');
  });

  it('下标越界报 E0415 且提示可用范围', () => {
    const out = runText(wrap('list(名单) {\n    甲\n    乙\n}\nsay(名单[5])'));
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0415');
    assert.match(out.error?.hint ?? '', /0 到 1/);
  });

  it('负数下标同样算越界（不支持从后往前数）', () => {
    const out = runText(wrap('list(名单) {\n    甲\n}\nsay(名单[0 - 1])'));
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0415');
  });

  it('空列表取下标越界，提示说清是空的', () => {
    const out = runText(wrap('list(空) {}\nsay(空[0])'));
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0415');
  });

  it('下标不是 int 在运行前就拦下（E0307）', () => {
    const result = checkText(wrap('list(名单) {\n    甲\n}\nsay(名单[1.5])'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
  });

  it('对文本取下标报 E0327，并说明文本没有下标', () => {
    const result = checkText(wrap('text 名字 = 你好\nsay(名字[0])'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0327']);
    assert.match(result.diagnostics[0].hint ?? '', /文本/);
  });

  it('对 int 取下标报 E0327', () => {
    const result = checkText(wrap('int a = 1\nsay(a[0])'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0327']);
  });
});

describe('列表：len', () => {
  it('返回元素个数', () => {
    const out = runText(wrap('list(值) {\n    1\n    2\n    3\n}\nsay(len(值))'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '3\n');
  });

  it('参数不是列表报 E0307', () => {
    const result = checkText(wrap('int a = 1\nsay(len(a))'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
  });

  it('实参个数不符报 E0310', () => {
    const result = checkText(wrap('list(值) {\n    1\n}\nsay(len())'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0310']);
  });
});

describe('列表：名字规则', () => {
  it('add list(非法目标) 报 E0326', () => {
    const error = captureError(() => parseProgram(new SourceFile('<test>', top('    add list(true)'))));
    assert.equal(error.code, 'E0326');
    assert.match(error.message, /整数编号或标识符/);
  });

  it('带花括号但目标非法时走引用分支，报 E0205', () => {
    // list(true) { ... } 里 true 不是合法目标，于是 checkList 不认它是声明，
    // 落到表达式那条路，由 parseListRef 报"只能写编号或名字"
    const error = captureError(() => parseProgram(new SourceFile('<test>', top('    list(true) {\n        1\n    }'))));
    assert.equal(error.code, 'E0205');
  });

  it('数字目标现在解释为编号槽：list(name = 1) 是合法写法', () => {
    const src = top('    list(name = 1) {\n        1\n        2\n    }');
    assert.deepEqual(errorCodes(checkText(src).diagnostics), []);
    const out = runText(src);
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  });

  it('重复声明报 E0306', () => {
    const result = checkText(top('    list(分数) {\n        1\n    }\n\n    list(分数) {\n        2\n    }'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0306']);
  });

  it('占用内置名报 E0306', () => {
    const result = checkText(wrap('list(say) {\n    1\n}'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0306']);
  });

  it('元素里引用自己报 E0312（绑定发生在元素求值之后）', () => {
    const result = checkText(top('    list(a) {\n        a\n    }'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0312']);
  });

  it('顶层列表在函数体内可见', () => {
    const out = runText(
      '__init__ {\n    list(配置) {\n        1\n        2\n    }\n\n    main() { say(len(配置)) }\n}\n',
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '2\n');
  });
});

describe('列表：list 是上下文关键字', () => {
  it('list 仍可作普通变量名', () => {
    const out = runText(wrap('text list = 你好\nsay(list)'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '你好\n');
  });

  it('say 里写 list（文本）要加引号', () => {
    const out = runText(wrap('say("list")'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, 'list\n');
  });

  it('方括号列表字面量给出指向块式写法的提示（E0201）', () => {
    const error = captureError(() => parseProgram(new SourceFile('<test>', wrap('say([1, 2, 3])'))));
    assert.equal(error.code, 'E0201');
    assert.match(error.hint ?? '', /list\(名字\)/);
  });
});

describe('列表：不可变', () => {
  it('按下标赋值报 E0201，并说清列表不可变', () => {
    const error = captureError(() =>
      parseProgram(
        new SourceFile('<test>', '__init__ {\n    list(a) {\n        1\n    }\n\n    main() { a[0] = 2 }\n}\n'),
      ),
    );
    assert.equal(error.code, 'E0201');
    assert.match(error.message, /不支持给列表元素赋值/);
    assert.match(error.hint ?? '', /不可变/);
  });

  it('给变量重新赋值也报 E0201，而不是含混的"缺少语句分隔"', () => {
    const error = captureError(() =>
      parseProgram(new SourceFile('<test>', '__init__ {\n    main() {\n        int x = 1\n        x = 2\n    }\n}\n')),
    );
    assert.equal(error.code, 'E0201');
    assert.match(error.message, /不支持给变量重新赋值/);
  });
});

describe('列表：语法树', () => {
  it('块式声明解析成 ListDecl，元素按顺序排列', () => {
    const program = parseProgram(new SourceFile('<test>', top('    list(值) {\n        1\n        2 + 3\n    }')));
    const decl = program.statements[0];
    assert.equal(decl.kind, 'ListDecl');
    assert.equal(decl.kind === 'ListDecl' ? decl.name : '', '值');
    assert.deepEqual(
      decl.kind === 'ListDecl' ? decl.elements.map(astShape) : [],
      [1, ['+', 2, 3]],
    );
  });

  it('下标解析成 Index，可以连写', () => {
    const program = parseProgram(new SourceFile('<test>', wrap('say(a[0][b + 1])')));
    const main = program.main;
    assert.ok(main);
    const stmt = main.body[0];
    assert.equal(stmt.kind, 'ExprStmt');
    const call = stmt.kind === 'ExprStmt' ? stmt.expr : null;
    assert.equal(call?.kind, 'Call');
    const arg = call?.kind === 'Call' ? call.args[0] : null;
    assert.equal(arg?.kind, 'Index');
    // 外层下标的下标是 b + 1，被下标的对象又是一层 Index
    assert.equal(arg?.kind === 'Index' ? arg.object.kind : '', 'Index');
  });
});
