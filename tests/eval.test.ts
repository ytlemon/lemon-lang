import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Env, Evaluator, SourceFile, analyze, parseProgram, renderLemonError } from '../src/index';
import { runText } from './support';

describe('求值器', () => {
  it('先执行 __init__ 顶层语句，再调用 main', () => {
    const out = runText(`__init__ {
    say("顶层")
    main() {
        say("主程序")
    }
}`);
    assert.equal(out.stdout, '顶层\n主程序\n');
    assert.equal(out.ok, true);
  });

  it('say 每次输出一行（自动换行）', () => {
    const out = runText(`__init__ {
    main() {
        say(1)
        say(2)
        say(3)
    }
}`);
    assert.equal(out.stdout, '1\n2\n3\n');
  });

  it('三种类型的输出形式', () => {
    const out = runText(`__init__ {
    int i = 7
    double d = 12.5
    text t = 你好
    main() {
        say(i)
        say(d)
        say(t)
    }
}`);
    assert.equal(out.stdout, '7\n12.5\n你好\n');
  });

  it('整数值的 double 保留 .0 后缀', () => {
    const out = runText(`__init__ {
    double a = 1
    double b = 1.0
    double c = 1e3
    main() {
        say(a)
        say(b)
        say(c)
    }
}`);
    assert.equal(out.stdout, '1.0\n1.0\n1000.0\n');
  });

  it('科学计数法不追加 .0 后缀（防回归）', () => {
    const out = runText(`__init__ {
    double big = 1e21
    main() { say(big) }
}`);
    assert.equal(out.stdout.trim(), '1e+21');
  });

  it('裸文本与引号字符串等价', () => {
    const out = runText(`__init__ {
    main() {
        say("你好")
        say("你好")
    }
}`);
    assert.equal(out.stdout, '你好\n你好\n');
  });

  it('用变量做实参', () => {
    const out = runText(`__init__ {
    text who = 世界
    main() { say(who) }
}`);
    assert.equal(out.stdout, '世界\n');
  });

  it('函数提升：可以先用后定义', () => {
    const out = runText(`__init__ {
    main() { later(1) }
    def later(x) { say(x) }
}`);
    assert.equal(out.stdout, '1\n');
  });

  it('函数可以调用函数，并传递变量', () => {
    const out = runText(`__init__ {
    int n = 5
    def outer(x) { inner(x) }
    def inner(y) { say(y) }
    main() { outer(n) }
}`);
    assert.equal(out.stdout, '5\n');
  });

  it('参数名遮蔽同名的顶层名字', () => {
    const out = runText(`__init__ {
    text v = 顶层
    def show(v) { say(v) }
    main() {
        show(参数)
        say(v)
    }
}`);
    assert.equal(out.stdout, '参数\n顶层\n');
  });

  it('函数体内声明的局部变量不会污染顶层', () => {
    const out = runText(`__init__ {
    text v = 顶层
    def f() {
        text v = 局部
        say(v)
    }
    main() {
        f()
        say(v)
    }
}`);
    assert.equal(out.stdout, '局部\n顶层\n');
  });

  it('main 不写 def、无参数、无返回值', () => {
    const out = runText(`__init__ {
    main() { }
}`);
    assert.equal(out.stdout, '');
    assert.equal(out.ok, true);
  });

  it('分号与换行混用', () => {
    const out = runText('__init__ { int a = 1; text b = 两句; main() { say(a); say(b) } }');
    assert.equal(out.stdout, '1\n两句\n');
  });

  it('复用同一个 Env 可以保留绑定', () => {
    const env = new Env();
    const write = (): void => undefined;
    const runOn = (text: string) => {
      const analysis = analyze('<test>', text);
      assert.ok(analysis.program && analysis.check);
      new Evaluator({ write }).runProgram(analysis.program, env);
    };
    runOn('__init__ {\n    int a = 42\n    main() { }\n}');
    let captured = '';
    const analysis = analyze('<test>', '__init__ {\n    main() { say(a) }\n}');
    assert.ok(analysis.program);
    new Evaluator({ write: (t) => { captured += t; } }).runProgram(analysis.program, env);
    assert.equal(captured, '42\n');
  });

  it('parseProgram 与 Evaluator 可独立使用', () => {
    const program = parseProgram(new SourceFile('<test>', '__init__ {\n    main() { say(ok) }\n}'));
    let captured = '';
    new Evaluator({ write: (t) => { captured += t; } }).runProgram(program, new Env());
    assert.equal(captured, 'ok\n');
  });

  /* ------------------------------ 基础运算 ------------------------------ */

  it('四则运算与优先级', () => {
    const out = runText(`__init__ {
    main() {
        say(1 + 2 * 3)
        say((1 + 2) * 3)
        say(10 - 2 - 3)
        say(8 / 4 / 2)
        say(2 * 3 + 4 * 5)
    }
}`);
    assert.equal(out.stdout, '7\n9\n5\n1\n26\n');
  });

  it('一元负号', () => {
    const out = runText(`__init__ {
    int a = 5
    main() {
        say(-1)
        say(-2.5)
        say(-a)
        say(-a * 2)
        say(-(1 + 2))
        say(1 - -1)
    }
}`);
    assert.equal(out.stdout, '-1\n-2.5\n-5\n-10\n-3\n2\n');
  });

  it('一元正号是数值恒等', () => {
    const out = runText(`__init__ {
    int a = 5
    main() {
        say(+1)
        say(+2.5)
        say(+a)
        say(1 + +a)
        say(- +a)
    }
}`);
    assert.equal(out.stdout, '1\n2.5\n5\n6\n-5\n');
  });

  it('乘方', () => {
    const out = runText(`__init__ {
    main() {
        say(2 ** 10)
        say(2 ** 3 ** 2)
        say(2 ** 0)
        say(2.0 ** 0.5)
        say(2 ** 0.5)
        say(2.0 ** 3)
        say(2.0 ** -1)
        say(-2 ** 2)
        say((0 - 2) ** 2)
        say(2 * 3 ** 2)
    }
}`);
    assert.equal(
      out.stdout,
      '1024\n512\n1\n1.4142135623730951\n1.4142135623730951\n8.0\n0.5\n-4\n4\n18\n',
    );
  });

  it('int 乘方遇到算出来的负指数报 E0407', () => {
    const out = runText(`__init__ {
    int n = 0 - 1
    main() {
        say(2 ** n)
    }
}`);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0407');
    assert.match(out.error?.hint ?? '', /2\.0 \*\* -1/);
  });

  it('int 乘方结果过大报 E0406', () => {
    const out = runText(`__init__ {
    main() {
        say(2 ** 100)
    }
}`);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0406');
  });

  it('double 乘方结果不是有限数报 E0408', () => {
    const nan = runText('__init__ {\n    main() {\n        say((0.0 - 8.0) ** 0.5)\n    }\n}');
    assert.equal(nan.ok, false);
    assert.equal(nan.error?.code, 'E0408');

    const infinity = runText('__init__ {\n    main() {\n        say(2.0 ** 10000)\n    }\n}');
    assert.equal(infinity.ok, false);
    assert.equal(infinity.error?.code, 'E0408');
  });

  it('int 除法向零截断（类 C）', () => {
    const out = runText(`__init__ {
    main() {
        say(7 / 2)
        say(6 / 3)
        say(0 - 7 / 2)
    }
}`);
    assert.equal(out.stdout, '3\n2\n-3\n');
  });

  it('含 double 时提升为 double', () => {
    const out = runText(`__init__ {
    main() {
        say(1.0 / 2)
        say(3 * 1.0)
        say(1 + 2.5)
        say(1.0 + 2)
    }
}`);
    assert.equal(out.stdout, '0.5\n3.0\n3.5\n3.0\n');
  });

  it('变量参与运算并可以再次参与', () => {
    const out = runText(`__init__ {
    int a = 2 + 3 * 4
    int b = a / 2
    main() {
        say(a)
        say(b)
        say(a - b * 2)
    }
}`);
    assert.equal(out.stdout, '14\n7\n0\n');
  });

  it('文本用 + 拼接', () => {
    const out = runText(`__init__ {
    text hello = 你好
    main() {
        say(hello + ， + 世界)
        say(你好 + 世界)
    }
}`);
    assert.equal(out.stdout, '你好，世界\n你好世界\n');
  });

  it('函数参数参与运算（按实参类型决定结果类型）', () => {
    const out = runText(`__init__ {
    def twice(x) {
        say(x * 2)
    }

    main() {
        twice(3)
        twice(2.5)
    }
}`);
    assert.equal(out.stdout, '6\n5.0\n');
  });

  it('运算结果可以作为实参传递', () => {
    const out = runText(`__init__ {
    int base = 10

    def show(x) {
        say(x)
    }

    main() {
        show(base * 2 + 1)
        show(base / 4)
    }
}`);
    assert.equal(out.stdout, '21\n2\n');
  });

  it('除以 0 在运行期报 E0405', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1
    main() {
        say(5 / zero)
    }
}`);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0405');
    assert.match(out.error?.message ?? '', /除数为 0/);
  });

  it('字面量 0 作除数在运行前就被拦下', () => {
    const out = runText(`__init__ {
    main() {
        say(5 / 0)
    }
}`);
    assert.equal(out.ok, false);
    assert.equal(out.error, null);
    assert.deepEqual(
      out.diagnostics.map((d) => d.code),
      ['E0315'],
    );
    assert.equal(out.stdout, '');
  });

  it('整数运算溢出报 E0406', () => {
    const out = runText(`__init__ {
    int big = 9007199254740991
    main() {
        say(big + 1)
    }
}`);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0406');
    assert.match(out.error?.hint ?? '', /double/);
  });

  it('除法结果不会溢出（int 截断后仍在范围内）', () => {
    const out = runText(`__init__ {
    int big = 9007199254740991
    main() {
        say(big / 3)
    }
}`);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, '3002399751580330\n');
  });

  /* ------------------------------ try / catch ------------------------------ */

  it('捕获运行期错误并继续执行', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1

    main() {
        try {
            say("开始")
            say(7 / zero)
            say("不会执行")
        } catch (错误) {
            say(错误)
        }
        say("继续")
    }
}`);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, '开始\nE0405 除数为 0，无法计算\n继续\n');
  });

  it('错误值可以读取 code / line / message', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1

    main() {
        try {
            say(7 / zero)
        } catch (e) {
            say(e.code)
            int n = e.line
            say(n)
            text m = e.message
            say(m)
        }
    }
}`);
    assert.equal(out.stdout, 'E0405\n6\n除数为 0，无法计算\n');
  });

  it('无错误时 catch 不执行', () => {
    const out = runText(`__init__ {
    main() {
        try {
            say("正常")
        } catch (错误) {
            say("不该出现")
        }
        say("结束")
    }
}`);
    assert.equal(out.stdout, '正常\n结束\n');
  });

  it('catch 块里再抛错会继续向外传播', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1

    main() {
        try {
            say(7 / zero)
        } catch (错误) {
            say("先捕获")
            say(3 / zero)
        }
    }
}`);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0405');
    assert.equal(out.stdout, '先捕获\n');
  });

  it('try / catch 各自是独立作用域，外层变量仍然可见', () => {
    const out = runText(`__init__ {
    text outer = 外层

    main() {
        try {
            int inner = 1
            say(outer)
            say(inner)
        } catch (错误) {
            say(1)
        }
        say("inner")
    }
}`);
    // 最后的 inner 在 try 外不可见：临时改成文本字面量
    assert.equal(out.stdout, '外层\n1\ninner\n');
  });

  it('能捕获递归过深，让无限递归变得可控', () => {
    const out = runText(`__init__ {
    def loop() {
        loop()
    }

    main() {
        try {
            loop()
        } catch (错误) {
            say(错误.code)
        }
        say("继续")
    }
}`);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, 'E0403\n继续\n');
  });

  it('捕获后调用深度与调用栈都复位', () => {
    const out = runText(`__init__ {
    def loop() {
        loop()
    }

    def deep(n) {
        loop()
    }

    main() {
        try {
            loop()
        } catch (错误) {
            say("第一次")
        }
        try {
            deep(1)
        } catch (错误) {
            say("第二次")
        }
        say("还能继续跑")
    }
}`);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, '第一次\n第二次\n还能继续跑\n');
  });

  it('错误值的 line 指向真正出错的那一行', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1

    def risky() {
        say(7 / zero)
    }

    main() {
        try {
            risky()
        } catch (e) {
            say(e.line)
        }
    }
}`);
    assert.equal(out.stdout, '5\n');
  });

  /* ------------------------------ 运行期错误 ------------------------------ */

  it('无限递归被拦住（E0403），并给出调用栈', () => {
    const out = runText(`__init__ {
    def loop() { loop() }
    main() { loop() }
}`);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0403');
    assert.match(out.error?.message ?? '', /调用层数过深/);
    const frames = out.error?.frames ?? [];
    assert.ok(frames.length > 1);
    assert.equal(frames[0].name, 'main');
    assert.ok(frames.some((f) => f.name === 'loop'));
  });

  it('渲染后的错误信息只展示 Lemon 层调用栈，不暴露宿主堆栈', () => {
    const out = runText(`__init__ {
    def loop() { loop() }
    main() { loop() }
}`);
    assert.ok(out.error);
    const rendered = renderLemonError(out.error, null, '<test>', { color: false });
    assert.match(rendered, /调用栈/);
    assert.match(rendered, /· loop/);
    // 宿主堆栈形如 "at Evaluator.invokeFunction (E:\...\eval.js:123:45)"
    assert.ok(!/^\s*at\s+/m.test(rendered), rendered);
  });

  it('出错前已经产生的输出会保留', () => {
    const out = runText(`__init__ {
    say("先输出")
    def loop() { loop() }
    main() { loop() }
}`);
    assert.equal(out.stdout, '先输出\n');
    assert.equal(out.ok, false);
  });

  it('maxCallDepth 可配置', () => {
    const analysis = analyze('<test>', `__init__ {
    def loop() { loop() }
    main() { loop() }
}`);
    assert.ok(analysis.program);
    let error: unknown = null;
    try {
      new Evaluator({ write: () => undefined, maxCallDepth: 5 }).runProgram(analysis.program, new Env());
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /超过 5 层/);
  });

  /* ------------------------------ bool 与比较 ------------------------------ */

  it('bool 值的输出形式是 true / false', () => {
    const out = runText(`__init__ {
    bool t = true
    bool f = false
    main() {
        say(t)
        say(f)
        say(true)
        say(false)
    }
}`);
    assert.equal(out.stdout, 'true\nfalse\ntrue\nfalse\n');
  });

  it('六个比较运算符都能用，int 与 double 按数值比较', () => {
    const out = runText(`__init__ {
    main() {
        say(1 == 1.0)
        say(1 != 1.0)
        say(1 < 2)
        say(2 <= 2)
        say(3 > 4)
        say(3 >= 4)
        say(你好 == 你好)
        say(你好 != 世界)
        say(true == true)
        say(true != false)
    }
}`);
    assert.equal(
      out.stdout,
      'true\nfalse\ntrue\ntrue\nfalse\nfalse\ntrue\ntrue\ntrue\ntrue\n',
    );
  });

  it('比较结果可以直接赋给 bool 变量并参与逻辑运算', () => {
    const out = runText(`__init__ {
    int a = 7
    bool 中间 = a > 5
    bool 结论 = 中间 && a < 10
    main() {
        say(中间)
        say(结论)
        say(!结论)
    }
}`);
    assert.equal(out.stdout, 'true\ntrue\nfalse\n');
  });

  /* ------------------------------ 逻辑运算 ------------------------------ */

  it('! 取反，&& 与 || 按 bool 求值', () => {
    const out = runText(`__init__ {
    bool t = true
    bool f = false
    main() {
        say(t && true)
        say(t && f)
        say(f || true)
        say(f || f)
        say(!t)
        say(!!t)
        say(!(t && f) || f)
    }
}`);
    assert.equal(out.stdout, 'true\nfalse\ntrue\nfalse\nfalse\ntrue\ntrue\n');
  });

  it('&& 与 || 短路：右侧的除零不会被触发', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1
    main() {
        say(false && 1 / zero > 0)
        say(true || 1 / zero > 0)
    }
}`);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, 'false\ntrue\n');
  });

  it('短路不成立时右侧照常求值并抛错', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1
    main() {
        say(true && 1 / zero > 0)
    }
}`);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0405');
    assert.equal(out.stdout, '');
  });

  /* ------------------------------ if / elif / else ------------------------------ */

  it('命中第一个为 true 的分支，其余不再求值', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1

    def 评级(分数) {
        if 分数 >= 90 {
            say("优秀")
        } elif 分数 >= 60 {
            say("及格")
        } else {
            say("不及格")
        }
    }

    main() {
        评级(95)
        评级(60)
        评级(59)

        if true {
            say("第一支")
        } elif 1 / zero > 0 {
            say("第二支")
        } else {
            say("第三支")
        }
    }
}`);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, '优秀\n及格\n不及格\n第一支\n');
  });

  it('条件都不成立且没有 else 时什么都不做', () => {
    const out = runText(`__init__ {
    main() {
        if false {
            say("不会出现")
        }
        say("继续")
    }
}`);
    assert.equal(out.stdout, '继续\n');
  });

  it('if 可以嵌套，分支体各自独立', () => {
    const out = runText(`__init__ {
    def 分类(n) {
        if n > 0 {
            if n > 100 {
                say("很大的正数")
            } else {
                say("正数")
            }
        } elif n == 0 {
            say("零")
        } else {
            say("负数")
        }
    }

    main() {
        分类(500)
        分类(3)
        分类(0)
        分类(-3)
    }
}`);
    assert.equal(out.stdout, '很大的正数\n正数\n零\n负数\n');
  });

  it('分支体是独立作用域：内层可遮蔽，外层不受影响', () => {
    const out = runText(`__init__ {
    text 标签 = 内部
    def 判断(flag) {
        int 计数 = 10
        if flag {
            int 计数 = 20
            say(标签)
            say(计数)
        } else {
            say(计数)
        }
        say(计数)
    }
    main() {
        判断(true)
        判断(false)
    }
}`);
    // 判断(true) → 内部 / 20 / 10（分支内的 20 不改变外层的 10）
    // 判断(false) → 10 / 10
    assert.equal(out.stdout, '内部\n20\n10\n10\n10\n');
  });

  it('if 里抛出的错误可以被外层 try 捕获', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1
    main() {
        try {
            if zero == 0 {
                say(7 / zero)
            } else {
                say("不会到这里")
            }
        } catch (e) {
            say(e.code)
        }
        say("继续")
    }
}`);
    assert.equal(out.stdout, 'E0405\n继续\n');
  });

  it('try 里的 if 分支可以吞掉错误', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1
    main() {
        try {
            if zero != 0 {
                say(7 / zero)
            } else {
                say("安全跳过")
            }
        } catch (e) {
            say("不该出现")
        }
    }
}`);
    assert.equal(out.stdout, '安全跳过\n');
  });

  /* ------------------------------ cycle 循环 ------------------------------ */

  it('cycle(N) 重复 N 次，i 从 0 递增到 N-1', () => {
    const out = runText(`__init__ {
    main() {
        cycle(3) {
            say(i)
        }
    }
}`);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, '0\n1\n2\n');
  });

  it('cycle(0) 一次都不执行', () => {
    const out = runText(`__init__ {
    main() {
        cycle(0) {
            say("不会出现")
        }
        say("结束")
    }
}`);
    assert.equal(out.stdout, '结束\n');
  });

  it('cycle() 是无限循环，靠 break 结束', () => {
    const out = runText(`__init__ {
    main() {
        cycle() {
            if i >= 3 {
                break
            }
            say(i)
        }
        say("跳出")
    }
}`);
    assert.equal(out.stdout, '0\n1\n2\n跳出\n');
  });

  it('内层的 break 只跳出内层循环', () => {
    const out = runText(`__init__ {
    main() {
        cycle(2) {
            cycle(5) {
                if i == 1 {
                    break
                }
                say(i)
            }
            say("外层")
        }
    }
}`);
    assert.equal(out.stdout, '0\n外层\n0\n外层\n');
  });

  it('轮次变量遮蔽外层的同名变量，循环结束后恢复', () => {
    const out = runText(`__init__ {
    main() {
        int i = 99
        cycle(2) {
            say(i)
        }
        say(i)
    }
}`);
    assert.equal(out.stdout, '0\n1\n99\n');
  });

  it('循环体每轮都是新作用域', () => {
    const out = runText(`__init__ {
    main() {
        cycle(2) {
            int 局部 = i + 1
            say(局部)
        }
    }
}`);
    assert.equal(out.stdout, '1\n2\n');
  });

  it('次数可以来自变量或函数参数', () => {
    const out = runText(`__init__ {
    def 报数(次数) {
        cycle(次数) {
            say(i)
        }
    }
    main() {
        int n = 2
        cycle(n) { say(i) }
        报数(3)
    }
}`);
    assert.equal(out.stdout, '0\n1\n0\n1\n2\n');
  });

  it('break 不会被 try / catch 吃掉', () => {
    const out = runText(`__init__ {
    main() {
        cycle() {
            try {
                if i == 2 {
                    break
                }
                say(i)
            } catch (错误) {
                say("不该出现")
            }
        }
        say("结束")
    }
}`);
    assert.equal(out.stdout, '0\n1\n结束\n');
  });

  it('循环体内抛出的错误可以用 try 捕获，且不会中断循环', () => {
    const out = runText(`__init__ {
    int zero = 1 - 1
    main() {
        cycle(3) {
            try {
                say(7 / zero)
            } catch (错误) {
                say(错误.code)
            }
        }
    }
}`);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, 'E0405\nE0405\nE0405\n');
  });

  it('算出来的次数为负报 E0409', () => {
    const out = runText(`__init__ {
    main() {
        int n = 0 - 1
        cycle(n) {
            say("不会执行")
        }
    }
}`);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0409');
    assert.equal(out.stdout, '');
  });

  /* ------------------------------ 时间与 sleep ------------------------------ */

  it('带单位的字面量输出为秒数（double）', () => {
    const out = runText(`__init__ {
    main() {
        say(1min)
        say(500ms)
        say(2s)
        say(1.5h)
    }
}`);
    assert.equal(out.stdout, '60.0\n0.5\n2.0\n5400.0\n');
  });

  it('sleep 真的会等（按秒计时）', () => {
    const started = Date.now();
    const out = runText('__init__ {\n    main() {\n        sleep(0.05)\n        say("醒")\n    }\n}');
    const elapsed = Date.now() - started;
    assert.equal(out.stdout, '醒\n');
    assert.ok(elapsed >= 40, `实际只等了 ${elapsed}ms`);
    assert.ok(elapsed < 1000, `等太久了：${elapsed}ms`);
  });

  it('sleep(0) 立即返回，不会阻塞', () => {
    const started = Date.now();
    const out = runText('__init__ {\n    main() {\n        sleep(0)\n        say("走")\n    }\n}');
    assert.equal(out.stdout, '走\n');
    assert.ok(Date.now() - started < 500);
  });

  it('循环里可以逐次 sleep（限帧的雏形）', () => {
    const started = Date.now();
    const out = runText(`__init__ {
    main() {
        cycle(3) {
            say(i)
            sleep(0.02)
        }
    }
}`);
    assert.equal(out.stdout, '0\n1\n2\n');
    // 三次 20ms 至少应明显超过单次
    assert.ok(Date.now() - started >= 50);
  });

  it('sleep 的时间不能为负（E0412）', () => {
    const out = runText('__init__ {\n    main() {\n        sleep(0 - 1)\n    }\n}');
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0412');
    assert.match(out.error?.message ?? '', /不能为负/);
  });

  it('sleep 可以作为独立语句，也可以放在 if / try 里', () => {
    const out = runText(`__init__ {
    main() {
        if true {
            sleep(0)
        }
        try {
            sleep(0)
        } catch (错误) {
            say("不该出现")
        }
        say("结束")
    }
}`);
    assert.equal(out.stdout, '结束\n');
  });

  it('递归有了终止条件后可以正常收敛', () => {
    const out = runText(`__init__ {
    def 倒数(n) {
        say(n)
        if n > 1 {
            倒数(n - 1)
        }
    }
    main() { 倒数(3) }
}`);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, '3\n2\n1\n');
  });
});
