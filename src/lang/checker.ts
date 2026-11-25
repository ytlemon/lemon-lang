/**
 * 静态检查器：作用域解析 + 类型检查。
 *
 * 核心规则（与用户确认过的语义一致）：
 *  1) __init__ 必须存在；main() 必须存在；两者都只能有一个。
 *  2) 变量声明必须带类型：int / double / text。
 *  3) 类型不匹配在运行前报错（int a = 你好 属于错误）。
 *  4) 未声明的名字默认按"裸文本"处理（say(你好) 中的 你好）；
 *     但若该名字与已声明的名字形近，或是在声明之前使用，则报错提醒。
 *  5) 顶层函数（含 main）整体提升，任意位置可调用；函数体内可见全部顶层变量
 *     （因为 main 一定在所有顶层语句执行完之后才被调用）。
 */
import type { Span } from '../utils/source';
import type {
  AssignStmt,
  Binary,
  BuildExeDecl,
  Call,
  ClassDecl,
  ClassField,
  CdStmt,
  ClassMethod,
  CycleStmt,
  DeleteStmt,
  Expr,
  GameDecl,
  GameElement,
  FileReadStmt,
  FileSaveStmt,
  FuncDecl,
  Ident,
  IfStmt,
  Index,
  LemonType,
  ListDecl,
  ListOp,
  ListRef,
  Member,
  MethodCall,
  OutputStmt,
  NameResolution,
  Program,
  ReturnStmt,
  RunningStmt,
  Stmt,
  TryStmt,
  Unary,
  VarDecl,
  WebBox,
  WebButton,
  WebDiv,
  WebElement,
  WebSetsDecl,
  WebText,
} from './ast';
import { COMPARISON_OPS, LOGICAL_OPS, LOOP_INDEX_NAME } from './ast';
import { BUILTINS, type BuiltinFn } from './builtins';
import { ErrorCodes, type Diagnostic } from './errors';
import {
  CLASS_MODULE,
  FILESKILL_MODULE,
  GAME_MODULE,
  MODULE_NAMES,
  moduleOfFunction,
  WEBSETS_MODULE,
} from './modules';

export type { NameResolution } from './ast';

export interface SymbolInfo {
  name: string;
  kind: 'variable' | 'function' | 'builtin';
  type: LemonType;
  span: Span;
  decl: FuncDecl | null;
  builtin: BuiltinFn | null;
  /** 类实例变量的类名（`Student stu = ...` 或方法里的 self）；其它情况为 null/缺失 */
  className?: string | null;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  /** 顶层符号表（含函数与内建），供 REPL 增量复用 */
  globals: Map<string, SymbolInfo>;
  hasErrors: boolean;
}

export interface CheckOptions {
  /** 是否提示"声明后从未使用"（默认关闭，避免干扰） */
  warnUnused?: boolean;
  /** REPL：允许裸表达式作为语句并回显其值 */
  allowBareExpr?: boolean;
  /** REPL：允许重复声明同名变量/函数（后一次覆盖前一次） */
  allowRedeclare?: boolean;
  /**
   * 本次编译额外可见的内置函数——由 `#incloud <模块名>` 启用的能力模块提供。
   * 与自带内置完全同级：同名冲突、参数个数、参数类型都走同一套规则。
   */
  builtins?: ReadonlyMap<string, BuiltinFn>;
  /**
   * 本次编译启用到的能力模块名（`#incloud` 的产物）。
   * 有些语言构造（如 `websets()`）本身不是函数，只能靠模块名判断是否解锁。
   */
  modules?: ReadonlySet<string>;
}

export function checkProgram(program: Program, options: CheckOptions = {}): CheckResult {
  const checker = new Checker(options);
  checker.checkProgram(program);
  return checker.finish();
}

/** REPL 增量检查：以已有顶层符号表为基础，检查一段语句片段 */
export function checkFragment(
  statements: Stmt[],
  globals: Map<string, SymbolInfo>,
  options: CheckOptions = {},
): CheckResult {
  const checker = new Checker(options);
  checker.checkFragment(statements, globals);
  return checker.finish();
}

/* ------------------------------------------------------------------ */
/* 类型可赋值性                                                        */
/* ------------------------------------------------------------------ */

export function assignable(from: LemonType, to: LemonType): boolean {
  if (from === 'any' || to === 'any') return true;
  if (from === to) return true;
  // 隐式提升：int → double
  if (from === 'int' && to === 'double') return true;
  return false;
}

/**
 * 函数的调用结果类型。
 *
 * 参数是不写类型的 `any`（见规范 §2.7），所以返回类型也没法靠声明写死。
 * 这里采用的规则只有一句：**函数体里出现带值的 return，调用结果就是 `any`；
 * 没有就是 `unit`**。不写类型并不吃亏——`any` 与函数参数完全同级，
 * 参与运算、赋值、比较都照常，具体对不对交给运行期。
 */
function returnTypeOf(fn: { body: Stmt[] }): LemonType {
  let hasValue = false;

  const walk = (statements: Stmt[]): void => {
    for (const stmt of statements) {
      if (hasValue) return;
      switch (stmt.kind) {
        case 'ReturnStmt':
          if (stmt.value !== null) hasValue = true;
          break;
        case 'IfStmt':
          for (const branch of stmt.branches) walk(branch.body);
          break;
        case 'CycleStmt':
          walk(stmt.body);
          break;
        case 'TryStmt':
          walk(stmt.body);
          walk(stmt.catchBody);
          break;
        default:
          break; // 函数内部不能再定义函数（E0305），不存在需要下钻的声明
      }
    }
  };

  walk(fn.body);
  return hasValue ? 'any' : 'unit';
}

function variableSymbol(
  name: string,
  span: Span,
  type: LemonType,
  className: string | null = null,
): SymbolInfo {
  return {
    name,
    kind: 'variable',
    type,
    span,
    decl: null,
    builtin: null,
    className,
  };
}

function typeLabel(t: LemonType): string {
  switch (t) {
    case 'int':
      return 'int（整数）';
    case 'double':
      return 'double（小数）';
    case 'text':
      return 'text（文本）';
    case 'bool':
      return 'bool（真假值）';
    case 'list':
      return 'list（列表）';
    case 'error':
      return 'error（错误值）';
    case 'unit':
      return 'unit（无值）';
    case 'object':
      return 'object（类实例）';
    case 'any':
      return '未知类型';
    default:
      return String(t);
  }
}

