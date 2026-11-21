/**
 * lemonmod（.lemon2）语法分析。
 *
 * 文法（v0.2）：
 *   file      := 'set' NAME 'public' '{' class '}' EOF
 *   class     := 'class' 'public' '{' statement* '}'
 *   statement := assignment | call | if | cycle | break | incloud | def | return
 *   assignment:= NAME '=' expr
 *   call      := ('say' | 'printf' | NAME) '(' args ')'        // 语句级调用
 *   def       := 'def' NAME '(' params ')' '{' statement* '}'  // 也兼容裸 NAME '(' params ')' '{' ... '}'
 *   return    := 'return' expr?                                // 只能写在函数体里
 *   expr      := comparison
 *   comparison:= additive (('=='|'!='|'<'|'<='|'>'|'>=') additive)*
 *   additive  := multiplicative (('+' | '-') multiplicative)*
 *   mult      := unary (('*' | '/') unary)*
 *   unary     := ('+' | '-' | '!') unary | primary
 *   primary   := NUMBER | STRING | NAME | '(' expr ')'
 *              | NAME '(' args ')'                              // 表达式里的函数调用，拿到 return 的值
 *
 * 换行与分号都算语句分隔符，可以任意混用。
 * 变量是动态类型：NAME 在赋值左侧是变量名，在表达式里是变量引用。
 */
import type { AssignStatement, BreakStatement, CallStatement, CycleStatement, Expr, FunctionDef, IfStatement, IncloudStatement, ModBuildManifest, ModFile, ModProgram, ReturnStatement, Statement, WaitForBuildStatement } from './ast';
import { ModError, ModErrorCode, type SourceSpan } from './errors';
import { tokenize } from './lexer';
import type { Token, TokenKind } from './token';
import { tokenSpan } from './token';

/** v0.2 支持的两个输出函数：二者等价 */
export const OUTPUT_FUNCTIONS = ['say', 'printf'] as const;

