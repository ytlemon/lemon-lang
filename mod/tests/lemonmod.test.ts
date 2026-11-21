/**
 * lemonmod v0.1 的语法与运行用例（node --test）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ModErrorCode, checkModSource, runModSource } from '../src/index';

/** 把片段包进必须的文件外壳，便于只关注块内的那几行 */
function wrap(body: string): string {
  return `set demo public{\n    class public{\n${body}\n    }\n}\n`;
}

function run(text: string): { ok: boolean; stdout: string; codes: string[] } {
  const result = runModSource(text);
  return {
    ok: result.ok,
    stdout: result.stdout,
    codes: result.diagnostics.map((d) => d.code),
  };
}

function errorCode(text: string): string | null {
  const result = checkModSource(text);
  return result.error === null ? null : result.error.code;
}

test('样本程序输出两行 hello', () => {
  const sample = [
    'set hello public{    //声明文件',
    '    class public{       //初始化',
    '        say(hello)  //说“你好”',
    '        printf("hello")   //说“你好”',
    '    }',
    '}',
    '',
  ].join('\n');
  const result = run(sample);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'hello\nhello\n');
});

test('say 与 printf 等价：裸文本与字符串都按内容输出', () => {
  assert.equal(run(wrap('say(hello)')).stdout, 'hello\n');
  assert.equal(run(wrap('printf("hello")')).stdout, 'hello\n');
  assert.equal(run(wrap('say("hello")')).stdout, 'hello\n');
  assert.equal(run(wrap('printf(hello)')).stdout, 'hello\n');
});

test('分号可有可无，两种断句可混用', () => {
  assert.equal(run(wrap('say(a); say(b)\nsay(c);')).stdout, 'a\nb\nc\n');
});

test('空行、缩进与 // 注释不产生语句', () => {
  assert.equal(run(wrap('// 只有注释\n\n    say(hi)\n')).stdout, 'hi\n');
});

test('文件名是任意裸词，可以是汉字', () => {
  const result = run('set 演示 public{\nclass public{\nsay(你好)\n}\n}\n');
  assert.equal(result.ok, true);
  assert.equal(result.stdout, '你好\n');
});

test('字符串支持转义', () => {
  assert.equal(run(wrap('printf("a\\nb")')).stdout, 'a\nb\n');
});

test('外壳必须完整', () => {
  assert.equal(errorCode(''), ModErrorCode.ExpectedSet);
  assert.equal(errorCode('class public{\n}\n'), ModErrorCode.ExpectedSet);
  assert.equal(errorCode('set demo {\nclass public{\n}\n}\n'), ModErrorCode.ExpectedPublic);
  assert.equal(errorCode('set demo public\nclass public{\n}\n}\n'), ModErrorCode.ExpectedFileBody);
  assert.equal(errorCode('set demo public{\n}\n'), ModErrorCode.ExpectedClass);
  assert.equal(errorCode('set demo public{\nclass private{\n}\n}\n'), ModErrorCode.ExpectedClassPublic);
  assert.equal(errorCode('set demo public{\nclass public\n}\n'), ModErrorCode.ExpectedClassBody);
  assert.equal(errorCode('set demo public{\nclass public{\n}\n'), ModErrorCode.ExpectedCloseBrace);
});

test('文件声明之后不能有多余内容', () => {
  assert.equal(errorCode('set demo public{\nclass public{\n}\n}\nsay(x)\n'), ModErrorCode.UnexpectedTrailing);
});

test('语句形状错误会报对应错误码', () => {
  assert.equal(errorCode(wrap('foo')), ModErrorCode.UnknownStatement);
  assert.equal(errorCode(wrap('say hello)')), ModErrorCode.ExpectedOpenParen);
  assert.equal(errorCode(wrap('say()')), ModErrorCode.ExpectedArgument);
  assert.equal(errorCode(wrap('say(hello')), ModErrorCode.ExpectedCloseParen);
  assert.equal(errorCode(wrap('say(a, b)')), ModErrorCode.TooManyArguments);
  assert.equal(errorCode(wrap('printf("a") printf("b")')), ModErrorCode.ExpectedStatementEnd);
  // foo(1) 在解析期是合法的函数调用，只有运行期才报 UnknownFunction
  assert.equal(errorCode(wrap('foo(1)')), null);
});

test('词法错误：未闭合字符串与非法字符', () => {
  assert.equal(errorCode(wrap('printf("hello)')), ModErrorCode.UnterminatedString);
  assert.equal(errorCode(wrap('say(hi) #')), ModErrorCode.UnexpectedCharacter);
});

test('报错时带上出错位置', () => {
  const result = checkModSource('class public{\n}\n');
  assert.equal(result.error?.span.line, 1);
  assert.equal(result.error?.span.col, 1);
});

test('变量赋值后可在 say 中引用', () => {
  assert.equal(run(wrap('a=1\nsay(a)')).stdout, '1\n');
  assert.equal(run(wrap('a=1\na=1+a\nsay(a)')).stdout, '2\n');
});

