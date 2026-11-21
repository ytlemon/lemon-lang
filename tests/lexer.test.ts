import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourceFile, tokenize } from '../src/index';
import { TokenKind } from '../src/lang/token';
import { captureError } from './support';

function lex(text: string) {
  return tokenize(new SourceFile('<test>', text));
}

function kinds(text: string) {
  return lex(text).map((t) => t.kind);
}

describe('词法分析器', () => {
  it('识别关键字、类型与标点', () => {
    const tokens = lex('__init__ { int a = 1 }');
    assert.deepEqual(
      tokens.map((t) => t.kind),
      [
        TokenKind.KwInit,
        TokenKind.LBrace,
        TokenKind.KwIntType,
        TokenKind.Ident,
        TokenKind.Assign,
        TokenKind.Int,
        TokenKind.RBrace,
        TokenKind.Eof,
      ],
    );
  });

  it('不发射换行 token，但行号随换行递增', () => {
    const tokens = lex('int a = 1\ndouble b = 2.5');
    assert.equal(tokens[0].span.line, 1);
    assert.equal(tokens[4].span.line, 2);
    // 换行不产生任何 token：Token 序列恰好是两条声明加 EOF
    assert.deepEqual(
      tokens.map((t) => t.kind),
      [
        TokenKind.KwIntType,
        TokenKind.Ident,
        TokenKind.Assign,
        TokenKind.Int,
        TokenKind.KwDoubleType,
        TokenKind.Ident,
        TokenKind.Assign,
        TokenKind.Double,
        TokenKind.Eof,
      ],
    );
  });

  it('区分整数与小数，并记录字面量值', () => {
    const tokens = lex('1 2.5 1e3 1.5e-2');
    assert.equal(tokens[0].kind, TokenKind.Int);
    assert.equal(tokens[0].value, 1);
    assert.equal(tokens[1].kind, TokenKind.Double);
    assert.equal(tokens[1].value, 2.5);
    assert.equal(tokens[2].kind, TokenKind.Double);
    assert.equal(tokens[2].value, 1000);
    assert.equal(tokens[3].kind, TokenKind.Double);
    assert.equal(tokens[3].value, 0.015);
  });

  it('裸文本：不加引号直接当字符串，可含全角标点', () => {
    const tokens = lex('你好，世界 123');
    assert.equal(tokens[0].kind, TokenKind.Text);
    assert.equal(tokens[0].value, '你好，世界');
    assert.equal(tokens[1].kind, TokenKind.Int);
  });

  it('Unicode 标识符合法（中文变量名）', () => {
    const tokens = lex('小明');
    assert.equal(tokens[0].kind, TokenKind.Ident);
    assert.equal(tokens[0].lexeme, '小明');
  });

  it('引号字符串支持转义', () => {
    const tokens = lex('"a\\nb\\t\\"c\\\\d\\u{4F60}"');
    assert.equal(tokens[0].kind, TokenKind.Text);
    assert.equal(tokens[0].value, 'a\nb\t"c\\d你');
  });

  it('跳过行注释、块注释与嵌套块注释', () => {
    const tokens = lex('int a = 1 // 行注释\n/* 块 /* 嵌套 */ 注释 */ double b = 2');
    assert.deepEqual(
      tokens.map((t) => t.kind),
      [TokenKind.KwIntType, TokenKind.Ident, TokenKind.Assign, TokenKind.Int, TokenKind.KwDoubleType, TokenKind.Ident, TokenKind.Assign, TokenKind.Int, TokenKind.Eof],
    );
  });

  it('全角空格与制表符都算空白', () => {
    const tokens = lex('int\u3000a\t=\t1');
    assert.deepEqual(
      tokens.map((t) => t.kind),
      [TokenKind.KwIntType, TokenKind.Ident, TokenKind.Assign, TokenKind.Int, TokenKind.Eof],
    );
  });

  it('记录精确的行列位置', () => {
    const tokens = lex('int a = 1\n    say("你好")');
    const call = tokens.find((t) => t.lexeme === 'say');
    assert.ok(call);
    assert.equal(call.span.line, 2);
    assert.equal(call.span.col, 5);
    assert.equal(call.span.endCol, 8);
  });

  /* ------------------------------ 错误场景 ------------------------------ */

  it('未支持符号给出针对性提示（E0102）', () => {
    const error = captureError(() => lex('int a = 1 % 2'));
    assert.equal(error.code, 'E0102');
    assert.match(error.message, /'%'/);
    assert.match(error.hint ?? '', /取余/);
  });

  it('四则运算符产出独立 Token（注释优先于除号）', () => {
    assert.deepEqual(
      lex('1 + 2 - 3 * 4 / 5').map((t) => t.kind),
      [
        TokenKind.Int,
        TokenKind.Plus,
        TokenKind.Int,
        TokenKind.Minus,
        TokenKind.Int,
        TokenKind.Star,
        TokenKind.Int,
        TokenKind.Slash,
        TokenKind.Int,
        TokenKind.Eof,
      ],
    );
    // '//' 与 '/*' 仍按注释处理，不会退化成两个除号
    assert.deepEqual(
      lex('1 // 注释\n2 /* 块注释 */').map((t) => t.kind),
      [TokenKind.Int, TokenKind.Int, TokenKind.Eof],
    );
  });

  it('比较与逻辑运算符：双字符优先，不会被拆成两个单字符', () => {
    assert.deepEqual(
      lex('a == b != c < d <= e > f >= g').map((t) => t.kind),
      [
        TokenKind.Ident, TokenKind.EqEq, TokenKind.Ident, TokenKind.NotEq, TokenKind.Ident,
        TokenKind.Lt, TokenKind.Ident, TokenKind.Le, TokenKind.Ident, TokenKind.Gt,
        TokenKind.Ident, TokenKind.Ge, TokenKind.Ident, TokenKind.Eof,
      ],
    );
    assert.deepEqual(
      lex('a && b || !c').map((t) => t.kind),
      [TokenKind.Ident, TokenKind.AndAnd, TokenKind.Ident, TokenKind.OrOr, TokenKind.Bang, TokenKind.Ident, TokenKind.Eof],
    );
    assert.equal(lex('>=')[0].lexeme, '>=');
    assert.equal(lex('!=')[0].lexeme, '!=');
  });

  it('单个 = 仍是赋值，与 == 区分开', () => {
    assert.deepEqual(
      lex('a = b').map((t) => t.kind),
      [TokenKind.Ident, TokenKind.Assign, TokenKind.Ident, TokenKind.Eof],
    );
  });

  it('单个 & 与 | 给出"是不是想写 && / ||"的提示（E0102）', () => {
    const amp = captureError(() => lex('a & b'));
    assert.equal(amp.code, 'E0102');
    assert.match(amp.hint ?? '', /&&/);

    const bar = captureError(() => lex('a | b'));
    assert.equal(bar.code, 'E0102');
    assert.match(bar.hint ?? '', /\|\|/);
  });

  it('if / elif / else / bool / true / false 都是关键字', () => {
    assert.deepEqual(
      lex('if elif else bool true false').map((t) => t.kind),
      [
        TokenKind.KwIf,
        TokenKind.KwElif,
        TokenKind.KwElse,
        TokenKind.KwBoolType,
        TokenKind.KwTrue,
        TokenKind.KwFalse,
        TokenKind.Eof,
      ],
    );
  });

  it('cycle / break 是关键字；while / for / return / continue 已预留', () => {
    assert.deepEqual(
      lex('cycle break').map((t) => t.kind),
      [TokenKind.KwCycle, TokenKind.KwBreak, TokenKind.Eof],
    );
    assert.deepEqual(
      lex('while for return continue').map((t) => t.kind),
      [TokenKind.KwWhile, TokenKind.KwFor, TokenKind.KwReturn, TokenKind.KwContinue, TokenKind.Eof],
    );
  });

  it('全角括号与分号给出"改用半角"的提示（E0102）', () => {
    const paren = captureError(() => lex('cycle（）{ }'));
    assert.equal(paren.code, 'E0102');
    assert.match(paren.message, /全角/);
    assert.match(paren.hint ?? '', /半角/);
    // 报错位置精确指向那个全角字符本身（cycle 之后的第 6 列）
    assert.equal(paren.span.col, 6);
    assert.equal(paren.span.endCol, 7);

    assert.match(captureError(() => lex('say（你好）')).hint ?? '', /半角/);
    assert.equal(captureError(() => lex('a；b')).code, 'E0102');
    assert.equal(captureError(() => lex('if a ｛')).code, 'E0102');
  });

  it('时间单位后缀：换算成秒的 double', () => {
    const cases: Array<[string, number, string]> = [
      ['1min', 60, 'min'],
      ['500ms', 0.5, 'ms'],
      ['2s', 2, 's'],
      ['1.5h', 5400, 'h'],
      ['1Min', 60, 'min'],
      ['1S', 1, 's'],
    ];
    for (const [text, seconds, unit] of cases) {
      const token = lex(text)[0];
      assert.equal(token.kind, TokenKind.Double, text);
      assert.equal(token.value, seconds, text);
      assert.equal(token.durationUnit, unit, text);
      // 源码原文完整保留，便于报错与 ast 展示
      assert.equal(token.lexeme, text, text);
    }
    assert.equal(lex('250MS')[0].durationUnit, 'ms');
  });

  it('单位后面还跟字符时不算单位，仍按"数字后跟字符"报错', () => {
    assert.equal(captureError(() => lex('1min2')).code, 'E0103');
    assert.equal(captureError(() => lex('1m')).code, 'E0103');
    assert.equal(captureError(() => lex('1元')).code, 'E0103');
  });

  it('不是单位的裸词照旧当文本（1元 之外的常见写法）', () => {
    // 只有贴着数字的才是单位；单独出现的 s / min 仍是标识符
    assert.equal(lex('s')[0].kind, TokenKind.Ident);
    assert.equal(lex('min')[0].kind, TokenKind.Ident);
    assert.equal(lex('1 + s')[2].kind, TokenKind.Ident);
  });

  it('全角逗号与冒号不受影响——它们仍是裸文本的内容', () => {
    const tokens = lex('你好，世界：尾');
    assert.equal(tokens[0].kind, TokenKind.Text);
    assert.equal(tokens[0].value, '你好，世界：尾');
  });

  it('try / catch 是关键字，点号是成员访问', () => {
    assert.deepEqual(
      lex('try catch').map((t) => t.kind),
      [TokenKind.KwTry, TokenKind.KwCatch, TokenKind.Eof],
    );
    assert.deepEqual(
      lex('a.b').map((t) => t.kind),
      [TokenKind.Ident, TokenKind.Dot, TokenKind.Ident, TokenKind.Eof],
    );
    // 小数点仍然属于数字，独立的 . 才是成员访问
    assert.equal(lex('1.5')[0].kind, TokenKind.Double);
    assert.equal(lex('1 .5')[1].kind, TokenKind.Dot);
    assert.equal(lex('错误.code')[1].kind, TokenKind.Dot);
  });

  it('** 是一个 Token，单个 * 仍然可用', () => {
    assert.deepEqual(
      lex('2 ** 3 * 4').map((t) => t.kind),
      [TokenKind.Int, TokenKind.StarStar, TokenKind.Int, TokenKind.Star, TokenKind.Int, TokenKind.Eof],
    );
    assert.equal(lex('**')[0].lexeme, '**');
  });

  it('运算符把连写的中文切开，两侧各自成词', () => {
    // 光看词法，你好 / 世界 都是合法标识符；
    // 它们究竟是变量还是裸文本由静态检查决定（见 checker 测试）
    const tokens = lex('你好+世界');
    assert.deepEqual(
      tokens.map((t) => t.kind),
      [TokenKind.Ident, TokenKind.Plus, TokenKind.Ident, TokenKind.Eof],
    );
    assert.equal(tokens[0].lexeme, '你好');
    assert.equal(tokens[2].lexeme, '世界');

    // 含全角标点时无法构成标识符，直接判定为文本
    assert.equal(lex('你好，世界')[0].kind, TokenKind.Text);
  });

  it('字符串未闭合（E0104）', () => {
    const error = captureError(() => lex('say("你好)'));
    assert.equal(error.code, 'E0104');
  });

  it('块注释未闭合（E0106）', () => {
    const error = captureError(() => lex('/* 没关'));
    assert.equal(error.code, 'E0106');
  });

  it('非法数字（E0103）', () => {
    assert.equal(captureError(() => lex('1.')).code, 'E0103');
    assert.equal(captureError(() => lex('1元')).code, 'E0103');
  });

  it('整数超出安全范围（E0103）', () => {
    const error = captureError(() => lex('99999999999999999999'));
    assert.equal(error.code, 'E0103');
    assert.match(error.message, /安全范围/);
  });

  it('非法转义（E0105）', () => {
    assert.equal(captureError(() => lex('"a\\qb"')).code, 'E0105');
    assert.equal(captureError(() => lex('"\\u4F60"')).code, 'E0105');
  });

  /* ------------------------------ 源码归一化 ------------------------------ */

  it('自动剥离 UTF-8 BOM，且列号不受影响', () => {
    const withBom = lex('\uFEFFint a = 1');
    assert.deepEqual(
      withBom.map((t) => t.kind),
      [TokenKind.KwIntType, TokenKind.Ident, TokenKind.Assign, TokenKind.Int, TokenKind.Eof],
    );
    // 剥离 BOM 后 a 仍位于第 5 列
    assert.equal(withBom[1].span.col, 5);
  });

  it('CRLF 与 LF 的行号一致', () => {
    const crlf = lex('int a = 1\r\nsay(a)');
    const lf = lex('int a = 1\nsay(a)');
    assert.deepEqual(
      crlf.map((t) => `${t.span.line}:${t.span.col}`),
      lf.map((t) => `${t.span.line}:${t.span.col}`),
    );
  });
});