function mismatchHint(from: LemonType, to: LemonType, varName: string): string | undefined {
  if (from === 'error') {
    return `错误值不能直接存进变量；请取它的字段，例如 ${varName} = 错误.message`;
  }
  if (to === 'bool') {
    return `若想保存真假值，请写成 true / false，或用比较运算，例如：bool ${varName} = a > b`;
  }
  if (from === 'bool') {
    return `bool（真假值）不能存进${typeLabel(to)}变量；直接 say(${varName}) 就能输出 true / false`;
  }
  if (to === 'int' && from === 'text') return `若想保存文字，请把类型改为：text ${varName} = ...`;
  if (to === 'int' && from === 'double') return 'double 不能自动转成 int，Lemon v1 暂不支持取整转换';
  if (to === 'text' && (from === 'int' || from === 'double')) {
    return `若想保存数字，请把类型改为：${from} ${varName} = ...`;
  }
  if (to === 'double' && from === 'text') return `若想保存文字，请把类型改为：text ${varName} = ...`;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Checker                                                             */
/* ------------------------------------------------------------------ */

class Checker {
  private readonly diagnostics: Diagnostic[] = [];

  /**
   * 当前正在检查的函数体深度。`return` 只能出现在函数体内，
   * 而函数不能嵌套定义（E0305），所以一个计数器就够。
   */
  private functionDepth = 0;
  /** 当前函数体是不是 main()：main 里不许写 return 值（E0328） */
  private inMainBody = false;
  private readonly globals = new Map<string, SymbolInfo>();

  /** 函数（含 main）——整体提升，任意位置可见 */
  private readonly hoisted = new Map<string, SymbolInfo>();
  /** 全部顶层变量——仅用于"函数体内可见"与诊断提示 */
  private readonly topVars = new Map<string, SymbolInfo>();
  /** 当前按顺序已可见的顶层符号 */
  private visibleTop = new Map<string, SymbolInfo>();
  private readonly scopes: Map<string, SymbolInfo>[] = [];
  private readonly used = new Set<string>();
  private readonly warnUnused: boolean;
  private readonly allowBareExpr: boolean;
  private readonly allowRedeclare: boolean;
  private readonly modules: ReadonlySet<string>;
  /** `#incloud game` 是否启用——game() 构造与 game.running / game.quit 靠它解锁 */
  private readonly hasGame: boolean;
  /** `#incloud class` 是否启用 */
  private readonly hasClass: boolean;
  /** `#incloud fileskill` 是否启用——cd / running / delete 靠它解锁 */
  private readonly hasFileskill: boolean;
  /** 当前嵌套在几层 `cd { ... }` 里；running / delete 只允许出现在它 > 0 的地方 */
  private cdDepth = 0;
  /** 类名 → 声明；class 构造、构造调用、成员访问都靠它 */
  private readonly classes = new Map<string, ClassDecl>();
  /** 当前正在检查的方法所属的类；方法体外为 null */
  private currentClass: ClassDecl | null = null;

  constructor(options: CheckOptions) {
    this.warnUnused = options.warnUnused === true;
    this.allowBareExpr = options.allowBareExpr === true;
    this.allowRedeclare = options.allowRedeclare === true;
    this.modules = options.modules ?? new Set<string>();
    this.hasGame = this.modules.has(GAME_MODULE);
    this.hasClass = this.modules.has(CLASS_MODULE);
    this.hasFileskill = this.modules.has(FILESKILL_MODULE);
    for (const [name, builtin] of BUILTINS) this.hoistBuiltin(name, builtin);
    if (options.builtins !== undefined) {
      for (const [name, builtin] of options.builtins) this.hoistBuiltin(name, builtin);
    }

    // build 是 buildexe 提供的内置 bool 标志（有 buildexe 声明即为 true）。
    // 运行期由 Evaluator 写入同一个名字，这里只让静态检查认得它、且不可被覆盖。
    this.hoisted.set('build', {
      name: 'build',
      kind: 'variable',
      type: 'bool',
      span: { line: 1, col: 1, endLine: 1, endCol: 1, start: 0, end: 0 },
      decl: null,
      builtin: null,
    });
  }

  /**
   * 内置函数与顶层函数一样整体提升（任意位置可调用）。
   * span 固定为 1:1：它的"声明处"不在本文件里，只是为了让符号表字段齐整。
   */
  private hoistBuiltin(name: string, builtin: BuiltinFn): void {
    this.hoisted.set(name, {
      name,
      kind: 'builtin',
      type: builtin.returns,
      span: { line: 1, col: 1, endLine: 1, endCol: 1, start: 0, end: 0 },
      decl: null,
      builtin,
    });
  }

  /* ------------------------------ 入口 ------------------------------ */

  checkProgram(program: Program): void {
    this.collectTopLevel(program);

    // 按源码顺序检查（变量只在声明之后可见；函数整体可见）
    for (const stmt of program.statements) {
      switch (stmt.kind) {
        case 'VarDecl':
          this.checkVarDecl(stmt);
          break;
        case 'ExprStmt':
          this.checkExprStmt(stmt.expr);
          break;
        case 'TryStmt':
          this.checkTry(stmt);
          break;
        case 'FuncDecl':
          this.checkFunction(stmt);
          break;
        case 'WebSets':
          this.checkWebSets(stmt);
          break;
        case 'Game':
          this.checkGame(stmt);
          break;
        case 'BuildExe':
          this.checkBuildExe(stmt);
          break;
        case 'Class':
          this.checkClass(stmt);
          break;
        case 'Assign':
          this.checkAssign(stmt);
          break;
        case 'Output':
          this.checkOutput(stmt);
          break;
        case 'Cd':
          this.checkCd(stmt);
          break;
        case 'Running':
          this.checkRunning(stmt);
          break;
        case 'Delete':
          this.checkDelete(stmt);
          break;
        case 'ListDecl':
          this.checkListDecl(stmt);
          break;
        case 'ListOp':
          this.checkListOp(stmt);
          break;
        case 'ReturnStmt':
          this.checkReturnStmt(stmt);
          break;
        case 'FileRead':
          this.checkFileRead(stmt);
          break;
        case 'FileSave':
          this.checkFileSave(stmt);
          break;
        default:
          break;
      }
    }

    if (program.main === null) {
      this.report(
        ErrorCodes.MISSING_MAIN,
        '程序缺少 main() 主程序声明',
        program.initSpan,
        '请在 __init__ 内声明 main() { ... } 作为程序入口',
      );
    }

    if (this.warnUnused) this.reportUnused(program);
  }

  checkFragment(statements: Stmt[], globals: Map<string, SymbolInfo>): void {
    for (const [name, sym] of globals) {
      this.globals.set(name, sym);
      if (sym.kind === 'function') this.hoisted.set(name, sym);
      else if (sym.kind === 'variable') this.topVars.set(name, sym);
    }
    this.visibleTop = new Map(this.globals);

    // 片段内的 def 同样做提升，并且要留进符号表供后续片段使用。
    // REPL 允许重复定义（覆盖旧定义），与文件模式不同。
    for (const stmt of statements) {
      if (stmt.kind !== 'FuncDecl') continue;
      const occupied = this.hoisted.get(stmt.name);
      if (occupied !== undefined && occupied.kind === 'builtin') {
        this.report(
          ErrorCodes.DUPLICATE_DECL,
          `${stmt.name} 是内置函数，不能重新定义`,
          stmt.nameSpan,
          '请换一个函数名',
        );
        continue;
      }
      const sym: SymbolInfo = {
        name: stmt.name,
        kind: 'function',
        type: returnTypeOf(stmt),
        span: stmt.nameSpan,
        decl: stmt,
        builtin: null,
      };
      this.hoisted.set(stmt.name, sym);
      this.visibleTop.set(stmt.name, sym);
      this.globals.set(stmt.name, sym);
    }

    for (const stmt of statements) {
      switch (stmt.kind) {
        case 'VarDecl':
          this.checkVarDecl(stmt);
          break;
        case 'ExprStmt':
          this.checkExprStmt(stmt.expr);
          break;
        case 'TryStmt':
          this.checkTry(stmt);
          break;
        case 'IfStmt':
          this.checkIf(stmt);
          break;
        case 'CycleStmt':
          this.checkCycle(stmt);
          break;
        case 'BreakStmt':
          break;
        case 'ListDecl':
          this.checkListDecl(stmt);
          break;
        case 'ListOp':
          this.checkListOp(stmt);
          break;
        case 'FuncDecl':
          this.checkFunction(stmt);
          break;
        case 'ReturnStmt':
          this.checkReturnStmt(stmt);
          break;
        case 'BuildExe':
          this.checkBuildExe(stmt);
          break;
        case 'Assign':
          this.checkAssign(stmt);
          break;
        case 'Output':
          this.checkOutput(stmt);
          break;
        case 'Cd':
          this.checkCd(stmt);
          break;
        case 'Running':
          this.checkRunning(stmt);
          break;
        case 'Delete':
          this.checkDelete(stmt);
          break;
        case 'FileRead':
          this.checkFileRead(stmt);
          break;
        case 'FileSave':
          this.checkFileSave(stmt);
          break;
        default:
          break;
      }
    }
  }

  finish(): CheckResult {
    return {
      diagnostics: this.diagnostics,
      globals: this.globals,
      hasErrors: this.diagnostics.some((d) => d.severity === 'error'),
    };
  }

  /* --------------------------- 顶层收集 ---------------------------- */

  /**
   * 预扫描：登记全部函数（整体提升），并记录全部顶层变量名（供函数体内可见性使用）。
   * 变量自身的名字冲突与类型检查统一放在 checkVarDecl，避免同一问题被报两次。
   */
  private collectTopLevel(program: Program): void {
    for (const stmt of program.statements) {
      // 与内建同名的声明会被 declareVariable 判为非法，这里不再登记，
      // 以免它覆盖内建符号导致后续调用产生级联报错
      // 变量与列表都绑定了一个顶层名字，函数体内必须看得见它们
      if (stmt.kind === 'VarDecl') {
        if (this.hoisted.has(stmt.name)) continue;
        this.topVars.set(stmt.name, variableSymbol(stmt.name, stmt.nameSpan, stmt.typeName));
      } else if (stmt.kind === 'ListDecl') {
        if (this.hoisted.has(stmt.name)) continue;
        this.topVars.set(stmt.name, variableSymbol(stmt.name, stmt.nameSpan, 'list'));
      }
    }

    // 类登记：类名重复直接报错（构造与成员访问都要靠这张表）
    for (const cls of program.classes) {
      if (this.classes.has(cls.name)) {
        this.report(
          ErrorCodes.DUPLICATE_DECL,
          `类 ${cls.name} 重复声明`,
          cls.nameSpan,
          `上一次声明在第 ${this.classes.get(cls.name)!.nameSpan.line} 行`,
        );
        continue;
      }
      this.classes.set(cls.name, cls);
    }

    // 函数重复声明检查（hoisted 里已有内建）
    const seenFns = new Set<string>();
    for (const fn of program.functions) {
      const occupied = this.hoisted.get(fn.name);
      if (occupied !== undefined && !seenFns.has(fn.name)) {
        this.report(
          ErrorCodes.DUPLICATE_DECL,
          occupied.kind === 'builtin'
            ? `${fn.name} 是内置函数，不能重新定义`
            : `函数名 ${fn.name} 已被占用`,
          fn.nameSpan,
          occupied.kind === 'builtin' ? '请换一个函数名' : `已有定义在第 ${occupied.span.line} 行`,
        );
        continue;
      }
      if (seenFns.has(fn.name)) {
        const prev = this.hoisted.get(fn.name)!;
        this.report(
          ErrorCodes.DUPLICATE_DECL,
          `函数 ${fn.name} 重复声明`,
          fn.nameSpan,
          `上一次声明在第 ${prev.span.line} 行`,
        );
        continue;
      }
      seenFns.add(fn.name);
      const sym: SymbolInfo = {
        name: fn.name,
        kind: 'function',
        type: returnTypeOf(fn),
        span: fn.nameSpan,
        decl: fn,
        builtin: null,
      };
      this.hoisted.set(fn.name, sym);
      this.globals.set(fn.name, sym);
    }

    // main() 固定没有返回值：里面只允许光秃秃的 return（提前收工），
    // 写 return 值会报 E0328，所以它的类型永远是 unit
    if (program.main !== null) {
      const sym: SymbolInfo = {
        name: 'main',
        kind: 'function',
        type: 'unit',
        span: program.main.nameSpan,
        decl: program.main,
        builtin: null,
      };
      this.hoisted.set('main', sym);
      this.globals.set('main', sym);
    }
  }

  /* --------------------------- 语句检查 ---------------------------- */

  private checkVarDecl(stmt: VarDecl): void {
    // 类类型声明：`Student stu = Student(...)`
    if (stmt.className !== null) {
      const initType = this.checkExpr(stmt.initializer);
      if (!this.hasClass) {
        this.report(
          ErrorCodes.CLASS_MODULE,
          `类类型需要 ${CLASS_MODULE} 能力模块`,
          stmt.nameSpan,
          `请在文件开头写 #incloud ${CLASS_MODULE}`,
        );
      } else if (!this.classes.has(stmt.className)) {
        this.report(
          ErrorCodes.CLASS_NAME,
          `未定义的类 ${stmt.className}`,
          stmt.nameSpan,
          `先用 class ${stmt.className} { ... } 定义它`,
        );
      } else if (initType !== 'object' && initType !== 'any') {
        this.report(
          ErrorCodes.TYPE_MISMATCH,
          `类型不匹配：${typeLabel(initType)}的值不能当作 ${stmt.className} 的实例`,
          stmt.initializer.span,
          `要用 ${stmt.className}(值...) 构造一个实例`,
        );
      }
      this.declareVariable(stmt.name, stmt.nameSpan, 'object', stmt.className);
      return;
    }

    const initType = this.checkExpr(stmt.initializer);
    if (!assignable(initType, stmt.typeName)) {
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `类型不匹配：${typeLabel(initType)}的值不能赋给${typeLabel(stmt.typeName)}变量 ${stmt.name}`,
        stmt.initializer.span,
        durationHint(stmt.typeName, stmt.initializer) ?? mismatchHint(initType, stmt.typeName, stmt.name),
      );
    }

    this.declareVariable(stmt.name, stmt.nameSpan, stmt.typeName);
  }

  /**
   * 列表声明 `list(名字) { 元素 ... }`。
   *
   * 元素逐个检查即可：列表元素类型统一记作 `any`，不要求类型一致
   * （`list(杂) { 1 你好 true }` 合法），所以这里没有可赋值性要判。
   * 名字的登记走 declareVariable，与普通变量完全同一套冲突规则。
   */
  private checkListDecl(stmt: ListDecl): void {
    for (const element of stmt.elements) this.checkExpr(element);
    // 编号槽是全局容器，不绑定任何变量名，因此没有"重复声明"一说
    if (stmt.slot !== null) return;
    this.declareVariable(stmt.name, stmt.nameSpan, 'list');
  }

  /**
   * 列表引用 `list(X)`。
   *
   *   编号槽 list(1)   —— 永远合法（用到就存在），类型就是 list
   *   命名   list(分数) —— 名字必须已声明，且本身就是列表
   *
   * 两种都返回 `list`，所以 `say(list(1))`、`len(list(1))`、`list(1)[0]`
   * 与命名列表写法完全一样。返回 `list` 而不是 `any`：它确实是列表，
   * 后面跟 `[下标]` 必须能过检查。
   */
  private checkListRef(expr: ListRef): LemonType {
    if (expr.slot !== null) return 'list';

    const sym = this.lookup(expr.name);
    if (sym === null) {
      const similar = this.findSimilar(expr.name, { includeBuiltins: false });
      this.report(
        ErrorCodes.LIST_OP_TARGET,
        `list(${expr.name}) 里的 ${expr.name} 还没有声明`,
        expr.targetSpan,
        similar !== null
          ? `是否想写 list(${similar})？`
          : `列表要先声明：list(${expr.name}) { ... }，或者用 add list(${expr.name}) 建一个空的`,
      );
      return 'list';
    }

    if (sym.type !== 'list' && sym.type !== 'any') {
      this.report(
        ErrorCodes.LIST_OP_TARGET,
        `${expr.name} 是${typeLabel(sym.type)}，不是列表`,
        expr.targetSpan,
        `list(${expr.name}) 只能用来引用列表；编号槽请写 list(1)`,
      );
    }
    return 'list';
  }

  /** 列表操作：作用对象必须是列表，元素表达式照常检查 */
  private checkListOp(stmt: ListOp): void {
    this.checkListRef(stmt.target);
    if (stmt.element !== null) this.checkExpr(stmt.element);

    // `del list(名字)` 想整体删掉一个命名列表。命名列表是普通变量，而语言里
    // 没有"取消声明"这回事：删掉绑定之后静态检查仍然认为它存在，此后每次引用
    // 都会变成"静态通过、运行期炸"。与其留这种裂缝，不如直接拦下。
    if (stmt.op === 'deleteList' && stmt.target.slot === null) {
      this.report(
        ErrorCodes.LIST_DELETE_NAMED,
        `不能整体删除命名列表 ${stmt.target.name}`,
        stmt.target.targetSpan,
        'del list(X) 只能删编号槽（全局容器）。命名列表用 clear list(名字) 清空内容；要让它彻底消失，就把它声明在更小的作用域里',
      );
    }
  }

  /** 读文件块：文件名必填，至少得有一个落点，列表落点须是列表 */
  private checkFileRead(stmt: FileReadStmt): void {
    if (stmt.name === null) {
      this.report(
        ErrorCodes.FILE_READ_NO_NAME,
        'read 块缺少文件名',
        stmt.span,
        '在块里写 name = "文件名"，例如 name = "1.txt"',
      );
    } else {
      this.checkExpr(stmt.name);
    }
    if (stmt.encoding !== null) this.checkExpr(stmt.encoding);

    if (stmt.targets.length === 0) {
      this.report(
        ErrorCodes.FILE_READ_NO_TARGET,
        'read 块至少要有一个落点（read in list(X) 或 read in say）',
        stmt.span,
        'read in answer 只是"交互式选段"开关，本身不决定内容去哪；至少再写一个 read in list(1) 或 read in say',
      );
    }
    for (const target of stmt.targets) {
      if (target.kind === 'list') this.checkListRef(target.ref);
    }
  }

  /** 写文件块：文件名必填，且必须指定要写出的列表 */
  private checkFileSave(stmt: FileSaveStmt): void {
    if (stmt.name === null) {
      this.report(
        ErrorCodes.FILE_WRITE_NO_NAME,
        'save 块缺少文件名',
        stmt.span,
        '在块里写 name = "文件名"，例如 name = "1.txt"',
      );
    } else {
      this.checkExpr(stmt.name);
    }
    if (stmt.encoding !== null) this.checkExpr(stmt.encoding);

    if (stmt.source === null) {
      this.report(
        ErrorCodes.FILE_WRITE_NO_SOURCE,
        'save 块缺少要写出的列表（save in list(X)）',
        stmt.span,
        '写法：save in list(1)——把列表每个元素写一行到文件',
      );
    } else {
      this.checkListRef(stmt.source);
    }
  }

  /* ---------------------------- fileskill ---------------------------- */

  /**
   * `cd <目录> { ... }`。
   *
   * 由 `#incloud fileskill` 解锁；没启用时只报一条 E0345 就收工，免得块里
   * 的 running / delete 再各报一遍。目录必须是文本；块体在"已进入目录"的
   * 状态下检查，running / delete 才放行。
   */
  private checkCd(stmt: CdStmt): void {
    if (!this.hasFileskill) {
      this.reportFileskillModule(stmt.span);
      return;
    }

    const pathType = this.checkExpr(stmt.path);
    if (pathType !== 'text' && pathType !== 'any') {
      this.report(
        ErrorCodes.FILESKILL_PATH,
        `cd 的目录必须是文本，实际是${typeLabel(pathType)}`,
        stmt.path.span,
        '目录要加引号，例如：cd "e:/traingame" { ... }',
      );
    }

    this.cdDepth += 1;
    try {
      this.checkBodyStatements(stmt.body);
    } finally {
      this.cdDepth -= 1;
    }
  }

  /** `running <文件>`：运行一个文件，只能在 cd 块里 */
  private checkRunning(stmt: RunningStmt): void {
    if (!this.hasFileskill) {
      this.reportFileskillModule(stmt.span);
      return;
    }
    if (this.cdDepth === 0) {
      this.report(
        ErrorCodes.FILESKILL_SHAPE,
        'running 只能写在 cd 块里',
        stmt.span,
        '先用 cd "目录" { ... } 锁定一个目录，再在里面写 running "文件"',
      );
      return;
    }
    const type = this.checkExpr(stmt.file);
    if (type !== 'text' && type !== 'any') {
      this.report(
        ErrorCodes.FILESKILL_PATH,
        `running 的文件名必须是文本，实际是${typeLabel(type)}`,
        stmt.file.span,
        '文件名要加引号，例如：running "start.bat"',
      );
    }
  }

  /** `delete <文件>`：删除一个文件，只能在 cd 块里 */
  private checkDelete(stmt: DeleteStmt): void {
    if (!this.hasFileskill) {
      this.reportFileskillModule(stmt.span);
      return;
    }
    if (this.cdDepth === 0) {
      this.report(
        ErrorCodes.FILESKILL_SHAPE,
        'delete 只能写在 cd 块里',
        stmt.span,
        '先用 cd "目录" { ... } 锁定一个目录，再在里面写 delete "文件"',
      );
      return;
    }
    const type = this.checkExpr(stmt.file);
    if (type !== 'text' && type !== 'any') {
      this.report(
        ErrorCodes.FILESKILL_PATH,
        `delete 的文件名必须是文本，实际是${typeLabel(type)}`,
        stmt.file.span,
        '文件名要加引号，例如：delete "临时.txt"',
      );
    }
  }

  private reportFileskillModule(span: Span): void {
    this.report(
      ErrorCodes.FILESKILL_MODULE,
      `cd / running / delete 需要 ${FILESKILL_MODULE} 能力模块`,
      span,
      `请在文件开头写 #incloud ${FILESKILL_MODULE}`,
    );
  }

  /**
   * 声明一个变量，把三类冲突一次拦下：占用内置名、与函数同名、重复声明。
   * 变量声明与列表声明共用，规则不允许有分叉。
   */
  private declareVariable(
    name: string,
    nameSpan: Span,
    type: LemonType,
    className: string | null = null,
  ): void {
    // 内置名任何情况下都不允许被占用
    if (this.isBuiltinName(name)) {
      this.report(
        ErrorCodes.DUPLICATE_DECL,
        `${name} 是内置函数名，不能用作变量名`,
        nameSpan,
        '请换一个变量名',
      );
      return;
    }

    const sym = variableSymbol(name, nameSpan, type, className);
    const localScope = this.scopes.length > 0 ? this.scopes[this.scopes.length - 1] : null;

    if (localScope !== null) {
      // 函数体内：只与同作用域内的已有名字冲突（允许遮蔽顶层名字）
      const existing = localScope.get(name);
      if (existing !== undefined && !this.allowRedeclare) {
        this.report(
          ErrorCodes.DUPLICATE_DECL,
          `变量 ${name} 在该作用域内重复声明`,
          nameSpan,
          `上一次声明在第 ${existing.span.line} 行`,
        );
        return;
      }
      localScope.set(name, sym);
      return;
    }

    // 顶层：不能与函数同名，也不能重复声明
    const fn = this.hoisted.get(name);
    if (fn !== undefined && !this.allowRedeclare) {
      this.report(
        ErrorCodes.DUPLICATE_DECL,
        `变量名 ${name} 与函数同名`,
        nameSpan,
        `${name} 是函数，定义在第 ${fn.span.line} 行`,
      );
      return;
    }
    const previous = this.visibleTop.get(name);
    if (previous !== undefined && !this.allowRedeclare) {
      this.report(
        ErrorCodes.DUPLICATE_DECL,
        `变量 ${name} 重复声明`,
        nameSpan,
        `上一次声明在第 ${previous.span.line} 行`,
      );
      return;
    }
    this.visibleTop.set(name, sym);
    this.globals.set(name, sym);
  }

  private isBuiltinName(name: string): boolean {
    return this.hoisted.get(name)?.kind === 'builtin';
  }

  private checkExprStmt(expr: Expr): void {
    // 允许作语句的：函数调用 `say(你好)`、方法调用 `对象.方法(...)`
    if (expr.kind !== 'Call' && expr.kind !== 'MethodCall' && !this.allowBareExpr) {
      this.report(
        ErrorCodes.NOT_A_STATEMENT,
        'Lemon v1 中独立的表达式不能作为语句',
        expr.span,
        '语句需要是一条调用（函数调用或方法调用），例如：say("你好") 或 对象.方法(...)',
      );
      this.checkExpr(expr);
      return;
    }
    this.checkExpr(expr);
  }

  /** 检查一段语句列表（函数体、try / catch 块、if 分支块共用） */
  private checkBodyStatements(statements: Stmt[]): void {
    for (const stmt of statements) {
      switch (stmt.kind) {
        case 'VarDecl':
          this.checkVarDecl(stmt);
          break;
        case 'ExprStmt':
          this.checkExprStmt(stmt.expr);
          break;
        case 'TryStmt':
          this.checkTry(stmt);
          break;
        case 'IfStmt':
          this.checkIf(stmt);
          break;
        case 'CycleStmt':
          this.checkCycle(stmt);
          break;
        case 'BreakStmt':
          break;
        case 'ListDecl':
          this.checkListDecl(stmt);
          break;
        case 'ListOp':
          this.checkListOp(stmt);
          break;
        case 'ReturnStmt':
          this.checkReturnStmt(stmt);
          break;
        case 'BuildExe':
          this.checkBuildExe(stmt);
          break;
        case 'Assign':
          this.checkAssign(stmt);
          break;
        case 'Output':
          this.checkOutput(stmt);
          break;
        case 'Cd':
          this.checkCd(stmt);
          break;
        case 'Running':
          this.checkRunning(stmt);
          break;
        case 'Delete':
          this.checkDelete(stmt);
          break;
        case 'FileRead':
          this.checkFileRead(stmt);
          break;
        case 'FileSave':
          this.checkFileSave(stmt);
          break;
        default:
          break;
      }
    }
  }

  /**
   * if / elif / else。
   * 每个分支体都是独立作用域（与 try / catch 一致），因此分支内声明的变量
   * 不会泄漏到别的分支或外层。条件必须是 bool。
   */
  private checkIf(stmt: IfStmt): void {
    for (const branch of stmt.branches) {
      if (branch.condition !== null) {
        const before = this.diagnostics.length;
        const condType = this.checkExpr(branch.condition);
        // 条件里已经有别的错误（比如名字写错）时不再补一刀，避免一条笔误报两遍
        const alreadyReported = this.diagnostics.length > before;
        if (condType !== 'bool' && condType !== 'any' && !alreadyReported) {
          this.report(
            ErrorCodes.CONDITION_TYPE,
            `${branch.kind} 的条件必须是 bool（真假值），实际是${typeLabel(condType)}`,
            branch.condition.span,
            conditionHint(condType),
          );
        }
      }

      this.scopes.push(new Map());
      this.checkBodyStatements(branch.body);
      this.scopes.pop();
    }
  }

  /**
   * cycle 循环。
   *
   * 次数必须是 int（字面量负数在运行前就拦下，算出来的负数在运行期报 E0409）。
   * 循环体是独立作用域，并额外绑定轮次变量 `i`（int，从 0 开始）。
   * `i` 与函数参数一样会遮蔽外层的同名变量；体内再声明 `int i` 会报重复声明。
   */
  private checkCycle(stmt: CycleStmt): void {
    if (stmt.count !== null) {
      const countType = this.checkExpr(stmt.count);
      if (countType !== 'int' && countType !== 'any') {
        this.report(
          ErrorCodes.CYCLE_COUNT_TYPE,
          `cycle 的次数必须是 int（整数），实际是${typeLabel(countType)}`,
          stmt.count.span,
          cycleCountHint(countType),
        );
      } else if (isNegativeIntLiteral(stmt.count)) {
        this.report(
          ErrorCodes.NEGATIVE_CYCLE_COUNT_STATIC,
          'cycle 的次数不能是负数',
          stmt.count.span,
          'cycle(0) 表示一次都不执行；负数没有意义，请检查这里的值',
        );
      }
    }

    const scope = new Map<string, SymbolInfo>();
    scope.set(LOOP_INDEX_NAME, {
      name: LOOP_INDEX_NAME,
      kind: 'variable',
      type: 'int',
      span: stmt.headerSpan,
      decl: null,
      builtin: null,
    });
    this.scopes.push(scope);
    this.checkBodyStatements(stmt.body);
    this.scopes.pop();
  }

  /**
   * try / catch。
   * try 与 catch 各自是独立作用域；catch 里额外绑定一个 error 类型的错误值。
   * 能捕获的是运行期错误——语法与类型错误在程序开始执行前就已经中止。
   */
  private checkTry(stmt: TryStmt): void {
    const usableBinding = !this.isBuiltinName(stmt.catchName);
    if (!usableBinding) {
      this.report(
        ErrorCodes.DUPLICATE_DECL,
        `${stmt.catchName} 是内置函数名，不能用作 catch 绑定的名字`,
        stmt.catchNameSpan,
        '请换一个名字',
      );
    }

    this.scopes.push(new Map());
    this.checkBodyStatements(stmt.body);
    this.scopes.pop();

    const scope = new Map<string, SymbolInfo>();
    if (usableBinding) {
      scope.set(stmt.catchName, {
        name: stmt.catchName,
        kind: 'variable',
        type: 'error',
        span: stmt.catchNameSpan,
        decl: null,
        builtin: null,
      });
    }
    this.scopes.push(scope);
    this.checkBodyStatements(stmt.catchBody);
    this.scopes.pop();
  }

  /* ------------------------------ websets ------------------------------ */

  /**
   * websets()。
   *
   * 由 `#incloud web` 解锁：模块没启用时只报一条 E0323 就收工，免得页面里的
   * 名字被当成"未声明"再报一遍，把真正的病因淹掉。
   *
   * `to` 的地址可以引用变量，所以作用域与函数一致（整份顶层变量 + 全部函数）——
   * 页面是在 __init__ 顶层语句与 main() 都跑完之后才生成的。
   */
  private checkWebSets(stmt: WebSetsDecl): void {
    if (!this.modules.has(WEBSETS_MODULE)) {
      this.report(
        ErrorCodes.WEBSETS_MODULE,
        `websets() 需要 ${WEBSETS_MODULE} 能力模块`,
        stmt.nameSpan,
        `请在文件开头写 #incloud ${WEBSETS_MODULE}`,
      );
      return;
    }

    if (stmt.init === null) {
      this.report(
        ErrorCodes.WEBSETS_SHAPE,
        'websets() 里缺少 web.init()',
        stmt.nameSpan,
        '页面内容写在 web.init() { ... } 里，例如：websets() { web.init() { button { to "localhost:9000" } } }',
      );
      return;
    }

    const savedTop = this.visibleTop;
    const merged = new Map<string, SymbolInfo>();
    for (const [name, sym] of this.topVars) merged.set(name, sym);
    for (const [name, sym] of this.hoisted) merged.set(name, sym);
    this.visibleTop = merged;

    this.scopes.push(new Map());
    try {
      for (const element of stmt.init.elements) this.checkWebElement(element);
    } finally {
      this.scopes.pop();
      this.visibleTop = savedTop;
    }
  }

  private checkWebElement(element: WebElement): void {
    switch (element.kind) {
      case 'WebButton':
        this.checkWebButton(element);
        return;
      case 'WebDiv':
        this.checkWebDiv(element);
        return;
      case 'WebText':
        this.checkWebText(element);
        return;
    }
  }

  private checkWebButton(element: WebButton): void {
    if (element.to === null) {
      this.report(
        ErrorCodes.WEBSETS_SHAPE,
        'button 缺少 to <地址>',
        element.span,
        '按钮得说清楚点了去哪：button { to "localhost:9000" }',
      );
      return;
    }

    const target = this.checkExpr(element.to.target);
    if (target === 'text' || target === 'any') return;

    this.report(
      ErrorCodes.TYPE_MISMATCH,
      `to 的地址必须是 text（文本），实际是${typeLabel(target)}`,
      element.to.target.span,
      '地址要加引号：to "localhost:9000"；也可以引用前面声明好的 text 变量',
    );
  }

  /** div 里的文本内容：一条表达式，结果必须是 text */
  private checkWebText(element: WebText): void {
    const value = this.checkExpr(element.value);
    if (value === 'text' || value === 'any') return;

    this.report(
      ErrorCodes.TYPE_MISMATCH,
      `div 里的文本必须是 text（文本），实际是${typeLabel(value)}`,
      element.value.span,
      '直接写文本或变量即可，例如：你好、变量名，含空格的文本用引号包起来',
    );
  }

  /** div：位置盒子四个坐标都必须是数字，颜色必须是 text，再递归检查子元素 */
  private checkWebDiv(element: WebDiv): void {
    if (element.box !== null) this.checkWebBox(element.box);

    if (element.color !== null) {
      const color = this.checkExpr(element.color);
      if (color !== 'text' && color !== 'any') {
        this.report(
          ErrorCodes.TYPE_MISMATCH,
          `div 的 color 必须是颜色（text），实际是${typeLabel(color)}`,
          element.color.span,
          '写法：color=#ffffff（颜色字面量本身就是文本）',
        );
      }
    }

    for (const child of element.children) this.checkWebElement(child);
  }

  private checkWebBox(box: WebBox): void {
    const corners: Array<[string, typeof box.left]> = [
      ['左', box.left],
      ['上', box.top],
      ['右', box.right],
      ['下', box.bottom],
    ];
    for (const [label, expr] of corners) {
      const type = this.checkExpr(expr);
      if (type === 'int' || type === 'double' || type === 'any') continue;
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `in(...) 的${label}坐标必须是数字，实际是${typeLabel(type)}`,
        expr.span,
        '写法：in (0,0;256,256)；坐标也可以引用前面声明好的 int / double 变量',
      );
    }
  }

  /* ------------------------------ game ------------------------------ */

  /**
   * game()。
   *
   * 由 `#incloud game` 解锁：模块没启用时只报一条 E0335 就收工，免得窗口里的
   * 名字被当成"未声明"再报一遍。缺失 game.init() 报 E0336。
   */
  private checkGame(stmt: GameDecl): void {
    if (!this.hasGame) {
      this.report(
        ErrorCodes.GAME_MODULE,
        `game() 需要 ${GAME_MODULE} 能力模块`,
        stmt.nameSpan,
        `请在文件开头写 #incloud ${GAME_MODULE}`,
      );
      return;
    }

    if (stmt.init === null) {
      this.report(
        ErrorCodes.GAME_SHAPE,
        'game() 里缺少 game.init()',
        stmt.nameSpan,
        '窗口内容写在 game.init() { ... } 里，例如：game() { game.init() { display.win(1000, 800) display.head("lemon") } }',
      );
      return;
    }

    const savedTop = this.visibleTop;
    const merged = new Map<string, SymbolInfo>();
    for (const [name, sym] of this.topVars) merged.set(name, sym);
    for (const [name, sym] of this.hoisted) merged.set(name, sym);
    this.visibleTop = merged;

    this.scopes.push(new Map());
    try {
      for (const element of stmt.init.elements) this.checkGameElement(element);
    } finally {
      this.scopes.pop();
      this.visibleTop = savedTop;
    }
  }

  private checkGameElement(element: GameElement): void {
    switch (element.kind) {
      case 'DisplayWin': {
        const width = this.checkExpr(element.width);
        const height = this.checkExpr(element.height);
        for (const [type, expr] of [
          [width, element.width],
          [height, element.height],
        ] as const) {
          if (type === 'int' || type === 'any') continue;
          this.report(
            ErrorCodes.TYPE_MISMATCH,
            `display.win 的宽高必须是 int（整数），实际是${typeLabel(type)}`,
            expr.span,
            '写法：display.win(1000, 800)',
          );
        }
        return;
      }
      case 'DisplayHead': {
        const title = this.checkExpr(element.title);
        if (title === 'text' || title === 'any') return;
        this.report(
          ErrorCodes.TYPE_MISMATCH,
          `display.head 的标题必须是 text（文本），实际是${typeLabel(title)}`,
          element.title.span,
          '标题要加引号：display.head("lemon")',
        );
        return;
      }
      default:
        return;
    }
  }

  /**
   * `buildexe = 文件名`：右侧求值为 text，且必须有 web / game 页面可打包。
   */
  private checkBuildExe(stmt: BuildExeDecl): void {
    const type = this.checkExpr(stmt.filename);
    if (type !== 'text' && type !== 'any') {
      this.report(
        ErrorCodes.BUILD_FILENAME,
        'buildexe 的文件名必须是文本',
        stmt.filename.span,
        '写裸文本或引号字符串，例如：buildexe = 我的游戏、buildexe = "my game.exe"',
      );
    }
    if (!this.modules.has(WEBSETS_MODULE) && !this.modules.has(GAME_MODULE)) {
      this.report(
        ErrorCodes.BUILD_MODULE,
        'buildexe 需要 websets() 或 game() 提供可打包的页面',
        stmt.span,
        `请在文件开头写 #incloud ${WEBSETS_MODULE} 或 #incloud ${GAME_MODULE}，并用 websets() / game() 描述界面`,
      );
    }
  }

  /**
   * `game.running = True` 这类赋值。
   *
   * 只允许 game.running / game.quit 两个 bool 字段；别的目标给出明确指引——
   * Lemon 的普通变量仍然不可重新赋值，这条限制只对 game 的运行状态开口子。
   */
  private checkAssign(stmt: AssignStmt): void {
    // 只认 game.<字段>；其它目标（含对象字段）一律不允许
    if (stmt.target.name !== 'game') {
      this.report(
        ErrorCodes.GAME_ASSIGN,
        `不能给 ${stmt.target.name}.${stmt.property} 赋值`,
        stmt.span,
        'Lemon 的变量不可重新赋值，对象字段也只读；这个赋值只用于 game.running / game.quit',
      );
      this.checkExpr(stmt.value);
      return;
    }

    if (!this.hasGame) {
      this.report(
        ErrorCodes.GAME_MODULE,
        `game 的运行状态需要 ${GAME_MODULE} 能力模块`,
        stmt.target.span,
        `请在文件开头写 #incloud ${GAME_MODULE}`,
      );
      this.checkExpr(stmt.value);
      return;
    }

    const validField = stmt.property === 'running' || stmt.property === 'quit';
    if (!validField) {
      this.report(
        ErrorCodes.GAME_ASSIGN,
        `game 没有可赋值的字段 '${stmt.property}'`,
        stmt.propertySpan,
        '可赋值的字段：running（是否运行）、quit（是否退出），都是 bool',
      );
    }

    const value = this.checkExpr(stmt.value);
    if (validField && value !== 'bool' && value !== 'any') {
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `game.${stmt.property} 只能赋 bool（真假值），实际是${typeLabel(value)}`,
        stmt.value.span,
        '写成 true / false，或用比较运算，例如：game.running = 分数 > 60',
      );
    }
  }

  /* ------------------------------ class ------------------------------ */

  /**
   * 尽量推断一个表达式是不是“某个类的实例”：
   *   - 类类型变量（SymbolInfo.className）
   *   - 方法里的接收者（第一个参数，约定叫 self）
   * 推不出来就返回 null（成员访问退化为不做字段校验）。
   */
  private classOfExpr(expr: Expr): ClassDecl | null {
    if (expr.kind !== 'Ident') return null;
    const sym = this.lookup(expr.name);
    if (sym === null || sym.className === undefined || sym.className === null) return null;
    return this.classes.get(sym.className) ?? null;
  }

  private checkClass(stmt: ClassDecl): void {
    if (!this.hasClass) {
      this.report(
        ErrorCodes.CLASS_MODULE,
        `class 需要 ${CLASS_MODULE} 能力模块`,
        stmt.nameSpan,
        `请在文件开头写 #incloud ${CLASS_MODULE}`,
      );
      return;
    }

    const seenFields = new Set<string>();
    for (const field of stmt.fields) {
      if (seenFields.has(field.name)) {
        this.report(
          ErrorCodes.DUPLICATE_DECL,
          `类 ${stmt.name} 的字段 ${field.name} 重复声明`,
          field.nameSpan,
          '字段名必须互不相同',
        );
      }
      seenFields.add(field.name);
    }

    const seenMethods = new Set<string>();
    for (const method of stmt.methods) {
      if (seenMethods.has(method.name)) {
        this.report(
          ErrorCodes.DUPLICATE_DECL,
          `类 ${stmt.name} 的方法 ${method.name} 重复声明`,
          method.nameSpan,
          '方法名必须互不相同',
        );
      }
      seenMethods.add(method.name);
    }

    for (const method of stmt.methods) this.checkClassMethod(stmt, method);
  }

  /** 方法体：第一个参数是接收者（绑定到对象），其余与普通函数一致 */
  private checkClassMethod(cls: ClassDecl, method: ClassMethod): void {
    const savedTop = this.visibleTop;
    const savedDepth = this.functionDepth;
    const savedInMain = this.inMainBody;
    const savedClass = this.currentClass;
    this.functionDepth += 1;
    this.inMainBody = false;
    this.currentClass = cls;

    const merged = new Map<string, SymbolInfo>();
    for (const [name, sym] of this.topVars) merged.set(name, sym);
    for (const [name, sym] of this.hoisted) merged.set(name, sym);
    this.visibleTop = merged;

    const scope = new Map<string, SymbolInfo>();
    method.params.forEach((param, index) => {
      scope.set(param.name, {
        name: param.name,
        kind: 'variable',
        type: index === 0 ? 'object' : 'any',
        span: param.span,
        decl: null,
        builtin: null,
        className: index === 0 ? cls.name : null,
      });
    });
    this.scopes.push(scope);

    this.checkBodyStatements(method.body);

    this.scopes.pop();
    this.currentClass = savedClass;
    this.visibleTop = savedTop;
    this.functionDepth = savedDepth;
    this.inMainBody = savedInMain;
  }

  /**
   * 构造 `类名(实参...)`：实参个数要与字段数一致，类型要能赋给对应字段。
   * 没有构造函数——按字段书写顺序把实参打包进去。
   */
  private checkConstruct(call: Call, cls: ClassDecl): LemonType {
    const argTypes = call.args.map((a) => this.checkExpr(a));

    if (call.args.length !== cls.fields.length) {
      this.report(
        ErrorCodes.ARG_COUNT,
        `构造 ${cls.name} 需要 ${cls.fields.length} 个参数（对应 ${cls.fields.length} 个字段），实际给了 ${call.args.length} 个`,
        call.span,
        cls.fields.length === 0
          ? `${cls.name} 没有字段，写成 ${cls.name}()`
          : `字段顺序：${cls.fields.map((f) => f.name).join('、')}`,
      );
      return 'object';
    }

    cls.fields.forEach((field, index) => {
      const type = argTypes[index];
      if (type === 'any' || assignable(type, field.typeName)) return;
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `构造 ${cls.name} 时第 ${index + 1} 个字段 ${field.name} 需要${typeLabel(field.typeName)}，实际是${typeLabel(type)}`,
        call.args[index].span,
        '按字段声明的顺序传值',
      );
    });

    return 'object';
  }

  /** `对象.方法(实参...)` */
  private checkMethodCall(call: MethodCall): LemonType {
    const base = this.checkExpr(call.object);
    for (const arg of call.args) this.checkExpr(arg);

    const cls = this.classOfExpr(call.object);
    if (cls === null) {
      if (base === 'any' || base === 'object') return 'any';
      this.report(
        ErrorCodes.INVALID_MEMBER,
        `${typeLabel(base)}没有方法 '${call.method}'`,
        call.methodSpan,
        '只有类实例才有方法；方法要写成 对象.方法(实参...)',
      );
      return 'any';
    }

    const method = cls.methods.find((m) => m.name === call.method);
    if (method === undefined) {
      const names = cls.methods.map((m) => m.name);
      this.report(
        ErrorCodes.INVALID_MEMBER,
        `类 ${cls.name} 没有方法 '${call.method}'`,
        call.methodSpan,
        names.length === 0 ? '这个类还没有定义方法' : `可用方法：${names.join('、')}`,
      );
      return 'any';
    }

    // 方法第一个参数是 self，调用时不用给
    const expected = Math.max(0, method.params.length - 1);
    const given = call.args.length;
    if (given !== expected) {
      this.report(
        ErrorCodes.ARG_COUNT,
        `方法 ${cls.name}.${call.method} 需要 ${expected} 个参数，实际给了 ${given} 个`,
        call.span,
        expected === 0 ? '它只接收 self，调用时不用给参数' : `调用示例：对象.${call.method}(值...)`,
      );
    }

    return returnTypeOf(method);
  }

  /* ------------------------------ output ------------------------------ */

  /**
   * `output <文本>`：只接受文本。开头 `[error]` / `[warning]` / `[log]` 的级别
   * 由运行期解释（决定走 stderr 还是 stdout），静态阶段不校验标记拼写。
   */
  private checkOutput(stmt: OutputStmt): void {
    const type = this.checkExpr(stmt.value);
    if (type === 'text' || type === 'any') return;
    this.report(
      ErrorCodes.TYPE_MISMATCH,
      `output 需要一段文本，实际是${typeLabel(type)}`,
      stmt.value.span,
      '用引号括起来，例如 output "[error]出错了"；开头写 [error] / [warning] / [log] 标级别',
    );
  }

  private checkFunction(fn: FuncDecl): void {
    const savedTop = this.visibleTop;
    const savedDepth = this.functionDepth;
    const savedInMain = this.inMainBody;
    this.functionDepth += 1;
    this.inMainBody = fn.isMain;
    // 函数体内可见：全部顶层变量 + 全部函数（含内建）。
    // 顺序很重要——函数/内建后写入，遇到非法同名变量时它们仍然胜出，避免级联误报。
    const merged = new Map<string, SymbolInfo>();
    for (const [name, sym] of this.topVars) merged.set(name, sym);
    for (const [name, sym] of this.hoisted) merged.set(name, sym);
    this.visibleTop = merged;

    const scope = new Map<string, SymbolInfo>();
    for (const p of fn.params) {
      if (this.isBuiltinName(p.name)) {
        this.report(
          ErrorCodes.DUPLICATE_DECL,
          `${p.name} 是内置函数名，不能用作参数名`,
          p.span,
          '请换一个参数名',
        );
        continue; // 不登记非法参数，避免函数体内产生级联误报
      }
      scope.set(p.name, {
        name: p.name,
        kind: 'variable',
        type: 'any',
        span: p.span,
        decl: null,
        builtin: null,
      });
    }
    this.scopes.push(scope);

    this.checkBodyStatements(fn.body);

    this.scopes.pop();
    this.visibleTop = savedTop;
    this.functionDepth = savedDepth;
    this.inMainBody = savedInMain;
  }

  /**
   * return。
   *
   * "写在函数外"（E0204）由解析器负责——那是结构位置问题，与 break 同理。
   * 这里只管函数内两种情况的区别：
   *   - main() 里带值：E0328，main 的结果没人接，值写了也会被丢掉
   *   - 普通函数里：带值返回那个值，不带值返回 unit
   */
  private checkReturnStmt(stmt: ReturnStmt): void {
    if (stmt.value === null) return; // 光秃秃的 return：提前收工

    if (this.inMainBody) {
      this.report(
        ErrorCodes.RETURN_VALUE_IN_MAIN,
        'main() 不能带值返回',
        stmt.value.span,
        'main 是程序入口，返回值没有人接。要提前结束程序写单独的 return 即可；要计算一个值请用 def 定义别的函数',
      );
      this.checkExpr(stmt.value);
      return;
    }

    this.checkExpr(stmt.value);
  }

  /* -------------------------- 表达式检查 --------------------------- */

  private checkExpr(expr: Expr): LemonType {
    switch (expr.kind) {
      case 'IntLit':
        return 'int';
      case 'DoubleLit':
        return 'double';
      case 'TextLit':
        return 'text';
      case 'BoolLit':
        return 'bool';
      case 'Ident':
        return this.checkIdent(expr);
      case 'Call':
        return this.checkCall(expr);
      case 'Binary':
        return this.checkBinary(expr);
      case 'Unary':
        return this.checkUnary(expr);
      case 'Member':
        return this.checkMember(expr);
      case 'MethodCall':
        return this.checkMethodCall(expr);
      case 'Index':
        return this.checkIndex(expr);
      case 'ListRef':
        return this.checkListRef(expr);
      default:
        return 'any';
    }
  }

  /**
   * 下标读取 `列表[下标]`。
   *
   * 元素类型一律是 `any`（块式字面量允许混合类型），所以 `列表[0]` 的类型也是
   * `any`——具体是什么值交给运行期，与函数参数同一条思路。
   * 下标必须是 `int`；越界是运行期的事（静态只知道类型，不知道长度）。
   */
  private checkIndex(expr: Index): LemonType {
    const base = this.checkExpr(expr.object);
    const indexType = this.checkExpr(expr.index);

    if (base !== 'list' && base !== 'any') {
      this.report(
        ErrorCodes.LIST_INDEX,
        `${typeLabel(base)}没有下标，不能用 [] 取值`,
        expr.object.span,
        base === 'text'
          ? '文本不能用下标取字符；直接 say(...) 就能输出整段文本'
          : '只有列表能取下标：先 list(名字) { 元素 换行 元素 } 声明，再写 名字[0]',
      );
    }

    if (indexType !== 'int' && indexType !== 'any') {
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `下标必须是 int（整数），实际是${typeLabel(indexType)}`,
        expr.index.span,
        '下标从 0 开始：名字[0] 是第一个元素，名字[1] 是第二个',
      );
    }

    return 'any';
  }

  /**
   * 成员访问：目前只有错误值有字段。
   *   code    → text（错误码，如 E0405）
   *   line    → int（出错行号）
   *   message → text（说明，不含错误码）
   */
  private checkMember(expr: Member): LemonType {
    // game 命名空间：game.running / game.quit 都是 bool（由 #incloud game 解锁）
    if (this.hasGame && expr.object.kind === 'Ident' && expr.object.name === 'game') {
      if (expr.property === 'running' || expr.property === 'quit') return 'bool';
      this.report(
        ErrorCodes.INVALID_MEMBER,
        `game 没有 '${expr.property}' 字段`,
        expr.propertySpan,
        '可用的字段：running（是否运行）、quit（是否退出），都是 bool',
      );
      return 'any';
    }

    const base = this.checkExpr(expr.object);

    // 类实例：能确定具体类时校验字段，返回字段类型
    const cls = this.classOfExpr(expr.object);
    if (cls !== null) {
      const field = cls.fields.find((f) => f.name === expr.property);
      if (field !== undefined) return field.typeName;
      const method = cls.methods.find((m) => m.name === expr.property);
      this.report(
        ErrorCodes.INVALID_MEMBER,
        `类 ${cls.name} 没有字段 '${expr.property}'`,
        expr.propertySpan,
        method !== undefined
          ? `'${expr.property}' 是方法，调用要写括号：对象.${expr.property}(...)`
          : `可用字段：${cls.fields.length === 0 ? '（无）' : cls.fields.map((f) => f.name).join('、')}`,
      );
      return 'any';
    }

    // 函数参数是 any（可能装着错误值），交给运行期判断；object 拿不到具体类时也不报
    if (base === 'any' || base === 'object') return 'any';

    if (base !== 'error') {
      this.report(
        ErrorCodes.INVALID_MEMBER,
        `${typeLabel(base)}没有 '${expr.property}' 字段`,
        expr.span,
        '只有 catch 捕获到的错误值才有 code / line / message 字段',
      );
      return 'any';
    }

    switch (expr.property) {
      case 'code':
      case 'message':
        return 'text';
      case 'line':
        return 'int';
      default:
        this.report(
          ErrorCodes.INVALID_MEMBER,
          `错误值没有 '${expr.property}' 字段`,
          expr.propertySpan,
          '可用的字段：code（错误码）、line（行号）、message（说明）',
        );
        return 'any';
    }
  }

  /**
   * 一元运算。
   *   '-' / '+'  保持操作数类型（-int 仍是 int），只接受 int 与 double
   *   '!'        只接受 bool，结果固定为 bool
   */
  private checkUnary(expr: Unary): LemonType {
    const operand = this.checkExpr(expr.operand);

    if (expr.op === '!') {
      if (operand !== 'bool' && operand !== 'any') {
        this.report(
          ErrorCodes.TYPE_MISMATCH,
          `'!' 的操作数必须是 bool（真假值），实际是${typeLabel(operand)}`,
          expr.operand.span,
          negationHint(operand),
        );
      }
      return 'bool';
    }

    if (operand === 'any') return 'any';

    if (!isNumeric(operand)) {
      const isMinus = expr.op === '-';
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        isMinus ? `${typeLabel(operand)}不能取负` : `${typeLabel(operand)}不能使用一元 '+'`,
        expr.span,
        isMinus
          ? '一元负号只接受 int 与 double'
          : "一元 '+' 只接受 int 与 double；若只是想去掉加号，直接写该值即可",
      );
      return 'any';
    }
    return operand;
  }

  /**
   * 二元运算的类型规则：
   *   '+'             int/double 之间按数值相加（含 int→double 提升）；text + text 拼接
   *   '-' '*' '/'     仅接受 int/double
   *   '&&' '||'       仅接受 bool，结果 bool
   *   '==' '!='       数字之间、text 之间、bool 之间
   *   '<' '<=' '>' '>='  仅数字
   *   同级类型        int 与 int 得 int，其余组合得 double
   */
  private checkBinary(expr: Binary): LemonType {
    const left = this.checkExpr(expr.left);
    const right = this.checkExpr(expr.right);

    if (LOGICAL_OPS.has(expr.op)) return this.checkLogical(expr, left, right);
    if (COMPARISON_OPS.has(expr.op)) return this.checkComparison(expr, left, right);

    // 函数参数是 any，运算结果无法静态确定，交给运行期判断，避免误报
    if (left === 'any' || right === 'any') return 'any';

    if (left === 'unit' || right === 'unit') {
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `${typeLabel(left === 'unit' ? left : right)}不能参与运算`,
        expr.span,
        'say(...) 只负责输出，没有返回值，不能作为运算数',
      );
      return 'any';
    }

    if (expr.op === '+') {
      if (left === 'text' && right === 'text') return 'text';
      if (isNumeric(left) && isNumeric(right)) return promoteNumeric(left, right);
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `${typeLabel(left)}与${typeLabel(right)}不能用 '+' 运算`,
        expr.span,
        "数字与文本不能直接相加；文本只能与文本用 '+' 拼接",
      );
      return 'any';
    }

    if (left === 'text' || right === 'text') {
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `文本不能参与 '${expr.op}' 运算`,
        expr.span,
        "文本只能用 '+' 拼接",
      );
      return 'any';
    }

    if (!isNumeric(left) || !isNumeric(right)) {
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `${typeLabel(left)}与${typeLabel(right)}不能用 '${expr.op}' 运算`,
        expr.span,
        '该运算符只接受 int 与 double',
      );
      return 'any';
    }

    // 除数是字面量 0 时可以在运行前就拦下来
    if (expr.op === '/' && isLiteralZero(expr.right)) {
      this.report(
        ErrorCodes.DIVIDE_BY_ZERO_STATIC,
        '除数为 0',
        expr.right.span,
        '任何数都不能除以 0，请检查这里的值',
      );
    }

    // int 乘方要求指数非负；字面量负数可以在运行前就拦下来
    if (expr.op === '**' && left === 'int' && isNegativeIntLiteral(expr.right)) {
      this.report(
        ErrorCodes.NEGATIVE_EXPONENT_STATIC,
        'int 乘方不支持负指数',
        expr.right.span,
        '把底数写成小数即可，例如 2.0 ** -1；或用 1.0 / (2 ** 1)',
      );
    }

    return promoteNumeric(left, right);
  }

  /** 逻辑运算：两侧都必须是 bool，结果固定为 bool（短路语义由求值器保证） */
  private checkLogical(expr: Binary, left: LemonType, right: LemonType): LemonType {
    const sides: Array<[LemonType, Expr]> = [
      [left, expr.left],
      [right, expr.right],
    ];
    for (const [type, side] of sides) {
      if (type === 'bool' || type === 'any') continue;
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `'${expr.op}' 的操作数必须是 bool（真假值），实际是${typeLabel(type)}`,
        side.span,
        logicalHint(type, expr.op),
      );
    }
    return 'bool';
  }

  /**
   * 比较运算。
   *   '==' '!='  数字之间（含 int/double 混合）、text 之间、bool 之间
   *   大小比较    仅数字之间；text 与 bool 没有全序，不做比较
   */
  private checkComparison(expr: Binary, left: LemonType, right: LemonType): LemonType {
    const op = expr.op;
    const equality = op === '==' || op === '!=';

    // 两侧类型有一处是 any（函数参数）时无法静态判断，交给运行期
    if (left === 'any' || right === 'any') return 'bool';

    // 一侧是写错的 bool 字面量（True / False）时已经报过 E0322，不再补比较错误
    if (isMisspelledBoolLiteral(expr.left) || isMisspelledBoolLiteral(expr.right)) return 'bool';

    if (left === 'unit' || right === 'unit') {
      this.report(
        ErrorCodes.TYPE_MISMATCH,
        `${typeLabel(left === 'unit' ? left : right)}不能参与 '${op}' 比较`,
        expr.span,
        'say(...) 只负责输出，没有返回值，不能作为比较的一方',
      );
      return 'bool';
    }

    if (isNumeric(left) && isNumeric(right)) return 'bool';

    if (equality && left === right && (left === 'text' || left === 'bool')) return 'bool';

    this.report(
      ErrorCodes.TYPE_MISMATCH,
      `${typeLabel(left)}与${typeLabel(right)}不能用 '${op}' 比较`,
      expr.span,
      comparisonHint(op, left, right),
    );
    return 'bool';
  }

  private checkIdent(node: Ident): LemonType {
    // game 是内置命名空间（#incloud game 解锁），只能取 game.running / game.quit；
    // 单独把 game 当变量用没有意义，这里给一个不报"未声明"的兜底类型
    if (node.name === 'game' && this.hasGame) return 'any';

    const sym = this.lookup(node.name);
    if (sym !== null) {
      this.used.add(node.name);
      node.resolution = this.resolutionOf(sym);
      return sym.type;
    }

    // 顶层语句里使用了"声明在后面的变量"——运行时确实拿不到值，直接报错
    if (this.scopes.length === 0 && !this.visibleTop.has(node.name)) {
      const later = this.topVars.get(node.name);
      if (later) {
        this.report(
          ErrorCodes.SIMILAR_NAME,
          `变量 ${node.name} 在第 ${later.span.line} 行才声明，此处还不能使用`,
          node.span,
          '顶层语句按从上到下的顺序执行',
        );
        return 'any';
      }
    }

    // 把 bool 字面量写成 True / False：这是从别的语言带过来的高频笔误
    const correctLiteral = MISSPELLED_BOOL_LITERALS.get(node.name);
    if (correctLiteral !== undefined) {
      this.report(
        ErrorCodes.MISSPELLED_LITERAL,
        `${node.name} 不是 Lemon 的写法（已按文本处理）`,
        node.span,
        `bool 字面量是全小写的 ${correctLiteral}；若确实要输出这段文字，请加引号：say("${node.name}")`,
      );
      node.resolution = { kind: 'bareText' };
      return 'text';
    }

    const similar = this.findSimilar(node.name, { includeBuiltins: false });
    if (similar !== null) {
      this.report(
        ErrorCodes.SIMILAR_NAME,
        `未声明的名字 ${node.name}（已按文本处理）`,
        node.span,
        `是否想使用已声明的 ${similar}？`,
      );
      node.resolution = { kind: 'bareText' };
      return 'text';
    }

    // 裸文本：不加引号直接当字符串
    node.resolution = { kind: 'bareText' };
    return 'text';
  }

  private checkCall(call: Call): LemonType {
    // 类名当构造用：`Student("小明", 18)`
    const cls = this.classes.get(call.callee.name);
    if (cls !== undefined) {
      if (!this.hasClass) {
        this.report(
          ErrorCodes.CLASS_MODULE,
          `构造 ${cls.name} 需要 ${CLASS_MODULE} 能力模块`,
          call.callee.span,
          `请在文件开头写 #incloud ${CLASS_MODULE}`,
        );
        for (const arg of call.args) this.checkExpr(arg);
        return 'any';
      }
      return this.checkConstruct(call, cls);
    }

    const sym = this.lookup(call.callee.name);

    if (sym === null) {
      const similar = this.findSimilar(call.callee.name, { includeBuiltins: true });
      this.report(
        ErrorCodes.UNDEFINED_FUNCTION,
        `未定义的函数 ${call.callee.name}`,
        call.callee.span,
        this.undefinedFunctionHint(call.callee.name, similar),
      );
      for (const arg of call.args) this.checkExpr(arg);
      return 'any';
    }

    this.used.add(sym.name);

    if (sym.kind === 'variable') {
      this.report(
        ErrorCodes.NOT_A_FUNCTION,
        `${sym.name} 是变量，不是函数，不能调用`,
        call.callee.span,
        `变量 ${sym.name} 声明于第 ${sym.span.line} 行，类型为 ${sym.type}`,
      );
      for (const arg of call.args) this.checkExpr(arg);
      return 'any';
    }

    call.callee.resolution = this.resolutionOf(sym);

    const beforeArgs = this.diagnostics.length;
    const argTypes = call.args.map((a) => this.checkExpr(a));

    if (sym.kind === 'builtin') {
      const b = sym.builtin!;
      if (call.args.length < b.minArgs || call.args.length > b.maxArgs) {
        const need =
          b.minArgs === b.maxArgs ? `恰好 ${b.minArgs} 个` : `${b.minArgs} ~ ${b.maxArgs} 个`;
        this.report(
          b.name === 'say' ? ErrorCodes.SAY_ARITY : ErrorCodes.ARG_COUNT,
          `${b.name} 需要${need}参数，实际给了 ${call.args.length} 个`,
          call.span,
          b.arityHint,
        );
        return b.returns;
      }
      argTypes.forEach((t, i) => {
        const expected = b.paramTypes[i] ?? b.paramTypes[b.paramTypes.length - 1] ?? 'any';
        if (!assignable(t, expected)) {
          this.report(
            ErrorCodes.TYPE_MISMATCH,
            `${b.name} 的第 ${i + 1} 个参数应为${typeLabel(expected)}，实际是${typeLabel(t)}`,
            call.args[i].span,
            b.paramHints?.[i],
          );
        }
      });

      // say 的文本必须加引号：裸文本（不加引号的文字）在这里报错；
      // 变量、数字、带引号的字符串都不受影响。
      // 实参本身已经报过错（如名字笔误 E0312）时就不再补一条，免得说两遍。
      if (b.name === 'say' && this.diagnostics.length === beforeArgs) {
        for (const arg of call.args) {
          const bare = bareTextOf(arg);
          if (bare === null) continue;
          this.report(
            ErrorCodes.SAY_BARE_TEXT,
            `say 的文本要加引号（这里是「${bare}」）`,
            arg.span,
            `改成 say("${bare}")；变量 say(a)、数字 say(1) 不用加`,
          );
        }
      }

      // 字面量参数的额外校验（如键名拼写）。实参本身已经报过错时不再补刀，
      // 免得一条笔误（比如名字打错）被说两遍。
      if (b.checkLiteralArg !== undefined && this.diagnostics.length === beforeArgs) {
        call.args.forEach((arg, index) => {
          const literal = literalTextOf(arg);
          if (literal === null) return;
          const problem = b.checkLiteralArg!(index, literal);
          if (problem !== null) {
            this.report(ErrorCodes.INVALID_ARGUMENT, problem.message, arg.span, problem.hint);
          }
        });
      }
      return b.returns;
    }

    const fn = sym.decl!;
    if (call.args.length !== fn.params.length) {
      this.report(
        ErrorCodes.ARG_COUNT,
        `函数 ${fn.name} 需要 ${fn.params.length} 个参数，实际给了 ${call.args.length} 个`,
        call.span,
        `函数 ${fn.name} 声明于第 ${fn.nameSpan.line} 行`,
      );
    }
    // 用户函数的返回类型在提升时就按"有没有带值的 return"定好了（见 returnTypeOf）
    return sym.type;
  }

  /**
   * "未定义的函数"该怎么提示。
   * 优先级：忘了 #incloud > 形近名 > 通用说明——前者是最常见也最好修的一类。
   */
  private undefinedFunctionHint(name: string, similar: string | null): string {
    const owner = moduleOfFunction(name);
    if (owner !== null) {
      return `${name} 来自 ${owner.name} 模块（${owner.summary}）；请在文件开头写 #incloud ${owner.name}`;
    }
    if (similar !== null) return `是否想调用 ${similar}？`;
    return `Lemon 自带的内置函数：${[...BUILTINS.keys()].join('、')}；要引入更多能力请写 #incloud <模块名>（可用：${MODULE_NAMES}），自定义函数用 def 声明`;
  }

  private resolutionOf(sym: SymbolInfo): NameResolution {
    if (sym.kind === 'builtin') return { kind: 'builtin', name: sym.name };
    if (sym.kind === 'function') return { kind: 'function', decl: sym.decl! };
    return { kind: 'variable', type: sym.type, line: sym.span.line };
  }

  private lookup(name: string): SymbolInfo | null {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const found = this.scopes[i].get(name);
      if (found !== undefined) return found;
    }
    const top = this.visibleTop.get(name);
    if (top !== undefined) return top;
    return this.hoisted.get(name) ?? null;
  }

  /* ------------------------- 形近名与未使用 ------------------------ */

  private findSimilar(name: string, options: { includeBuiltins: boolean }): string | null {
    if (name.length < 3 || !isAsciiIdentifier(name)) return null;

    const candidates = new Set<string>();
    for (const key of this.visibleTop.keys()) candidates.add(key);
    for (const scope of this.scopes) for (const key of scope.keys()) candidates.add(key);
    // 内建只在与"调用"位置比对时参与，避免 say(bay) 这类裸文本被误判
    if (options.includeBuiltins) for (const key of this.hoisted.keys()) candidates.add(key);

    let best: string | null = null;
    for (const candidate of candidates) {
      if (candidate === name) continue;
      if (candidate.length < 3 || !isAsciiIdentifier(candidate)) continue;
      if (!options.includeBuiltins && this.isBuiltinName(candidate)) continue;
      if (!withinEditDistanceOne(name, candidate)) continue;
      if (best === null || candidate.length < best.length) best = candidate;
    }
    return best;
  }

  private reportUnused(program: Program): void {
    for (const [name, sym] of this.topVars) {
      if (this.used.has(name)) continue;
      this.report(
        ErrorCodes.UNDEFINED_VAR,
        `变量 ${name} 声明后从未使用`,
        sym.span,
        undefined,
        'warning',
      );
    }
    for (const fn of program.functions) {
      if (this.used.has(fn.name)) continue;
      this.report(ErrorCodes.UNDEFINED_VAR, `函数 ${fn.name} 定义后从未调用`, fn.nameSpan, undefined, 'warning');
    }
  }

  /* ------------------------------ 工具 ----------------------------- */

  private report(
    code: string,
    message: string,
    span: Span,
    hint?: string,
    severity: 'error' | 'warning' = 'error',
  ): void {
    const diag: Diagnostic = {
      severity,
      code,
      message,
      line: span.line,
      col: span.col,
      endLine: span.endLine,
      endCol: span.endCol,
    };
    if (hint) diag.hint = hint;
    this.diagnostics.push(diag);
  }
}