test('变量可重复赋值（无需提前声明）', () => {
  assert.equal(run(wrap('a=1\na=5\nsay(a)')).stdout, '5\n');
  assert.equal(run(wrap('x=你好\nsay(x)')).stdout, '你好\n');
});

test('四则运算与括号', () => {
  assert.equal(run(wrap('a=2\nb=3\nsay(a*b)')).stdout, '6\n');
  assert.equal(run(wrap('say(1+2*3)')).stdout, '7\n');
  assert.equal(run(wrap('say((1+2)*3)')).stdout, '9\n');
  assert.equal(run(wrap('say(10/4)')).stdout, '2.5\n');
  assert.equal(run(wrap('say(7-2-1)')).stdout, '4\n');
});

test('一元负号与小数', () => {
  assert.equal(run(wrap('a=-3\nsay(a)')).stdout, '-3\n');
  assert.equal(run(wrap('say(-2+5)')).stdout, '3\n');
  assert.equal(run(wrap('pi=3.14\nsay(pi)')).stdout, '3.14\n');
});

test('+ 在数字与文本间做拼接', () => {
  assert.equal(run(wrap('a=1\nsay(a+倍)')).stdout, '1倍\n');
  assert.equal(run(wrap('say(你好+世界)')).stdout, '你好世界\n');
});

test('未定义的裸词变量回退成文本（兼容 v0.1）', () => {
  // 没有任何赋值，hello 当作字面量文本
  assert.equal(run(wrap('say(hello)')).stdout, 'hello\n');
});

test('类型错误：文本参与 - * /（运行期）', () => {
  assert.equal(run(wrap('a=你好\nsay(a-a)')).codes[0], ModErrorCode.TypeMismatch);
  assert.equal(run(wrap('a=你好\nsay(a*2)')).codes[0], ModErrorCode.TypeMismatch);
});

test('除数为 0 报错（运行期）', () => {
  assert.equal(run(wrap('say(1/0)')).codes[0], ModErrorCode.DivisionByZero);
});

test('赋值语句形状错误', () => {
  // 裸词既不是 say/printf 也没有 `=`
  assert.equal(errorCode(wrap('foo')), ModErrorCode.UnknownStatement);
  // 赋值右侧缺表达式
  assert.equal(errorCode(wrap('a=')), ModErrorCode.ExpectedExpression);
});

test('运行失败时 stdout 为空', () => {
  const result = run('set demo public{\nclass public{\n}\n');
  assert.equal(result.ok, false);
  assert.equal(result.stdout, '');
});

test('if/else：真分支执行，假分支跳过', () => {
  assert.equal(run(wrap('a = 1\nif a == 1 {\n  say(对)\n} else {\n  say(错)\n}')).stdout, '对\n');
  assert.equal(run(wrap('a = 2\nif a == 1 {\n  say(对)\n} else {\n  say(错)\n}')).stdout, '错\n');
});

test('if 可省略 else', () => {
  assert.equal(run(wrap('a = 0\nif a == 1 {\n  say(命中)\n}\nsay(结束)')).stdout, '结束\n');
});

test('elif 链按顺序判定，首个为真者执行', () => {
  const body = 'x = 2\nif x == 1 {\n  say(一)\n} elif x == 2 {\n  say(二)\n} elif x == 3 {\n  say(三)\n} else {\n  say(其它)\n}';
  assert.equal(run(wrap(body)).stdout, '二\n');
  const body2 = 'x = 9\nif x == 1 {\n  say(一)\n} elif x == 2 {\n  say(二)\n} else {\n  say(其它)\n}';
  assert.equal(run(wrap(body2)).stdout, '其它\n');
});

test('数字按非零为真，文本按非空为真', () => {
  assert.equal(run(wrap('if 1 {\n  say(真)\n} else {\n  say(假)\n}')).stdout, '真\n');
  assert.equal(run(wrap('if 0 {\n  say(真)\n} else {\n  say(假)\n}')).stdout, '假\n');
  assert.equal(run(wrap('if 你好 {\n  say(真)\n} else {\n  say(假)\n}')).stdout, '真\n');
  assert.equal(run(wrap('if "" {\n  say(真)\n} else {\n  say(假)\n}')).stdout, '假\n');
});

test('比较运算与布尔值', () => {
  assert.equal(run(wrap('say(3 > 2)')).stdout, 'true\n');
  assert.equal(run(wrap('say(1 >= 2)')).stdout, 'false\n');
  assert.equal(run(wrap('say(3 == 3)')).stdout, 'true\n');
  assert.equal(run(wrap('say(3 != 4)')).stdout, 'true\n');
  assert.equal(run(wrap('say(!(1 == 2))')).stdout, 'true\n');
});

test('if 可嵌套', () => {
  const body = 'a = 5\nif a > 0 {\n  if a > 3 {\n    say(大)\n  } else {\n    say(小)\n  }\n} else {\n  say(负)\n}';
  assert.equal(run(wrap(body)).stdout, '大\n');
});

test('关系运算只接受数字（运行期）', () => {
  assert.equal(run(wrap('a = 你好\nsay(a < 2)')).codes[0], ModErrorCode.TypeMismatch);
  assert.equal(run(wrap('say(你好 > 世界)')).codes[0], ModErrorCode.TypeMismatch);
});

