/**
 * 语法分析器：递归下降 + 单趟扫描，无回溯。
 *
 * 语法（EBNF）：
 *   program      := '__init__' '{' initStmt* '}'
 *   initStmt     := varDecl | funcDecl | mainDecl | ifStmt | cycleStmt | breakStmt | tryStmt | exprStmt
 *   varDecl      := ('int' | 'double' | 'text' | 'bool') IDENT '=' expr
 *   funcDecl     := 'def' IDENT '(' params? ')' funcBody
 *   mainDecl     := 'main' '(' ')' funcBody
 *   funcBody     := '{' blockStmt* '}'
 *   params       := IDENT (',' IDENT)*
 *   ifStmt       := 'if' expr block ('elif' expr block)* ('else' block)?
 *   cycleStmt    := 'cycle' '(' expr? ')' block
 *   breakStmt    := 'break'
 *   block        := '{' blockStmt* '}'
 *   blockStmt    := varDecl | ifStmt | cycleStmt | breakStmt | tryStmt | exprStmt
 *   exprStmt     := expr
 *   expr         := or
 *   or           := and ('||' and)*
 *   and          := comparison ('&&' comparison)*
 *   comparison   := additive (('==' | '!=' | '<' | '<=' | '>' | '>=') additive)*
 *   additive     := multiplicative (('+' | '-') multiplicative)*
 *   multiplicative := unary (('*' | '/') unary)*
 *   unary        := ('-' | '+' | '!') unary | power
 *   power        := postfix ('**' unary)?
 *   postfix      := callExpr ('.' IDENT)*
 *   callExpr     := primary callSuffix?
 *   callSuffix   := '(' (expr (',' expr)*)? ')'
 *   primary      := INT | DOUBLE | TEXT | TRUE | FALSE | IDENT | '(' expr ')'
 *   tryStmt      := 'try' block 'catch' '(' IDENT ')' block
 *
 * 优先级（低 → 高）：
 *   '||'  →  '&&'  →  比较（== != < <= > >=）  →  '+' '-'
 *     →  '*' '/'  →  一元 '+' '-' '!'  →  '**'  →  调用  →  '.'  →  括号
 * 同级左结合；一元运算与 '**' 右结合。
 * 因此 - -1 等于 1、2 ** 3 ** 2 等于 512、-2 ** 2 等于 -4。
 * 指数的写法是 unary，所以 2 ** -1 也合法（结果类型见值规则）。
 *
 * 六个比较运算符同处一级（不像 C 那样再分两级），因此 a == b < c 解析为
 * (a == b) < c —— 该写法几乎总是类型错误，报错信息会指出具体的类型。
 *
 * 语句分隔：分号可选。若既没有 ';'，下一个 token 也不在后续行，且不是 '}' / EOF，
 * 则报"缺少语句分隔"（E0206）。
 */
import { SourceFile, type Span } from '../utils/source';
import type {
  AssignStmt,
  Binary,
  BinaryOp,
  BoolLit,
  BreakStmt,
  BuildExeDecl,
  Call,
  CdStmt,
  ClassDecl,
  ClassField,
  ClassMethod,
  CycleStmt,
  DeleteStmt,
  DoubleLit,
  DisplayHead,
  DisplayWin,
  Expr,
  GameDecl,
  GameElement,
  GameInit,
  ExprStmt,
  FileReadStmt,
  FileSaveStmt,
  FuncDecl,
  Ident,
  IfBranch,
  IfStmt,
  Index,
  IntLit,
  ListDecl,
  ListOp,
  ListOpKind,
  ListRef,
  Member,
  MethodCall,
  OutputStmt,
  Param,
  Program,
  ReadTarget,
  ReturnStmt,
  RunningStmt,
  Stmt,
  TextLit,
  TryStmt,
  Unary,
  VarDecl,
  WebBox,
  WebButton,
  WebDiv,
  WebElement,
  WebInit,
  WebSetsDecl,
  WebText,
  WebTo,
} from './ast';
import { ErrorCodes, LemonError } from './errors';
import { tokenize } from './lexer';
import { describeToken, DIRECTIVE_NAME, isTypeKeyword, Token, TokenKind, TYPE_KEYWORDS } from './token';

export function parseProgram(src: SourceFile): Program {
  return new Parser(src).parseProgram();
}

/** 解析一段语句片段（`__init__` 体内的形式），供 REPL 使用 */
export function parseStatements(src: SourceFile): Stmt[] {
  return new Parser(src).parseFragment();
}

class Parser {
  private readonly src: SourceFile;
  private readonly tokens: Token[];
  private pos = 0;
  /** 当前所在的 cycle 嵌套深度 —— break 只允许出现在循环体内 */
  private loopDepth = 0;
  /** 当前所在的函数体深度 —— return 只允许出现在函数体内（与 loopDepth 同一套路） */
  private functionDepth = 0;

  constructor(src: SourceFile) {
    this.src = src;
    this.tokens = tokenize(src);
  }

  /* ------------------------------------------------------------------ */
  /* 入口                                                                */
  /* ------------------------------------------------------------------ */

  parseProgram(): Program {
    if (!this.check(TokenKind.KwInit)) {
      throw new LemonError({
        code: ErrorCodes.MISSING_INIT,
        phase: 'parse',
        message: '程序缺少 __init__ 块',
        span: this.peek().span,
        hint: '__init__ 是必需的外壳，程序结构为 __init__ { main() { ... } }',
      });
    }

    const initTok = this.advance();
    this.expect(TokenKind.LBrace, '__init__ 后应紧跟 {');

    const statements: Stmt[] = [];
    const functions: FuncDecl[] = [];
    let main: FuncDecl | null = null;
    const classes: ClassDecl[] = [];
    let websets: WebSetsDecl | null = null;
    let game: GameDecl | null = null;
    let buildExe: BuildExeDecl | null = null;

    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      const stmt = this.parseStatement(true);
      statements.push(stmt);
      if (stmt.kind === 'Class') classes.push(stmt);
      if (stmt.kind === 'Game') {
        if (game !== null) {
          throw new LemonError({
            code: ErrorCodes.DUPLICATE_DECL,
            phase: 'parse',
            message: 'game() 只能声明一次',
            span: stmt.nameSpan,
            hint: `第一个 game() 声明于 ${game.nameSpan.line} 行`,
          });
        }
        game = stmt;
      }
      if (stmt.kind === 'WebSets') {
        if (websets !== null) {
          throw new LemonError({
            code: ErrorCodes.DUPLICATE_DECL,
            phase: 'parse',
            message: 'websets() 只能声明一次',
            span: stmt.nameSpan,
            hint: `第一个 websets() 声明于 ${websets.nameSpan.line} 行`,
          });
        }
        websets = stmt;
      }
      if (stmt.kind === 'BuildExe') {
        if (buildExe !== null) {
          throw new LemonError({
            code: ErrorCodes.DUPLICATE_DECL,
            phase: 'parse',
            message: 'buildexe 只能声明一次',
            span: stmt.nameSpan,
            hint: `第一个 buildexe 声明于 ${buildExe.nameSpan.line} 行`,
          });
        }
        buildExe = stmt;
      }
      if (stmt.kind === 'FuncDecl') {
        if (stmt.isMain) {
          if (main !== null) {
            throw new LemonError({
              code: ErrorCodes.DUPLICATE_DECL,
              phase: 'parse',
              message: 'main() 只能声明一次',
              span: stmt.nameSpan,
              hint: '第一个 main() 声明于 ' + main.nameSpan.line + ' 行',
            });
          }
          main = stmt;
        } else {
          functions.push(stmt);
        }
      }
      this.expectStatementEnd();
    }

    const endBrace = this.expect(TokenKind.RBrace, '__init__ 块缺少配对的 }');
    const initSpan = cover(initTok.span, endBrace.span);

    if (this.check(TokenKind.KwInit)) {
      throw new LemonError({
        code: ErrorCodes.MULTIPLE_INIT,
        phase: 'parse',
        message: '__init__ 块只能出现一次',
        span: this.peek().span,
        hint: '所有声明与语句都写进同一个 __init__ 块中',
      });
    }
    if (!this.check(TokenKind.Eof)) {
      const t = this.peek();
      throw new LemonError({
        code: ErrorCodes.UNEXPECTED_TOKEN,
        phase: 'parse',
        message: `__init__ 块之外不能再有内容，却遇到 ${describeToken(t.kind)} '${t.lexeme}'`,
        span: t.span,
        hint: '请把这部分代码移入 __init__ { ... } 内部',
      });
    }