/* ------------------------------------------------------------------ */
/* 字符串相似度：编辑距离 ≤ 1                                          */
/* ------------------------------------------------------------------ */

function isNumeric(type: LemonType): boolean {
  return type === 'int' || type === 'double';
}

/**
 * 把 bool 字面量写成 True / False —— 从 Python / Java 带过来的高频笔误。
 * 只收这一组：它们是已有关键字的"大小写近亲"，误判概率极低。
 */
const MISSPELLED_BOOL_LITERALS = new Map<string, string>([
  ['True', 'true'],
  ['False', 'false'],
  ['TRUE', 'true'],
  ['FALSE', 'false'],
]);

/**
 * 带时间单位的字面量（1min / 500ms）是 double（秒）。
 * 存进 int 变量时报错要给专门的提示，否则"double 不能转 int"会让人困惑。
 */
function durationHint(target: LemonType, expr: Expr): string | undefined {
  if (target !== 'int' || expr.kind !== 'DoubleLit' || expr.durationUnit === undefined) return undefined;
  return `${expr.raw} 是带单位的时长，按秒换算后是 double（${expr.value}）；要整数请把类型改成 double，或直接写 ${expr.value}`;
}

function isMisspelledBoolLiteral(expr: Expr): boolean {
  return expr.kind === 'Ident' && MISSPELLED_BOOL_LITERALS.has(expr.name);
}