test('if 语法错误', () => {
  // 条件残缺：`if {` 直接遇到块体 → 期望表达式
  assert.equal(errorCode(wrap('if {\n  say(a)\n}')), ModErrorCode.ExpectedExpression);
  // 条件后缺 `{`
  assert.equal(errorCode(wrap('if a == 1\n  say(a)')), ModErrorCode.ExpectedIfBody);
  // 顶层出现 elif / else 不认识
  assert.equal(errorCode(wrap('elif a == 1 {\n  say(a)\n}')), ModErrorCode.UnknownStatement);
  assert.equal(errorCode(wrap('else {\n  say(a)\n}')), ModErrorCode.UnknownStatement);
});

test('cycle：重复 N 次，体内 i 为 0..N-1', () => {
  assert.equal(run(wrap('cycle(3) {\n  say(i)\n}')).stdout, '0\n1\n2\n');
});

test('cycle()：无限循环靠 break 结束', () => {
  const body = 'cycle() {\n  if i >= 3 {\n    break\n  }\n  say(i)\n}';
  assert.equal(run(wrap(body)).stdout, '0\n1\n2\n');
});

test('cycle(0)：一轮都不执行', () => {
  const body = 'cycle(0) {\n  say(不应出现)\n}\nsay(结束)';
  assert.equal(run(wrap(body)).stdout, '结束\n');
});

test('break 只跳出最内层 cycle', () => {
  const body = 'cycle(2) {\n  cycle(3) {\n    if i == 2 {\n      break\n    }\n    say(i)\n  }\n}';
  assert.equal(run(wrap(body)).stdout, '0\n1\n0\n1\n');
});

test('break 可以写在 if 分支里', () => {
  const body = 'cycle(5) {\n  if i * i > 10 {\n    break\n  }\n  say(i)\n}';
  assert.equal(run(wrap(body)).stdout, '0\n1\n2\n3\n');
});

test('cycle 次数引用变量也算数', () => {
  assert.equal(run(wrap('n = 3\ncycle(n) {\n  say(i)\n}')).stdout, '0\n1\n2\n');
});

test('cycle 次数不是数字：运行期报错', () => {
  const body = 'cycle(你好) {\n  say(x)\n}';
  assert.equal(run(wrap(body)).codes[0], ModErrorCode.CycleCountType);
});

test('cycle 次数为负：运行期报错', () => {
  const body = 'n = 0 - 1\ncycle(n) {\n  say(x)\n}';
  assert.equal(run(wrap(body)).codes[0], ModErrorCode.NegativeCycleCount);
});

test('break 写在 cycle 之外：解析期报错', () => {
  assert.equal(errorCode(wrap('break')), ModErrorCode.BreakOutsideLoop);
});

test('cycle 缺少 ( 或 { 报错', () => {
  assert.equal(errorCode(wrap('cycle 3 {\n  say(i)\n}')), ModErrorCode.ExpectedOpenParen);
  assert.equal(errorCode(wrap('cycle(3) say(i)')), ModErrorCode.ExpectedCycleBody);
});

test('#incloud gamemodmake 引入 SDK 后可在 modmain 里调用', () => {
  const body = [
    '#incloud gamemodmake',
    'modmain() {',
    '  auther = dev',
    '  game = "neno defender"',
    '  setLevel("第一关")',
    '  spawnEnemy("boss", 2)',
    '  say(完成)',
    '}',
  ].join('\n');
  const result = run(wrap(body));
  assert.equal(result.ok, true);
  assert.match(result.stdout, /\[gamemodmake\] setLevel: 第一关/);
  assert.match(result.stdout, /\[gamemodmake\] spawnEnemy: boss x2/);
  assert.match(result.stdout, /完成/);
});

test('modmain 是自动入口：定义后会被自动调用', () => {
  const body = [
    'say(顶层)',
    'modmain() {',
    '  say(入口)',
    '}',
  ].join('\n');
  assert.equal(run(wrap(body)).stdout, '顶层\n入口\n');
});

test('用户函数可被调用（语句形式）并传参', () => {
  const body = [
    'modmain() {',
    '  greet(霓虹)',
    '}',
    'greet(name) {',
    '  say(你好 + name)',
    '}',
  ].join('\n');
  const result = run(wrap(body));
  assert.equal(result.ok, true);
  assert.equal(result.stdout, '你好霓虹\n');
});

test('未 #incloud 就调用 SDK 函数会报 UnknownFunction', () => {
  const body = 'modmain() {\n  spawnEnemy("x")\n}';
  assert.equal(run(wrap(body)).codes[0], ModErrorCode.UnknownFunction);
});

test('#incloud 未知模块报 UnknownModule', () => {
  const body = '#incloud nope\nmodmain() {}';
  assert.equal(run(wrap(body)).codes[0], ModErrorCode.UnknownModule);
});

test('函数参数个数不匹配报 WrongArgumentCount', () => {
  const body = 'modmain() {\n  helper(1)\n}\nhelper(a, b) {}';
  assert.equal(run(wrap(body)).codes[0], ModErrorCode.WrongArgumentCount);
});
