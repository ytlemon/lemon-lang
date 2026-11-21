import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourceFile, parseProgram } from '../src/index';
import type { Expr, FuncDecl, VarDecl } from '../src/lang/ast';
import { astShape, captureError } from './support';

function parse(text: string) {
  return parseProgram(new SourceFile('<test>', text));
}

/** 解析 `int r = <expr>` 里的表达式，并压成紧凑形状 */
function shapeOf(expr: string) {
  const program = parse(`__init__ {\n    int r = ${expr}\n    main() { say(1) }\n}`);
  return astShape((program.statements[0] as VarDecl).initializer);
}

describe('语法分析器', () => {
  it('解析 __init__ 外壳、声明与 main', () => {
    const program = parse(`__init__ {
    int a = 1
    def greet(name) { say(name) }
    main() { say("你好") }
}`);
    assert.equal(program.statements.length, 3);
    assert.equal(program.functions.length, 1);
    assert.equal(program.functions[0].name, 'greet');
    assert.ok(program.main);
    assert.equal(program.main.name, 'main');
    assert.equal(program.main.isMain, true);
  });

  it('变量声明的类型与初始值被正确记录', () => {
    const program = parse(`__init__ {
    double price = 1.5
    main() { say(price) }
}`);
    const decl = program.statements[0] as VarDecl;
    assert.equal(decl.typeName, 'double');
    assert.equal(decl.name, 'price');
    assert.equal(decl.initializer.kind, 'DoubleLit');
  });

  it('分号可选：靠换行断句', () => {
    const program = parse(`__init__ {
    int a = 1
    int b = 2
    main() { say(a) }
}`);
    assert.equal(program.statements.length, 3);
  });

  it('同一行多条语句需要分号', () => {
    const program = parse(`__init__ { int a = 1; int b = 2; main() { say(a) } }`);
    assert.equal(program.statements.length, 3);
  });

  it('同一行缺少分号时报 E0206 并提示', () => {
    const error = captureError(() => parse('__init__ { int a = 1 int b = 2 main() { say(a) } }'));
    assert.equal(error.code, 'E0206');
    assert.match(error.hint ?? '', /换行断句/);
  });

  it('允许把实参换行书写', () => {
    const program = parse(`__init__ {
    main() {
        say("你好")
    }
}`);
    const main = program.main as FuncDecl;
    assert.equal(main.body[0].kind, 'ExprStmt');
  });

  it('裸文本进入 AST 并标记 bare', () => {
    const program = parse(`__init__ {
    text x = 你好，世界
    main() { say("ok") }
}`);
    const stmt = program.statements[0];
    assert.equal(stmt.kind, 'VarDecl');
    if (stmt.kind !== 'VarDecl') throw new Error('结构不符预期');
    const arg = stmt.initializer;
    assert.equal(arg.kind, 'TextLit');
    if (arg.kind !== 'TextLit') throw new Error('结构不符预期');
    assert.equal(arg.value, '你好，世界');
    assert.equal(arg.bare, true);
  });

  it('函数提升：先调用后声明也能解析', () => {
    const program = parse(`__init__ {
    main() { later() }
    def later() { say(1) }
}`);
    assert.equal(program.main?.body.length, 1);
    assert.equal(program.functions[0].name, 'later');
  });

  it('记录准确的声明位置', () => {
    const program = parse('__init__ {\n    int a = 1\n    main() { say(a) }\n}');
    const decl = program.statements[0] as VarDecl;
    assert.equal(decl.nameSpan.line, 2);
    assert.equal(decl.nameSpan.col, 9);
  });

  /* ------------------------------ 错误场景 ------------------------------ */

  it('缺少 __init__（E0301）', () => {
    const error = captureError(() => parse('main() { say("你好") }'));
    assert.equal(error.code, 'E0301');
    assert.match(error.hint ?? '', /__init__/);
  });

  it('重复的 __init__（E0302）', () => {
    const error = captureError(() => parse('__init__ { main() { say(1) } }\n__init__ { }'));
    assert.equal(error.code, 'E0302');
  });

  it('__init__ 之外还有内容时报错', () => {
    const error = captureError(() => parse('__init__ { main() { say(1) } }\nint a = 1'));
    assert.equal(error.code, 'E0201');
  });

  it('main 不允许带参数（E0313）', () => {
    const error = captureError(() => parse('__init__ { main(a) { say(a) } }'));
    assert.equal(error.code, 'E0313');
  });

  it('main 不允许重复声明', () => {
    const error = captureError(() =>
      parse('__init__ {\n    main() { say(1) }\n    main() { say(2) }\n}'),
    );
    assert.equal(error.code, 'E0306');
  });

  it('函数内不允许再定义函数（E0305）', () => {
    const error = captureError(() => parse('__init__ { main() { def inner() { say(1) } } }'));
    assert.equal(error.code, 'E0305');
  });

  it('main 不需要 def', () => {
    const error = captureError(() => parse('__init__ { def main() { say(1) } }'));
    assert.match(error.message, /不需要 def/);
  });

  it('参数名重复（E0314）', () => {
    const error = captureError(() => parse('__init__ { def f(a, a) { say(a) } main() { f(1, 2) } }'));
    assert.equal(error.code, 'E0314');
  });

  it('缺少配对的括号时定位到出错位置', () => {
    const error = captureError(() => parse('__init__ {\n    main() { say(你好 }\n}'));
    assert.equal(error.code, 'E0202');
    assert.equal(error.span.line, 2);
  });

  /* ------------------------------ 运算符 ------------------------------ */

  it('* / 优先于 + -', () => {
    assert.deepEqual(shapeOf('1 + 2 * 3'), ['+', 1, ['*', 2, 3]]);
    assert.deepEqual(shapeOf('1 * 2 + 3'), ['+', ['*', 1, 2], 3]);
    assert.deepEqual(shapeOf('1 - 4 / 2'), ['-', 1, ['/', 4, 2]]);
    assert.deepEqual(shapeOf('1 + 2 * 3 - 4'), ['-', ['+', 1, ['*', 2, 3]], 4]);
  });

  it('同级运算符左结合', () => {
    assert.deepEqual(shapeOf('1 - 2 - 3'), ['-', ['-', 1, 2], 3]);
    assert.deepEqual(shapeOf('8 / 4 / 2'), ['/', ['/', 8, 4], 2]);
    assert.deepEqual(shapeOf('1 + 2 + 3'), ['+', ['+', 1, 2], 3]);
  });

  it('括号改变结合方式', () => {
    assert.deepEqual(shapeOf('(1 + 2) * 3'), ['*', ['+', 1, 2], 3]);
    assert.deepEqual(shapeOf('1 / (2 / 3)'), ['/', 1, ['/', 2, 3]]);
    assert.deepEqual(shapeOf('((1))'), 1);
  });

  it('运算数可以是字面量、标识符、调用与裸文本', () => {
    assert.deepEqual(shapeOf('a * 2'), ['*', 'a', 2]);
    // 你好 / 世界 在词法层是标识符，语法树里也是 Ident；是否为裸文本由静态检查决定
    assert.deepEqual(shapeOf('你好 + 世界'), ['+', '你好', '世界']);
    assert.deepEqual(shapeOf('1 + f(2)'), ['+', 1, ['f', 2]]);
    assert.deepEqual(shapeOf('f(1) + g(2, 3)'), ['+', ['f', 1], ['g', 2, 3]]);
    // 含全角标点时词法层就直接判定为文本
    assert.deepEqual(shapeOf('你好，世界 + 尾'), ['+', '"你好，世界"', '尾']);
  });

  it('运算可以出现在函数实参中', () => {
    const program = parse('__init__ {\n    main() { say(1 + 2 * 3) }\n}');
    const main = program.main as FuncDecl;
    const stmt = main.body[0];
    assert.equal(stmt.kind, 'ExprStmt');
    if (stmt.kind !== 'ExprStmt' || stmt.expr.kind !== 'Call') throw new Error('结构不符预期');
    assert.deepEqual(astShape(stmt.expr), ['say', ['+', 1, ['*', 2, 3]]]);
  });

  it('负数写成 -1，解析为一元负号 + 正数字面量', () => {
    assert.deepEqual(shapeOf('-5'), ['-', 5]);
    assert.deepEqual(shapeOf('-2.5'), ['-', 2.5]);
    assert.deepEqual(shapeOf('-a'), ['-', 'a']);
    assert.deepEqual(shapeOf('0 - 5'), ['-', 0, 5]);
  });

  it('一元负号优先级高于 * /，且右结合', () => {
    assert.deepEqual(shapeOf('-2 * 3'), ['*', ['-', 2], 3]);
    assert.deepEqual(shapeOf('8 / -2'), ['/', 8, ['-', 2]]);
    assert.deepEqual(shapeOf('- -1'), ['-', ['-', 1]]);
    assert.deepEqual(shapeOf('-(1 + 2)'), ['-', ['+', 1, 2]]);
    assert.deepEqual(shapeOf('1 - -1'), ['-', 1, ['-', 1]]);
    assert.deepEqual(shapeOf('-a - -b'), ['-', ['-', 'a'], ['-', 'b']]);
  });

  it('正号也能用：+5 解析为一元正号 + 正数字面量', () => {
    assert.deepEqual(shapeOf('+5'), ['+', 5]);
    assert.deepEqual(shapeOf('+2.5'), ['+', 2.5]);
    assert.deepEqual(shapeOf('+a'), ['+', 'a']);
    assert.deepEqual(shapeOf('+ +1'), ['+', ['+', 1]]);
    assert.deepEqual(shapeOf('- +1'), ['-', ['+', 1]]);
    assert.deepEqual(shapeOf('+ -1'), ['+', ['-', 1]]);
  });

  /* ------------------------- try / catch 与成员访问 ------------------------- */

  it('解析 try / catch 并记录绑定的名字', () => {
    const program = parse(`__init__ {
    main() {
        try {
            say(1)
            say(2)
        } catch (错误) {
            say("错误")
        }
    }
}`);
    const main = program.main as FuncDecl;
    const stmt = main.body[0];
    assert.equal(stmt.kind, 'TryStmt');
    if (stmt.kind !== 'TryStmt') throw new Error('结构不符预期');
    assert.equal(stmt.body.length, 2);
    assert.equal(stmt.catchName, '错误');
    assert.equal(stmt.catchBody.length, 1);
    assert.equal(stmt.catchNameSpan.line, 6);
  });

  it('try 也允许出现在 __init__ 顶层', () => {
    const program = parse(`__init__ {
    try {
        say(1)
    } catch (e) {
        say(e)
    }
    main() { say(2) }
}`);
    assert.equal(program.statements[0].kind, 'TryStmt');
  });

  it('缺少 catch 时报错', () => {
    const error = captureError(() => parse('__init__ {\n    main() {\n        try { say(1) }\n    }\n}'));
    assert.equal(error.code, 'E0202');
    assert.match(error.message, /catch/);
  });

  it('catch 缺少绑定的名字时报错', () => {
    const error = captureError(() =>
      parse('__init__ {\n    main() {\n        try { say(1) } catch (1) { say(2) }\n    }\n}'),
    );
    assert.equal(error.code, 'E0202');
    assert.match(error.message, /绑定的名字/);
  });

  it('catch 块里缺少配对的 } 时报错', () => {
    const error = captureError(() => parse('__init__ {\n    main() {\n        try { say(1) } catch (e) { say(2)\n    }\n}'));
    assert.equal(error.code, 'E0202');
  });

  it('成员访问绑定最紧，可以连写', () => {
    assert.deepEqual(shapeOf('a.b'), ['member', 'a', 'b']);
    assert.deepEqual(shapeOf('错误.code'), ['member', '错误', 'code']);
    assert.deepEqual(shapeOf('a.b.c'), ['member', ['member', 'a', 'b'], 'c']);
    assert.deepEqual(shapeOf('e.code + 1'), ['+', ['member', 'e', 'code'], 1]);
    assert.deepEqual(shapeOf('a.b ** 2'), ['**', ['member', 'a', 'b'], 2]);
    assert.deepEqual(shapeOf('(a + b).code'), ['member', ['+', 'a', 'b'], 'code']);
  });

  it('. 后面缺少字段名时报错', () => {
    const error = captureError(() => parse('__init__ {\n    main() { say(a.) }\n}'));
    assert.equal(error.code, 'E0202');
    assert.match(error.message, /字段名/);
  });

  it('乘方优先级最高，且右结合', () => {
    assert.deepEqual(shapeOf('2 ** 3'), ['**', 2, 3]);
    assert.deepEqual(shapeOf('2 ** 3 ** 2'), ['**', 2, ['**', 3, 2]]);
    assert.deepEqual(shapeOf('2 * 3 ** 2'), ['*', 2, ['**', 3, 2]]);
    assert.deepEqual(shapeOf('2 ** 3 * 2'), ['*', ['**', 2, 3], 2]);
    assert.deepEqual(shapeOf('2 + 3 ** 2'), ['+', 2, ['**', 3, 2]]);
    assert.deepEqual(shapeOf('a ** b ** c'), ['**', 'a', ['**', 'b', 'c']]);
  });

  it('乘方高于一元正负号：-2 ** 2 即 -(2 ** 2)', () => {
    assert.deepEqual(shapeOf('-2 ** 2'), ['-', ['**', 2, 2]]);
    assert.deepEqual(shapeOf('+2 ** 2'), ['+', ['**', 2, 2]]);
    assert.deepEqual(shapeOf('(0 - 2) ** 2'), ['**', ['-', 0, 2], 2]);
  });

  it('指数可以带一元正负号，也可以用括号', () => {
    assert.deepEqual(shapeOf('2 ** -1'), ['**', 2, ['-', 1]]);
    assert.deepEqual(shapeOf('2 ** +1'), ['**', 2, ['+', 1]]);
    assert.deepEqual(shapeOf('2 ** (3 + 1)'), ['**', 2, ['+', 3, 1]]);
    assert.deepEqual(shapeOf('2 ** -3 ** 2'), ['**', 2, ['-', ['**', 3, 2]]]);
  });

  it('二元与一元正负号可以连写', () => {
    assert.deepEqual(shapeOf('1 + +1'), ['+', 1, ['+', 1]]);
    assert.deepEqual(shapeOf('1 - +1'), ['-', 1, ['+', 1]]);
    assert.deepEqual(shapeOf('1 + -1'), ['+', 1, ['-', 1]]);
    assert.deepEqual(shapeOf('+a * 2'), ['*', ['+', 'a'], 2]);
    assert.deepEqual(shapeOf('+(a + b)'), ['+', ['+', 'a', 'b']]);
  });

  it('实参含空格（裸文本写错）时给出加引号的提示', () => {
    const error = captureError(() => parse('__init__ {\n    main() {\n        say(hello world)\n    }\n}'));
    assert.equal(error.code, 'E0202');
    assert.match(error.message, /缺少 , /);
    assert.match(error.hint ?? '', /不能含空格/);
    assert.match(error.hint ?? '', /say\("hello world"\)/);
    assert.equal(error.span.line, 3);
    assert.equal(error.span.col, 19);
  });

  it('实参漏写逗号时也走同一条提示', () => {
    const error = captureError(() => parse('__init__ {\n    main() {\n        say(1 2)\n    }\n}'));
    assert.equal(error.code, 'E0202');
    assert.match(error.hint ?? '', /, 分隔/);
  });

  it('加了引号的带空格文本正常解析', () => {
    const program = parse('__init__ {\n    main() {\n        say("hello world")\n    }\n}');
    const main = program.main as FuncDecl;
    const stmt = main.body[0];
    if (stmt.kind !== 'ExprStmt' || stmt.expr.kind !== 'Call') throw new Error('结构不符预期');
    assert.deepEqual(astShape(stmt.expr), ['say', '"hello world"']);
  });

  it('带时间单位的字面量解析为 DoubleLit 并保留单位', () => {
    const program = parse('__init__ {\n    double t = 1min\n    main() { say(t) }\n}');
    const decl = program.statements[0] as VarDecl;
    assert.equal(decl.initializer.kind, 'DoubleLit');
    if (decl.initializer.kind !== 'DoubleLit') throw new Error('结构不符预期');
    assert.equal(decl.initializer.value, 60);
    assert.equal(decl.initializer.durationUnit, 'min');
    assert.equal(decl.initializer.raw, '1min');
    // 普通小数没有单位
    assert.equal(shapeOf('1.5'), 1.5);
  });

  it('单位字面量可以参与运算', () => {
    assert.deepEqual(shapeOf('1min + 30'), ['+', 60, 30]);
    assert.deepEqual(shapeOf('2 * 500ms'), ['*', 2, 0.5]);
  });

  it('运算符后缺少操作数时报错', () => {
    const error = captureError(() => parse('__init__ {\n    int a = 1 +\n    main() { say(a) }\n}'));
    assert.equal(error.code, 'E0201');
  });

  /* --------------------------- 比较与逻辑运算 --------------------------- */

  it('比较运算符同处一级，左结合', () => {
    assert.deepEqual(shapeOf('a == b'), ['==', 'a', 'b']);
    assert.deepEqual(shapeOf('a < b'), ['<', 'a', 'b']);
    assert.deepEqual(shapeOf('a <= b'), ['<=', 'a', 'b']);
    assert.deepEqual(shapeOf('a >= b'), ['>=', 'a', 'b']);
    assert.deepEqual(shapeOf('a == b == c'), ['==', ['==', 'a', 'b'], 'c']);
    assert.deepEqual(shapeOf('a < b == c'), ['==', ['<', 'a', 'b'], 'c']);
  });

  it('比较的优先级低于算术运算', () => {
    assert.deepEqual(shapeOf('a + 1 > b * 2'), ['>', ['+', 'a', 1], ['*', 'b', 2]]);
    assert.deepEqual(shapeOf('a == 1 + 2'), ['==', 'a', ['+', 1, 2]]);
    assert.deepEqual(shapeOf('a < 2 ** 3'), ['<', 'a', ['**', 2, 3]]);
    assert.deepEqual(shapeOf('0 - a < b'), ['<', ['-', 0, 'a'], 'b']);
  });

  it('&& 低于比较，|| 低于 &&', () => {
    assert.deepEqual(shapeOf('a > 0 && b > 0'), ['&&', ['>', 'a', 0], ['>', 'b', 0]]);
    assert.deepEqual(shapeOf('a && b || c'), ['||', ['&&', 'a', 'b'], 'c']);
    assert.deepEqual(shapeOf('a || b && c'), ['||', 'a', ['&&', 'b', 'c']]);
    assert.deepEqual(shapeOf('a && b && c'), ['&&', ['&&', 'a', 'b'], 'c']);
    assert.deepEqual(shapeOf('(a || b) && c'), ['&&', ['||', 'a', 'b'], 'c']);
  });

  it('一元 ! 高于比较与逻辑，且右结合', () => {
    assert.deepEqual(shapeOf('!a'), ['!', 'a']);
    assert.deepEqual(shapeOf('!!a'), ['!', ['!', 'a']]);
    assert.deepEqual(shapeOf('!a && b'), ['&&', ['!', 'a'], 'b']);
    assert.deepEqual(shapeOf('!(a > 0)'), ['!', ['>', 'a', 0]]);
    assert.deepEqual(shapeOf('!a == b'), ['==', ['!', 'a'], 'b']);
  });

  it('true / false 解析为 BoolLit', () => {
    assert.equal(shapeOf('true'), true);
    assert.equal(shapeOf('false'), false);
    assert.deepEqual(shapeOf('true && false'), ['&&', true, false]);
    assert.deepEqual(shapeOf('flag == true'), ['==', 'flag', true]);
    // 关键字不会被当成裸文本
    const program = parse('__init__ {\n    bool b = true\n    main() { say(b) }\n}');
    const decl = program.statements[0] as VarDecl;
    assert.equal(decl.typeName, 'bool');
    assert.equal(decl.initializer.kind, 'BoolLit');
  });

  /* ------------------------------ if / elif / else ------------------------------ */

  it('解析 if / elif / else 与各自的分支体', () => {
    const program = parse(`__init__ {
    main() {
        if a > 0 {
            say("正")
        } elif a == 0 {
            say("零")
        } else {
            say("负")
        }
    }
}`);
    const main = program.main as FuncDecl;
    const stmt = main.body[0];
    assert.equal(stmt.kind, 'IfStmt');
    if (stmt.kind !== 'IfStmt') throw new Error('结构不符预期');
    assert.deepEqual(
      stmt.branches.map((b) => b.kind),
      ['if', 'elif', 'else'],
    );
    assert.equal(stmt.branches[2].condition, null);
    assert.equal(stmt.branches[0].body.length, 1);
    assert.equal(stmt.branches[1].condition?.kind, 'Binary');
  });

  it('if 可以只有一支，elif 可以重复多次', () => {
    const program = parse(`__init__ {
    main() {
        if a { say(1) }
        if b { say(2) } elif c { say(3) } elif d { say(4) }
    }
}`);
    const main = program.main as FuncDecl;
    const ifs = main.body.filter((s) => s.kind === 'IfStmt');
    assert.equal(ifs.length, 2);
    if (ifs[0].kind !== 'IfStmt' || ifs[1].kind !== 'IfStmt') throw new Error('结构不符预期');
    assert.equal(ifs[0].branches.length, 1);
    assert.equal(ifs[1].branches.length, 3);
  });

  it('条件外层的括号只是分组，可以照常写', () => {
    const program = parse('__init__ {\n    main() {\n        if (a > 0) { say(1) }\n    }\n}');
    const main = program.main as FuncDecl;
    assert.equal(main.body[0].kind, 'IfStmt');
  });

  it('条件与 { 之间允许换行', () => {
    const program = parse('__init__ {\n    main() {\n        if a > 0\n        {\n            say(1)\n        }\n    }\n}');
    const main = program.main as FuncDecl;
    assert.equal(main.body[0].kind, 'IfStmt');
  });

  it('if 块里可以嵌套 if', () => {
    const program = parse(`__init__ {
    main() {
        if a {
            if b {
                say(1)
            } else {
                say(2)
            }
        }
    }
}`);
    const main = program.main as FuncDecl;
    const outer = main.body[0];
    if (outer.kind !== 'IfStmt') throw new Error('结构不符预期');
    assert.equal(outer.branches[0].body[0].kind, 'IfStmt');
  });

  it('if 也允许出现在 __init__ 顶层与函数体内', () => {
    const program = parse(`__init__ {
    if a { say(1) }
    def f() {
        if b { say(2) }
    }
    main() { f() }
}`);
    assert.equal(program.statements[0].kind, 'IfStmt');
  });

  it('孤立的 elif / else 给出针对性提示', () => {
    const orphan = captureError(() => parse('__init__ {\n    main() {\n        elif a { say(1) }\n    }\n}'));
    assert.equal(orphan.code, 'E0201');
    assert.match(orphan.message, /必须紧跟在 if/);

    const orphanElse = captureError(() => parse('__init__ {\n    main() {\n        else { say(1) }\n    }\n}'));
    assert.equal(orphanElse.code, 'E0201');
  });

  it('把 == 写成 = 时提示等号写法', () => {
    const error = captureError(() => parse('__init__ {\n    main() {\n        if a = 1 { say(1) }\n    }\n}'));
    assert.equal(error.code, 'E0202');
    assert.match(error.hint ?? '', /==/);
  });

  it('else 后面不能再跟条件', () => {
    const error = captureError(() =>
      parse('__init__ {\n    main() {\n        if a { say(1) } else b { say(2) }\n    }\n}'),
    );
    assert.equal(error.code, 'E0202');
    assert.match(error.message, /不能再跟条件/);
  });

  it('if 的条件后缺少 { 时报错', () => {
    const error = captureError(() => parse('__init__ {\n    main() {\n        if a say(1)\n    }\n}'));
    assert.equal(error.code, 'E0202');
    assert.match(error.message, /紧跟 \{/);
  });

  it('分支体的花括号不配对时报错', () => {
    const error = captureError(() => parse('__init__ {\n    main() {\n        if a {\n            say(1)\n    }\n}'));
    assert.equal(error.code, 'E0202');
  });

  it('while / for / continue 给出"暂不支持"而不是含混的语法错误', () => {
    // 注意：return 曾经也在这个名单里，现在它已经实现了，用例随之收窄
    const whileError = captureError(() => parse('__init__ {\n    main() {\n        while a {\n        }\n    }\n}'));
    assert.equal(whileError.code, 'E0201');
    assert.match(whileError.message, /暂不支持 while 循环/);
    assert.match(whileError.hint ?? '', /cycle/);

    const forError = captureError(() => parse('__init__ {\n    main() {\n        for a {\n        }\n    }\n}'));
    assert.equal(forError.code, 'E0201');
    assert.match(forError.message, /暂不支持 for 循环/);

    const continueError = captureError(() =>
      parse('__init__ {\n    main() {\n        cycle(2) {\n            continue\n        }\n    }\n}'),
    );
    assert.equal(continueError.code, 'E0201');
    assert.match(continueError.message, /暂不支持 continue/);
  });

  /* ------------------------------ cycle / break ------------------------------ */

  it('解析 cycle(N) 与 cycle()', () => {
    const program = parse(`__init__ {
    main() {
        cycle(3) { say(i) }
        cycle() { break }
    }
}`);
    const main = program.main as FuncDecl;
    const first = main.body[0];
    const second = main.body[1];
    assert.equal(first.kind, 'CycleStmt');
    assert.equal(second.kind, 'CycleStmt');
    if (first.kind !== 'CycleStmt' || second.kind !== 'CycleStmt') throw new Error('结构不符预期');
    assert.equal(first.count?.kind, 'IntLit');
    assert.equal(first.body.length, 1);
    assert.equal(second.count, null);
    assert.equal(second.body[0].kind, 'BreakStmt');
  });

  it('cycle 的次数可以是任意表达式', () => {
    const program = parse('__init__ {\n    int n = 2\n    main() {\n        cycle(n * 2 + 1) { say(i) }\n    }\n}');
    const main = program.main as FuncDecl;
    const stmt = main.body[0];
    if (stmt.kind !== 'CycleStmt') throw new Error('结构不符预期');
    assert.deepEqual(astShape(stmt.count as Expr), ['+', ['*', 'n', 2], 1]);
  });

  it('cycle 可以嵌套，也能出现在函数体 / if / try 里', () => {
    const program = parse(`__init__ {
    def f() {
        cycle(2) {
            if true {
                cycle(3) { break }
            }
            try { break } catch (e) { say(e) }
        }
    }
    main() { f() }
}`);
    assert.equal(program.statements[0].kind, 'FuncDecl');
  });

  it('break 只能出现在 cycle 循环体里（E0203）', () => {
    const atTop = captureError(() => parse('__init__ {\n    main() {\n        break\n    }\n}'));
    assert.equal(atTop.code, 'E0203');
    assert.match(atTop.message, /cycle/);

    const inFunc = captureError(() =>
      parse('__init__ {\n    def f() {\n        break\n    }\n    main() { f() }\n}'),
    );
    assert.equal(inFunc.code, 'E0203');

    // 循环已经结束，不再是"循环体内"
    const afterLoop = captureError(() =>
      parse('__init__ {\n    main() {\n        cycle(1) {\n            say(i)\n        }\n        break\n    }\n}'),
    );
    assert.equal(afterLoop.code, 'E0203');
  });

  it('cycle 缺少括号或花括号时报错', () => {
    assert.equal(
      captureError(() => parse('__init__ {\n    main() {\n        cycle 3 { say(i) }\n    }\n}')).code,
      'E0202',
    );
    assert.equal(
      captureError(() => parse('__init__ {\n    main() {\n        cycle(3) say(i)\n    }\n}')).code,
      'E0202',
    );
  });
});