/**
 * 实参是字面量文本时取出它的值：引号字符串、裸文本都算。
 * 已经解析成变量 / 函数的名字返回 null——值要到运行期才知道，不静态校验。
 */
/**
 * 这个表达式是不是“**不加引号**的文本”：
 *   - 裸文本字面量（`你好，世界` 这种带标点的）
 *   - 解析成裸文本的标识符（`你好`、`bay`）
 * 带引号的字符串（`"你好"`）**不算**，所以 `say("x")` 不受影响。
 */
function bareTextOf(expr: Expr): string | null {
  if (expr.kind === 'TextLit' && expr.bare) return expr.value;
  if (expr.kind === 'Ident' && expr.resolution?.kind === 'bareText') return expr.name;
  return null;
}

function literalTextOf(expr: Expr): string | null {
  if (expr.kind === 'TextLit') return expr.value;
  if (expr.kind === 'Ident' && expr.resolution?.kind === 'bareText') return expr.name;
  return null;
}





/* ------------------------------------------------------------------ */
/* 各类 "类型不对" 时的针对性修复建议                                   */
/* ------------------------------------------------------------------ */

/** if / elif 的条件不是 bool */
function conditionHint(actual: LemonType): string {
  if (isNumeric(actual)) {
    return '比较运算的结果就是 bool，例如：if a > 0 { ... }；判断非 0 请写 a != 0';
  }
  if (actual === 'text') {
    return '文本不能直接作条件；请先比较，例如：if name != "" { ... }';
  }
  if (actual === 'error') {
    return '错误值不能直接作条件；请比较它的字段，例如：if 错误.code == E0405 { ... }';
  }
  if (actual === 'unit') {
    return 'say(...) 只负责输出，没有返回值，不能作为条件';
  }
  return '条件要写成能求值为 true / false 的表达式，例如：if a > 0 { ... }';
}

