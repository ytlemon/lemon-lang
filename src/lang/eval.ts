/**
 * 树遍历求值器。
 *
 * 执行模型：
 *  1) 把所有 def（含 main）登记进全局环境（函数提升）；
 *  2) 按源码顺序执行 __init__ 的顶层语句；
 *  3) 最后调用 main()。
 *
 * 可靠性：
 *  - 显式维护调用深度计数，超限抛领域错误；
 *  - 捕获宿主 RangeError（栈溢出）转译为友好的"递归过深"提示；
 *  - 运行期错误附带 Lemon 层调用栈，不暴露宿主堆栈。
 */
import type { Span } from '../utils/source';
import type {
  AssignStmt,
  Binary,
  Call,
  CdStmt,
  ClassDecl,
  ClassMethod,
  CycleStmt,
  DeleteStmt,
  Expr,
  FileReadStmt,
  FileSaveStmt,
  FuncDecl,
  GameDecl,
  Ident,
  IfStmt,
  Index,
  OutputStmt,
  ListDecl,
  ListOp,
  ListRef,
  Member,
  MethodCall,
  Program,
  RunningStmt,
  Stmt,
  TryStmt,
  Unary,
  WebElement,
  WebSetsDecl,
} from './ast';
import { COMPARISON_OPS, LOGICAL_OPS, LOOP_INDEX_NAME, slotKey } from './ast';
import { getBuiltin, type BuiltinFn, type KeyboardInput } from './builtins';
import { Env } from './env';
import { ErrorCodes, LemonError, type Frame } from './errors';
import { DEFAULT_GAME_TITLE, type GameWindow } from './gamepage';
import { displayValue, UNIT, type FuncValue, type ListValue, type ObjectValue, type Value } from './value';
import { buttonNode, makePage, type WebNode, type WebPage, type WebRect } from './webpage';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { isAbsolute, relative, resolve as resolvePath } from 'path';

import { isModExt, runModSource } from '../../mod/src/index';

/** running 子进程的超时（毫秒）：卡住的程序不能把解释器一起拖死 */
const RUN_TIMEOUT_MS = 60_000;

/**
 * 把 `name` 解析到 `dir` 下，并确认没有逃出 dir。
 * 逃逸（写了 `..`、绝对路径，或指向 dir 本身）时返回 null，由调用方报错。
 */