describe('#incloud 指令的词法', () => {
  it('占一行时产出 Directive 单元，参数是去掉引号与注释后的文本', () => {
    assert.deepEqual(kinds('#incloud web'), [TokenKind.Directive, TokenKind.Eof]);

    const bare = lex('#incloud 工具').find((t) => t.kind === TokenKind.Directive);
    assert.equal(bare?.value, '工具');

    const quoted = lex('#incloud "lib/工具.lemon1"').find((t) => t.kind === TokenKind.Directive);
    assert.equal(quoted?.value, 'lib/工具.lemon1');

    const commented = lex('#incloud 工具 // 引入工具').find((t) => t.kind === TokenKind.Directive);
    assert.equal(commented?.value, '工具');
  });

  it('指令单元覆盖整行，argSpan 只覆盖参数', () => {
    const token = lex('#incloud web').find((t) => t.kind === TokenKind.Directive);
    assert.equal(token?.span.line, 1);
    assert.equal(token?.span.col, 1);
    assert.equal(token?.span.endCol, 13);
    assert.equal(token?.argSpan?.col, 10);
    assert.equal(token?.argSpan?.endCol, 13);
  });

  it('前面只允许空白；行内出现报 E0107', () => {
    const indented = lex('    #incloud web');
    assert.equal(indented[0].kind, TokenKind.Directive);

    const inline = captureError(() => lex('say(1) #incloud web'));
    assert.equal(inline.code, 'E0107');
    assert.match(inline.message, /必须独占一行/);
    assert.match(inline.hint ?? '', /行内注释请用 \/\//);
  });

  it('拼错指令名：E0107 且点名正确写法', () => {
    const include = captureError(() => lex('#include web'));
    assert.equal(include.code, 'E0107');
    assert.match(include.hint ?? '', /#incloud（不是 #include）/);

    const other = captureError(() => lex('#define X'));
    assert.equal(other.code, 'E0107');
    assert.match(other.message, /不认识 '#define'/);

    const bare = captureError(() => lex('#'));
    assert.equal(bare.code, 'E0107');
    assert.match(bare.message, /不认识 '#'/);
  });

  it('参数为空：E0107', () => {
    for (const text of ['#incloud', '#incloud   ', '#incloud // 先留着']) {
      const error = captureError(() => lex(text));
      assert.equal(error.code, 'E0107', text);
      assert.match(error.message, /要写引入的目标/);
    }
  });

  it('字符串与块注释里的 #incloud 不产生指令单元', () => {
    assert.deepEqual(
      kinds('say("#incloud web")').filter((k) => k === TokenKind.Directive),
      [],
    );
    assert.deepEqual(
      kinds('/*\n#incloud web\n*/').filter((k) => k === TokenKind.Directive),
      [],
    );
  });

  it('参数里没有空白隔开的 // 不算注释（路径可以含 //）', () => {
    const token = lex('#incloud lib//工具.lemon1').find((t) => t.kind === TokenKind.Directive);
    assert.equal(token?.value, 'lib//工具.lemon1');
  });
});