/** 一元 '!' 的操作数不是 bool */
function negationHint(actual: LemonType): string {
  if (isNumeric(actual)) {
    return "取反要用比较，例如：!(a > 0)；数字本身没有真假，if a == 0 或 a != 0 更清楚";
  }
  if (actual === 'text') {
    return '文本不能取反；请先比较，例如：!(name == 小明) 或 name != 小明';
  }
  if (actual === 'unit') return 'say(...) 没有返回值，不能取反';
  return "只有 bool（true / false）能取反";
}

/** '&&' / '||' 的操作数不是 bool */
function logicalHint(actual: LemonType, op: string): string {
  if (isNumeric(actual)) {
    return `数字没有真假之分；请写成比较，例如：a > 0 ${op} b > 0`;
  }
  if (actual === 'text') {
    return `文本不能直接参与 '${op}'；请写成比较，例如：name != "" ${op} age > 0`;
  }
  if (actual === 'error') {
    return `错误值不能参与 '${op}'；请比较它的字段，例如：错误.code == E0405`;
  }
  if (actual === 'unit') return 'say(...) 没有返回值，不能参与运算';
  return `'${op}' 的两侧都必须是 bool（true / false）`;
}

/** cycle 的次数类型不对 */
function cycleCountHint(actual: LemonType): string {
  if (actual === 'double') {
    return '循环小数次没有意义：请用 int 次数，或写成 cycle(2.7) 的等价写法 cycle(3) / cycle(2)';
  }
  if (actual === 'text') return '这里是文本，不是次数；次数要写整数，例如 cycle(3)';
  if (actual === 'bool') return 'bool 不能当次数；要按条件循环请用 if，或 cycle() 配合 break';
  if (actual === 'unit') return 'say(...) 只负责输出，没有返回值，不能作为循环次数';
  if (actual === 'error') return '错误值不能作为循环次数；请取它的字段或先处理错误';
  return 'cycle(N) 的 N 必须是 int，例如 cycle(3) 表示重复 3 次';
}

