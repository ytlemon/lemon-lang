import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourceFile, parseStatements } from '../src/index';
import { checkProgram, checkFragment, type SymbolInfo } from '../src/lang/checker';
import { checkText, errorCodes, warningCodes, wrap } from './support';

function codes(text: string) {
  return errorCodes(checkText(text).diagnostics);
}

function messages(text: string) {
  return checkText(text).diagnostics.map((d) => `${d.code}:${d.message}`);
}

describe('静态检查器', () => {
  it('通过：三种类型各自匹配', () => {
    const result = checkText(wrap('int a = 1\ndouble b = 1.23\ntext c = 你好\nsay(a)\nsay(b)\nsay(c)'));
    assert.deepEqual(errorCodes(result.diagnostics), []);
  });

  it('类型不匹配：int a = 你好（E0307）', () => {
    const result = checkText(wrap('int a = 你好'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].hint ?? '', /text a = /);
  });

  it('类型不匹配：int a = 1.5（E0307）', () => {
    const result = checkText(wrap('int a = 1.5'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].hint ?? '', /不能自动转成 int/);
  });

  it('类型不匹配：double b = 你好（E0307）', () => {
    assert.deepEqual(codes(wrap('double b = 你好')), ['E0307']);
  });

  it('隐式提升：int 可以赋给 double', () => {
    assert.deepEqual(codes(wrap('double b = 1\nsay(b)')), []);
  });

  it('say 的文本必须加引号（E0344）；变量与数字不受影响', () => {
    assert.deepEqual(codes(wrap('say(你好)')), ['E0344']);
    assert.deepEqual(codes(wrap('say("你好")')), []);
    assert.deepEqual(codes(wrap('int a = 1\nsay(a)')), []);
    assert.deepEqual(codes(wrap('say(1)')), []);
    // 名字写错时只报形近名（E0312），不再补一条要加引号
    assert.deepEqual(codes(wrap('int count = 1\nsay(countt)')), ['E0312']);
  });

  it('裸文本：say 之外照常，say 里要加引号（E0344）', () => {
    // say 之外的裸文本仍是普通文本，不报错
    assert.deepEqual(codes(wrap('text t = 你好')), []);
    // say 里写裸文本要加引号
    assert.deepEqual(codes(wrap('say("你好")\nsay(hello)')), ['E0344']);
  });

  it('形近名只在与声明相似时报错，且不会因内建误报裸文本', () => {
    // bay 与 say 编辑距离为 1，但不在调用位，不应报错
    assert.deepEqual(codes(wrap('text t = bay')), []);
    // countt 与已声明的 count 形近，应提示
    assert.deepEqual(codes(wrap('int count = 1\ntext t = countt')), ['E0312']);
  });

  it('调用位置上的形近名提示（如 sya → say）', () => {
    const result = checkText(wrap('sya(你好)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0308']);
    assert.match(result.diagnostics[0].hint ?? '', /say/);
  });

  it('顶层变量在声明之前使用会报错（E0312）', () => {
    const result = checkText(`__init__ {
    say(a)
    int a = 1
    main() { say(a) }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0312']);
    assert.match(result.diagnostics[0].message, /第 3 行才声明/);
  });

  it('函数体内可以使用任意顶层变量（main 在初始化之后运行）', () => {
    const result = checkText(`__init__ {
    main() { say(later) }
    int later = 1
}`);
    assert.deepEqual(errorCodes(result.diagnostics), []);
  });

  it('调用未定义的函数（E0308）', () => {
    assert.deepEqual(codes(wrap('hello(你好)')), ['E0308']);
  });

  it('把变量当函数调用（E0309）', () => {
    const result = checkText(wrap('int a = 1\na(1)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0309']);
    assert.match(result.diagnostics[0].message, /是变量，不是函数/);
  });

  it('say 参数个数必须是 1（E0311）', () => {
    assert.deepEqual(codes(wrap('say(1, 2)')), ['E0311']);
    assert.deepEqual(codes(wrap('say()')), ['E0311']);
    const zero = checkText(wrap('say()'));
    assert.match(zero.diagnostics[0].hint ?? '', /分多次调用/);
  });

  it('自定义函数参数个数必须一致（E0310）', () => {
    const result = checkText(`__init__ {
    def greet(a, b) { say(a) }
    main() { greet(1) }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0310']);
    assert.match(result.diagnostics[0].message, /需要 2 个参数/);
  });

  it('缺少 main（E0303）', () => {
    const result = checkText('__init__ {\n    int a = 1\n}');
    assert.deepEqual(errorCodes(result.diagnostics), ['E0303']);
  });

  it('变量重复声明（E0306）', () => {
    const result = checkText(wrap('int a = 1\nint a = 2'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0306']);
  });

  it('内建函数名不能被重定义（E0306）', () => {
    const fn = checkText(`__init__ {
    def say(x) { say(x) }
    main() { say(1) }
}`);
    assert.deepEqual(errorCodes(fn.diagnostics), ['E0306']);
    assert.match(fn.diagnostics[0].message, /内置函数/);

    // 顶层变量占用内置名
    const topLevelVar = checkText('__init__ {\n    int say = 1\n    main() { say(1) }\n}');
    assert.deepEqual(errorCodes(topLevelVar.diagnostics), ['E0306']);

    // 函数体内也不允许
    const localVar = checkText(wrap('int say = 1'));
    assert.deepEqual(errorCodes(localVar.diagnostics), ['E0306']);

    // 参数名同样不允许（且只报一次，不产生级联错误）
    const param = checkText(`__init__ {
    def f(say) { say(say) }
    main() { f(1) }
}`);
    assert.deepEqual(errorCodes(param.diagnostics), ['E0306']);
  });

  it('函数名与变量名冲突（E0306，且不产生级联错误）', () => {
    const result = checkText(`__init__ {
    int f = 1
    def f(a) { say(a) }
    main() { f(1) }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0306']);
  });

  it('独立表达式不能作为语句（E0304）', () => {
    const result = checkText(wrap('1'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0304']);
    assert.match(result.diagnostics[0].hint ?? '', /函数调用/);
  });

  it('未使用的变量/函数只在开启开关时提示为警告', () => {
    const source = '__init__ {\n    int a = 1\n    main() { say("你好") }\n}';
    assert.deepEqual(warningCodes(checkText(source).diagnostics), []);
    const withWarnings = checkText(source, { warnUnused: true });
    assert.deepEqual(warningCodes(withWarnings.diagnostics), ['E0401']);
    assert.deepEqual(errorCodes(withWarnings.diagnostics), []);
    assert.match(withWarnings.diagnostics[0].message, /从未使用/);
  });

  it('函数参数是 any 类型，任何值都可传入', () => {
    const result = checkText(`__init__ {
    def show(x) { say(x) }
    main() {
        show(1)
        show(1.5)
        show(你好)
        show(x)
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), []);
  });

  it('函数内的局部变量不会泄漏到顶层（say 里用到就报 E0344）', () => {
    const result = checkText(`__init__ {
    def f(a) {
        int local = 1
        say(local)
    }
    main() {
        f(1)
        say(local)
    }
}`);
    // local 在 main 的作用域内不存在：say 里写它要加引号
    assert.deepEqual(errorCodes(result.diagnostics), ['E0344']);
  });

  /* --------------------------- REPL 增量检查 --------------------------- */

  it('checkFragment 保留跨片段的符号表', () => {
    const globals = new Map<string, SymbolInfo>();

    const first = parseFragmentSource('int a = 1');
    const r1 = checkFragment(first, globals);
    assert.deepEqual(errorCodes(r1.diagnostics), []);
    for (const [k, v] of r1.globals) globals.set(k, v);

    const second = parseFragmentSource('say(a)');
    const r2 = checkFragment(second, globals);
    assert.deepEqual(errorCodes(r2.diagnostics), []);
  });

  it('checkFragment 支持 def 并允许重复定义（覆盖）', () => {
    const globals = new Map<string, SymbolInfo>();
    for (const src of ['def g(x) { say(x) }', 'def g(x) { say(x) }', 'g(1)']) {
      const result = checkFragment(parseFragmentSource(src), globals);
      assert.deepEqual(errorCodes(result.diagnostics), []);
      for (const [k, v] of result.globals) globals.set(k, v);
    }
    assert.ok(globals.has('g'));
  });

  /* ---------------------------- 运算符类型规则 ---------------------------- */

  it('数值运算：同为 int 得 int，含 double 得 double', () => {
    assert.deepEqual(codes(wrap('int a = 1 + 2\nsay(a)')), []);
    assert.deepEqual(codes(wrap('int a = 6 * 7 - 1\nsay(a)')), []);
    assert.deepEqual(codes(wrap('double b = 1 + 2.5\nsay(b)')), []);
    assert.deepEqual(codes(wrap('double c = 1.0 * 3\nsay(c)')), []);
    assert.deepEqual(codes(wrap('double d = 5\nsay(d + 1)')), []);
  });

  it('把 double 结果存进 int 变量仍然报 E0307', () => {
    assert.deepEqual(codes(wrap('int a = 1 + 2.5\nsay(a)')), ['E0307']);
  });

  it('文本用 + 拼接', () => {
    assert.deepEqual(codes(wrap('text t = 你好 + 世界\nsay(t)')), []);
    assert.deepEqual(codes(wrap('text a = x\ntext b = y\nsay(a + b)')), []);
  });

  it('数字与文本相加报 E0307 并提示', () => {
    const result = checkText(wrap('text t = 1 + 你好\nsay(t)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].hint ?? '', /文本只能与文本/);
  });

  it('文本不能参与 - * /（提示改用 +）', () => {
    for (const op of ['-', '*', '/']) {
      const result = checkText(wrap(`text t = 你好 ${op} 世界\nsay(t)`));
      assert.deepEqual(errorCodes(result.diagnostics), ['E0307'], `运算符 ${op}`);
      assert.match(result.diagnostics[0].hint ?? '', /只能用 '\+' 拼接/);
    }
  });

  it('say(...) 的结果是 unit，不能参与运算', () => {
    const result = checkText(wrap('int a = say(1) + 2\nsay(a)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].message, /unit/);
  });

  it('除数为字面量 0 时在运行前报 E0315', () => {
    const result = checkText(wrap('int a = 7 / 0\nsay(a)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0315']);
    assert.match(result.diagnostics[0].message, /除数为 0/);
    // wrap() 包了一层 __init__ 与 main()，用户代码从第 3 行开始
    assert.equal(result.diagnostics[0].line, 3);
  });

  it('除数为 0.0 同样报 E0315', () => {
    assert.deepEqual(codes(wrap('double a = 1.0 / 0.0\nsay(a)')), ['E0315']);
  });

  it('一元负号保持操作数类型', () => {
    assert.deepEqual(codes(wrap('int a = -1\nsay(a)')), []);
    assert.deepEqual(codes(wrap('double b = -1.5\nsay(b)')), []);
    assert.deepEqual(codes(wrap('double c = -1\nsay(c)')), []);
    assert.deepEqual(codes(wrap('int d = 5\nsay(-d)')), []);
    assert.deepEqual(codes(wrap('int d = 5\nint e = 3\nsay(-(d + e))')), []);
  });

  it('文本不能取负（E0307）', () => {
    const result = checkText(wrap('text t = -你好\nsay(t)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].hint ?? '', /只接受 int 与 double/);
  });

  it('一元正号是数值恒等，保持操作数类型', () => {
    assert.deepEqual(codes(wrap('int a = +1\nsay(a)')), []);
    assert.deepEqual(codes(wrap('double b = +1\nsay(b)')), []);
    assert.deepEqual(codes(wrap('int c = 5\nsay(+c)')), []);
    assert.deepEqual(codes(wrap('int d = 5\nsay(1 + +d)')), []);
    assert.deepEqual(codes(wrap('int e = 5\nsay(- +e)')), []);
  });

  it('文本不能取正（E0307）', () => {
    const result = checkText(wrap('text t = +你好\nsay(t)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].hint ?? '', /去掉加号/);
  });

  it('-0 作除数同样在运行前报 E0315', () => {
    assert.deepEqual(codes(wrap('int a = 7 / -0\nsay(a)')), ['E0315']);
  });

  it('乘方：int ** int 得 int，含 double 得 double', () => {
    assert.deepEqual(codes(wrap('int a = 2 ** 10\nsay(a)')), []);
    assert.deepEqual(codes(wrap('int b = 2 ** 3 ** 2\nsay(b)')), []);
    assert.deepEqual(codes(wrap('double c = 2.0 ** 0.5\nsay(c)')), []);
    assert.deepEqual(codes(wrap('double d = 2 ** 0.5\nsay(d)')), []);
    assert.deepEqual(codes(wrap('double e = 2.0 ** 3\nsay(e)')), []);
  });

  it('把乘方结果存进 int 变量时类型要匹配', () => {
    assert.deepEqual(codes(wrap('int a = 2.0 ** 3\nsay(a)')), ['E0307']);
  });

  it('int 乘方不支持负指数：字面量在运行前报 E0316', () => {
    const result = checkText(wrap('int a = 2 ** -1\nsay(a)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0316']);
    assert.match(result.diagnostics[0].hint ?? '', /2\.0 \*\* -1/);
  });

  it('指数是小数时不算负指数错误（结果本来就是 double）', () => {
    assert.deepEqual(codes(wrap('double a = 2 ** -1.5\nsay(a)')), []);
    assert.deepEqual(codes(wrap('double b = 2.0 ** -1\nsay(b)')), []);
  });

  it('文本不能参与乘方', () => {
    const result = checkText(wrap('int a = 你好 ** 2\nsay(a)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].message, /文本不能参与/);
  });

  /* ------------------------------ try / catch ------------------------------ */

  it('catch 绑定错误值，字段类型正确', () => {
    const result = checkText(`__init__ {
    int zero = 1 - 1
    main() {
        try {
            say(7 / zero)
        } catch (错误) {
            say(错误)
            text c = 错误.code
            int n = 错误.line
            text m = 错误.message
            say(c)
            say(n)
            say(m)
        }
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), []);
  });

  it('错误值可以传给函数（参数是 any）', () => {
    const result = checkText(`__init__ {
    def show(e) {
        say(e.code)
        say(e.line)
    }

    int zero = 1 - 1
    main() {
        try {
            say(7 / zero)
        } catch (错误) {
            show(错误)
        }
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), []);
  });

  it('取不存在的字段报 E0317', () => {
    const result = checkText(`__init__ {
    main() {
        try {
            say(1)
        } catch (错误) {
            say(错误.行号)
        }
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0317']);
    assert.match(result.diagnostics[0].hint ?? '', /code/);
  });

  it('对非错误值取字段报 E0317', () => {
    const result = checkText(wrap('text name = Lemon\nsay(name.code)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0317']);
    assert.match(result.diagnostics[0].message, /text（文本）没有/);
  });

  it('错误值不能直接存进变量（E0307）', () => {
    const result = checkText(`__init__ {
    main() {
        try {
            say(1)
        } catch (错误) {
            text t = 错误
            say(t)
        }
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].hint ?? '', /错误值不能直接存进变量/);
  });

  it('catch 名字不能占用内置函数名（E0306）', () => {
    const result = checkText(`__init__ {
    main() {
        try {
            say(1)
        } catch (say) {
            say(1)
        }
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0306']);
  });

  it('try 与 catch 各自是独立作用域', () => {
    const result = checkText(`__init__ {
    text outer = 外层

    main() {
        try {
            int inner = 1
            say(outer)
            say(inner)
        } catch (错误) {
            say(1)
        }
        say(inner)
    }
}`);
    // inner 在 try 之外不可见：say 里写它要加引号（E0344）
    assert.deepEqual(errorCodes(result.diagnostics), ['E0344']);
  });

  it('catch 里绑定的名字不会泄漏到外面', () => {
    const result = checkText(`__init__ {
    main() {
        try {
            say(1)
        } catch (错误) {
            say(错误)
        }
        say(错误)
    }
}`);
    // 外面再引用 错误 已不是变量：say 里写它要加引号（E0344）
    assert.deepEqual(errorCodes(result.diagnostics), ['E0344']);
  });

  it('函数参数类型为 any，参与运算不误报', () => {
    assert.deepEqual(
      codes(`__init__ {
    def add(a, b) { say(a + b) }
    def half(x) { say(x / 2) }
    def pick(s) { say(s - s) }
    main() { add(1, 2) }
}`),
      [],
    );
  });

  it('精确的错误消息文本（防回归）', () => {
    const list = messages(wrap('int a = 你好'));
    assert.equal(list.length, 1);
    assert.equal(list[0], 'E0307:类型不匹配：text（文本）的值不能赋给int（整数）变量 a');
  });

  /* ------------------------------ bool 类型 ------------------------------ */

  it('bool 是第四种变量类型，true / false 都可以赋值', () => {
    const result = checkText(`__init__ {
    bool 已登录 = true
    bool 已过期 = false
    main() {
        say(已登录)
        say(已过期)
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), []);
  });

  it('bool 与数字之间不能互相赋值（E0307）', () => {
    const toInt = checkText(wrap('int a = true'));
    assert.deepEqual(errorCodes(toInt.diagnostics), ['E0307']);
    assert.match(toInt.diagnostics[0].hint ?? '', /true \/ false/);

    const toBool = checkText(wrap('bool b = 1'));
    assert.deepEqual(errorCodes(toBool.diagnostics), ['E0307']);
    assert.match(toBool.diagnostics[0].hint ?? '', /bool/);
  });

  it('bool 不能存进 int / text（E0307）', () => {
    assert.deepEqual(codes(wrap('int a = false')), ['E0307']);
    assert.deepEqual(codes(wrap('text a = true')), ['E0307']);
  });

  /* ------------------------------ 比较运算 ------------------------------ */

  it('比较运算的类型规则', () => {
    // 数字之间（含 int/double 混用）都合法
    assert.deepEqual(codes(wrap('say(1 == 1.0)\nsay(1 < 2)\nsay(1.5 <= 2)')), []);
    // text 与 bool 只支持 == / !=
    assert.deepEqual(codes(wrap('text a = x\nsay(a == y)\nsay(a != y)\nsay(true == false)')), []);
    // 大小比较只接受数字
    assert.deepEqual(codes(wrap('text a = x\nsay(a > y)')), ['E0307']);
    assert.deepEqual(codes(wrap('say(true < false)')), ['E0307']);
  });

  it('跨类型比较一律报 E0307', () => {
    const mixed = checkText(wrap('say(1 == 你好)'));
    assert.deepEqual(errorCodes(mixed.diagnostics), ['E0307']);
    assert.match(mixed.diagnostics[0].hint ?? '', /文本只能与文本比较/);

    const boolNumber = checkText(wrap('say(true == 1)'));
    assert.deepEqual(errorCodes(boolNumber.diagnostics), ['E0307']);
    assert.match(boolNumber.diagnostics[0].hint ?? '', /bool/);
  });

  it('比较结果类型是 bool，不是 int', () => {
    assert.deepEqual(codes(wrap('int a = 1 > 0')), ['E0307']);
    assert.deepEqual(codes(wrap('bool a = 1 > 0\nsay(a)')), []);
  });

  /* ------------------------------ 逻辑运算 ------------------------------ */

  it('逻辑运算的操作数必须是 bool（E0307）', () => {
    assert.deepEqual(codes(wrap('say(true && false)\nsay(true || false)\nsay(!true)')), []);
    assert.deepEqual(codes(wrap('int a = 1\nsay(a && true)')), ['E0307']);
    assert.deepEqual(codes(wrap('text a = x\nsay(!a)')), ['E0307']);
  });

  it('逻辑运算两侧都会被发现，且结果仍是 bool', () => {
    const result = checkText(wrap('say(1 && 你好)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307', 'E0307']);
    assert.deepEqual(codes(wrap('bool b = true && !false\nsay(b)')), []);
  });

  /* ------------------------------ if / elif / else ------------------------------ */

  it('条件必须是 bool，否则报 E0318', () => {
    assert.deepEqual(codes(wrap('if 1 { say("x") }')), ['E0318']);
    assert.deepEqual(codes(wrap('text n = 你好\nif n { say("x") }')), ['E0318']);
    assert.deepEqual(codes(wrap('bool b = true\nif b { say("x") }')), []);
    assert.deepEqual(codes(wrap('int a = 1\nif a > 0 { say("x") }')), []);
  });

  it('if 条件没有返回值时给出针对性提示', () => {
    const result = checkText(wrap('if say(1) { }'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0318']);
    assert.match(result.diagnostics[0].hint ?? '', /没有返回值/);
  });

  it('elif 的条件同样要求 bool，报错时点名 elif', () => {
    const result = checkText(`__init__ {
    main() {
        if true { say(1) } elif 2 { say(3) }
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0318']);
    assert.match(result.diagnostics[0].message, /^elif/);
  });

  it('条件里的名字笔误只报一次，不再补条件类型错误', () => {
    const result = checkText(`__init__ {
    int count = 1
    main() {
        if countt { say("x") }
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0312']);
    assert.match(result.diagnostics[0].hint ?? '', /count/);
  });

  it('分支体是独立作用域：外层变量可见，同名声明互不冲突', () => {
    const result = checkText(`__init__ {
    int outer = 1
    main() {
        if outer > 0 {
            int inner = 2
            say(inner)
        } else {
            int inner = 3
            say(inner)
        }
        say(outer)
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), []);
  });

  it('同一个分支里重复声明同名变量报 E0306', () => {
    const result = checkText(`__init__ {
    main() {
        if true {
            int a = 1
            int a = 2
            say(a)
        }
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0306']);
  });

  it('分支内声明的变量不会出现在分支外', () => {
    const result = checkText(`__init__ {
    main() {
        if true {
            int inside = 1
            say(inside)
        }
        say(inside)
    }
}`);
    // 分支外的 inside 解析不到：say 里写它要加引号（E0344）
    assert.deepEqual(errorCodes(result.diagnostics), ['E0344']);
  });

  it('if 顶层分支体里的声明不会进入全局符号表', () => {
    const result = checkText(`__init__ {
    if true {
        int a = 1
    }
    main() { say(a) }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0344']);
    assert.equal(result.check?.globals.has('a'), false);
  });

  /* ------------------------------ cycle 循环 ------------------------------ */

  it('cycle 的次数必须是 int（E0319）', () => {
    assert.deepEqual(codes(wrap('cycle(3) { say(i) }')), []);
    assert.deepEqual(codes(wrap('cycle(1.5) { say(i) }')), ['E0319']);
    assert.deepEqual(codes(wrap('text n = 三\ncycle(n) { say(i) }')), ['E0319']);
    assert.deepEqual(codes(wrap('bool b = true\ncycle(b) { say(i) }')), ['E0319']);
    assert.deepEqual(codes(wrap('cycle(say(1)) { say(i) }')), ['E0319']);
  });

  it('次数类型不对时的提示按实际类型给出', () => {
    const double = checkText(wrap('cycle(1.5) { say(i) }'));
    assert.match(double.diagnostics[0].hint ?? '', /循环小数次/);

    const unit = checkText(wrap('cycle(say(1)) { say(i) }'));
    assert.match(unit.diagnostics[0].hint ?? '', /没有返回值/);
  });

  it('cycle 的次数不能是字面量负数（E0320），算出来的留给运行期', () => {
    assert.deepEqual(codes(wrap('cycle(-1) { say(i) }')), ['E0320']);
    assert.deepEqual(codes(wrap('cycle(0) { say(i) }')), []);
    // 0 - 1 不是字面量负数，静态放过，运行期报 E0409
    assert.deepEqual(codes(wrap('cycle(0 - 1) { say(i) }')), []);
  });

  it('cycle() 不需要次数，体内用 break 结束', () => {
    assert.deepEqual(codes(wrap('cycle() { break }')), []);
  });

  it('体内可以读到轮次变量 i（int）', () => {
    assert.deepEqual(codes(wrap('cycle(2) { say(i)\nint 加倍 = i * 2\nsay(加倍) }')), []);
  });

  it('体内声明 i 会与轮次变量冲突（E0306）', () => {
    const result = checkText(wrap('cycle(2) { int i = 5 }'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0306']);
    assert.match(result.diagnostics[0].message, /重复声明/);
  });

  it('轮次变量遮蔽外层的 i，循环之外不受影响', () => {
    assert.deepEqual(codes(wrap('int i = 99\ncycle(2) { say(i) }\nsay(i)')), []);
  });

  it('cycle 可以出现在函数体、if 分支与 try 块里', () => {
    assert.deepEqual(
      codes(`__init__ {
    def f() {
        cycle(2) {
            if true {
                cycle(1) { break }
            }
            try { break } catch (e) { say(e) }
        }
    }
    main() { f() }
}`),
      [],
    );
  });

  it('参数是 any 时次数不做静态判断（交给运行期）', () => {
    assert.deepEqual(
      codes(`__init__ {
    def 报数(次数) {
        cycle(次数) { say(i) }
    }
    main() { 报数(3) }
}`),
      [],
    );
  });

  /* ------------------------------ 时间与 sleep ------------------------------ */

  it('带单位的时长是 double（秒）', () => {
    assert.deepEqual(codes(wrap('double t = 1min\nsay(t)')), []);
    assert.deepEqual(codes(wrap('double t = 500ms\nsay(t)')), []);
    assert.deepEqual(codes(wrap('double t = 1min + 30.5\nsay(t)')), []);
  });

  it('把时长存进 int 变量时给出专门的提示', () => {
    const result = checkText(wrap('int t = 1min'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0307']);
    assert.match(result.diagnostics[0].hint ?? '', /带单位的时长/);
    assert.match(result.diagnostics[0].hint ?? '', /60/);
  });

  it('sleep 接受 int 与 double 的秒数，也接受带单位的时长', () => {
    assert.deepEqual(codes(wrap('sleep(1)')), []);
    assert.deepEqual(codes(wrap('sleep(0.5)')), []);
    assert.deepEqual(codes(wrap('sleep(1min)')), []);
    assert.deepEqual(codes(wrap('sleep(500ms)')), []);
    assert.deepEqual(codes(wrap('int n = 3\nsleep(n)')), []);
  });

  it('sleep 返回 unit：不能当条件，也不能存进变量', () => {
    assert.deepEqual(codes(wrap('bool b = sleep(1)')), ['E0307']);
    assert.deepEqual(codes(wrap('if sleep(1) { say(1) }')), ['E0318']);
  });

  it('sleep 的参数类型与个数都有检查', () => {
    const typed = checkText(wrap('sleep(你好)'));
    assert.deepEqual(errorCodes(typed.diagnostics), ['E0307']);
    assert.match(typed.diagnostics[0].hint ?? '', /按秒算/);

    assert.deepEqual(codes(wrap('sleep()')), ['E0310']);
    assert.deepEqual(codes(wrap('sleep(1, 2)')), ['E0310']);
  });

  it('sleep 是内置名，不能被占用', () => {
    assert.deepEqual(codes(wrap('int sleep = 1')), ['E0306']);
  });

  it('cycle 体内声明的变量不会泄漏到循环之外', () => {
    const result = checkText(`__init__ {
    main() {
        cycle(2) {
            int 局部 = 1
            say(局部)
        }
        say(局部)
    }
}`);
    assert.deepEqual(errorCodes(result.diagnostics), ['E0344']);
  });
});

function parseFragmentSource(text: string) {
  return parseStatements(new SourceFile('<test>', text));
}