function insideDir(dir: string, name: string): string | null {
  const target = resolvePath(dir, name);
  const rel = relative(dir, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

export const DEFAULT_MAX_DEPTH = 200;

/**
 * 两个值是否相等，供 `del[元素] to list(X)` 找要删的那一项。
 *
 * 语义与 `==` 保持一致：数字跨 int / double 比较（1 等于 1.0），
 * 文本与 bool 按值比较；列表、错误值这类复合值按**引用**比较
 * （语言里的 `==` 本来也不支持列表，这里不另立一套结构相等）。
 */
/**
 * 最外层的环境。
 *
 * 编号槽（`list(1)`）是**全局**容器，必须定义在根环境里：否则在函数体里
 * `add[7] to list(5)` 会把槽建在那个函数的作用域上，函数一返回就没了。
 * 读取侧不用它——`Env.lookup` 本来就会沿祖先链往上找。
 */
function rootEnv(env: Env): Env {
  let current = env;
  while (current.parent !== null) current = current.parent;
  return current;
}

function valuesEqual(a: Value, b: Value): boolean {
  const aNum = a.kind === 'int' || a.kind === 'double';
  const bNum = b.kind === 'int' || b.kind === 'double';
  if (aNum && bNum) return a.value === b.value;
  if (a.kind === 'text' && b.kind === 'text') return a.value === b.value;
  if (a.kind === 'bool' && b.kind === 'bool') return a.value === b.value;
  return a === b;
}

/**
 * 把文件内容按行切开，并去掉末尾因结尾换行产生的空元素。
 * 这样 "a\nb\nc" 与 "a\nb\nc\n" 都得到 ['a','b','c']，与 `file list(X)` 的
 * 写入格式（每个元素一行）正好可逆。
 */
function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 解析交互式选段的行号说明，支持：
 *   5          单行
 *   3-7        闭区间范围（3、4、5、6、7）
 *   3,5,7      逗号列举
 *   3-7,9      以上任意组合
 * 返回 1 基、升序、去重、且在 [1, total] 范围内的行号；越界与格式错误的部分直接忽略。
 */
function parseLineSpec(spec: string, total: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const addLine = (n: number): void => {
    if (n >= 1 && n <= total && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  for (const raw of spec.split(',')) {
    const tok = raw.trim();
    if (tok === '') continue;
    const range = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let lo = parseInt(range[1], 10);
      let hi = parseInt(range[2], 10);
      if (lo > hi) [lo, hi] = [hi, lo];
      for (let i = lo; i <= hi; i++) addLine(i);
      continue;
    }
    const single = tok.match(/^\d+$/);
    if (single) addLine(parseInt(single[0], 10));
  }
  out.sort((a, b) => a - b);
  return out;
}

/** 取值并强制为文本；不是文本就按运行期类型错误抛出 */
function expectText(value: Value, span: Span): string {
  if (value.kind !== 'text') {
    throw new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: `文件名 / 编码必须是文本（字符串），实际是 ${value.kind}`,
      span,
      hint: 'name = "1.txt" 这类要加引号；或在读之前把它存成文本变量',
    });
  }
  return value.value;
}

/**
 * break 的内部信号。
 *
 * 它不是错误，只是从循环体里跳出来的一条捷径；刻意**不继承 LemonError**，
 * 因此 `try / catch` 不会误抓它（evalTry 只认 LemonError），也不会附带调用栈。
 */
class BreakSignal extends Error {
  constructor() {
    super('break');
    this.name = 'BreakSignal';
  }
}

/**
 * return 的内部信号，与 BreakSignal 同一套路。
 *
 * 同样**不继承 LemonError**，于是：
 *   - `try / catch` 不会把 return 当成错误抓走（evalTry 只认 LemonError）
 *   - `cycle` 也不会拦住它（evalCycle 只认 BreakSignal）
 * 信号会一路穿出所有块，最后在 invokeFunction 里被接住。
 */
class ReturnSignal extends Error {
  readonly value: Value;

  constructor(value: Value) {
    super('return');
    this.name = 'ReturnSignal';
    this.value = value;
  }
}

/**
 * 从 `output` 文本开头的 `[tag]` 判断级别：
 * `error` / `warning` 走高优先级（stderr），其余（含 `log`、无标记）走 stdout。
 * 只认这三个标记，其它 `[xxx]` 一律当普通日志。
 */
function outputLevelOf(text: string): 'error' | 'warning' | 'log' {
  const match = /^\s*\[([A-Za-z]+)\]/.exec(text);
  if (match === null) return 'log';
  const tag = match[1].toLowerCase();
  if (tag === 'error') return 'error';
  if (tag === 'warning') return 'warning';
  return 'log';
}

export interface EvalOptions {
  /** stdout 写入器（不含隐式换行） */
  write(text: string): void;
  /** stderr 写入器；缺省时 error / warning 级别也走 write。`output` 用到 */
  writeError?(text: string): void;
  /** 最大调用深度，默认 200 */
  maxCallDepth?: number;
  /** 键盘输入源；缺省时 keyboard / waitKey 会报"当前环境拿不到键盘" */
  keyboard?: KeyboardInput;
  /**
   * 行输入源（供 `read in answer` 交互式选段用）：给定提示语，返回用户输的一行；
   * 拿不到终端（管道 / 重定向）时返回 null。缺省时交互式读取会报 E0410。
   */
  readLine?: (prompt: string) => string | null;
  /**
   * 本次编译额外可见的内置函数（`#incloud <模块名>` 启用的能力模块）。
   * 求值器与静态检查器拿到的必须是同一张表，否则会出现"查得到却调不到"。
   */
  builtins?: ReadonlyMap<string, BuiltinFn>;
}

export class Evaluator {
  private readonly options: EvalOptions;
  private readonly maxDepth: number;
  private depth = 0;
  private readonly frames: Frame[] = [];
  /** websets() 描述出的页面；没有 websets()（或还没跑完）时为 null */
  private page: WebPage | null = null;
  /** game() 描述出的窗口；没有 game() 时为 null */
  private game: GameWindow | null = null;
  /** game 命名空间的运行状态，供 game.running / game.quit 读写 */
  private gameState = { running: false, quit: false };
  /** fileskill：当前 cd 到的目录（绝对路径）栈；空表示不在任何 cd 块里 */
  private readonly dirStack: string[] = [];
  /** 类名 → 声明；构造与成员/方法访问都靠它 */
  private classes = new Map<string, ClassDecl>();
  /** 程序顶层环境，方法体以它为父作用域（方法能看到顶层变量，但看不到调用方的局部变量） */
  private programEnv: Env | null = null;

  constructor(options: EvalOptions) {
    this.options = options;
    this.maxDepth = options.maxCallDepth ?? DEFAULT_MAX_DEPTH;
  }

  /**
   * 本次运行产出的页面（`program.websets` 为 null 时恒为 null）。
   * 求值器只负责把它算成纯数据，写 .html 与打开浏览器是宿主（CLI）的事。
   */
  get webPage(): WebPage | null {
    return this.page;
  }

  /**
   * 本次运行产出的游戏窗口（`program.game` 为 null 时恒为 null）。
   * 与 webPage 同理：求值器只把它算成纯数据，写 .html 与打开浏览器是宿主（CLI）的事。
   */
  get gameWindow(): GameWindow | null {
    return this.game;
  }

  /* ------------------------------ 对外 API ------------------------------ */

  /** 把 def / main 登记进环境（函数提升，因此调用不受声明顺序限制） */
  defineFunctions(functions: FuncDecl[], env: Env): void {
    for (const fn of functions) {
      env.define(fn.name, { kind: 'func', decl: fn, closure: env });
    }
  }

  execStatements(statements: Stmt[], env: Env): void {
    for (const stmt of statements) {
      this.execStatement(stmt, env);
    }
  }

  /** 执行单条语句；表达式语句返回其值（其余返回 null），供 REPL 回显 */
  execStatement(stmt: Stmt, env: Env): Value | null {
    switch (stmt.kind) {
      case 'VarDecl': {
        const value = this.evalExpr(stmt.initializer, env);
        // 类类型声明：值必须是实例，不做标量转换
        if (stmt.className !== null) {
          if (value.kind !== 'object') {
            throw new LemonError({
              code: ErrorCodes.RUNTIME_TYPE,
              phase: 'runtime',
              message: `${stmt.name} 需要 ${stmt.className} 的实例，实际是 ${value.kind}`,
              span: stmt.nameSpan,
              hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
              frames: [...this.frames],
            });
          }
          env.define(stmt.name, value);
          return null;
        }
        env.define(stmt.name, coerceTo(value, stmt.typeName, stmt.nameSpan));
        return null;
      }
      case 'ExprStmt':
        return this.evalExpr(stmt.expr, env);
      case 'TryStmt':
        this.evalTry(stmt, env);
        return null;
      case 'IfStmt':
        this.evalIf(stmt, env);
        return null;
      case 'CycleStmt':
        this.evalCycle(stmt, env);
        return null;
      case 'BreakStmt':
        // 解析器保证 break 只出现在 cycle 体内，因此这个信号一定会被接住
        throw new BreakSignal();
      case 'ReturnStmt':
        // 光秃秃的 return 带着 unit 走，好让调用方统一按"有值"处理；
        // main() 里它等效于"提前结束程序"（返回值没人接，丢掉）
        throw new ReturnSignal(stmt.value === null ? UNIT : this.evalExpr(stmt.value, env));
      case 'ListDecl': {
        // 元素按书写顺序求值，全部算完才绑定名字——所以元素里引用不到
        // 这个名字本身（与 `int a = a` 是同一条规则）。
        // 不做 coerce：列表没有隐式转换可言
        const items = stmt.elements.map((element) => this.evalExpr(element, env));

        if (stmt.slot !== null) {
          // 编号槽：声明就是**初始化**（覆盖原有内容）。原地替换 items
          // 而不是换一个新对象，这样已经持有它的引用也能看到新内容。
          const key = slotKey(stmt.slot);
          const existing = env.lookup(key);
          if (existing !== undefined && existing.kind === 'list') {
            existing.items = items;
            return null;
          }
          rootEnv(env).define(key, { kind: 'list', items });
          return null;
        }

        env.define(stmt.name, { kind: 'list', items });
        return null;
      }
      case 'ListOp': {
        // del list(X)：把整个编号槽删掉。这里刻意不走 resolveListRef——
        // 那个是"用到就建"，先建再删等于白忙一场。删掉之后 `list(X)`
        // 会重新变回一个空槽（编号槽没有"未声明"这种状态）。
        // 命名列表的这种情况静态检查已经拦下（E0330），这里兜个底。
        if (stmt.op === 'deleteList') {
          if (stmt.target.slot !== null) rootEnv(env).undefine(slotKey(stmt.target.slot));
          return null;
        }

        const list = this.resolveListRef(stmt.target, env);
        switch (stmt.op) {
          case 'addElement':
            list.items.push(stmt.element === null ? UNIT : this.evalExpr(stmt.element, env));
            return null;
          case 'delElement': {
            const wanted = stmt.element === null ? UNIT : this.evalExpr(stmt.element, env);
            const at = list.items.findIndex((item) => valuesEqual(item, wanted));
            if (at < 0) {
              throw new LemonError({
                code: ErrorCodes.LIST_ELEMENT_NOT_FOUND,
                phase: 'runtime',
                message: `列表里没有 ${displayValue(wanted)}，删不掉`,
                span: stmt.element?.span ?? stmt.opSpan,
                hint: 'del[元素] to list(X) 只删第一个与它相等的元素。找不到就报错，不会静默跳过——这样写错值能立刻发现；要清空整个列表用 clear list(X)',
                frames: [...this.frames],
              });
            }
            list.items.splice(at, 1);
            return null;
          }
          case 'file':
            // 一行一个元素，与 say(列表) 的 [1, 2, 3] 形式刻意不同
            for (const item of list.items) this.options.write(`${displayValue(item)}\n`);
            return null;
          case 'clear':
            list.items.length = 0;
            return null;
          default:
            return null;
        }
      }
      case 'FileRead': {
        this.evalFileRead(stmt, env);
        return null;
      }
      case 'FileSave': {
        this.evalFileSave(stmt, env);
        return null;
      }
      case 'Assign':
        this.evalAssign(stmt, env);
        return null;
      case 'Output':
        this.evalOutput(stmt, env);
        return null;
      case 'Cd':
        this.evalCd(stmt, env);
        return null;
      case 'Running':
        this.evalRunning(stmt, env);
        return null;
      case 'Delete':
        this.evalDelete(stmt, env);
        return null;
      case 'FuncDecl':
      case 'WebSets':
      case 'Game':
      case 'Class':
        return null; // 声明本身不产生动作（页面/窗口在 runProgram 末尾统一生成）
      default:
        return null;
    }
  }

  /** 完整运行一个程序 */
  runProgram(program: Program, env: Env): void {
    this.page = null;
    this.game = null;
    this.gameState = { running: false, quit: false };
    this.programEnv = env;
    this.classes = new Map<string, ClassDecl>();
    for (const cls of program.classes) this.classes.set(cls.name, cls);
    this.defineFunctions(program.functions, env);
    if (program.main !== null) this.defineFunctions([program.main], env);

    for (const stmt of program.statements) {
      if (stmt.kind === 'FuncDecl') continue; // 已在上面登记
      this.execStatement(stmt, env);
    }

    if (program.main === null) {
      throw new LemonError({
        code: ErrorCodes.MISSING_MAIN,
        phase: 'runtime',
        message: '程序缺少 main() 主程序',
        span: program.initSpan,
        hint: '请在 __init__ 内声明 main() { ... }',
      });
    }

    const mainValue = env.lookup('main');
    if (mainValue === undefined || mainValue.kind !== 'func') {
      throw new LemonError({
        code: ErrorCodes.MISSING_MAIN,
        phase: 'runtime',
        message: 'main 未正确注册为函数',
        span: program.main.nameSpan,
      });
    }
    this.invokeFunction(mainValue, [], program.main.nameSpan);

    // 页面在 main() 之后才生成：to 里的地址可以引用 __init__ 顶层变量，
    // 到这一步它们的值都已经定下来了
    if (program.websets !== null) this.page = this.buildPage(program.websets, env);
    // 窗口同理：display.head 的标题可以引用变量
    if (program.game !== null) this.game = this.buildGameWindow(program.game, env);
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  private evalExpr(expr: Expr, env: Env): Value {
    switch (expr.kind) {
      case 'IntLit':
        return { kind: 'int', value: expr.value };
      case 'DoubleLit':
        return { kind: 'double', value: expr.value };
      case 'TextLit':
        return { kind: 'text', value: expr.value };
      case 'BoolLit':
        return { kind: 'bool', value: expr.value };
      case 'Ident':
        return this.evalIdent(expr, env);
      case 'Call':
        return this.evalCall(expr, env);
      case 'Binary':
        return this.evalBinary(expr, env);
      case 'Unary':
        return this.evalUnary(expr, env);
      case 'Member':
        return this.evalMember(expr, env);
      case 'MethodCall':
        return this.evalMethodCall(expr, env);
      case 'Index':
        return this.evalIndex(expr, env);
      case 'ListRef':
        return this.resolveListRef(expr, env);
      default:
        return UNIT;
    }
  }

  /**
   * 列表引用求值。
   *
   *   编号槽 `list(1)`：用保留键名（`#slot1`）存在环境里，**用到就存在**——
   *     编号槽是全局容器，没有"未声明"这种状态。存环境里而不是求值器字段，
   *     是为了 REPL 跨片段也能保持（会话复用的是同一个 Env）。
   *   命名 `list(分数)`：就是普通的变量查找，静态检查已经验过它是列表。
   */
  private resolveListRef(expr: ListRef, env: Env): ListValue {
    if (expr.slot !== null) {
      const key = slotKey(expr.slot);
      const existing = env.lookup(key);
      if (existing !== undefined && existing.kind === 'list') return existing;
      const created: ListValue = { kind: 'list', items: [] };
      rootEnv(env).define(key, created);
      return created;
    }

    const value = env.lookup(expr.name);
    if (value === undefined || value.kind !== 'list') {
      throw new LemonError({
        code: ErrorCodes.RUNTIME_TYPE,
        phase: 'runtime',
        message: `list(${expr.name}) 不是一个列表`,
        span: expr.targetSpan,
        hint: 'list(X) 只能引用列表：编号写法 list(1)，名字写法 list(分数)（那个变量必须是列表）',
        frames: [...this.frames],
      });
    }
    return value;
  }

  /**
   * 读取文件块 `read { ... }`。
   *
   * 一次 IO 把文件读进来，按行拆分；交互式选段（read in answer）时先在终端问
   * 用户要哪些行，再筛出对应行。最后按落点扇出：存进列表（每行一个文本元素）
   * 和/或打印内容。
   */
  private evalFileRead(stmt: FileReadStmt, env: Env): void {
    const filename =
      stmt.name === null ? '' : expectText(this.evalExpr(stmt.name, env), stmt.name.span);
    const encoding =
      stmt.encoding === null
        ? 'utf-8'
        : expectText(this.evalExpr(stmt.encoding, env), stmt.encoding.span);

    let content: string;
    try {
      content = readFileSync(filename, { encoding: encoding as BufferEncoding });
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        throw new LemonError({
          code: ErrorCodes.FILE_NOT_FOUND,
          phase: 'runtime',
          message: `找不到文件 ${filename}`,
          span: stmt.name?.span ?? stmt.span,
          hint: '检查文件名与相对路径：相对路径以运行命令时的目录为基准',
          frames: [...this.frames],
        });
      }
      throw new LemonError({
        code: ErrorCodes.READ_FAILED,
        phase: 'runtime',
        message: `读文件 ${filename} 失败：${(error as Error).message}`,
        span: stmt.name?.span ?? stmt.span,
        hint: `编码 ${encoding} 可能不被支持（目前最稳妥的是 utf-8）`,
        frames: [...this.frames],
      });
    }

    // 去掉 Windows 常见的 UTF-8 BOM，避免它混进第一行元素
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

    const allLines = splitLines(content);

    let selected: string[];
    if (stmt.interactive) {
      if (this.options.readLine === undefined) {
        throw new LemonError({
          code: ErrorCodes.KEYBOARD_UNAVAILABLE,
          phase: 'runtime',
          message: 'read in answer 需要真实终端来询问"读哪一部分"，当前环境拿不到键盘输入',
          span: stmt.span,
          hint: '请把程序写成 .lemon1 文件后用 lemon 运行（管道 / 重定向里无法交互选段）',
          frames: [...this.frames],
        });
      }
      const answer = this.options.readLine('要读哪一部分？（行号，如 3、3-7、3,5,7）\n');
      if (answer === null) {
        throw new LemonError({
          code: ErrorCodes.KEYBOARD_UNAVAILABLE,
          phase: 'runtime',
          message: 'read in answer 读不到用户输入（非终端环境）',
          span: stmt.span,
          hint: '交互式选段只能在真实终端里进行',
          frames: [...this.frames],
        });
      }
      selected = parseLineSpec(answer, allLines.length).map((i) => allLines[i - 1]);
    } else {
      selected = allLines;
    }

    for (const target of stmt.targets) {
      if (target.kind === 'say') {
        if (selected.length > 0) this.options.write(`${selected.join('\n')}\n`);
      } else {
        const list = this.resolveListRef(target.ref, env);
        list.items = selected.map((line) => ({ kind: 'text', value: line }));
      }
    }
  }

  /**
   * 写入文件块 `write { ... }`。
   *
   * 序列化方式与 `file list(X)` / `read in list(1)` 对称：列表每个元素写一行，
   * 读回来能原样还原。覆盖写（不追加）。
   */
  private evalFileSave(stmt: FileSaveStmt, env: Env): void {
    const filename =
      stmt.name === null ? '' : expectText(this.evalExpr(stmt.name, env), stmt.name.span);
    const encoding =
      stmt.encoding === null
        ? 'utf-8'
        : expectText(this.evalExpr(stmt.encoding, env), stmt.encoding.span);
    const list = stmt.source === null ? null : this.resolveListRef(stmt.source, env);

    const items = list?.items ?? [];
    const content = items.map((item) => displayValue(item)).join('\n') + (items.length > 0 ? '\n' : '');

    try {
      writeFileSync(filename, content, encoding as BufferEncoding);
    } catch (error) {
      throw new LemonError({
        code: ErrorCodes.WRITE_FAILED,
        phase: 'runtime',
        message: `写文件 ${filename} 失败：${(error as Error).message}`,
        span: stmt.name?.span ?? stmt.span,
        hint: '检查路径是否可写、磁盘是否已满；相对路径以运行命令时的目录为基准',
        frames: [...this.frames],
      });
    }
  }

  /* ---------------------------- fileskill ---------------------------- */

  /** 当前 cd 到的目录；不在 cd 块里时为 null */
  private currentDir(): string | null {
    return this.dirStack.length === 0 ? null : this.dirStack[this.dirStack.length - 1]!;
  }

  /** `cd <目录> { ... }`：锁定目录后执行块体（块内再嵌套 cd 会继续压栈） */
  private evalCd(stmt: CdStmt, env: Env): void {
    const dir = resolvePath(expectText(this.evalExpr(stmt.path, env), stmt.path.span));

    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new LemonError({
        code: ErrorCodes.CD_FAILED,
        phase: 'runtime',
        message: `cd 的目录不存在或不是文件夹：${dir}`,
        span: stmt.path.span,
        hint: '检查路径拼写；Windows 路径里的反斜杠要写成 \\\\（或直接用 /），例如 cd "e:/traingame"',
        frames: [...this.frames],
      });
    }

    this.dirStack.push(dir);
    try {
      for (const inner of stmt.body) this.execStatement(inner, env);
    } finally {
      this.dirStack.pop();
    }
  }

  /**
   * `running "<文件>"`：在 cd 目录里运行一个文件，输出原样转发。
   * 目标必须落在 cd 目录内；子进程返回非 0 会报错（可用 try / catch 兜住）。
   *
   * `.lemon2` 是例外：它是 lemon2（lemonmod）程序，由 lemon1 内置的 lemonmod
   * 解释器就地执行（不起子进程）。
   */
  private evalRunning(stmt: RunningStmt, env: Env): void {
    const dir = this.currentDir();
    const name = expectText(this.evalExpr(stmt.file, env), stmt.file.span);
    if (dir === null) {
      throw this.fileskillOutsideCd('running', stmt.span);
    }

    const target = insideDir(dir, name);
    if (target === null) {
      throw new LemonError({
        code: ErrorCodes.FILESKILL_ESCAPE,
        phase: 'runtime',
        message: `running 只能运行 ${dir} 里的文件，不能跑 ${name}`,
        span: stmt.file.span,
        hint: '文件名不能写 .. 或绝对路径；它必须是 cd 目录里的一个文件',
        frames: [...this.frames],
      });
    }
    if (!existsSync(target)) {
      throw new LemonError({
        code: ErrorCodes.RUN_FAILED,
        phase: 'runtime',
        message: `要运行的 ${name} 不存在（应在 ${dir} 里）`,
        span: stmt.file.span,
        hint: '检查文件名，以及它是否就在 cd 指定的目录里',
        frames: [...this.frames],
      });
    }

    const ext = target.slice(target.lastIndexOf('.')).toLowerCase();

    // .lemon2 / .mod1：lemon2（lemonmod）程序。lemon1 已内置 lemonmod 解释器，
    // 就地执行即可，也不必（更没法）把它当子进程 spawn。.mod1 是构建清单，
    // 其内相对路径（源 / 产物）基于 cd 目录解析，故传入 baseDir。
    if (isModExt(target)) {
      let text: string;
      try {
        text = readFileSync(target, 'utf8');
      } catch (error) {
        throw new LemonError({
          code: ErrorCodes.RUN_FAILED,
          phase: 'runtime',
          message: `读不到 ${name}：${(error as Error).message}`,
          span: stmt.file.span,
          hint: '确认文件可读，且确实在 cd 指定的目录里',
          frames: [...this.frames],
        });
      }
      const modResult = runModSource(text, { baseDir: dir });
      if (modResult.stdout.length > 0) this.options.write(modResult.stdout);
      if (!modResult.ok) {
        const detail =
          modResult.error === null ? '未知错误' : `${modResult.error.code} ${modResult.error.message}`;
        throw new LemonError({
          code: ErrorCodes.RUN_FAILED,
          phase: 'runtime',
          message: `${name} 运行失败：${detail}`,
          span: stmt.file.span,
          hint: '这是 lemon2（lemonmod）程序，错误码以 M 开头；可用 try / catch 兜住',
          frames: [...this.frames],
        });
      }
      return;
    }

    // Windows 上 .bat / .cmd 要通过 cmd /c 才能执行
    const isBatch = process.platform === 'win32' && (ext === '.bat' || ext === '.cmd');
    const command = isBatch ? { file: 'cmd', argv: ['/c', target] } : { file: target, argv: [] as string[] };

    const result = spawnSync(command.file, command.argv, {
      cwd: dir,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });

    if (result.stdout) this.options.write(result.stdout);
    if (result.stderr) (this.options.writeError ?? this.options.write)(result.stderr);

    if (result.error !== undefined) {
      throw new LemonError({
        code: ErrorCodes.RUN_FAILED,
        phase: 'runtime',
        message: `运行 ${name} 失败：${result.error.message}`,
        span: stmt.file.span,
        hint: '这个文件能直接运行吗？.bat / .cmd / .exe 可以；其它类型需要它自己有可执行权限',
        frames: [...this.frames],
      });
    }
    if (result.status !== 0) {
      throw new LemonError({
        code: ErrorCodes.RUN_FAILED,
        phase: 'runtime',
        message: `${name} 退出码 ${String(result.status)}`,
        span: stmt.file.span,
        hint: '子进程返回了非 0；可以用 try / catch 兜住继续跑',
        frames: [...this.frames],
      });
    }
  }

  /** `delete "<文件>"`：删除 cd 目录里的一个文件（只删文件，不删目录、不递归） */
  private evalDelete(stmt: DeleteStmt, env: Env): void {
    const dir = this.currentDir();
    const name = expectText(this.evalExpr(stmt.file, env), stmt.file.span);
    if (dir === null) {
      throw this.fileskillOutsideCd('delete', stmt.span);
    }

    const target = insideDir(dir, name);
    if (target === null) {
      throw new LemonError({
        code: ErrorCodes.FILESKILL_ESCAPE,
        phase: 'runtime',
        message: `delete 只能删 ${dir} 里的文件，不能删 ${name}`,
        span: stmt.file.span,
        hint: '文件名不能写 .. 或绝对路径；它必须是 cd 目录里的一个文件',
        frames: [...this.frames],
      });
    }

    let stat;
    try {
      stat = statSync(target);
    } catch {
      throw new LemonError({
        code: ErrorCodes.DELETE_FAILED,
        phase: 'runtime',
        message: `要删除的 ${name} 不存在（应在 ${dir} 里）`,
        span: stmt.file.span,
        hint: '确认文件名，以及它是否就在 cd 指定的目录里',
        frames: [...this.frames],
      });
    }
    if (stat.isDirectory()) {
      throw new LemonError({
        code: ErrorCodes.DELETE_FAILED,
        phase: 'runtime',
        message: `delete 只能删文件，不能删文件夹：${name}`,
        span: stmt.file.span,
        hint: '这是防误删的保护：要删文件夹请在系统里自己操作',
        frames: [...this.frames],
      });
    }

    try {
      unlinkSync(target);
    } catch (error) {
      throw new LemonError({
        code: ErrorCodes.DELETE_FAILED,
        phase: 'runtime',
        message: `删除 ${name} 失败：${(error as Error).message}`,
        span: stmt.file.span,
        hint: '文件可能正被别的程序占用，或当前用户没有权限',
        frames: [...this.frames],
      });
    }
  }

  /** running / delete 出现在 cd 之外时的兜底（静态检查本应先拦下） */
  private fileskillOutsideCd(word: string, span: Span): LemonError {
    return new LemonError({
      code: ErrorCodes.FILESKILL_SHAPE,
      phase: 'runtime',
      message: `${word} 只能写在 cd 块里`,
      span,
      hint: '先用 cd "目录" { ... } 锁定一个目录',
      frames: [...this.frames],
    });
  }

  /**
   * 下标读取 `列表[下标]`。
   *
   * 静态检查能确定的都拦下了；这里兜的是类型为 `any` 的值（函数参数传进来的）
   * 与**长度**——长度静态无从得知，越界只能到运行期才发现。
   * 越界不返回 unit 之类的空值，而是直接报错，避免把问题拖到更远的地方。
   */
  private evalIndex(expr: Index, env: Env): Value {
    const object = this.evalExpr(expr.object, env);
    if (object.kind !== 'list') {
      throw new LemonError({
        code: ErrorCodes.RUNTIME_TYPE,
        phase: 'runtime',
        message: `${object.kind} 类型的值不能取下标`,
        span: expr.object.span,
        hint: '只有列表能取下标：list(名字) { 元素 换行 元素 } 声明之后写 名字[0]',
        frames: [...this.frames],
      });
    }

    const index = this.evalExpr(expr.index, env);
    if (index.kind !== 'int') {
      throw new LemonError({
        code: ErrorCodes.RUNTIME_TYPE,
        phase: 'runtime',
        message: `下标必须是 int（整数），实际是 ${index.kind}`,
        span: expr.index.span,
        hint: '下标从 0 开始：名字[0] 是第一个元素，名字[1] 是第二个',
        frames: [...this.frames],
      });
    }

    const at = index.value;
    if (at < 0 || at >= object.items.length) {
      throw new LemonError({
        code: ErrorCodes.INDEX_OUT_OF_RANGE,
        phase: 'runtime',
        message: `下标 ${at} 越界：这个列表一共有 ${object.items.length} 个元素`,
        span: expr.bracketSpan,
        hint:
          object.items.length === 0
            ? '这个列表是空的，没有任何元素可以取'
            : `可用的下标是 0 到 ${object.items.length - 1}`,
        frames: [...this.frames],
      });
    }
    return object.items[at];
  }

  /** 成员访问：错误值的 code / line / message，或 game 的运行状态 */
  private evalMember(expr: Member, env: Env): Value {
    // game 命名空间：running / quit 都是 bool 状态
    if (expr.object.kind === 'Ident' && expr.object.name === 'game') {
      switch (expr.property) {
        case 'running':
          return { kind: 'bool', value: this.gameState.running };
        case 'quit':
          return { kind: 'bool', value: this.gameState.quit };
        default:
          throw new LemonError({
            code: ErrorCodes.INVALID_MEMBER,
            phase: 'runtime',
            message: `game 没有 '${expr.property}' 字段`,
            span: expr.propertySpan,
            hint: '可用的字段：running（是否运行）、quit（是否退出）',
            frames: [...this.frames],
          });
      }
    }

    const object = this.evalExpr(expr.object, env);
    if (object.kind === 'object') {
      const field = object.fields.get(expr.property);
      if (field === undefined) {
        throw new LemonError({
          code: ErrorCodes.INVALID_MEMBER,
          phase: 'runtime',
          message: `类 ${object.className} 没有字段 '${expr.property}'`,
          span: expr.propertySpan,
          hint: `可用字段：${[...object.fields.keys()].join('、') || '（无）'}`,
          frames: [...this.frames],
        });
      }
      return field;
    }
    if (object.kind !== 'error') {
      throw new LemonError({
        code: ErrorCodes.RUNTIME_TYPE,
        phase: 'runtime',
        message: `${object.kind} 类型的值没有 '${expr.property}' 字段`,
        span: expr.span,
        hint: '只有 catch 捕获到的错误值才有 code / line / message 字段',
        frames: [...this.frames],
      });
    }

    switch (expr.property) {
      case 'code':
        return { kind: 'text', value: object.code };
      case 'message':
        return { kind: 'text', value: object.message };
      case 'line':
        return { kind: 'int', value: object.line };
      default:
        throw new LemonError({
          code: ErrorCodes.INVALID_MEMBER,
          phase: 'runtime',
          message: `错误值没有 '${expr.property}' 字段`,
          span: expr.propertySpan,
          hint: '可用的字段：code（错误码）、line（行号）、message（说明）',
          frames: [...this.frames],
        });
    }
  }

  /**
   * if / elif / else：按顺序求值条件，命中第一个为 true 的分支后执行其语句块。
   * 没有命中的条件不会被求值（`&&` / `||` 的短路同理），因此条件里不要写有副作用的调用。
   * 条件都求值为 false 且没有 else 时，什么都不做。
   */
  private evalIf(stmt: IfStmt, env: Env): void {
    for (const branch of stmt.branches) {
      if (branch.condition === null) {
        this.execBlock(branch.body, env); // else：无条件执行
        return;
      }

      const value = this.evalExpr(branch.condition, env);
      if (value.kind !== 'bool') {
        throw new LemonError({
          code: ErrorCodes.RUNTIME_TYPE,
          phase: 'runtime',
          message: `${branch.kind} 的条件必须是 bool（真假值），实际是 ${value.kind}`,
          span: branch.condition.span,
          hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
          frames: [...this.frames],
        });
      }
      if (value.value) {
        this.execBlock(branch.body, env);
        return;
      }
    }
  }

  /**
   * 把 websets() 的描述求值成页面数据。
   *
   * `to` 的地址在这里求值，所以它可以引用变量：
   *   text 地址 = "localhost:9000"
   *   button { to 地址 }
   *
   * 静态检查已经保证地址是 text，元素结构也校验过；这里的检查只是兜底。
   */
  private buildPage(decl: WebSetsDecl, env: Env): WebPage {
    const init = decl.init;
    if (init === null) return makePage([]);
    return makePage(this.buildWebNodes(init.elements, env));
  }

  /** 递归把 websets 元素求值成页面节点（按钮 / div / 文本） */
  private buildWebNodes(elements: WebElement[], env: Env): WebNode[] {
    const nodes: WebNode[] = [];
    for (const element of elements) {
      switch (element.kind) {
        case 'WebButton': {
          if (element.to === null) continue;
          nodes.push(buttonNode(this.webText(element.to.target, env, 'to 的地址')));
          break;
        }
        case 'WebText': {
          nodes.push({ kind: 'text', text: this.webText(element.value, env, 'div 里的文本') });
          break;
        }
        case 'WebDiv': {
          let box: WebRect | null = null;
          if (element.box !== null) {
            const left = this.webCoord(element.box.left, env);
            const top = this.webCoord(element.box.top, env);
            const right = this.webCoord(element.box.right, env);
            const bottom = this.webCoord(element.box.bottom, env);
            box = { left, top, width: right - left, height: bottom - top };
          }
          let color: string | null = null;
          if (element.color !== null) color = this.webText(element.color, env, 'div 的 color');
          nodes.push({ kind: 'div', box, color, children: this.buildWebNodes(element.children, env) });
          break;
        }
      }
    }
    return nodes;
  }

  /** 求值一个必须是 text 的 websets 子表达式；静态检查已保证，这里是兜底 */
  private webText(expr: Expr, env: Env, what: string): string {
    const value = this.evalExpr(expr, env);
    if (value.kind === 'text') return value.value;
    throw new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: `${what}必须是 text（文本），实际是 ${value.kind}`,
      span: expr.span,
      hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
      frames: [...this.frames],
    });
  }

  /** 求值一个坐标（int 或 double） */
  private webCoord(expr: Expr, env: Env): number {
    const value = this.evalExpr(expr, env);
    if (value.kind === 'int' || value.kind === 'double') return value.value;
    throw new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: `in(...) 的坐标必须是数字，实际是 ${value.kind}`,
      span: expr.span,
      hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
      frames: [...this.frames],
    });
  }

  /**
   * `game.running = True` 这类赋值。
   * 静态检查已经保证目标是 game.running / game.quit 且值为 bool，这里只做兜底。
   */
  private evalAssign(stmt: AssignStmt, env: Env): void {
    const value = this.evalExpr(stmt.value, env);
    if (value.kind !== 'bool') {
      throw new LemonError({
        code: ErrorCodes.RUNTIME_TYPE,
        phase: 'runtime',
        message: `game.${stmt.property} 只能赋 bool，实际是 ${value.kind}`,
        span: stmt.value.span,
        hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
        frames: [...this.frames],
      });
    }
    if (stmt.property === 'running') this.gameState.running = value.value;
    else if (stmt.property === 'quit') this.gameState.quit = value.value;
  }

  /**
   * 带级别的输出：`[error]` / `[warning]` 走 stderr，其余（含 `[log]`、无标记）走 stdout。
   * 标记本身原样打印。
   */
  private evalOutput(stmt: OutputStmt, env: Env): void {
    const value = this.evalExpr(stmt.value, env);
    if (value.kind !== 'text') {
      throw new LemonError({
        code: ErrorCodes.RUNTIME_TYPE,
        phase: 'runtime',
        message: `output 需要一段文本，实际是 ${value.kind}`,
        span: stmt.value.span,
        hint: '把要输出的内容用引号括起来，例如 output "[log]已完成"',
        frames: [...this.frames],
      });
    }
    const text = value.value;
    const sink =
      outputLevelOf(text) === 'log'
        ? this.options.write
        : (this.options.writeError ?? this.options.write);
    sink(`${text}\n`);
  }

  /**
   * 把 game() 的描述求值成窗口数据。
   *
   * display.head 的标题可以引用变量，所以在这里求值。缺省窗口 800×600，
   * 标题为 DEFAULT_GAME_TITLE——静态检查已经保证类型，这里的判断只是兜底。
   */
  private buildGameWindow(decl: GameDecl, env: Env): GameWindow {
    let width = 800;
    let height = 600;
    let title = DEFAULT_GAME_TITLE;
    const init = decl.init;
    if (init !== null) {
      for (const element of init.elements) {
        if (element.kind === 'DisplayWin') {
          const widthValue = this.evalExpr(element.width, env);
          const heightValue = this.evalExpr(element.height, env);
          if (widthValue.kind !== 'int' || heightValue.kind !== 'int') {
            throw new LemonError({
              code: ErrorCodes.RUNTIME_TYPE,
              phase: 'runtime',
              message: 'display.win 的宽高必须是 int（整数）',
              span: element.span,
              hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
              frames: [...this.frames],
            });
          }
          width = widthValue.value;
          height = heightValue.value;
        } else if (element.kind === 'DisplayHead') {
          const titleValue = this.evalExpr(element.title, env);
          if (titleValue.kind !== 'text') {
            throw new LemonError({
              code: ErrorCodes.RUNTIME_TYPE,
              phase: 'runtime',
              message: 'display.head 的标题必须是 text（文本）',
              span: element.title.span,
              hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
              frames: [...this.frames],
            });
          }
          title = titleValue.value;
        }
      }
    }
    return { width, height, title };
  }

  /** 在子作用域里执行一组语句（`{ ... }` 块共用） */
  private execBlock(body: Stmt[], env: Env): void {
    const scope = new Env(env);
    for (const inner of body) this.execStatement(inner, scope);
  }

  /**
   * cycle 循环。
   *   cycle(N)   执行 N 轮；N <= 0 时一轮都不执行
   *   cycle()    无限循环，只能靠 break（或运行期错误）结束
   *
   * 每轮都是**全新的作用域**，体内绑定轮次变量 `i`（从 0 开始）。
   * `break` 通过 BreakSignal 跳出，只影响最内层的这个 cycle。
   */
  private evalCycle(stmt: CycleStmt, env: Env): void {
    let count = Number.POSITIVE_INFINITY;

    if (stmt.count !== null) {
      const value = this.evalExpr(stmt.count, env);
      if (value.kind !== 'int') {
        throw new LemonError({
          code: ErrorCodes.RUNTIME_TYPE,
          phase: 'runtime',
          message: `cycle 的次数必须是 int（整数），实际是 ${value.kind}`,
          span: stmt.count.span,
          hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
          frames: [...this.frames],
        });
      }
      if (value.value < 0) {
        throw new LemonError({
          code: ErrorCodes.NEGATIVE_CYCLE_COUNT,
          phase: 'runtime',
          message: `cycle 的次数不能为负（这里是 ${value.value}）`,
          span: stmt.count.span,
          hint: 'cycle(0) 表示一次都不执行；请检查次数的计算方式',
          frames: [...this.frames],
        });
      }
      count = value.value;
    }

    for (let index = 0; index < count; index += 1) {
      const scope = new Env(env);
      scope.define(LOOP_INDEX_NAME, { kind: 'int', value: index });
      try {
        for (const inner of stmt.body) this.execStatement(inner, scope);
      } catch (error) {
        if (error instanceof BreakSignal) return; // break：跳出整个循环
        throw error;
      }
    }
  }

  /**
   * try / catch：捕获 try 块内（含其调用的函数）抛出的运行期错误。
   * catch 块自身抛出的错误继续向外传播。
   */
  private evalTry(stmt: TryStmt, env: Env): void {
    try {
      this.execBlock(stmt.body, env);
    } catch (error) {
      if (!(error instanceof LemonError)) throw error;

      const scope = new Env(env);
      scope.define(stmt.catchName, {
        kind: 'error',
        code: error.code,
        message: error.message,
        line: error.span.line,
      });
      for (const inner of stmt.catchBody) this.execStatement(inner, scope);
    }
  }

  /**
   * 一元运算。
   *   '-' / '+'  保持操作数类型（int 还是 int，double 还是 double）
   *   '!'        逻辑取反，操作数必须是 bool
   */
  private evalUnary(expr: Unary, env: Env): Value {
    const operand = this.evalExpr(expr.operand, env);

    if (expr.op === '!') {
      return { kind: 'bool', value: !this.boolOperand(operand, expr.operand.span, '!') };
    }

    const value = this.numericOperand(operand, expr.operand.span);
    const signed = expr.op === '-' ? -value : value;
    if (operand.kind === 'int') return { kind: 'int', value: signed };
    return { kind: 'double', value: signed };
  }

  /**
   * 二元运算求值。
   *   '+'             text + text 拼接；数字按数值相加
   *   '-' '*'        数字相减 / 相乘
   *   '/'            int / int 向零截断；除数为 0 时报 E0405
   *   '&&' '||'      短路求值：右侧只在必要时才计算
   *   '==' '!='      数字 / text / bool 之间
   *   '<' '<=' '>' '>='  仅数字
   * 结果为 int 时会检查安全整数范围，避免静默产生不精确的整数。
   */
  private evalBinary(expr: Binary, env: Env): Value {
    // 逻辑运算必须短路，因此不能预先求值右侧
    if (LOGICAL_OPS.has(expr.op)) return this.evalLogical(expr, env);

    const left = this.evalExpr(expr.left, env);
    const right = this.evalExpr(expr.right, env);

    if (COMPARISON_OPS.has(expr.op)) {
      return { kind: 'bool', value: this.compare(expr, left, right) };
    }

    if (expr.op === '+' && left.kind === 'text' && right.kind === 'text') {
      return { kind: 'text', value: left.value + right.value };
    }

    const a = this.numericOperand(left, expr.left.span);
    const b = this.numericOperand(right, expr.right.span);
    const bothInt = left.kind === 'int' && right.kind === 'int';

    switch (expr.op) {
      case '+':
        return this.numberResult(bothInt, a + b, expr.span);
      case '-':
        return this.numberResult(bothInt, a - b, expr.span);
      case '*':
        return this.numberResult(bothInt, a * b, expr.span);
      case '/': {
        if (b === 0) {
          throw new LemonError({
            code: ErrorCodes.DIVIDE_BY_ZERO,
            phase: 'runtime',
            message: '除数为 0，无法计算',
            span: expr.right.span,
            hint: '请确认除数不为 0；只有字面量 0 才能在运行前被检查出来',
            frames: [...this.frames],
          });
        }
        // int 除法向零截断（类 C）：7 / 2 = 3，(0 - 7) / 2 = -3
        return this.numberResult(bothInt, bothInt ? Math.trunc(a / b) : a / b, expr.span);
      }
      case '**': {
        if (bothInt) {
          // 静态检查只拦得住字面量，运行期还要兜住算出来的负指数
          if (b < 0) {
            throw new LemonError({
              code: ErrorCodes.NEGATIVE_EXPONENT,
              phase: 'runtime',
              message: `int 乘方的指数不能为负（这里是 ${b}）`,
              span: expr.right.span,
              hint: '把底数改成小数即可，例如 2.0 ** -1；或用 1.0 / (2 ** 1)',
              frames: [...this.frames],
            });
          }
          // 结果过大会被 numberResult 按整数溢出（E0406）拦下
          return this.numberResult(true, a ** b, expr.span);
        }

        const result = a ** b;
        if (!Number.isFinite(result)) {
          throw new LemonError({
            code: ErrorCodes.NON_FINITE_RESULT,
            phase: 'runtime',
            message: '乘方结果不是有限数',
            span: expr.span,
            hint: '负数不能开偶次方根，过大的指数也会溢出；请检查底数与指数',
            frames: [...this.frames],
          });
        }
        return { kind: 'double', value: result };
      }
      default:
        return UNIT;
    }
  }

  /** 逻辑运算：左侧已能定下结果时，右侧整体不求值（短路） */
  private evalLogical(expr: Binary, env: Env): Value {
    const left = this.boolOperand(this.evalExpr(expr.left, env), expr.left.span, expr.op);
    if (expr.op === '&&' && !left) return { kind: 'bool', value: false };
    if (expr.op === '||' && left) return { kind: 'bool', value: true };

    const right = this.boolOperand(this.evalExpr(expr.right, env), expr.right.span, expr.op);
    return { kind: 'bool', value: right };
  }

  /**
   * 比较两个值。
   *   数字（int/double 混合）按数值比较，因此 1 == 1.0 为 true
   *   text 与 bool 只支持 == / !=
   * 静态检查已经排除的类型组合走到这里，属于兜底错误。
   */
  private compare(expr: Binary, left: Value, right: Value): boolean {
    const op = expr.op;

    if (left.kind === 'text' && right.kind === 'text') {
      if (op === '==') return left.value === right.value;
      if (op === '!=') return left.value !== right.value;
      throw this.comparisonTypeError(expr, left, right);
    }

    if (left.kind === 'bool' && right.kind === 'bool') {
      if (op === '==') return left.value === right.value;
      if (op === '!=') return left.value !== right.value;
      throw this.comparisonTypeError(expr, left, right);
    }

    const a = this.numericOperand(left, expr.left.span);
    const b = this.numericOperand(right, expr.right.span);
    switch (op) {
      case '==':
        return a === b;
      case '!=':
        return a !== b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      default:
        return a >= b;
    }
  }

  private comparisonTypeError(expr: Binary, left: Value, right: Value): LemonError {
    return new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: `${left.kind} 与 ${right.kind} 不能用 '${expr.op}' 比较`,
      span: expr.span,
      hint:
        expr.op === '<' || expr.op === '<=' || expr.op === '>' || expr.op === '>='
          ? '大小比较只支持 int 与 double；文本与 bool 只能判断相等（== / !=）'
          : '只有同类型的值才能判断相等',
      frames: [...this.frames],
    });
  }

  private boolOperand(value: Value, span: Span, op: string): boolean {
    if (value.kind === 'bool') return value.value;
    throw new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: `${value.kind} 类型的值不能参与 '${op}' 运算`,
      span,
      hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
      frames: [...this.frames],
    });
  }

  private numericOperand(value: Value, span: Span): number {
    if (value.kind === 'int' || value.kind === 'double') return value.value;
    throw new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: `${value.kind} 类型的值不能参与数值运算`,
      span,
      hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
      frames: [...this.frames],
    });
  }

  /** 整数运算结果必须落在安全整数范围内，否则静默误差会一路传播下去 */
  private numberResult(bothInt: boolean, result: number, span: Span): Value {
    if (!bothInt) return { kind: 'double', value: result };
    if (!Number.isSafeInteger(result)) {
      throw new LemonError({
        code: ErrorCodes.INT_OVERFLOW,
        phase: 'runtime',
        message: '整数运算结果超出安全范围（±9007199254740991）',
        span,
        hint: '请把参与运算的变量改用 double 类型',
        frames: [...this.frames],
      });
    }
    return { kind: 'int', value: result };
  }

  private evalIdent(node: Ident, env: Env): Value {
    // 解析信息由静态检查器写在 AST 节点上，因此跨 REPL 片段依然有效
    const resolution = node.resolution;

    // 未声明 → 裸文本字面量。
    // 若环境里确实已有同名绑定（跨多次运行复用同一 Env 的场景），则优先取绑定值。
    if (resolution === undefined || resolution.kind === 'bareText') {
      const bound = env.lookup(node.name);
      if (bound !== undefined) return bound;
      return { kind: 'text', value: node.name };
    }
    if (resolution.kind === 'builtin' || resolution.kind === 'function') {
      throw new LemonError({
        code: ErrorCodes.RUNTIME_TYPE,
        phase: 'runtime',
        message: `函数名 ${node.name} 不能单独作为值使用`,
        span: node.span,
        hint: 'Lemon v1 不支持函数值，请写成调用形式，例如 ' + `${node.name}(...)`,
      });
    }

    const found = env.lookup(node.name);
    if (found === undefined) {
      throw new LemonError({
        code: ErrorCodes.UNDEFINED_VAR,
        phase: 'runtime',
        message: `变量 ${node.name} 还没有值`,
        span: node.span,
        hint: '顶层语句按从上到下的顺序执行，请确认该变量已在前面赋值',
        frames: [...this.frames],
      });
    }
    return found;
  }

  private evalCall(call: Call, env: Env): Value {
    // 类名当构造用：`Student("小明", 18)` —— 按字段顺序把实参打包成对象
    const cls = this.classes.get(call.callee.name);
    if (cls !== undefined) {
      const ctorArgs = call.args.map((arg) => this.evalExpr(arg, env));
      const fields = new Map<string, Value>();
      cls.fields.forEach((field, index) => fields.set(field.name, ctorArgs[index] ?? UNIT));
      return { kind: 'object', className: cls.name, fields };
    }

    const args = call.args.map((arg) => this.evalExpr(arg, env));
    const resolution = call.callee.resolution;

    // 内建按名字解析：即使没有解析信息（如 REPL 跨片段）也能正确调用
    if (resolution === undefined || resolution.kind === 'builtin') {
      const builtin = getBuiltin(call.callee.name) ?? this.options.builtins?.get(call.callee.name);
      if (builtin !== undefined) {
        return builtin.invoke(
          args,
          {
            write: this.options.write,
            keyboard: this.options.keyboard,
            readLine: this.options.readLine,
          },
          call.callee.span,
        );
      }
    }

    const target = env.lookup(call.callee.name);
    if (target === undefined || target.kind !== 'func') {
      throw new LemonError({
        code: ErrorCodes.UNDEFINED_FUNCTION,
        phase: 'runtime',
        message: `未定义的函数 ${call.callee.name}`,
        span: call.callee.span,
        frames: [...this.frames],
      });
    }
    return this.invokeFunction(target, args, call.callee.span);
  }

  private invokeFunction(fn: FuncValue, args: Value[], callSpan: Span): Value {
    if (this.depth >= this.maxDepth) {
      throw new LemonError({
        code: ErrorCodes.RECURSION_DEPTH,
        phase: 'runtime',
        message: `调用层数过深（超过 ${this.maxDepth} 层），程序已中止`,
        span: callSpan,
        hint: '请检查递归是否设置了终止条件（用 if 判断），避免无限递归',
        frames: [...this.frames],
      });
    }

    this.depth += 1;
    this.frames.push({ name: fn.decl.name, line: callSpan.line, col: callSpan.col });

    try {
      const scope = new Env(fn.closure);
      fn.decl.params.forEach((param, index) => {
        scope.define(param.name, args[index] ?? UNIT);
      });
      for (const stmt of fn.decl.body) {
        this.execStatement(stmt, scope);
      }
      return UNIT;
    } catch (error) {
      // return：不是错误，是提前退出的捷径。把携带的值交给调用方。
      // 必须排在 LemonError 判断之前——虽然两者互斥，但先认自己人更不容易读错。
      if (error instanceof ReturnSignal) return error.value;
      if (error instanceof LemonError) {
        // 只由最内层负责附加调用栈，避免层层重复包装
        if (error.frames.length === 0) {
          throw new LemonError({
            code: error.code,
            message: error.message,
            phase: error.phase,
            span: error.span,
            hint: error.hint,
            frames: [...this.frames],
          });
        }
        throw error;
      }
      if (error instanceof RangeError) {
        throw new LemonError({
          code: ErrorCodes.RECURSION_DEPTH,
          phase: 'runtime',
          message: '递归层数过深，程序已中止',
          span: fn.decl.nameSpan,
          hint: '请检查递归是否设置了终止条件（用 if 判断），避免无限递归',
          frames: [...this.frames],
        });
      }
      throw error;
    } finally {
      this.frames.pop();
      this.depth -= 1;
    }
  }

  /** 方法调用：`对象.方法(实参...)` —— 把对象绑定到方法第一个参数 self */
  private evalMethodCall(call: MethodCall, env: Env): Value {
    const object = this.evalExpr(call.object, env);
    if (object.kind !== 'object') {
      throw new LemonError({
        code: ErrorCodes.RUNTIME_TYPE,
        phase: 'runtime',
        message: `${object.kind} 类型的值没有方法 '${call.method}'`,
        span: call.methodSpan,
        hint: '只有类实例才有方法；写法：对象.方法(实参...)',
        frames: [...this.frames],
      });
    }

    const cls = this.classes.get(object.className);
    const method = cls?.methods.find((m) => m.name === call.method);
    if (method === undefined) {
      throw new LemonError({
        code: ErrorCodes.INVALID_MEMBER,
        phase: 'runtime',
        message: `类 ${object.className} 没有方法 '${call.method}'`,
        span: call.methodSpan,
        frames: [...this.frames],
      });
    }

    const args = call.args.map((arg) => this.evalExpr(arg, env));
    return this.invokeMethod(object, method, args, call.span);
  }

  /**
   * 执行方法体：第一个参数绑定到 self，其余按位置绑定实参。
   * 方法与普通函数一样以程序顶层环境为父作用域。
   */
  private invokeMethod(self: ObjectValue, method: ClassMethod, args: Value[], callSpan: Span): Value {
    if (this.depth >= this.maxDepth) {
      throw new LemonError({
        code: ErrorCodes.RECURSION_DEPTH,
        phase: 'runtime',
        message: `调用层数过深（超过 ${this.maxDepth} 层），程序已中止`,
        span: callSpan,
        hint: '请检查递归是否设置了终止条件（用 if 判断），避免无限递归',
        frames: [...this.frames],
      });
    }

    this.depth += 1;
    this.frames.push({ name: method.name, line: callSpan.line, col: callSpan.col });

    try {
      const scope = new Env(this.programEnv ?? new Env());
      method.params.forEach((param, index) => {
        scope.define(param.name, index === 0 ? self : (args[index - 1] ?? UNIT));
      });
      for (const stmt of method.body) this.execStatement(stmt, scope);
      return UNIT;
    } catch (error) {
      if (error instanceof ReturnSignal) return error.value;
      if (error instanceof LemonError) {
        if (error.frames.length === 0) {
          throw new LemonError({
            code: error.code,
            message: error.message,
            phase: error.phase,
            span: error.span,
            hint: error.hint,
            frames: [...this.frames],
          });
        }
        throw error;
      }
      if (error instanceof RangeError) {
        throw new LemonError({
          code: ErrorCodes.RECURSION_DEPTH,
          phase: 'runtime',
          message: '递归层数过深，程序已中止',
          span: method.nameSpan,
          hint: '请检查递归是否设置了终止条件（用 if 判断），避免无限递归',
          frames: [...this.frames],
        });
      }
      throw error;
    } finally {
      this.frames.pop();
      this.depth -= 1;
    }
  }
}

/** 类型提升：int → double 隐式转换；其余组合由静态检查保证不会出现 */
function coerceTo(value: Value, target: 'int' | 'double' | 'text' | 'bool', span: Span): Value {
  if (target === value.kind) return value;
  if (target === 'double' && value.kind === 'int') {
    return { kind: 'double', value: value.value };
  }
  throw new LemonError({
    code: ErrorCodes.RUNTIME_TYPE,
    phase: 'runtime',
    message: `运行期类型不匹配：${value.kind} 不能存入 ${target}`,
    span,
    hint: '这通常意味着静态检查存在漏洞，请提交一份最小复现',
  });
}