/** 比较运算两侧类型不兼容 */
function comparisonHint(op: string, left: LemonType, right: LemonType): string | undefined {
  const equality = op === '==' || op === '!=';
  if (left === 'error' || right === 'error') {
    return `错误值不能直接比较；请比较它的字段，例如：错误.code ${op} E0405`;
  }
  if (!equality && (left === 'text' || right === 'text')) {
    return '文本只支持 == 与 !=，不支持大小比较';
  }
  if (!equality && (left === 'bool' || right === 'bool')) {
    return 'bool（真假值）只支持 == 与 !=';
  }
  if (left === 'text' || right === 'text') {
    return '文本只能与文本比较，例如：name == 小明；数字与文本不能比较';
  }
  if (left === 'bool' || right === 'bool') {
    return 'bool（真假值）只能与 bool 比较，例如：flag == true';
  }
  return undefined;
}

/** int 与 int 得 int，只要有一侧是 double 就得 double */
function promoteNumeric(a: LemonType, b: LemonType): LemonType {
  return a === 'double' || b === 'double' ? 'double' : 'int';
}

function isLiteralZero(expr: Expr): boolean {
  if (expr.kind === 'IntLit' || expr.kind === 'DoubleLit') return expr.value === 0;
  // -0 也是 0
  if (expr.kind === 'Unary') return isLiteralZero(expr.operand);
  return false;
}

/** 形如 `-1` 的负整数字面量（不含 -1.5、-0） */
function isNegativeIntLiteral(expr: Expr): boolean {
  return (
    expr.kind === 'Unary' &&
    expr.op === '-' &&
    expr.operand.kind === 'IntLit' &&
    expr.operand.value > 0
  );
}

function isAsciiIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function withinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i += 1) {
      if (a[i] !== b[i]) {
        diff += 1;
        if (diff > 1) return false;
      }
    }
    return diff === 1;
  }

  // 长度差 1：短的应是长的删掉一个字符的结果
  const short = la < lb ? a : b;
  const long = la < lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j += 1;
  }
  return true;
}