    return { statements, initSpan, main, functions, websets, game, buildExe, classes };
  }

  parseFragment(): Stmt[] {
    const out: Stmt[] = [];
    while (!this.check(TokenKind.Eof)) {
      if (this.check(TokenKind.KwInit)) {
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'REPL 中无需书写 __init__ 外壳',
          span: this.peek().span,
          hint: '直接输入语句即可，例如：int a = 1',
        });
      }
      if (this.checkWebSets()) {
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'REPL 里不能使用 websets()',
          span: this.peek().span,
          hint: 'websets() 要产出 .html 文件，需要文件上下文；请写成 .lemon1 文件后用 lemon run 运行',
        });
      }
      if (this.checkGame()) {
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'REPL 里不能使用 game()',
          span: this.peek().span,
          hint: 'game() 要产出 .html 文件，需要文件上下文；请写成 .lemon1 文件后用 lemon run 运行',
        });
      }
      if (this.checkBuildExe()) {
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'REPL 里不能使用 buildexe',
          span: this.peek().span,
          hint: 'buildexe 要产出 .exe 文件，需要文件上下文；请写成 .lemon1 文件后用 lemon run 运行',
        });
      }
      if (this.checkClassDecl()) {
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'REPL 里不能定义 class',
          span: this.peek().span,
          hint: 'class 要写在 __init__ 顶层，请写成 .lemon1 文件后用 lemon run 运行',
        });
      }
      out.push(this.parseStatement(true));
      this.expectStatementEnd();
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 语句                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * @param topLevel 是否位于 `__init__` 顶层。只有这里才允许 `websets()`——
   *   它和 `def` / `main` 一样属于顶层声明，不能出现在函数体或分支里。
   */
  private parseStatement(topLevel: boolean): Stmt {
    if (isTypeKeyword(this.peek().kind)) return this.parseVarDecl();
    if (this.check(TokenKind.KwDef)) return this.parseFuncDecl(false);
    if (this.check(TokenKind.KwMain)) return this.parseFuncDecl(true);
    if (this.checkWebSets()) {
      if (!topLevel) {
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'websets() 只能写在 __init__ 顶层',
          span: this.peek().span,
          hint: '它与 main() 同级，要写在 __init__ { ... } 里面、函数体之外',
        });
      }
      return this.parseWebSets();
    }
    if (this.checkGame()) {
      if (!topLevel) {
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'game() 只能写在 __init__ 顶层',
          span: this.peek().span,
          hint: '它与 main() 同级，要写在 __init__ { ... } 里面、函数体之外',
        });
      }
      return this.parseGame();
    }
    // `buildexe = 文件名`：只作为 __init__ 顶层的打包声明
    if (this.checkBuildExe()) {
      if (!topLevel) {
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'buildexe 只能写在 __init__ 顶层',
          span: this.peek().span,
          hint: '它与 main() 同级，要写在 __init__ { ... } 里面、函数体之外',
        });
      }
      return this.parseBuildExe();
    }
    // `game.running = True`：只面向 game 命名空间的字段赋值
    if (this.checkAssign()) return this.parseAssign();
    // `class 名字 { ... }`：类声明（只能写在 __init__ 顶层）
    if (this.checkClassDecl()) {
      if (!topLevel) {
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'class 只能写在 __init__ 顶层',
          span: this.peek().span,
          hint: '它与 main() 同级，要写在 __init__ { ... } 里面、函数体之外',
        });
      }
      return this.parseClassDecl();
    }
    // `类名 变量 = ...`：用类名当类型的变量声明
    if (this.checkClassVarDecl()) return this.parseClassVarDecl();
    // `output "..."`：带级别的输出语句
    if (this.checkOutput()) return this.parseOutput();
    // `cd <目录> { ... }` / `running <文件>` / `delete <文件>`：fileskill 的三条语句
    if (this.checkFileskillWord('cd')) return this.parseCdStmt();
    if (this.checkFileskillWord('running')) return this.parseRunningStmt();
    if (this.checkFileskillWord('delete')) return this.parseDeleteStmt();
    // `read { ... }` / `write { ... }`：文件读写块。`read` / `write` 是上下文
    // 关键字——只有紧跟 `{` 才成立，所以 `text read = 1`、`say(write)` 之类不受影响。
    if (this.checkFileBlock('read')) return this.parseFileRead();
    if (this.checkFileBlock('save')) return this.parseFileSave();
    // `add list(X)` 建空列表；与 `add[元素] to list(X)` 靠 `[` 区分
    if (this.checkAddListDecl()) {
      const addTok = this.advance();
      return this.parseListDecl(addTok.span);
    }
    const listOp = this.checkListOp();
    if (listOp !== null) return this.parseListOp(listOp);
    if (this.checkList()) return this.parseListDecl();
    if (this.check(TokenKind.KwIf)) return this.parseIfStmt();
    if (this.check(TokenKind.KwElif) || this.check(TokenKind.KwElse)) return this.parseOrphanBranch();
    if (this.check(TokenKind.KwTry)) return this.parseTryStmt();
    if (this.check(TokenKind.KwCycle)) return this.parseCycleStmt();
    if (this.check(TokenKind.KwBreak)) return this.parseBreakStmt();
    if (this.check(TokenKind.KwReturn)) return this.parseReturnStmt();
    if (this.check(TokenKind.Directive)) return this.parseDirectiveNotAllowed();
    if (UNSUPPORTED_KEYWORDS.has(this.peek().kind)) return this.parseUnsupportedKeyword();
    return this.parseExprStmt();
  }

  /**
   * 走到这里说明源码里的 `#incloud` 没被加载器消费掉——也就是在
   * eval / REPL 这类没有文件上下文的场景里用了它。
   * 与其报"意外的 token"，不如直接说清楚它需要文件上下文。
   */
  private parseDirectiveNotAllowed(): never {
    const t = this.advance();
    throw new LemonError({
      code: ErrorCodes.DIRECTIVE_NOT_ALLOWED,
      phase: 'parse',
      message: `#${DIRECTIVE_NAME} 只在从文件运行时生效`,
      span: t.span,
      hint: `请把代码存成 .lemon1 文件后用 lemon run <文件.lemon1> 运行；eval 与 REPL 里不能使用 #${DIRECTIVE_NAME}`,
    });
  }

  /**
   * cycle 循环。
   *
   *   cycle(3) { ... }   重复 3 次，体内 i 依次是 0 1 2
   *   cycle()  { ... }   无限循环，用 break 跳出
   *
   * 形状与 `main() { ... }` 一致：名字 + 括号 + 块，因此不需要新记一套语法。
   * 次数必须是 int，且不能是负的（字面量负数在静态检查阶段就拦下）。
   */
  private parseCycleStmt(): CycleStmt {
    const startTok = this.advance(); // 'cycle'
    this.expect(TokenKind.LParen, 'cycle 后应紧跟 ( —— cycle(N) 重复 N 次，cycle() 表示无限循环');

    let count: Expr | null = null;
    if (!this.check(TokenKind.RParen)) count = this.parseExpr();

    const close = this.expect(TokenKind.RParen, 'cycle 的次数缺少配对的 )');
    const headerSpan = cover(startTok.span, close.span);
    this.expect(TokenKind.LBrace, 'cycle 的括号后应紧跟 {');

    this.loopDepth += 1;
    const body = this.parseBlockBody('cycle 循环体');
    this.loopDepth -= 1;

    const endBrace = this.expect(TokenKind.RBrace, 'cycle 循环体缺少配对的 }');
    return { kind: 'CycleStmt', count, body, headerSpan, span: cover(startTok.span, endBrace.span) };
  }

  /** break：跳出最内层的 cycle。放在循环外属于结构错误，在解析阶段就报出来 */
  private parseBreakStmt(): BreakStmt {
    const t = this.advance();
    if (this.loopDepth === 0) {
      throw new LemonError({
        code: ErrorCodes.BREAK_OUTSIDE_LOOP,
        phase: 'parse',
        message: 'break 只能写在 cycle 循环体里',
        span: t.span,
        hint: 'break 用来跳出最内层的 cycle；这里没有可跳出的循环',
      });
    }
    return { kind: 'BreakStmt', span: t.span };
  }

  /**
   * `return [表达式]`
   *
   * 值是**可选**的，判据是"同一个行内后面还有东西"：
   *
   *   return            ← 不带值
   *   return 1 + 2      ← 带值
   *   return            ← 换行了就不是它的一部分（与全局的换行断句规则一致）
   *   1
   *
   * 采用"排除语句终止符"而不是"列举表达式开头"：`return -1` 里的 `-` 是
   * 一元运算符、不在表达式开头表里，用列举法会漏掉它。
   */
  private parseReturnStmt(): ReturnStmt {
    const t = this.advance(); // 'return'

    // 与 break 同一处报错时机：结构位置不对属于语法问题，在解析阶段就拦下
    if (this.functionDepth === 0) {
      throw new LemonError({
        code: ErrorCodes.RETURN_OUTSIDE_FUNC,
        phase: 'parse',
        message: 'return 只能写在函数体内',
        span: t.span,
        hint: '它用来从函数里带一个值回去、或者提前结束函数；__init__ 顶层没有可返回的地方',
      });
    }

    const next = this.peek();
    const terminates =
      next.kind === TokenKind.RBrace || next.kind === TokenKind.Semi || next.kind === TokenKind.Eof;
    const sameLine = next.span.line === t.span.endLine;

    if (terminates || !sameLine) return { kind: 'ReturnStmt', value: null, span: t.span };

    const value = this.parseExpr();
    return { kind: 'ReturnStmt', value, span: cover(t.span, value.span) };
  }

  /**
   * 已预留但尚未实现的关键字。
   * 这些词已经被词法层占用，因此不会再被当成裸文本；这里补上明确的"暂不支持"提示，
   * 否则用户写 while 只会看到一条含混的"两条语句之间缺少分隔"。
   */
  private parseUnsupportedKeyword(): never {
    const t = this.advance();
    throw new LemonError({
      code: ErrorCodes.UNEXPECTED_TOKEN,
      phase: 'parse',
      message: `Lemon 暂不支持 ${UNSUPPORTED_KEYWORDS.get(t.kind)}`,
      span: t.span,
      hint: '当前可用的控制流是 if / elif / else、cycle 循环、break 与 return（continue、while、for 尚未实现）',
    });
  }

  /** 光秃秃的 elif / else：给出比"意外 token"更有用的提示 */
  private parseOrphanBranch(): never {
    const t = this.advance();
    throw new LemonError({
      code: ErrorCodes.UNEXPECTED_TOKEN,
      phase: 'parse',
      message: `${t.lexeme} 必须紧跟在 if 或 elif 的分支体之后`,
      span: t.span,
      hint: '写法：if 条件 { ... } elif 条件 { ... } else { ... }',
    });
  }

  /**
   * if / elif / else。
   *
   *   if 条件 {
   *       ...
   *   } elif 条件 {
   *       ...
   *   } else {
   *       ...
   *   }
   *
   * 条件**不写括号**（与 try / catch 的风格一致），且必须能求值成 bool。
   * `elif` 可重复任意次；`else` 至多一次且只能是最后一支。
   */
  private parseIfStmt(): IfStmt {
    const startTok = this.advance(); // 'if'
    const branches: IfBranch[] = [];

    let keyword: 'if' | 'elif' = 'if';
    let condition: Expr | null = this.parseExpr();

    for (;;) {
      // 循环入口一定刚解析完一个条件，此时遇到 '=' 几乎都是把 == 写成了 =
      if (this.check(TokenKind.Assign)) {
        // 唯一例外：buildexe 的内置 bool 标志允许 `if build = true` 这种写法。
        // build 是本次功能新增的标志变量，不是可赋值变量，这里只做语法糖展开。
        if (condition !== null && condition.kind === 'Ident' && condition.name === 'build') {
          this.advance(); // '='
          const right = this.parseExpr();
          condition = {
            kind: 'Binary',
            op: '==',
            left: condition,
            right,
            span: cover(condition.span, right.span),
          };
          continue;
        }
        const t = this.peek();
        throw new LemonError({
          code: ErrorCodes.EXPECTED_TOKEN,
          phase: 'parse',
          message: `${keyword} 的条件后应紧跟 {，这里却遇到 '='`,
          span: t.span,
          hint: '判断相等要写 ==（单个 = 只用在变量声明里）',
        });
      }

      this.expect(TokenKind.LBrace, `${keyword} 的条件后应紧跟 {`);
      const body = this.parseBlockBody(`${keyword} 块`);
      const close = this.expect(TokenKind.RBrace, `${keyword} 块缺少配对的 }`);
      branches.push({ kind: keyword, condition, body, closeSpan: close.span });

      if (this.check(TokenKind.KwElif)) {
        this.advance();
        keyword = 'elif';
        condition = this.parseExpr();
        continue;
      }

      if (this.check(TokenKind.KwElse)) {
        this.advance(); // 'else'
        this.expect(TokenKind.LBrace, 'else 后应紧跟 {，且不能再跟条件');
        const elseBody = this.parseBlockBody('else 块');
        const elseClose = this.expect(TokenKind.RBrace, 'else 块缺少配对的 }');
        branches.push({ kind: 'else', condition: null, body: elseBody, closeSpan: elseClose.span });
        return { kind: 'IfStmt', branches, span: cover(startTok.span, elseClose.span) };
      }

      return { kind: 'IfStmt', branches, span: cover(startTok.span, close.span) };
    }
  }

  /** try { ... } catch (名字) { ... } */
  private parseTryStmt(): TryStmt {
    const startTok = this.advance();
    this.expect(TokenKind.LBrace, 'try 后应紧跟 {');
    const body = this.parseBlockBody('try 块');
    this.expect(TokenKind.RBrace, 'try 块缺少配对的 }');

    if (!this.check(TokenKind.KwCatch)) {
      throw new LemonError({
        code: ErrorCodes.EXPECTED_TOKEN,
        phase: 'parse',
        message: 'try 块必须紧跟一个 catch 块',
        span: this.peek().span,
        hint: '写法：try { ... } catch (错误) { ... }',
      });
    }

    this.advance(); // 'catch'
    this.expect(TokenKind.LParen, 'catch 后应紧跟 ( 与绑定的名字');
    const nameTok = this.expect(TokenKind.Ident, 'catch 缺少绑定的名字，例如 catch (错误)');
    this.expect(TokenKind.RParen, 'catch 的名字后应紧跟 )');
    this.expect(TokenKind.LBrace, 'catch 后应紧跟 {');
    const catchBody = this.parseBlockBody('catch 块');
    const endBrace = this.expect(TokenKind.RBrace, 'catch 块缺少配对的 }');

    return {
      kind: 'TryStmt',
      body,
      catchName: nameTok.lexeme,
      catchNameSpan: nameTok.span,
      catchBody,
      span: cover(startTok.span, endBrace.span),
    };
  }

  /* ------------------------------------------------------------------ */
  /* websets()：声明式描述一个网页                                        */
  /* ------------------------------------------------------------------ */

  /**
   * 上下文关键字：只有「标识符 websets 紧跟 `(`」才算声明。
   *
   * 之所以不做成全局关键字：`say(websets)`、`text websets = ...` 这类现有写法
   * 不该因为多了一个新构造就失效。同理，`button` / `to` / `web.init` 也只在
   * websets 块内部才有特殊含义。
   */
  private checkWebSets(): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.peek().lexeme === 'websets' &&
      this.tokens[this.pos + 1]?.kind === TokenKind.LParen
    );
  }

  /** 上下文关键字：`web` `.` `init` `(` 四个 token 连写才算 */
  private checkWebInit(): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.peek().lexeme === 'web' &&
      this.tokens[this.pos + 1]?.kind === TokenKind.Dot &&
      this.tokens[this.pos + 2]?.kind === TokenKind.Ident &&
      this.tokens[this.pos + 2]?.lexeme === 'init' &&
      this.tokens[this.pos + 3]?.kind === TokenKind.LParen
    );
  }

  /**
   * websets 块里出现了 `web.init()` 之外的东西。
   *
   * 这个地方的写法翻来覆去就那几种，所以逐个认出来单独提示。
   * 尤其是 `wed.init()`（把 web 打错）和 `web.init{`（漏了括号）——
   * 如果一律只报"只能写 web.init()"，用户盯着自己那行里的 `web` 反而更困惑。
   */
  private unexpectedInWebSets(): never {
    const name = this.peek();
    const dot = this.tokens[this.pos + 1];
    const init = this.tokens[this.pos + 2];
    const paren = this.tokens[this.pos + 3];

    // 形状已经是 `<名字>.init`：说明用户知道要写 web.init()，问题在名字或括号
    if (
      name.kind === TokenKind.Ident &&
      dot?.kind === TokenKind.Dot &&
      init?.kind === TokenKind.Ident &&
      init.lexeme === 'init'
    ) {
      if (name.lexeme !== 'web') {
        throw new LemonError({
          code: ErrorCodes.WEBSETS_ELEMENT,
          phase: 'parse',
          message: `web.init() 的模块名写错了：这里是 '${name.lexeme}.init()'`,
          span: name.span,
          hint: '页面根容器固定写 web.init() { ... }',
        });
      }
      if (paren?.kind !== TokenKind.LParen) {
        throw new LemonError({
          code: ErrorCodes.EXPECTED_TOKEN,
          phase: 'parse',
          message: 'web.init 后面要跟一对括号',
          span: init.span,
          hint: '写法是 web.init() { ... }，元素写在花括号里面',
        });
      }
    }

    throw new LemonError({
      code: ErrorCodes.WEBSETS_ELEMENT,
      phase: 'parse',
      message: `websets 块里只能写 web.init()，却遇到 ${describeToken(name.kind)} '${name.lexeme}'`,
      span: name.span,
      hint:
        name.lexeme === 'button'
          ? 'button 要写在 web.init() 里面：websets() { web.init() { button { to "localhost:9000" } } }'
          : '页面结构：websets() { web.init() { button { to "localhost:9000" } } }',
    });
  }

  /**
   * websets() { web.init() { ... } }
   *
   * 形状与 `main() { ... }` 完全一致（名字 + 括号 + 块），不必新记一套语法。
   */
  private parseWebSets(): WebSetsDecl {
    const startTok = this.advance(); // 'websets'
    this.expect(TokenKind.LParen, 'websets 后应紧跟 (');
    if (!this.check(TokenKind.RParen)) {
      throw new LemonError({
        code: ErrorCodes.EXPECTED_TOKEN,
        phase: 'parse',
        message: 'websets() 不能带参数',
        span: this.peek().span,
        hint: '写法是 websets() { ... }；需要的数据请在 __init__ 顶层声明成变量，再在 to 里引用',
      });
    }
    this.advance(); // ')'
    this.expect(TokenKind.LBrace, 'websets 后应紧跟 {');

    let init: WebInit | null = null;
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      if (!this.checkWebInit()) this.unexpectedInWebSets();
      if (init !== null) {
        throw new LemonError({
          code: ErrorCodes.EXPECTED_TOKEN,
          phase: 'parse',
          message: 'web.init() 只能写一次',
          span: this.peek().span,
          hint: '页面内容都写在同一个 web.init() { ... } 里',
        });
      }
      init = this.parseWebInit();
      this.expectStatementEnd();
    }

    const endBrace = this.expect(TokenKind.RBrace, 'websets 块缺少配对的 }');
    return {
      kind: 'WebSets',
      init,
      nameSpan: startTok.span,
      span: cover(startTok.span, endBrace.span),
    };
  }

  /** web.init() { 元素... }：页面的根容器 */
  private parseWebInit(): WebInit {
    const startTok = this.advance(); // 'web'
    this.advance(); // '.'
    this.advance(); // 'init'
    this.advance(); // '('
    if (!this.check(TokenKind.RParen)) {
      throw new LemonError({
        code: ErrorCodes.EXPECTED_TOKEN,
        phase: 'parse',
        message: 'web.init() 不能带参数',
        span: this.peek().span,
        hint: '写法是 web.init() { ... }',
      });
    }
    this.advance(); // ')'

    // 漏了花括号时直接点出来元素该放哪——比笼统的"缺少 {" 好用得多
    const next = this.peek();
    if (next.kind === TokenKind.Ident && next.lexeme === 'button') {
      throw new LemonError({
        code: ErrorCodes.WEBSETS_ELEMENT,
        phase: 'parse',
        message: 'button 要写在 web.init() 的花括号里',
        span: next.span,
        hint: '写成：web.init() { button { to "localhost:9000" } }',
      });
    }
    this.expect(TokenKind.LBrace, 'web.init() 后应紧跟 {');

    const elements: WebElement[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      elements.push(this.parseWebElement());
      this.expectStatementEnd();
    }

    const endBrace = this.expect(TokenKind.RBrace, 'web.init 块缺少配对的 }');
    return { kind: 'WebInit', elements, span: cover(startTok.span, endBrace.span) };
  }

  /**
   * websets 元素分派。
   *
   *   - `button { ... }` / `div { ... }` / `div (属性...) { ... }` 是元素；
   *   - 其余一律当成**文本内容**：一条表达式（裸文本、字符串或变量），
   *     求值后按 text 渲染进页面。
   *
   * 名字后面直接跟 `{` 却不认识时，仍按"未知元素"报 E0325，而不是硬塞进表达式。
   */
  private parseWebElement(): WebElement {
    const t = this.peek();
    const after = this.tokens[this.pos + 1];
    if (t.kind === TokenKind.Ident && after?.kind === TokenKind.LBrace) {
      if (t.lexeme === 'button') return this.parseWebButton();
      if (t.lexeme === 'div') return this.parseWebDiv();
      throw new LemonError({
        code: ErrorCodes.WEBSETS_ELEMENT,
        phase: 'parse',
        message: `web.init 里不认识元素 ${t.lexeme}`,
        span: t.span,
        hint: '元素只有 button 与 div；写法：button { to "localhost:9000" }、div (in (0,0;256,256); color=#ffffff) { ... }',
      });
    }
    if (t.kind === TokenKind.Ident && t.lexeme === 'div' && after?.kind === TokenKind.LParen) {
      return this.parseWebDiv();
    }
    return this.parseWebText();
  }

  /**
   * `div (属性...) { 子元素... }` / `div { 子元素... }`。
   *
   * 属性写在 `div` 后面的括号里、用 `;` 分隔：`in (...)` 与 `color=...`；
   * 括号可以整个省略（只写子元素时），那时 div 就是普通块级容器。
   */
  private parseWebDiv(): WebDiv {
    const startTok = this.advance(); // 'div'
    let box: WebBox | null = null;
    let color: Expr | null = null;

    if (this.check(TokenKind.LParen)) {
      this.advance(); // '('
      while (!this.check(TokenKind.RParen) && !this.check(TokenKind.Eof)) {
        const prop = this.peek();
        if (prop.kind !== TokenKind.Ident || (prop.lexeme !== 'in' && prop.lexeme !== 'color')) {
          throw new LemonError({
            code: ErrorCodes.WEBSETS_PROPS,
            phase: 'parse',
            message: `div 的属性只能是 in(...) 或 color=...，却遇到 ${describeToken(prop.kind)} '${prop.lexeme}'`,
            span: prop.span,
            hint: '写法：div (in (0,0;256,256); color=#ffffff) { ... }',
          });
        }
        if (prop.lexeme === 'in') {
          if (box !== null) {
            throw new LemonError({
              code: ErrorCodes.WEBSETS_PROPS,
              phase: 'parse',
              message: 'div 里只能写一个 in(...)',
              span: prop.span,
              hint: '一个 div 只有一个位置盒子',
            });
          }
          box = this.parseWebBox();
        } else {
          if (color !== null) {
            throw new LemonError({
              code: ErrorCodes.WEBSETS_PROPS,
              phase: 'parse',
              message: 'div 里只能写一个 color=...',
              span: prop.span,
              hint: '一个 div 只有一个颜色',
            });
          }
          this.advance(); // 'color'
          this.expect(TokenKind.Assign, 'color 后面要写 =', '写法：color=#ffffff');
          color = this.parseExpr();
        }

        if (this.check(TokenKind.Semi)) {
          this.advance();
          continue;
        }
        if (this.check(TokenKind.RParen)) break;
        throw new LemonError({
          code: ErrorCodes.WEBSETS_PROPS,
          phase: 'parse',
          message: `div 的属性之间要用 ; 分隔，却遇到 ${describeToken(this.peek().kind)}`,
          span: this.peek().span,
          hint: '写法：div (in (0,0;256,256); color=#ffffff) { ... }',
        });
      }
      this.expect(TokenKind.RParen, 'div 的属性列表缺少配对的 )');
    }

    this.expect(TokenKind.LBrace, 'div 后应紧跟 {');

    const children: WebElement[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      children.push(this.parseWebElement());
      this.expectStatementEnd();
    }
    const endBrace = this.expect(TokenKind.RBrace, 'div 块缺少配对的 }');
    return { kind: 'WebDiv', box, color, children, span: cover(startTok.span, endBrace.span) };
  }

  /** `in (x1,y1;x2,y2)`：两个点分别是左上与右下；点内用 `,`、点间用 `;` */
  private parseWebBox(): WebBox {
    const startTok = this.advance(); // 'in'
    this.expect(TokenKind.LParen, 'in 后面要写括号', '写法：in (x1,y1;x2,y2)');
    const left = this.parseExpr();
    this.expect(TokenKind.Comma, 'in 的第一个点要写 x,y 两个数，缺少逗号', '写法：in (0,0;256,256)');
    const top = this.parseExpr();
    this.expect(TokenKind.Semi, 'in 的两个点之间用 ; 分隔', '写法：in (0,0;256,256)');
    const right = this.parseExpr();
    this.expect(TokenKind.Comma, 'in 的第二个点要写 x,y 两个数，缺少逗号', '写法：in (0,0;256,256)');
    const bottom = this.parseExpr();
    const close = this.expect(TokenKind.RParen, 'in 缺少配对的 )');
    return { kind: 'WebBox', left, top, right, bottom, span: cover(startTok.span, close.span) };
  }

  /** div / web.init 里的一段文本内容：一条表达式，求值后按 text 渲染 */
  private parseWebText(): WebText {
    const startTok = this.peek();
    const value = this.parseExpr();
    return { kind: 'WebText', value, span: cover(startTok.span, value.span) };
  }

  /** button { to <地址> } */
  private parseWebButton(): WebButton {
    const startTok = this.advance(); // 'button'
    this.expect(TokenKind.LBrace, 'button 后应紧跟 {');

    let to: WebTo | null = null;
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      const t = this.peek();
      if (t.kind !== TokenKind.Ident || t.lexeme !== 'to') {
        throw new LemonError({
          code: ErrorCodes.WEBSETS_ELEMENT,
          phase: 'parse',
          message: `button 里只能写 to <地址>，却遇到 ${describeToken(t.kind)} '${t.lexeme}'`,
          span: t.span,
          hint: '写法：button { to "localhost:9000" }——地址里的 : 要加引号',
        });
      }
      if (to !== null) {
        throw new LemonError({
          code: ErrorCodes.WEBSETS_ELEMENT,
          phase: 'parse',
          message: 'button 里只能写一个 to',
          span: t.span,
          hint: '一个按钮只有一个跳转目标',
        });
      }
      to = this.parseWebTo();
      this.expectStatementEnd();
    }

    const endBrace = this.expect(TokenKind.RBrace, 'button 块缺少配对的 }');
    return { kind: 'WebButton', to, span: cover(startTok.span, endBrace.span) };
  }

  /** `to <地址>`：地址可以是字面量，也可以是变量 */
  private parseWebTo(): WebTo {
    const startTok = this.advance(); // 'to'
    const target = this.parseExpr();
    return { kind: 'WebTo', target, span: cover(startTok.span, target.span) };
  }

  /* ------------------------------------------------------------------ */
  /* game()：声明式描述一个游戏窗口                                       */
  /* ------------------------------------------------------------------ */

  /**
   * 上下文关键字：只有「标识符 game 紧跟 `(`」才算 game() 声明。
   * `game.running` / `game.quit` 是表达式（点号），不会被这条规则命中。
   */
  private checkGame(): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.peek().lexeme === 'game' &&
      this.tokens[this.pos + 1]?.kind === TokenKind.LParen
    );
  }

  /** 上下文关键字：`game` `.` `init` `(` 四个 token 连写 */
  private checkGameInit(): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.peek().lexeme === 'game' &&
      this.tokens[this.pos + 1]?.kind === TokenKind.Dot &&
      this.tokens[this.pos + 2]?.kind === TokenKind.Ident &&
      this.tokens[this.pos + 2]?.lexeme === 'init' &&
      this.tokens[this.pos + 3]?.kind === TokenKind.LParen
    );
  }

  /**
   * 上下文关键字：只有「标识符 buildexe 紧跟 `=`」才算打包声明。
   * `buildexe` 不在 KEYWORDS 里，所以 `say(buildexe)`、`text buildexe = 1`
   * 这类既有写法不受影响。
   */
  private checkBuildExe(): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.peek().lexeme === 'buildexe' &&
      this.tokens[this.pos + 1]?.kind === TokenKind.Assign
    );
  }

  /** `buildexe = <文件名>`：文件名是一个 text 表达式（裸文本或引号字符串） */
  private parseBuildExe(): BuildExeDecl {
    const nameTok = this.advance(); // 'buildexe'
    this.advance(); // '='
    const filename = this.parseExpr();
    return {
      kind: 'BuildExe',
      filename,
      nameSpan: nameTok.span,
      span: cover(nameTok.span, filename.span),
    };
  }

  /** 赋值：`<名字> . <字段> =`（目前只有 game.running / game.quit 合法） */
  private checkAssign(): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.tokens[this.pos + 1]?.kind === TokenKind.Dot &&
      this.tokens[this.pos + 2]?.kind === TokenKind.Ident &&
      this.tokens[this.pos + 3]?.kind === TokenKind.Assign
    );
  }

  private parseAssign(): AssignStmt {
    const targetTok = this.advance(); // 名字
    const target: Ident = { kind: 'Ident', name: targetTok.lexeme, span: targetTok.span };
    this.advance(); // '.'
    const propTok = this.expect(TokenKind.Ident, '字段名，例如 running');
    this.advance(); // '='
    const value = this.parseExpr();
    return {
      kind: 'Assign',
      target,
      property: propTok.lexeme,
      propertySpan: propTok.span,
      value,
      span: cover(targetTok.span, value.span),
    };
  }

  /**
   * 上下文关键字：`output` 后面紧跟一个表达式开头才算输出语句。
   * `output "..."`、`output("...")` 都成立；单独一个 `output` 仍按普通名字处理。
   */
  private checkOutput(): boolean {
    if (this.peek().kind !== TokenKind.Ident || this.peek().lexeme !== 'output') return false;
    const next = this.tokens[this.pos + 1];
    return next !== undefined && EXPRESSION_STARTERS.has(next.kind);
  }

  /** `output <文本表达式>` —— 开头 [error] / [warning] 走 stderr，其余走 stdout */
  private parseOutput(): OutputStmt {
    const startTok = this.advance(); // 'output'
    const value = this.parseExpr();
    return { kind: 'Output', value, span: cover(startTok.span, value.span) };
  }

  /* ------------------------------------------------------------------ */
  /* fileskill：cd / running / delete                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 上下文关键字预判：标识符后面紧跟一个表达式开头。
   *
   * `cd "./目录" { ... }` / `running "a.bat"` / `delete "b.txt"` 成立；
   * 单独一个 `cd` / `running` / `delete` 仍按普通名字处理，不影响既有程序。
   */
  private checkFileskillWord(word: 'cd' | 'running' | 'delete'): boolean {
    if (this.peek().kind !== TokenKind.Ident || this.peek().lexeme !== word) return false;
    const next = this.tokens[this.pos + 1];
    return next !== undefined && EXPRESSION_STARTERS.has(next.kind);
  }

  /** `cd <目录> { 语句... }` —— 块内的 running / delete 以该目录为基准 */
  private parseCdStmt(): CdStmt {
    const startTok = this.advance(); // 'cd'
    const path = this.parseExpr();
    this.expect(TokenKind.LBrace, 'cd 的目录后应紧跟 {');
    const body = this.parseBlockBody('cd 块');
    const endBrace = this.expect(TokenKind.RBrace, 'cd 块缺少配对的 }');
    return { kind: 'Cd', path, body, span: cover(startTok.span, endBrace.span) };
  }

  /** `running <文件>` */
  private parseRunningStmt(): RunningStmt {
    const startTok = this.advance(); // 'running'
    const file = this.parseExpr();
    return { kind: 'Running', file, span: cover(startTok.span, file.span) };
  }

  /** `delete <文件>` */
  private parseDeleteStmt(): DeleteStmt {
    const startTok = this.advance(); // 'delete'
    const file = this.parseExpr();
    return { kind: 'Delete', file, span: cover(startTok.span, file.span) };
  }

  /**
   * game() { game.init() { ... } }
   * 形状与 websets() 完全一致（名字 + 括号 + 块）。
   */
  private parseGame(): GameDecl {
    const startTok = this.advance(); // 'game'
    this.expect(TokenKind.LParen, 'game 后应紧跟 (');
    if (!this.check(TokenKind.RParen)) {
      throw new LemonError({
        code: ErrorCodes.EXPECTED_TOKEN,
        phase: 'parse',
        message: 'game() 不能带参数',
        span: this.peek().span,
        hint: '写法是 game() { ... }；窗口尺寸写在里面的 display.win(宽, 高)',
      });
    }
    this.advance(); // ')'
    this.expect(TokenKind.LBrace, 'game 后应紧跟 {');

    let init: GameInit | null = null;
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      if (!this.checkGameInit()) {
        throw new LemonError({
          code: ErrorCodes.GAME_ELEMENT,
          phase: 'parse',
          message: `game 块里只能写 game.init()，却遇到 ${describeToken(this.peek().kind)} '${this.peek().lexeme}'`,
          span: this.peek().span,
          hint: '窗口结构：game() { game.init() { display.win(1000, 800) display.head("lemon") } }',
        });
      }
      if (init !== null) {
        throw new LemonError({
          code: ErrorCodes.EXPECTED_TOKEN,
          phase: 'parse',
          message: 'game.init() 只能写一次',
          span: this.peek().span,
          hint: '窗口内容都写在同一个 game.init() { ... } 里',
        });
      }
      init = this.parseGameInit();
      this.expectStatementEnd();
    }

    const endBrace = this.expect(TokenKind.RBrace, 'game 块缺少配对的 }');
    return {
      kind: 'Game',
      init,
      nameSpan: startTok.span,
      span: cover(startTok.span, endBrace.span),
    };
  }

  /** game.init() { 元素... }：窗口的根容器 */
  private parseGameInit(): GameInit {
    const startTok = this.advance(); // 'game'
    this.advance(); // '.'
    this.advance(); // 'init'
    this.advance(); // '('
    if (!this.check(TokenKind.RParen)) {
      throw new LemonError({
        code: ErrorCodes.EXPECTED_TOKEN,
        phase: 'parse',
        message: 'game.init() 不能带参数',
        span: this.peek().span,
        hint: '写法是 game.init() { ... }',
      });
    }
    this.advance(); // ')'
    this.expect(TokenKind.LBrace, 'game.init() 后应紧跟 {');

    const elements: GameElement[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      elements.push(this.parseGameElement());
      this.expectStatementEnd();
    }

    const endBrace = this.expect(TokenKind.RBrace, 'game.init 块缺少配对的 }');
    return { kind: 'GameInit', elements, span: cover(startTok.span, endBrace.span) };
  }

  /** 目前只有 display.win(...) 与 display.head(...) */
  private parseGameElement(): GameElement {
    const t = this.peek();
    if (
      t.kind === TokenKind.Ident &&
      t.lexeme === 'display' &&
      this.tokens[this.pos + 1]?.kind === TokenKind.Dot &&
      this.tokens[this.pos + 2]?.kind === TokenKind.Ident
    ) {
      const prop = this.tokens[this.pos + 2]!.lexeme;
      if (prop === 'win') return this.parseDisplayWin();
      if (prop === 'head') return this.parseDisplayHead();
    }
    throw new LemonError({
      code: ErrorCodes.GAME_ELEMENT,
      phase: 'parse',
      message: `game.init 里不认识元素 ${t.lexeme}`,
      span: t.span,
      hint: '目前有 display.win(宽, 高) 与 display.head(标题)，例如：display.win(1000, 800)',
    });
  }

  /** display.win(宽, 高) */
  private parseDisplayWin(): DisplayWin {
    const startTok = this.advance(); // 'display'
    this.advance(); // '.'
    this.advance(); // 'win'
    this.expect(TokenKind.LParen, 'display.win 后应紧跟 (');
    const width = this.parseExpr();
    this.expect(TokenKind.Comma, 'display.win(宽, 高) 需要两个参数，用逗号分隔');
    const height = this.parseExpr();
    const rparen = this.expect(TokenKind.RParen, 'display.win(宽, 高) 缺少配对的 )');
    return { kind: 'DisplayWin', width, height, span: cover(startTok.span, rparen.span) };
  }

  /** display.head(标题) */
  private parseDisplayHead(): DisplayHead {
    const startTok = this.advance(); // 'display'
    this.advance(); // '.'
    this.advance(); // 'head'
    this.expect(TokenKind.LParen, 'display.head 后应紧跟 (');
    const title = this.parseExpr();
    const rparen = this.expect(TokenKind.RParen, 'display.head(标题) 缺少配对的 )');
    return { kind: 'DisplayHead', title, span: cover(startTok.span, rparen.span) };
  }

  /* ------------------------------------------------------------------ */
  /* list(名字) { ... }：块式列表                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 上下文关键字：只有「`list` `(` 目标 `)` `{`」才算列表**声明**。
   *
   * 必须一路看到 `{` 才能认定，因为不带花括号的 `list(1)` 是**引用**：
   *   list(分数) { 90 85 }    ← 声明（语句位置的构造）
   *   say(list(分数))         ← 引用（表达式，等价于 say(分数)）
   * 两者靠这一眼区分，否则 REPL 里敲 `list(1)` 想看内容会变成语法错误。
   *
   * 目标既可以是整数编号（list(1)），也可以是标识符（list(分数)）——
   * 编号槽是全局容器，命名列表就是普通变量，见规范 §2.10。
   */
  private checkList(): boolean {
    if (this.peek().kind !== TokenKind.Ident || this.peek().lexeme !== 'list') return false;
    if (this.tokens[this.pos + 1]?.kind !== TokenKind.LParen) return false;
    const afterClose = this.listTargetEnd();
    return afterClose >= 0 && this.tokens[afterClose]?.kind === TokenKind.LBrace;
  }

  /**
   * 从当前位置的 `list` 出发，返回 `)` **之后**那个 token 的下标；
   * 形状不是「( 目标 )」时返回 -1。仅供 checkList 做形状预判。
   */
  private listTargetEnd(): number {
    let i = this.pos + 2;
    // 可选的 `name =` 前缀
    if (this.tokens[i]?.kind === TokenKind.Ident && this.tokens[i].lexeme === 'name') {
      if (this.tokens[i + 1]?.kind === TokenKind.Assign) i += 2;
    }
    const target = this.tokens[i];
    if (target === undefined) return -1;
    if (target.kind !== TokenKind.Int && target.kind !== TokenKind.Ident) return -1;
    if (this.tokens[i + 1]?.kind !== TokenKind.RParen) return -1;
    return i + 2;
  }

  /**
   * `list(目标) { 元素 换行 元素 }`、`list(目标) {}`，以及 `add list(目标)`。
   *
   * 目标是两者之一：
   *   整数编号   list(1)      → 全局编号槽
   *   标识符     list(分数)    → 命名列表变量（作用域与 int a = 1 相同）
   * 也可以显式写 `list(name = 目标)`，只是把"这个位置放的是列表名"写明白。
   *
   * 元素是任意表达式，按书写顺序求值；一行一个，同一行写多个要用 ; 分隔。
   * `addSpan` 非空表示这是 `add list(目标)` 形式：不写花括号，建一个空列表。
   */
  private parseListDecl(addSpan: Span | null = null): ListDecl {
    const listTok = this.advance(); // 'list'
    this.expect(TokenKind.LParen, 'list 后应紧跟 (');

    // 可选的 `name =` 前缀
    if (this.peek().kind === TokenKind.Ident && this.peek().lexeme === 'name') {
      const save = this.pos;
      this.advance(); // 'name'
      if (!this.match(TokenKind.Assign)) this.pos = save; // 不是 name =，原样退回
    }

    const target = this.peek();
    let slot: number | null = null;
    let name = '';

    if (target.kind === TokenKind.Int) {
      slot = target.value as number;
      this.advance();
    } else if (target.kind === TokenKind.Ident) {
      name = target.lexeme;
      this.advance();
    } else {
      throw new LemonError({
        code: ErrorCodes.LIST_NAME,
        phase: 'parse',
        message: `列表的目标要写成整数编号或标识符，这里是 ${describeToken(target.kind)} '${target.lexeme}'`,
        span: target.span,
        hint: '两种写法：编号槽 list(1) { 90 85 }（全局容器，按编号访问），或命名列表 list(分数) { 90 85 }（普通变量，能传参、能嵌套）',
      });
    }

    const label = slot === null ? name : String(slot);
    const close = this.expect(TokenKind.RParen, `list(${label}) 缺少配对的 )`);

    // `add list(X)`：不写花括号，建一个空列表
    if (addSpan !== null && !this.check(TokenKind.LBrace)) {
      return {
        kind: 'ListDecl',
        slot,
        name,
        nameSpan: target.span,
        elements: [],
        keywordSpan: addSpan,
        span: cover(addSpan, close.span),
      };
    }

    this.expect(
      TokenKind.LBrace,
      `list(${label}) 后应紧跟 {`,
      '写法：list(名字) { 元素 换行 元素 }；只想建一个空列表可以写 add list(名字)',
    );

    const elements: Expr[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      elements.push(this.parseExpr());
      this.expectStatementEnd();
    }
    const endBrace = this.expect(TokenKind.RBrace, `list(${label}) 块缺少配对的 }`);

    return {
      kind: 'ListDecl',
      slot,
      name,
      nameSpan: target.span,
      elements,
      keywordSpan: listTok.span,
      span: cover(addSpan ?? listTok.span, endBrace.span),
    };
  }

  /* ------------------------------------------------------------------ */
  /* list(X) 引用，与 add / del / file / clear 四个操作                    */
  /* ------------------------------------------------------------------ */

  /**
   * 列表引用 `list(X)`：X 是整数编号或标识符。
   *
   * 它出现在表达式里（`say(list(1))`、`len(list(1))`、`list(1)[0]`），
   * 也出现在四个操作的对象位置——两处写法完全一致，这是刻意的：
   * 学一次 `list(X)`，哪里都认。
   */
  private parseListRef(): ListRef {
    const listTok = this.advance(); // 'list'
    this.expect(TokenKind.LParen, 'list 后应紧跟 (');

    const target = this.peek();
    let slot: number | null = null;
    let name = '';

    if (target.kind === TokenKind.Int) {
      slot = target.value as number;
      this.advance();
    } else if (target.kind === TokenKind.Ident) {
      name = target.lexeme;
      this.advance();
    } else {
      throw new LemonError({
        code: ErrorCodes.LIST_REF_SHAPE,
        phase: 'parse',
        message: `list(...) 里只能写列表的编号或名字，这里是 ${describeToken(target.kind)} '${target.lexeme}'`,
        span: target.span,
        hint: '编号写法 list(1)、list(2)；名字写法 list(分数)。要引用别的表达式，请先把它存进一个变量',
      });
    }

    const close = this.expect(TokenKind.RParen, 'list(...) 缺少配对的 )');
    return {
      kind: 'ListRef',
      slot,
      name,
      targetSpan: target.span,
      span: cover(listTok.span, close.span),
    };
  }

  /** `add list(X)`：建一个空列表。与 `add[元素] to list(X)` 靠有没有 `[` 区分 */
  private checkAddListDecl(): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.peek().lexeme === 'add' &&
      this.tokens[this.pos + 1]?.kind === TokenKind.Ident &&
      this.tokens[this.pos + 1]?.lexeme === 'list' &&
      this.tokens[this.pos + 2]?.kind === TokenKind.LParen
    );
  }

  /**
   * 四个列表操作的形状预判。`add` / `del` / `file` / `clear` 都是
   * **上下文关键字**：只有后面紧跟 `[` 或 `list (` 时才成立，因此
   * `text add = 1`、`say(file)` 这些既有写法不受影响。
   */
  private checkListOp(): ListOpKind | null {
    const head = this.peek();
    if (head.kind !== TokenKind.Ident) return null;
    const word = head.lexeme;
    if (word !== 'add' && word !== 'del' && word !== 'file' && word !== 'clear') return null;

    const next = this.tokens[this.pos + 1];
    if (next === undefined) return null;

    // add[元素] / del[元素] —— 操作一个元素
    if (next.kind === TokenKind.LBracket) {
      if (word === 'add') return 'addElement';
      if (word === 'del') return 'delElement';
      return null;
    }

    // 后面跟 list(X) 的三种：del 删掉整个列表，file / clear 操作内容。
    // `add list(X)`（建空列表）不在这里——它由 checkAddListDecl 接走，
    // 因为它在 AST 上就是"元素为空的 ListDecl"。
    const isListHead =
      next.kind === TokenKind.Ident &&
      next.lexeme === 'list' &&
      this.tokens[this.pos + 2]?.kind === TokenKind.LParen;
    if (!isListHead) return null;

    if (word === 'del') return 'deleteList';
    if (word === 'file') return 'file';
    if (word === 'clear') return 'clear';
    return null;
  }

  /**
   * add[元素] to list(X)     追加一个元素
   * del[元素] to list(X)     删掉第一个相等的元素
   * del list(X)              删掉整个列表
   * file list(X)             一行一个元素全部输出
   * clear list(X)            清空内容
   */
  private parseListOp(op: ListOpKind): ListOp {
    const opTok = this.advance(); // 操作关键字
    const word = opTok.lexeme; // add / del / file / clear，报错文案用原词

    let element: Expr | null = null;

    if (op === 'addElement' || op === 'delElement') {
      this.advance(); // '['
      element = this.parseExpr();
      this.expect(TokenKind.RBracket, `${word} 的元素缺少配对的 ]`);

      const toTok = this.peek();
      if (toTok.kind !== TokenKind.Ident || toTok.lexeme !== 'to') {
        throw new LemonError({
          code: ErrorCodes.EXPECTED_TOKEN,
          phase: 'parse',
          message: `${word} 之后要写 to list(目标)，这里遇到 ${describeToken(toTok.kind)} '${toTok.lexeme}'`,
          span: toTok.span,
          hint: `写法：${word}[元素] to list(1) 或 ${word}[元素] to list(分数)`,
        });
      }
      this.advance(); // 'to'
    }

    if (this.peek().kind !== TokenKind.Ident || this.peek().lexeme !== 'list') {
      const t = this.peek();
      const withElement = op === 'addElement' || op === 'delElement';
      throw new LemonError({
        code: ErrorCodes.EXPECTED_TOKEN,
        phase: 'parse',
        message: `${word} 之后要写 list(目标)，这里遇到 ${describeToken(t.kind)} '${t.lexeme}'`,
        span: t.span,
        hint: withElement
          ? `写法：${word}[元素] to list(1) 或 ${word}[元素] to list(分数)`
          : `写法：${word} list(1) 或 ${word} list(分数)`,
      });
    }

    const target = this.parseListRef();
    return {
      kind: 'ListOp',
      op,
      target,
      element,
      opSpan: opTok.span,
      span: cover(opTok.span, target.span),
    };
  }

  /**
   * `read` / `write` 作文件块上下文关键字的形状预判：标识符紧跟 `{`。
   * 不跟 `{` 时它们就是普通标识符，留给表达式语句照常处理。
   */
  private checkFileBlock(word: 'read' | 'save'): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.peek().lexeme === word &&
      this.tokens[this.pos + 1]?.kind === TokenKind.LBrace
    );
  }

  /**
   * 读取文件块。
   *
   *   read {
   *       name = "1.txt"
   *       according = "utf-8"
   *       read in list(1)
   *       read in say
   *       read in answer
   *   }
   *
   * 块内每行要么 `name = 表达式` / `according = 表达式`（配置键），要么
   * `read in <落点>`：`list(X)` 存列表、`say` 打印、`answer` 打开交互式选段。
   * 具体取值（文件名、编码、目标）的合法性交给静态检查兜底；这里只管形状。
   */
  private parseFileRead(): FileReadStmt {
    const readTok = this.advance(); // 'read'
    this.expect(TokenKind.LBrace, 'read 后应紧跟 {');

    let name: Expr | null = null;
    let encoding: Expr | null = null;
    const targets: ReadTarget[] = [];
    let interactive = false;

    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      const head = this.peek();

      if (head.kind === TokenKind.Ident && head.lexeme === 'name') {
        this.advance();
        this.expect(TokenKind.Assign, 'name 后应是 =', '写法：name = "1.txt"');
        name = this.parseExpr();
      } else if (head.kind === TokenKind.Ident && head.lexeme === 'according') {
        this.advance();
        this.expect(TokenKind.Assign, 'according 后应是 =', '写法：according = "utf-8"');
        encoding = this.parseExpr();
      } else if (head.kind === TokenKind.Ident && head.lexeme === 'read') {
        this.advance(); // 'read'
        const inTok = this.peek();
        if (inTok.kind !== TokenKind.Ident || inTok.lexeme !== 'in') {
          throw new LemonError({
            code: ErrorCodes.EXPECTED_TOKEN,
            phase: 'parse',
            message: `read 之后要写 in 目标，这里遇到 ${describeToken(inTok.kind)} '${inTok.lexeme}'`,
            span: inTok.span,
            hint: '写法：read in list(1) / read in say / read in answer',
          });
        }
        this.advance(); // 'in'
        const what = this.peek();
        if (what.kind === TokenKind.Ident && what.lexeme === 'say') {
          this.advance();
          targets.push({ kind: 'say' });
        } else if (what.kind === TokenKind.Ident && what.lexeme === 'answer') {
          this.advance();
          interactive = true;
        } else if (what.kind === TokenKind.Ident && what.lexeme === 'list') {
          targets.push({ kind: 'list', ref: this.parseListRef() });
        } else {
          throw new LemonError({
            code: ErrorCodes.EXPECTED_TOKEN,
            phase: 'parse',
            message: `read in 后面要跟 list(X) / say / answer，这里遇到 ${describeToken(what.kind)} '${what.lexeme}'`,
            span: what.span,
            hint: 'read in list(1) 把每行存进列表；read in say 打印内容；read in answer 交互式选段',
          });
        }
      } else {
        throw new LemonError({
          code: ErrorCodes.EXPECTED_TOKEN,
          phase: 'parse',
          message: `read 块里只认 name = / according = / read in ...，这里遇到 ${describeToken(head.kind)} '${head.lexeme}'`,
          span: head.span,
          hint: '块内合法行：name = "文件"、according = "utf-8"、read in list(1)、read in say、read in answer',
        });
      }

      this.expectStatementEnd();
    }

    const close = this.expect(TokenKind.RBrace, 'read 块缺少配对的 }');
    return {
      kind: 'FileRead',
      name,
      encoding,
      targets,
      interactive,
      span: cover(readTok.span, close.span),
    };
  }

  /**
   * 写入文件块。
   *
   *   write {
   *       name = "1.txt"
   *       according = "utf-8"
   *       write in list(1)
   *   }
   *
   * 块内每行要么配置键，要么 `write in list(X)`（确定要写出的列表）。
   */
  /**
   * 写入文件块。
   *
   *   save {
   *       name = "1.txt"
   *       according = "utf-8"
   *       save in list(1)
   *   }
   *
   * 块内每行要么配置键，要么 `save in list(X)`（确定要写出的列表）。
   */
  private parseFileSave(): FileSaveStmt {
    const saveTok = this.advance(); // 'save'
    this.expect(TokenKind.LBrace, 'save 后应紧跟 {');

    let name: Expr | null = null;
    let encoding: Expr | null = null;
    let source: ListRef | null = null;

    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      const head = this.peek();

      if (head.kind === TokenKind.Ident && head.lexeme === 'name') {
        this.advance();
        this.expect(TokenKind.Assign, 'name 后应是 =', '写法：name = "1.txt"');
        name = this.parseExpr();
      } else if (head.kind === TokenKind.Ident && head.lexeme === 'according') {
        this.advance();
        this.expect(TokenKind.Assign, 'according 后应是 =', '写法：according = "utf-8"');
        encoding = this.parseExpr();
      } else if (head.kind === TokenKind.Ident && head.lexeme === 'save') {
        this.advance(); // 'save'
        const inTok = this.peek();
        if (inTok.kind !== TokenKind.Ident || inTok.lexeme !== 'in') {
          throw new LemonError({
            code: ErrorCodes.EXPECTED_TOKEN,
            phase: 'parse',
            message: `save 之后要写 in list(X)，这里遇到 ${describeToken(inTok.kind)} '${inTok.lexeme}'`,
            span: inTok.span,
            hint: '写法：save in list(1)',
          });
        }
        this.advance(); // 'in'
        const what = this.peek();
        if (what.kind === TokenKind.Ident && what.lexeme === 'list') {
          source = this.parseListRef();
        } else {
          throw new LemonError({
            code: ErrorCodes.EXPECTED_TOKEN,
            phase: 'parse',
            message: `save in 后面要跟 list(X)，这里遇到 ${describeToken(what.kind)} '${what.lexeme}'`,
            span: what.span,
            hint: 'save in list(1) 把列表每个元素写一行到文件',
          });
        }
      } else {
        throw new LemonError({
          code: ErrorCodes.EXPECTED_TOKEN,
          phase: 'parse',
          message: `save 块里只认 name = / according = / save in ...，这里遇到 ${describeToken(head.kind)} '${head.lexeme}'`,
          span: head.span,
          hint: '块内合法行：name = "文件"、according = "utf-8"、save in list(1)',
        });
      }

      this.expectStatementEnd();
    }

    const close = this.expect(TokenKind.RBrace, 'save 块缺少配对的 }');
    return {
      kind: 'FileSave',
      name,
      encoding,
      source,
      span: cover(saveTok.span, close.span),
    };
  }

  private parseVarDecl(): VarDecl {
    const typeTok = this.advance();
    const typeName = TYPE_KEYWORDS.get(typeTok.kind);
    if (typeName === undefined) {
      throw this.internal(`未知类型关键字：${typeTok.lexeme}`, typeTok.span);
    }
    const nameTok = this.expect(TokenKind.Ident, '变量声明缺少变量名');
    this.expect(TokenKind.Assign, `变量 ${nameTok.lexeme} 声明缺少 =`);
    const initializer = this.parseExpr();
    return {
      kind: 'VarDecl',
      typeName,
      className: null,
      name: nameTok.lexeme,
      nameSpan: nameTok.span,
      initializer,
      span: cover(typeTok.span, initializer.span),
    };
  }

  private parseFuncDecl(isMain: boolean): FuncDecl {
    const startTok = this.advance();

    if (!isMain && this.check(TokenKind.KwMain)) {
      throw new LemonError({
        code: ErrorCodes.UNEXPECTED_TOKEN,
        phase: 'parse',
        message: 'main() 是主程序声明，不需要 def',
        span: this.peek().span,
        hint: '直接写成 main() { ... } 即可',
      });
    }

    let name: string;
    let nameSpan: Span;
    if (isMain) {
      name = 'main';
      nameSpan = startTok.span;
    } else {
      const nameTok = this.expect(TokenKind.Ident, 'def 后缺少函数名');
      name = nameTok.lexeme;
      nameSpan = nameTok.span;
    }

    this.expect(TokenKind.LParen, `函数 ${name} 缺少参数列表的 (`);
    const params = this.parseParams(name);

    if (isMain && params.length > 0) {
      throw new LemonError({
        code: ErrorCodes.MAIN_PARAMS,
        phase: 'parse',
        message: 'main() 不能带参数',
        span: nameSpan,
        hint: '请把需要的值改成 __init__ 顶层的变量',
      });
    }

    this.expect(TokenKind.LBrace, `函数 ${name} 缺少函数体的 {`);
    this.functionDepth += 1;
    const body = this.parseBlockBody(`函数 ${name} 的函数体`);
    this.functionDepth -= 1;
    const endBrace = this.expect(TokenKind.RBrace, `函数 ${name} 的函数体缺少配对的 }`);

    return {
      kind: 'FuncDecl',
      name,
      nameSpan,
      params,
      body,
      bodySpan: endBrace.span,
      isMain,
      span: cover(startTok.span, endBrace.span),
    };
  }

  private parseParams(fnName: string): Param[] {
    const params: Param[] = [];
    if (this.check(TokenKind.RParen)) {
      this.advance();
      return params;
    }
    const seen = new Set<string>();
    while (true) {
      const t = this.expect(TokenKind.Ident, `函数 ${fnName} 的参数名不合法`);
      if (seen.has(t.lexeme)) {
        throw new LemonError({
          code: ErrorCodes.DUPLICATE_PARAM,
          phase: 'parse',
          message: `函数 ${fnName} 的参数名 ${t.lexeme} 重复`,
          span: t.span,
          hint: '参数名必须互不相同',
        });
      }
      seen.add(t.lexeme);
      params.push({ name: t.lexeme, span: t.span });
      if (this.match(TokenKind.Comma)) continue;
      break;
    }
    this.expect(TokenKind.RParen, `函数 ${fnName} 的参数列表缺少配对的 )`);
    return params;
  }

  /* ------------------------------------------------------------------ */
  /* class：字段 + 方法                                                   */
  /* ------------------------------------------------------------------ */

  /** 上下文关键字：`class` `名字` `{` 三个 token 连写才算类声明 */
  private checkClassDecl(): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.peek().lexeme === 'class' &&
      this.tokens[this.pos + 1]?.kind === TokenKind.Ident &&
      this.tokens[this.pos + 2]?.kind === TokenKind.LBrace
    );
  }

  /** `<类名> <变量名> =` —— 用类名当类型的变量声明 */
  private checkClassVarDecl(): boolean {
    return (
      this.peek().kind === TokenKind.Ident &&
      this.tokens[this.pos + 1]?.kind === TokenKind.Ident &&
      this.tokens[this.pos + 2]?.kind === TokenKind.Assign
    );
  }

  /** `类名 变量 = 表达式` */
  private parseClassVarDecl(): VarDecl {
    const typeTok = this.advance(); // 类名
    const nameTok = this.expect(TokenKind.Ident, `变量声明缺少变量名`);
    this.expect(TokenKind.Assign, `变量 ${nameTok.lexeme} 声明缺少 =`);
    const initializer = this.parseExpr();
    return {
      kind: 'VarDecl',
      typeName: 'text', // className 非空时无意义，见 ast.ts 的说明
      className: typeTok.lexeme,
      name: nameTok.lexeme,
      nameSpan: nameTok.span,
      initializer,
      span: cover(typeTok.span, initializer.span),
    };
  }

  /**
   * `class 名字 { 字段... 方法... }`
   *
   * 字段形似变量声明但没有 `=`（`text 名字`）；方法就是 `def`，只是第一个
   * 参数约定叫 `self`（调用时绑定到对象）。
   */
  private parseClassDecl(): ClassDecl {
    const startTok = this.advance(); // 'class'
    const nameTok = this.expect(TokenKind.Ident, 'class 后应紧跟类名');
    this.expect(TokenKind.LBrace, `类 ${nameTok.lexeme} 后应紧跟 {`);

    const fields: ClassField[] = [];
    const methods: ClassMethod[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      if (isTypeKeyword(this.peek().kind)) {
        fields.push(this.parseClassField());
      } else if (this.check(TokenKind.KwDef)) {
        methods.push(this.parseClassMethod(nameTok.lexeme));
      } else {
        const t = this.peek();
        throw new LemonError({
          code: ErrorCodes.CLASS_ELEMENT,
          phase: 'parse',
          message: `类 ${nameTok.lexeme} 里只能写字段（如 text 名字）或方法（def 名字(...)），却遇到 ${describeToken(t.kind)} '${t.lexeme}'`,
          span: t.span,
          hint: '写法：class 学生 { text 名字  int 年龄  def 介绍(self) { say(self.名字) } }',
        });
      }
      this.expectStatementEnd();
    }

    const endBrace = this.expect(TokenKind.RBrace, `类 ${nameTok.lexeme} 缺少配对的 }`);
    return {
      kind: 'Class',
      name: nameTok.lexeme,
      nameSpan: nameTok.span,
      fields,
      methods,
      span: cover(startTok.span, endBrace.span),
    };
  }

  /** 字段：`text 名字` —— 类型 + 名字，没有初始值 */
  private parseClassField(): ClassField {
    const typeTok = this.advance();
    const typeName = TYPE_KEYWORDS.get(typeTok.kind);
    if (typeName === undefined) {
      throw this.internal(`未知类型关键字：${typeTok.lexeme}`, typeTok.span);
    }
    const nameTok = this.expect(TokenKind.Ident, '字段声明缺少字段名');
    return {
      kind: 'ClassField',
      name: nameTok.lexeme,
      nameSpan: nameTok.span,
      typeName,
      span: cover(typeTok.span, nameTok.span),
    };
  }

  /** 方法：`def 名字(self, 参数...) { 体 }` */
  private parseClassMethod(className: string): ClassMethod {
    const defTok = this.advance(); // 'def'
    const nameTok = this.expect(TokenKind.Ident, 'def 后缺少方法名');
    this.expect(TokenKind.LParen, `方法 ${nameTok.lexeme} 缺少参数列表的 (`);
    const params = this.parseParams(nameTok.lexeme);
    this.expect(TokenKind.LBrace, `方法 ${nameTok.lexeme} 缺少方法体的 {`);
    this.functionDepth += 1;
    const body = this.parseBlockBody(`方法 ${className}.${nameTok.lexeme} 的方法体`);
    this.functionDepth -= 1;
    const endBrace = this.expect(TokenKind.RBrace, `方法 ${nameTok.lexeme} 的方法体缺少配对的 }`);
    return {
      kind: 'ClassMethod',
      name: nameTok.lexeme,
      nameSpan: nameTok.span,
      params,
      body,
      bodySpan: endBrace.span,
      span: cover(defTok.span, endBrace.span),
    };
  }

  /** 解析一对 {} 内的语句列表；context 是用于报错文案的名词短语 */
  private parseBlockBody(context: string): Stmt[] {
    const body: Stmt[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      if (this.check(TokenKind.KwDef) || this.check(TokenKind.KwMain)) {
        const t = this.peek();
        throw new LemonError({
          code: ErrorCodes.NESTED_DEF,
          phase: 'parse',
          message: `Lemon 暂不支持在${context}内定义函数`,
          span: t.span,
          hint: `请把 ${t.lexeme} 声明移到 __init__ 顶层`,
        });
      }
      body.push(this.parseStatement(false));
      this.expectStatementEnd();
    }
    if (this.check(TokenKind.Eof)) {
      throw new LemonError({
        code: ErrorCodes.EXPECTED_TOKEN,
        phase: 'parse',
        message: `${context}缺少配对的 }`,
        span: this.peek().span,
        hint: '每个 { 都需要一个对应的 }',
      });
    }
    return body;
  }

  private parseExprStmt(): ExprStmt {
    const expr = this.parseExpr();

    /**
     * 表达式后面紧跟 `=`，只可能是"想重新赋值"。
     *
     * 不拦的话会掉进语句分隔规则，报成「两条语句之间缺少分隔，遇到 '='」——
     * 这句提示把人往"是不是少写分号"上带，而真正的原因是 Lemon 根本没有
     * 重新赋值语法。列表尤其容易踩：`分数[0] = 60` 是最自然的尝试动作。
     */
    if (this.check(TokenKind.Assign)) {
      const eq = this.peek();
      const onElement = expr.kind === 'Index';
      throw new LemonError({
        code: ErrorCodes.UNEXPECTED_TOKEN,
        phase: 'parse',
        message: onElement ? 'Lemon 不支持给列表元素赋值' : 'Lemon 不支持给变量重新赋值',
        span: eq.span,
        hint: onElement
          ? '列表是不可变的：没有追加、删除、按下标赋值。需要"改"就重新 list(名字) { ... } 造一个'
          : '一个名字只声明一次。要装新值请换个变量名；要装一串值请用 list(名字) { 元素 换行 元素 }',
      });
    }

    return { kind: 'ExprStmt', expr, span: expr.span };
  }

  /** 语句分隔：';' 可写可不写，靠换行判定 */
  private expectStatementEnd(): void {
    if (this.match(TokenKind.Semi)) {
      while (this.match(TokenKind.Semi)) {
        /* 允许连续分号 */
      }
      return;
    }
    const next = this.peek();
    if (next.kind === TokenKind.RBrace || next.kind === TokenKind.Eof) return;
    const prev = this.previous();
    if (next.span.line > prev.span.endLine) return;

    throw new LemonError({
      code: ErrorCodes.MISSING_STATEMENT_END,
      phase: 'parse',
      message: `两条语句之间缺少分隔，遇到 ${describeToken(next.kind)} '${next.lexeme}'`,
      span: next.span,
      hint: 'Lemon 以换行断句；写在同一行时需要用 ; 分隔',
    });
  }

  /* ------------------------------------------------------------------ */
  /* 表达式                                                              */
  /* ------------------------------------------------------------------ */

  private parseExpr(): Expr {
    return this.parseOr();
  }

  /** 逻辑或：最低优先级，左结合，短路求值 */
  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.check(TokenKind.OrOr)) {
      this.advance();
      left = binary('||', left, this.parseAnd());
    }
    return left;
  }

  /** 逻辑与：高于 ||，左结合，短路求值 */
  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.check(TokenKind.AndAnd)) {
      this.advance();
      left = binary('&&', left, this.parseComparison());
    }
    return left;
  }

  /**
   * 比较：高于 &&、低于加减。
   * 六个运算符（== != < <= > >=）同处一级、左结合，
   * 因此 a == b < c 解析为 (a == b) < c，随后由类型检查指出问题。
   */
  private parseComparison(): Expr {
    let left = this.parseAdditive();
    for (;;) {
      const op = COMPARISON_TOKENS.get(this.peek().kind);
      if (op === undefined) return left;
      this.advance();
      left = binary(op, left, this.parseAdditive());
    }
  }

  /** 加减：高于比较，左结合 */
  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.check(TokenKind.Plus) || this.check(TokenKind.Minus)) {
      const opTok = this.advance();
      left = binary(opTok.kind === TokenKind.Plus ? '+' : '-', left, this.parseMultiplicative());
    }
    return left;
  }

  /** 乘除：高于加减，左结合 */
  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.check(TokenKind.Star) || this.check(TokenKind.Slash)) {
      const opTok = this.advance();
      left = binary(opTok.kind === TokenKind.Star ? '*' : '/', left, this.parseUnary());
    }
    return left;
  }

  /**
   * 一元运算：取负、取正、逻辑非。
   * 高于乘除、右结合，因此 - -1 等于 1、!!flag 等于 flag。
   */
  private parseUnary(): Expr {
    const kind = this.peek().kind;
    if (kind === TokenKind.Minus || kind === TokenKind.Plus || kind === TokenKind.Bang) {
      const opTok = this.advance();
      const operand = this.parseUnary();
      const node: Unary = {
        kind: 'Unary',
        op: opTok.kind === TokenKind.Bang ? '!' : opTok.kind === TokenKind.Minus ? '-' : '+',
        operand,
        span: cover(opTok.span, operand.span),
      };
      return node;
    }
    return this.parsePower();
  }

  /**
   * 乘方：优先级高于一元正负号（所以 -2 ** 2 等于 -4），右结合。
   * 指数用 parseUnary 解析，因此 2 ** -1 合法。
   */
  private parsePower(): Expr {
    const base = this.parsePostfix();
    if (!this.check(TokenKind.StarStar)) return base;

    this.advance();
    const exponent = this.parseUnary();
    const node: Binary = {
      kind: 'Binary',
      op: '**',
      left: base,
      right: exponent,
      span: cover(base.span, exponent.span),
    };
    return node;
  }

  /**
   * 后缀运算：成员访问。绑定最紧，可以连写（a.b.c），也可以接在调用之后。
   */
  private parsePostfix(): Expr {
    let object = this.parseCallExpr();
    // `.` 与 `[` 同级、可以任意交替连写（a.b[0].c），所以放在同一个循环里
    for (;;) {
      if (this.check(TokenKind.Dot)) {
        this.advance();
        const propertyTok = this.expect(TokenKind.Ident, '. 后面应紧跟字段名或方法名');
        // `.方法(...)`：点号后紧跟 `(` 视为方法调用，否则是字段读取
        if (this.check(TokenKind.LParen)) {
          const { args, close } = this.parseArgList(`方法 ${propertyTok.lexeme}(...)`);
          const call: MethodCall = {
            kind: 'MethodCall',
            object,
            method: propertyTok.lexeme,
            methodSpan: propertyTok.span,
            args,
            span: cover(object.span, close.span),
          };
          object = call;
          continue;
        }
        const node: Member = {
          kind: 'Member',
          object,
          property: propertyTok.lexeme,
          propertySpan: propertyTok.span,
          span: cover(object.span, propertyTok.span),
        };
        object = node;
        continue;
      }
      if (this.check(TokenKind.LBracket)) {
        const open = this.advance();
        const index = this.parseExpr();
        const close = this.expect(TokenKind.RBracket, '下标缺少配对的 ]');
        const node: Index = {
          kind: 'Index',
          object,
          index,
          bracketSpan: open.span,
          span: cover(object.span, close.span),
        };
        object = node;
        continue;
      }
      break;
    }
    return object;
  }

  private parseCallExpr(): Expr {
    const expr = this.parsePrimary();
    // 标识符后紧跟 '(' 即视为调用。不要求同一行：允许把参数换行书写，
    // 例如 say(\n 你好\n)。由此带来的歧义由后续语句分隔规则兜住。
    if (expr.kind === 'Ident' && this.check(TokenKind.LParen)) {
      return this.parseCall(expr);
    }
    return expr;
  }

  private parseCall(callee: Ident): Call {
    const { args, close } = this.parseArgList(`调用 ${callee.name}(...)`);
    return { kind: 'Call', callee, args, span: cover(callee.span, close.span) };
  }

  /**
   * 解析一对 `( 实参... )`——调用方已确认当前 token 是 `(`。
   * 普通调用（`f(...)`）与方法调用（`obj.m(...)`）共用这段。
   */
  private parseArgList(label: string): { args: Expr[]; close: Token } {
    this.advance(); // '('
    const args: Expr[] = [];
    if (!this.check(TokenKind.RParen)) {
      while (true) {
        args.push(this.parseExpr());
        if (this.match(TokenKind.Comma)) continue;

        // 后面既不是 , 也不是 )，却又是一个表达式的开头：
        // 最常见的原因是写了带空格的裸文本（say(hello world)）或漏了逗号
        const next = this.peek();
        if (EXPRESSION_STARTERS.has(next.kind)) {
          throw new LemonError({
            code: ErrorCodes.EXPECTED_TOKEN,
            phase: 'parse',
            message: `${label} 的实参之间缺少 , —— 这里遇到 ${describeToken(next.kind)} '${next.lexeme}'`,
            span: next.span,
            hint: '裸文本不能含空格：要输出带空格的文本请加引号，例如 say("hello world")；多个实参则用 , 分隔',
          });
        }
        break;
      }
    }
    const close = this.expect(TokenKind.RParen, `${label} 缺少配对的 )`);
    return { args, close };
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case TokenKind.Int: {
        this.advance();
        const node: IntLit = { kind: 'IntLit', value: t.value as number, raw: t.lexeme, span: t.span };
        return node;
      }
      case TokenKind.Double: {
        this.advance();
        const node: DoubleLit = {
          kind: 'DoubleLit',
          value: t.value as number,
          raw: t.lexeme,
          span: t.span,
        };
        if (t.durationUnit !== undefined) node.durationUnit = t.durationUnit;
        return node;
      }
      case TokenKind.Text: {
        this.advance();
        const node: TextLit = {
          kind: 'TextLit',
          value: t.value as string,
          // 引号字符串与颜色字面量（#rrggbb）都是"显式写的字面量"，
          // 不算裸文本——因此 say(#ffffff) 不会被 E0344 要求加引号。
          bare: !t.lexeme.startsWith('"') && !t.lexeme.startsWith('#'),
          raw: t.lexeme,
          span: t.span,
        };
        return node;
      }
      case TokenKind.KwTrue:
      case TokenKind.KwFalse: {
        this.advance();
        const node: BoolLit = {
          kind: 'BoolLit',
          value: t.kind === TokenKind.KwTrue,
          raw: t.lexeme,
          span: t.span,
        };
        return node;
      }
      case TokenKind.Ident: {
        // `list(X)` 是列表引用，不是名字：say(list(1)) / len(list(1)) / list(1)[0]
        if (t.lexeme === 'list' && this.tokens[this.pos + 1]?.kind === TokenKind.LParen) {
          return this.parseListRef();
        }
        this.advance();
        const node: Ident = { kind: 'Ident', name: t.lexeme, span: t.span };
        return node;
      }
      case TokenKind.LParen: {
        const open = this.advance();
        const inner = this.parseExpr();
        const close = this.expect(TokenKind.RParen, '缺少配对的 )');
        return { ...inner, span: cover(open.span, close.span) };
      }
      case TokenKind.LBracket:
        // 方括号只用来取下标，没有方括号形式的列表字面量。这是最容易踩的
        // 一个坑（`[` `]` 在旧版本里报的是"暂不支持列表"），所以专门给一条
        // 指路的报错，而不是笼统的"此处应为表达式"
        throw new LemonError({
          code: ErrorCodes.UNEXPECTED_TOKEN,
          phase: 'parse',
          message: 'Lemon 没有方括号列表字面量',
          span: t.span,
          hint: '列表用块式声明：list(名字) { 元素 换行 元素 }；方括号只用来取下标，例如 名字[0]',
        });
      default:
        break;
    }

    throw new LemonError({
      code: ErrorCodes.UNEXPECTED_TOKEN,
      phase: 'parse',
      message: `此处应为表达式，实际遇到 ${describeToken(t.kind)}${t.lexeme ? ` '${t.lexeme}'` : ''}`,
      span: t.span,
    });
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private advance(): Token {
    const t = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }

  private match(kind: TokenKind): boolean {
    if (!this.check(kind)) return false;
    this.advance();
    return true;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.pos - 1)];
  }

  private expect(kind: TokenKind, message: string, hint?: string): Token {
    if (this.check(kind)) return this.advance();
    const t = this.peek();
    throw new LemonError({
      code: ErrorCodes.EXPECTED_TOKEN,
      phase: 'parse',
      message: `${message}，实际遇到 ${describeToken(t.kind)}${t.lexeme ? ` '${t.lexeme}'` : ''}`,
      span: t.span,
      hint,
    });
  }

  private internal(message: string, span: Span): LemonError {
    return new LemonError({ code: ErrorCodes.UNEXPECTED_TOKEN, phase: 'parse', message, span });
  }
}