export function parseModFile(text: string): ModProgram {
  return new Parser(tokenize(text)).parseFile();
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;
  /** 当前所处的 cycle 嵌套层数；仅用于让 break 必须写在 cycle 体内 */
  private loopDepth = 0;
  /** 当前所处的函数嵌套层数；仅用于让 return 必须写在函数体内 */
  private functionDepth = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseFile(): ModProgram {
    this.skipSeparators();
    const first = this.peek();
    // .mod1 构建清单：`class mod to build { ... }`（bulid 作为 build 的宽容别名）
    if (first.kind === 'word' && first.value === 'class') {
      const t1 = this.tokens[this.index + 1];
      const t2 = this.tokens[this.index + 2];
      const t3 = this.tokens[this.index + 3];
      if (
        t1?.kind === 'word' && t1.value === 'mod' &&
        t2?.kind === 'word' && t2.value === 'to' &&
        t3?.kind === 'word' && (t3.value === 'build' || t3.value === 'bulid')
      ) {
        return this.parseBuildManifest();
      }
    }

    const setToken = this.expectWordValue('set', ModErrorCode.ExpectedSet,
      '文件必须以 `set <文件名> public{` 开头（.mod1 构建清单则以 `class mod to build {` 开头）');

    const name = this.expectWord(ModErrorCode.ExpectedFileName, '`set` 后面要写文件名');
    this.expectWordValue('public', ModErrorCode.ExpectedPublic, '文件名后面必须写 `public`');
    this.expectKind('lbrace', ModErrorCode.ExpectedFileBody, '文件声明后面必须写 `{`');

    const start = tokenSpan(setToken);
    const statements = this.parseClassBody();
    // 初始化块的 `}` 后面可能换行，再轮到文件声明的 `}`
    this.skipSeparators();
    const end = this.expectKind('rbrace', ModErrorCode.ExpectedCloseBrace,
      '文件声明缺少收尾的 `}`');

    this.skipSeparators();
    const eof = this.peek();
    if (eof.kind !== 'eof') {
      throw new ModError(
        ModErrorCode.UnexpectedTrailing,
        '文件声明已经结束了，后面还有多余内容（v0.2 一个文件只能有一个文件声明）',
        tokenSpan(eof),
      );
    }

    return {
      kind: 'modFile',
      name: name.value,
      nameSpan: tokenSpan(name),
      statements,
      span: { line: start.line, col: start.col, endLine: end.endLine, endCol: end.endCol },
    };
  }

  /**
   * 解析 .mod1 构建清单：`class mod to build { mod file() {…} build { become "…" } wait for build() … }`。
   * 体内除两条声明外，其余语句（if / say / 赋值 / 调用等）按通用语句解析。
   */
  private parseBuildManifest(): ModBuildManifest {
    const start = tokenSpan(this.expectWordValue('class', ModErrorCode.ExpectedSet,
      '构建清单必须以 `class mod to build {` 开头'));
    this.expectWordValue('mod', ModErrorCode.ExpectedSet, '`class` 后面必须是 `mod`');
    this.expectWordValue('to', ModErrorCode.ExpectedSet, '`mod` 后面必须是 `to`');
    const buildKw = this.expectWord(ModErrorCode.ExpectedSet,
      '`to` 后面必须是 `build`（也接受 `bulid`）');
    if (buildKw.value !== 'build' && buildKw.value !== 'bulid') {
      throw new ModError(ModErrorCode.ExpectedSet,
        '`to` 后面必须是 `build`（也接受 `bulid`）', tokenSpan(buildKw));
    }
    this.expectKind('lbrace', ModErrorCode.ExpectedFileBody, '`class mod to build` 后面必须写 `{`');

    let source: Expr | null = null;
    let output: Expr | null = null;
    const body: Statement[] = [];

    this.skipSeparators();
    while (this.peek().kind !== 'rbrace' && this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'word' && tok.value === 'mod') {
        source = this.parseModFileDecl();
      } else if (tok.kind === 'word' && (tok.value === 'build' || tok.value === 'bulid')) {
        output = this.parseBuildOutput(tok);
      } else if (tok.kind === 'word' && tok.value === 'wait') {
        this.index += 1; // 消耗 wait
        body.push(this.parseWaitForBuild(tok));
      } else {
        body.push(this.parseStatement());
      }
      const next = this.peek();
      if (next.kind !== 'newline' && next.kind !== 'semicolon' && next.kind !== 'rbrace' && next.kind !== 'eof') {
        throw new ModError(
          ModErrorCode.ExpectedStatementEnd,
          `语句之间需要换行或分号，实际读到 ${describe(next)}`,
          tokenSpan(next),
        );
      }
      this.skipSeparators();
    }
    const end = this.expectKind('rbrace', ModErrorCode.ExpectedCloseBrace, '构建清单缺少收尾的 `}`');

    this.skipSeparators();
    const eof = this.peek();
    if (eof.kind !== 'eof') {
      throw new ModError(
        ModErrorCode.UnexpectedTrailing,
        '构建清单已经结束了，后面还有多余内容',
        tokenSpan(eof),
      );
    }

    if (source === null) {
      throw new ModError(ModErrorCode.ExpectedSet,
        '构建清单缺少 `mod file() { <源文件名> }` 声明', start);
    }
    if (output === null) {
      throw new ModError(ModErrorCode.ExpectedSet,
        '构建清单缺少 `build { become <产物名> }` 声明', start);
    }

    return {
      kind: 'modBuild',
      source,
      output,
      body,
      span: { line: start.line, col: start.col, endLine: end.endLine, endCol: end.endCol },
    };
  }

  /** `mod file() { <表达式> }`：给出要打包的 mod 源文件名 */
  private parseModFileDecl(): Expr {
    this.expectWordValue('mod', ModErrorCode.ExpectedSet, '这里要写 `mod file() { ... }`');
    this.expectWordValue('file', ModErrorCode.ExpectedSet, '`mod` 后面必须是 `file`');
    this.expectKind('lparen', ModErrorCode.ExpectedOpenParen, '`file` 后面必须写 `(`');
    this.expectKind('rparen', ModErrorCode.ExpectedCloseParen, '`file` 的参数列表缺少 `)`');
    this.expectKind('lbrace', ModErrorCode.ExpectedSet, '`mod file()` 后面必须写 `{`');
    this.skipSeparators();
    const expr = this.parseExpr();
    this.skipSeparators();
    this.expectKind('rbrace', ModErrorCode.ExpectedSet, '`mod file()` 的 `{` 缺少配对的 `}`');
    return expr;
  }

  /** `build { become <表达式> }` / `bulid { become <表达式> }`：给出产物文件名 */
  private parseBuildOutput(tok: Token): Expr {
    this.index += 1; // 消耗 build / bulid
    this.expectKind('lbrace', ModErrorCode.ExpectedSet, '`build` 后面必须写 `{`');
    this.skipSeparators();
    this.expectWordValue('become', ModErrorCode.ExpectedSet, '`build {` 里面必须是 `become <产物名>`');
    this.skipSeparators();
    const expr = this.parseExpr();
    this.skipSeparators();
    this.expectKind('rbrace', ModErrorCode.ExpectedSet, '`build { become ... }` 缺少收尾的 `}`');
    return expr;
  }

  /** `wait for build()`：把这条语句记为 WaitForBuild；运行期触发真正的打包 */
  private parseWaitForBuild(head: Token): WaitForBuildStatement {
    this.expectWordValue('for', ModErrorCode.ExpectedSet, '`wait` 后面必须是 `for`');
    const buildKw = this.expectWord(ModErrorCode.ExpectedSet, '`wait for` 后面必须是 `build`');
    if (buildKw.value !== 'build' && buildKw.value !== 'bulid') {
      throw new ModError(ModErrorCode.ExpectedSet, '`wait for` 后面必须是 `build`', tokenSpan(buildKw));
    }
    this.expectKind('lparen', ModErrorCode.ExpectedOpenParen, '`build` 后面必须写 `(`');
    this.expectKind('rparen', ModErrorCode.ExpectedCloseParen, '`build()` 缺少配对的 `)`');
    return { kind: 'WaitForBuild', span: { line: head.line, col: head.col, endLine: head.line, endCol: head.col + 4 } };
  }

  /** `class public{ ... }` —— 注释里说的「初始化」块 */
  private parseClassBody(): Statement[] {
    this.skipSeparators();
    this.expectWordValue('class', ModErrorCode.ExpectedClass,
      '文件声明里必须写 `class public{`（缺了它就没有初始化块）');
    this.expectWordValue('public', ModErrorCode.ExpectedClassPublic, '`class` 后面必须写 `public`');
    this.expectKind('lbrace', ModErrorCode.ExpectedClassBody, '`class public` 后面必须写 `{`');

    const statements: Statement[] = [];
    this.skipSeparators();
    while (this.peek().kind !== 'rbrace' && this.peek().kind !== 'eof') {
      statements.push(this.parseStatement());
      const next = this.peek();
      if (next.kind !== 'newline' && next.kind !== 'semicolon' && next.kind !== 'rbrace' && next.kind !== 'eof') {
        throw new ModError(
          ModErrorCode.ExpectedStatementEnd,
          `语句之间需要换行或分号，实际读到 ${describe(next)}`,
          tokenSpan(next),
        );
      }
      this.skipSeparators();
    }
    this.expectKind('rbrace', ModErrorCode.ExpectedCloseBrace, '初始化块缺少收尾的 `}`');
    return statements;
  }

  private parseStatement(): Statement {
    const tok = this.peek();
    // #incloud 指令：模块名作为下一条 word
    if (tok.kind === 'incloud') {
      return this.parseIncloud(tok);
    }

    const head = this.expectWord(
      ModErrorCode.UnknownStatement,
      '这里要写一条语句，比如 `say(hello)`、`a = 1`、`def foo() { ... }`、`return 1`、`if 条件 { ... }`、`modmain() { ... }`、`wait for build()` 或 `#incloud 模块`',
    );

    // 触发构建：wait for build()
    if (head.value === 'wait') {
      return this.parseWaitForBuild(head);
    }

    // 函数定义：def NAME(params) { ... }
    if (head.value === 'def') {
      return this.parseDef(head);
    }

    // 从函数返回：return [expr]
    if (head.value === 'return') {
      return this.parseReturn(head);
    }

    // 条件分支：if / elif / else（elif / else 只能在 if 之后，这里只认 if）
    if (head.value === 'if') {
      return this.parseIf(head);
    }

    // 循环：cycle(N) / cycle()
    if (head.value === 'cycle') {
      return this.parseCycle(head);
    }

    // 跳出循环：break（只能写在 cycle 体内，由 loopDepth 保证）
    if (head.value === 'break') {
      return this.parseBreak(head);
    }

    // 输出语句：say / printf
    if ((OUTPUT_FUNCTIONS as readonly string[]).includes(head.value)) {
      return this.parseCall(head);
    }

    // 赋值语句：NAME '=' expr
    if (this.peek().kind === 'assign') {
      this.index += 1;
      const value = this.parseExpr();
      const end = tokenSpanOf(value);
      const assign: AssignStatement = {
        kind: 'Assign',
        name: head.value,
        value,
        span: { line: head.line, col: head.col, endLine: end.endLine, endCol: end.endCol },
      };
      return assign;
    }

    // NAME '(' ... ')' '{'  → 函数定义；NAME '(' ... ')'  → 函数调用
    if (this.peek().kind === 'lparen') {
      return this.parseCallableOrDef(head);
    }

    // 既不是条件也不是循环也不是输出也不是赋值也不是函数：当作未知语句
    throw new ModError(
      ModErrorCode.UnknownStatement,
      `不认识的语句 \`${head.value}\`（v0.3 支持 ${OUTPUT_FUNCTIONS.join(' / ')}、变量赋值、if/else、cycle/break、#incloud 与函数定义 modmain() { ... }）`,
      tokenSpan(head),
    );
  }

  /** `#incloud 模块名` —— 引入一个内置 SDK 模块（如 gamemodmake） */
  private parseIncloud(tok: Token): IncloudStatement {
    this.index += 1; // 消耗 #incloud 自身
    const name = this.expectWord(
      ModErrorCode.ExpectedIncloudModule,
      '`#incloud` 后面要写模块名（如 `#incloud gamemodmake`）',
    );
    return {
      kind: 'Incloud',
      module: name.value,
      span: { line: tok.line, col: tok.col, endLine: name.endLine, endCol: name.endCol },
    };
  }

  /** `def NAME(params) { 语句* }` —— 定义函数（与裸 `NAME(params){...}` 等价） */
  private parseDef(defToken: Token): FunctionDef {
    const name = this.expectWord(
      ModErrorCode.ExpectedFunctionName,
      '`def` 后面要写函数名（如 `def add(a, b) { ... }`）',
    );
    return this.parseFunctionDef(name);
  }

  /** `return [expr]` —— 从函数返回；只能写在函数体里（由 functionDepth 保证） */
  private parseReturn(head: Token): ReturnStatement {
    if (this.functionDepth === 0) {
      throw new ModError(
        ModErrorCode.ReturnOutsideFunction,
        'return 只能写在函数体里',
        tokenSpan(head),
      );
    }
    const next = this.peek();
    let value: Expr | null = null;
    if (
      next.kind !== 'newline' &&
      next.kind !== 'semicolon' &&
      next.kind !== 'rbrace' &&
      next.kind !== 'eof'
    ) {
      value = this.parseExpr();
    }
    const end = value !== null ? tokenSpanOf(value) : tokenSpan(head);
    return {
      kind: 'Return',
      value,
      span: { line: head.line, col: head.col, endLine: end.endLine, endCol: end.endCol },
    };
  }

  /**
   * NAME '(' ... ')' '{' 是函数定义；NAME '(' ... ')' 是函数调用。
   * 用成对的 `)` 之后（跳过换行/分号）那个 token 是不是 `{` 来消歧。
   * 这里只做前瞻，不消耗 `(`，真正的 `(` 由 parseFunctionDef / parseCall 自己吃。
   */
  private parseCallableOrDef(head: Token): Statement {
    // peek 就是 `(`（parseStatement 已确认），从它开始配对
    let depth = 0;
    let j = this.index;
    while (j < this.tokens.length) {
      const tk = this.tokens[j]!;
      if (tk.kind === 'lparen') depth += 1;
      else if (tk.kind === 'rparen') {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    let k = j + 1;
    while (k < this.tokens.length) {
      const tk = this.tokens[k]!;
      if (tk.kind === 'newline' || tk.kind === 'semicolon') {
        k += 1;
        continue;
      }
      break;
    }
    const after = this.tokens[k];
    if (after !== undefined && after.kind === 'lbrace') {
      return this.parseFunctionDef(head);
    }
    return this.parseCall(head);
  }

  /** `name(p1, p2, ...) { 语句* }` —— 定义一个函数（不立即执行） */
  private parseFunctionDef(head: Token): FunctionDef {
    this.expectKind('lparen', ModErrorCode.ExpectedOpenParen, '函数名后面必须写 `(`');
    const params: string[] = [];
    this.skipSeparators();
    if (this.peek().kind !== 'rparen') {
      while (true) {
        const p = this.expectWord(
          ModErrorCode.ExpectedParamName,
          '函数参数名必须是裸词（如 `modmain()` 或 `foo(a, b)`）',
        );
        params.push(p.value);
        const next = this.peek();
        if (next.kind === 'comma') {
          this.index += 1;
          this.skipSeparators();
          continue;
        }
        break;
      }
    }
    this.expectKind('rparen', ModErrorCode.ExpectedCloseParen, '参数列表缺少配对的 `)`');
    this.skipSeparators();
    this.expectKind('lbrace', ModErrorCode.ExpectedFunctionBody,
      '函数定义后面必须写 `{` 包住函数体');
    this.functionDepth += 1;
    const block = this.parseBlock();
    this.functionDepth -= 1;
    const end = tokenSpan(block.close);
    return {
      kind: 'FunctionDef',
      name: head.value,
      params,
      body: block.body,
      span: { line: head.line, col: head.col, endLine: end.endLine, endCol: end.endCol },
    };
  }

  /** `if 条件 { ... } [elif 条件 { ... }]* [else { ... }]` */
  private parseIf(head: Token): IfStatement {
    const condition = this.parseExpr();
    this.expectKind('lbrace', ModErrorCode.ExpectedIfBody, '`if` 条件后必须写 `{`');
    const thenBlock = this.parseBlock();
    let endSpan = tokenSpan(thenBlock.close);
    const elifBodies: { condition: Expr; body: Statement[] }[] = [];
    let elseBody: Statement[] | null = null;

    while (true) {
      const next = this.peek();
      if (next.kind === 'word' && next.value === 'elif') {
        this.index += 1;
        const cond = this.parseExpr();
        this.expectKind('lbrace', ModErrorCode.ExpectedElifBody, '`elif` 条件后必须写 `{`');
        const block = this.parseBlock();
        elifBodies.push({ condition: cond, body: block.body });
        endSpan = tokenSpan(block.close);
        continue;
      }
      if (next.kind === 'word' && next.value === 'else') {
        this.index += 1;
        this.expectKind('lbrace', ModErrorCode.ExpectedElseBody, '`else` 后面必须写 `{`');
        const block = this.parseBlock();
        elseBody = block.body;
        endSpan = tokenSpan(block.close);
        break;
      }
      break;
    }

    return {
      kind: 'If',
      condition,
      thenBody: thenBlock.body,
      elifBodies,
      elseBody,
      span: { line: head.line, col: head.col, endLine: endSpan.endLine, endCol: endSpan.endCol },
    };
  }

  /** `cycle(N) { ... }` 重复 N 次；`cycle() { ... }` 无限循环，靠 break 结束 */
  private parseCycle(head: Token): CycleStatement {
    this.expectKind('lparen', ModErrorCode.ExpectedOpenParen,
      '`cycle` 后面必须写 `(`（cycle(N) 重复 N 次，cycle() 无限循环）');
    let count: Expr | null = null;
    if (this.peek().kind !== 'rparen') count = this.parseExpr();
    const close = this.expectKind('rparen', ModErrorCode.ExpectedCloseParen,
      '`cycle` 的次数缺少配对的 `)`');
    const headerSpan: SourceSpan = spanOf(tokenSpan(head), tokenSpan(close));
    this.expectKind('lbrace', ModErrorCode.ExpectedCycleBody,
      '`cycle` 的次数后必须写 `{` 包住循环体');
    this.loopDepth += 1;
    const block = this.parseBlock();
    this.loopDepth -= 1;
    return {
      kind: 'Cycle',
      count,
      body: block.body,
      headerSpan,
      span: spanOf(tokenSpan(head), tokenSpan(block.close)),
    };
  }

  /** break：跳出最内层的 cycle。放在循环外属于结构错误 */
  private parseBreak(head: Token): BreakStatement {
    if (this.loopDepth === 0) {
      throw new ModError(
        ModErrorCode.BreakOutsideLoop,
        'break 只能写在 cycle 循环体里',
        tokenSpan(head),
      );
    }
    return { kind: 'Break', span: tokenSpan(head) };
  }

  /** 解析一个 `{ ... }` 语句块，返回语句列表与收尾的 `}` token */
  private parseBlock(): { body: Statement[]; close: Token } {
    const body: Statement[] = [];
    this.skipSeparators();
    while (this.peek().kind !== 'rbrace' && this.peek().kind !== 'eof') {
      body.push(this.parseStatement());
      const next = this.peek();
      if (next.kind !== 'newline' && next.kind !== 'semicolon' && next.kind !== 'rbrace' && next.kind !== 'eof') {
        throw new ModError(
          ModErrorCode.ExpectedStatementEnd,
          `语句之间需要换行或分号，实际读到 ${describe(next)}`,
          tokenSpan(next),
        );
      }
      this.skipSeparators();
    }
    const close = this.expectKind('rbrace', ModErrorCode.ExpectedBlockClose, '块缺少收尾的 `}`');
    return { body, close };
  }

  private parseCall(head: Token): CallStatement {
    this.expectKind('lparen', ModErrorCode.ExpectedOpenParen, `\`${head.value}\` 后面必须写 \`(\``);
    const args: Expr[] = [];
    this.skipSeparators();
    if (this.peek().kind !== 'rparen') {
      while (true) {
        args.push(this.parseExpr());
        const next = this.peek();
        if (next.kind === 'comma') {
          this.index += 1;
          this.skipSeparators();
          continue;
        }
        break;
      }
    }
    const close = this.expectKind('rparen', ModErrorCode.ExpectedCloseParen,
      `参数后面必须写 \`)\``);

    // say / printf 在 v0.3 仍只接受 1 个参数
    if ((OUTPUT_FUNCTIONS as readonly string[]).includes(head.value)) {
      if (args.length === 0) {
        throw new ModError(
          ModErrorCode.ExpectedArgument,
          `\`${head.value}\` 需要 1 个参数：数字、变量、字符串或裸文本（如 ${head.value}(hello)）`,
          tokenSpan(head),
        );
      }
      if (args.length > 1) {
        throw new ModError(
          ModErrorCode.TooManyArguments,
          `\`${head.value}\` 在 v0.3 只支持 1 个参数`,
          tokenSpan(close),
        );
      }
    }

    return {
      kind: 'Call',
      callee: head.value,
      args,
      span: {
        line: head.line,
        col: head.col,
        endLine: close.endLine,
        endCol: close.endCol,
      },
    };
  }

  // ---- 表达式 ----

  private parseExpr(): Expr {
    return this.parseComparison();
  }

  /** 比较运算（优先级最低）：== != < <= > >= */
  private parseComparison(): Expr {
    let left = this.parseAdditive();
    while (true) {
      const tok = this.peek();
      let op: '==' | '!=' | '<' | '<=' | '>' | '>=' | null = null;
      if (tok.kind === 'eqeq') op = '==';
      else if (tok.kind === 'noteq') op = '!=';
      else if (tok.kind === 'lt') op = '<';
      else if (tok.kind === 'lte') op = '<=';
      else if (tok.kind === 'gt') op = '>';
      else if (tok.kind === 'gte') op = '>=';
      if (op === null) break;
      const start = tokenSpanOf(left);
      this.index += 1;
      const right = this.parseAdditive();
      const end = tokenSpanOf(right);
      left = { kind: 'Compare', op, left, right, span: spanOf(start, end) };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.peek().kind === 'plus' || this.peek().kind === 'minus') {
      const op = this.peek().kind === 'plus' ? '+' : '-';
      const start = tokenSpanOf(left);
      this.index += 1;
      const right = this.parseMultiplicative();
      const end = tokenSpanOf(right);
      left = { kind: 'Binary', op, left, right, span: spanOf(start, end) };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.peek().kind === 'star' || this.peek().kind === 'slash') {
      const op = this.peek().kind === 'star' ? '*' : '/';
      const start = tokenSpanOf(left);
      this.index += 1;
      const right = this.parseUnary();
      const end = tokenSpanOf(right);
      left = { kind: 'Binary', op, left, right, span: spanOf(start, end) };
    }
    return left;
  }

  private parseUnary(): Expr {
    const tok = this.peek();
    if (tok.kind === 'plus' || tok.kind === 'minus') {
      const op = tok.kind === 'plus' ? '+' : '-';
      const start = tokenSpan(tok);
      this.index += 1;
      const operand = this.parseUnary();
      const end = tokenSpanOf(operand);
      return { kind: 'Unary', op, operand, span: spanOf(start, end) };
    }
    if (tok.kind === 'not') {
      const start = tokenSpan(tok);
      this.index += 1;
      const operand = this.parseUnary();
      const end = tokenSpanOf(operand);
      return { kind: 'Not', operand, span: spanOf(start, end) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    if (tok.kind === 'number') {
      this.index += 1;
      return { kind: 'Number', value: Number(tok.value), span: tokenSpan(tok) };
    }
    if (tok.kind === 'string') {
      this.index += 1;
      return { kind: 'String', value: tok.value, span: tokenSpan(tok) };
    }
    if (tok.kind === 'bool') {
      this.index += 1;
      return { kind: 'Bool', value: tok.value === 'true', span: tokenSpan(tok) };
    }
    if (tok.kind === 'word') {
      const name = tok.value;
      this.index += 1;
      // 裸词后面紧跟 `(` → 当作表达式里的函数调用（拿到 return 的值）
      if (this.peek().kind === 'lparen') {
        this.index += 1;
        const args: Expr[] = [];
        this.skipSeparators();
        if (this.peek().kind !== 'rparen') {
          while (true) {
            args.push(this.parseExpr());
            const next = this.peek();
            if (next.kind === 'comma') {
              this.index += 1;
              this.skipSeparators();
              continue;
            }
            break;
          }
        }
        const close = this.expectKind('rparen', ModErrorCode.ExpectedCloseParen,
          '函数调用缺少配对的 `)`');
        return {
          kind: 'CallExpr',
          callee: name,
          args,
          span: spanOf(tokenSpan(tok), tokenSpan(close)),
        };
      }
      return { kind: 'Variable', name, span: tokenSpan(tok) };
    }
    if (tok.kind === 'lparen') {
      const start = tokenSpan(tok);
      this.index += 1;
      const inner = this.parseExpr();
      const close = this.expectKind('rparen', ModErrorCode.ExpectedCloseParen,
        '括号没有闭合，缺少收尾的 `)`');
      return { ...inner, span: spanOf(start, tokenSpan(close)) };
    }
    throw new ModError(
      ModErrorCode.ExpectedExpression,
      `这里需要一个值（数字、变量、字符串或 (...)），实际读到 ${describe(tok)}`,
      tokenSpan(tok),
    );
  }

  /** 换行与分号都可以断句；连续多个也照收 */
  private skipSeparators(): void {
    while (this.peek().kind === 'newline' || this.peek().kind === 'semicolon') this.index += 1;
  }

  private peek(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) {
      return this.tokens[this.tokens.length - 1]!;
    }
    return token;
  }

  private expectKind(kind: TokenKind, code: string, message: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new ModError(code, `${message}，实际读到 ${describe(token)}`, tokenSpan(token));
    }
    this.index += 1;
    return token;
  }

  private expectWord(code: string, message: string): Token {
    const token = this.peek();
    if (token.kind !== 'word') {
      throw new ModError(code, `${message}，实际读到 ${describe(token)}`, tokenSpan(token));
    }
    this.index += 1;
    return token;
  }

  /** 要求下一个裸词正好是指定关键字 */
  private expectWordValue(value: string, code: string, message: string): Token {
    const token = this.expectWord(code, message);
    if (token.value !== value) {
      throw new ModError(code, `${message}，实际读到 \`${token.value}\``, tokenSpan(token));
    }
    return token;
  }
}

function tokenSpanOf(expr: Expr): SourceSpan {
  return expr.span;
}

function spanOf(a: SourceSpan, b: SourceSpan): SourceSpan {
  return { line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol };
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'eof':
      return '文件结尾';
    case 'newline':
      return '换行';
    case 'string':
      return `字符串 "${token.value}"`;
    case 'number':
      return `数字 ${token.value}`;
    case 'assign':
      return '`=`';
    case 'plus':
    case 'minus':
    case 'star':
    case 'slash':
      return `\`${token.text}\``;
    default:
      return `\`${token.text}\``;
  }
}