/** 能作为表达式开头的 Token —— 在实参位置遇到它，说明漏了逗号或裸文本带了空格 */
const EXPRESSION_STARTERS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  TokenKind.Ident,
  TokenKind.Text,
  TokenKind.Int,
  TokenKind.Double,
  TokenKind.KwTrue,
  TokenKind.KwFalse,
  TokenKind.LParen,
]);

/** 已预留但尚未实现的关键字 → 报错时的功能名 */
const UNSUPPORTED_KEYWORDS = new Map<TokenKind, string>([
  [TokenKind.KwWhile, 'while 循环'],
  [TokenKind.KwFor, 'for 循环'],
  [TokenKind.KwContinue, 'continue'],
]);

/** 比较运算符 Token → AST 运算符名 */
const COMPARISON_TOKENS = new Map<TokenKind, BinaryOp>([
  [TokenKind.EqEq, '=='],
  [TokenKind.NotEq, '!='],
  [TokenKind.Lt, '<'],
  [TokenKind.Le, '<='],
  [TokenKind.Gt, '>'],
  [TokenKind.Ge, '>='],
]);

/** 以左右操作数构造二元节点，span 覆盖两者 */
function binary(op: BinaryOp, left: Expr, right: Expr): Binary {
  return { kind: 'Binary', op, left, right, span: cover(left.span, right.span) };
}

function cover(a: Span, b: Span): Span {
  return {
    line: a.line,
    col: a.col,
    endLine: b.endLine,
    endCol: b.endCol,
    start: a.start,
    end: b.end,
  };
}
