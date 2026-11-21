/**
 * lemonmod（.lemon2）求值。
 *
 * v0.2 的语义：
 *   - `say(x)` / `printf(x)` 把表达式 x 的结果输出一行；
 *   - `name = expr` 给变量赋值（动态类型，可重复赋值，无需提前声明）；
 *   - 表达式是动态类型：数字与文本。未定义的变量引用会回退成「名字本身」当作文本，
 *     这样 v0.1 的 `say(hello)` 仍然按字面量输出。
 *
 * 求值器不直接碰 stdout——写出的文本交给宿主提供的 write，
 * 这样测试与 CLI 能共用同一份实现。
 */
import type { AssignStatement, BreakStatement, CallStatement, CycleStatement, Expr, FunctionDef, IfStatement, IncloudStatement, ModProgram, ModValue, ReturnStatement, Statement, WaitForBuildStatement } from './ast';
import { BUILTIN_MODULES, type BuiltinFn } from './sdk';
import { ModError, ModErrorCode, type SourceSpan } from './errors';
import { parseModFile } from './parser';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

export type WriteFn = (text: string) => void;

export class Interpreter {
  private readonly write: WriteFn;
  private readonly buffer: string[] = [];
  /** 变量环境栈：函数调用会压入一层局部环境，离开时弹出 */
  private readonly envStack: Array<Map<string, ModValue>> = [new Map()];
  /** 用户自定义函数表：名字 → 定义 */
  private readonly functions = new Map<string, FunctionDef>();
  /** 当前已加载的内置 SDK 函数表：名字 → 实现 */
  private readonly builtins = new Map<string, BuiltinFn>();
  /** 模组运行期累积的游戏状态（仅内存，运行结束即丢弃；lemon1 执行 .lemon2 时不会把它落盘或打包，只转发 stdout） */
  public readonly gameState: { [key: string]: unknown } = {};
  /** 构建清单（.mod1）里声明的源文件 / 产物表达式；仅构建清单运行时使用 */
  private buildSource: Expr | null = null;
  private buildOutput: Expr | null = null;
  /** 文件 IO 的基准目录（.mod1 / 被打包 mod 的相对路径都基于它） */
  private readonly baseDir: string;
  /** modmain 入口执行后的局部变量：视为模组的「公开配置」，供 .mod1 打包捕获 */
  public readonly modmainVars: { [key: string]: ModValue } = {};

  constructor(options: { write?: WriteFn; baseDir?: string } = {}) {
    this.write = options.write ?? (() => {});
    this.baseDir = options.baseDir ?? '.';
  }

  /** 顶层变量（全局环境）的快照，供构建清单把 mod 配置打进 .lemonmod */
  public get globals(): { [key: string]: ModValue } {
    const out: { [key: string]: ModValue } = {};
    for (const [key, value] of this.envStack[0]!) out[key] = value;
    return out;
  }

  /** 本次运行累计输出的文本 */
  get output(): string {
    return this.buffer.join('');
  }

  /**
   * 执行一个文件：
   *   1) 第一遍：处理 #incloud（加载 SDK 模块）并登记所有函数定义；
   *   2) 第二遍：执行顶层语句（赋值 / 输出 / if / cycle / 调用）；
   *   3) 若定义了 modmain，则自动调用它作为模组入口。
   */
  run(program: ModProgram): void {
    // .mod1 构建清单：跑清单体内语句（含 wait for build()），不自动调用 modmain
    if (program.kind === 'modBuild') {
      this.buildSource = program.source;
      this.buildOutput = program.output;
      for (const statement of program.body) this.execStatement(statement);
      return;
    }

    for (const statement of program.statements) {
      if (statement.kind === 'Incloud') this.execIncloud(statement);
      else if (statement.kind === 'FunctionDef') this.functions.set(statement.name, statement);
    }
    for (const statement of program.statements) {
      if (statement.kind === 'Incloud' || statement.kind === 'FunctionDef') continue;
      this.execStatement(statement);
    }
    if (this.functions.has('modmain')) {
      // 以独立局部环境运行 modmain，结束后把它的赋值当作模组「公开配置」保存下来，
      // 这样 .mod1 构建清单才能把 auther / game 这类写在 modmain 里的配置也打进 .lemonmod
      const local = new Map<string, ModValue>();
      this.envStack.push(local);
      try {
        for (const s of this.functions.get('modmain')!.body) this.execStatement(s);
      } catch (error) {
        if (!(error instanceof ReturnSignal)) throw error; // modmain 里的 return 直接忽略
      } finally {
        this.envStack.pop();
      }
      for (const [key, value] of local) this.modmainVars[key] = value;
    }
  }

  /** 把一段文本写入输出（同时进缓冲区，供 SDK 函数使用） */
  public emit(text: string): void {
    this.buffer.push(text);
    this.write(text);
  }

  /** 把运行期值转成显示文本（供 SDK 函数复用） */
  public toText(value: ModValue): string {
    return this.valueToText(value);
  }

  /** 从栈顶往下查找变量（函数内能读到外层/全局变量） */
  private getVar(name: string): ModValue | undefined {
    for (let i = this.envStack.length - 1; i >= 0; i -= 1) {
      const found = this.envStack[i]!.get(name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** 在当前（最内层）环境写入变量 */
  private setVar(name: string, value: ModValue): void {
    this.envStack[this.envStack.length - 1]!.set(name, value);
  }

  /** 执行单条语句（赋值 / 输出 / 条件分支 / 循环 / 调用 / 指令 / 函数定义），供块内复用 */
  private execStatement(statement: Statement): void {
    switch (statement.kind) {
      case 'Assign':
        this.evalAssign(statement);
        break;
      case 'If':
        this.evalIf(statement);
        break;
      case 'Cycle':
        this.evalCycle(statement);
        break;
      case 'Break':
        throw new BreakSignal();
      case 'Call':
        this.evalCall(statement);
        break;
      case 'Return':
        this.evalReturn(statement);
        break;
      case 'Incloud':
        this.execIncloud(statement);
        break;
      case 'FunctionDef':
        this.functions.set(statement.name, statement);
        break;
      case 'WaitForBuild':
        this.execWaitForBuild(statement);
        break;
    }
  }

  /**
   * `wait for build()`：读取构建清单声明的 mod 源文件，就地运行它拿到配置与游戏状态，
   * 然后把一份 .lemonmod 包写到产物路径。产物是**二进制**文件：魔数头 `LMNMOD1`
   * 紧跟 gzip 压缩的 JSON（源名 / mod 名 / 顶层变量 / 游戏状态），不再是可读文本，
   * 因此 lemon 无法把它当作源码编译。成功把 `build` 设为 true，失败设为 false
   * （并输出一行原因），供 `if build == true` 判断。
   */
  private execWaitForBuild(_stmt: WaitForBuildStatement): void {
    if (this.buildSource === null || this.buildOutput === null) {
      this.setVar('build', { kind: 'bool', value: false });
      return;
    }
    const sourceName = this.valueToText(this.evalExpr(this.buildSource));
    const outputName = this.valueToText(this.evalExpr(this.buildOutput));
    const sourcePath = path.resolve(this.baseDir, sourceName);
    const outputPath = path.resolve(this.baseDir, outputName);

    let ok = false;
    try {
      const srcText = fs.readFileSync(sourcePath, 'utf8');
      const parsed = parseModFile(srcText);
      const inner = new Interpreter({ write: () => {}, baseDir: this.baseDir });
      inner.run(parsed);
      const vars: { [key: string]: unknown } = {};
      // 顶层变量与 modmain 的公开配置合并（modmain 里的 auther/game 等也应进包）
      for (const [key, value] of Object.entries(inner.globals)) vars[key] = value.value;
      for (const [key, value] of Object.entries(inner.modmainVars)) vars[key] = value.value;
      const pkg = {
        format: 'lemonmod',
        version: 1,
        source: sourceName,
        modName: parsed.kind === 'modFile' ? parsed.name : null,
        vars,
        gameState: inner.gameState,
      };
      // 二进制产物：魔数头 + 4 字节大端负载长度 + gzip(JSON)。
      // 这样既不可读、也不可被 lemon 当源码编译，却能被 loadLemonmod 还原。
      const json = JSON.stringify(pkg);
      const body = zlib.gzipSync(Buffer.from(json, 'utf8'));
      const header = Buffer.from('LMNMOD1');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length, 0);
      fs.writeFileSync(outputPath, Buffer.concat([header, len, body]));
      ok = true;
    } catch (error) {
      this.emit(`✘ 打包失败：${(error as Error).message}\n`);
    }
    this.setVar('build', { kind: 'bool', value: ok });
  }

  private evalAssign(statement: AssignStatement): void {
    this.setVar(statement.name, this.evalExpr(statement.value));
  }

  private evalIf(statement: IfStatement): void {
    if (this.isTruthy(this.evalExpr(statement.condition))) {
      for (const s of statement.thenBody) this.execStatement(s);
      return;
    }
    for (const branch of statement.elifBodies) {
      if (this.isTruthy(this.evalExpr(branch.condition))) {
        for (const s of branch.body) this.execStatement(s);
        return;
      }
    }
    if (statement.elseBody !== null) {
      for (const s of statement.elseBody) this.execStatement(s);
    }
  }

  /**
   * cycle 循环（与 Lemon 的 cycle 同语义）：
   *   cycle(N)   执行 N 轮，每轮把轮次变量 i 设为 0..N-1
   *   cycle()    无限循环，i 从 0 开始递增，靠 break 结束
   *
   * break 通过 BreakSignal 跳出，只影响最内层的这个 cycle。
   */
  private evalCycle(stmt: CycleStatement): void {
    let count = Number.POSITIVE_INFINITY;
    if (stmt.count !== null) {
      const value = this.evalExpr(stmt.count);
      if (value.kind !== 'number') {
        throw new ModError(
          ModErrorCode.CycleCountType,
          `cycle 的次数必须是数字，实际是 ${describeValue(value)}`,
          stmt.count.span,
        );
      }
      if (value.value < 0) {
        throw new ModError(
          ModErrorCode.NegativeCycleCount,
          `cycle 的次数不能为负（这里是 ${value.value}）`,
          stmt.count.span,
        );
      }
      count = value.value;
    }
    for (let index = 0; index < count; index += 1) {
      this.setVar('i', { kind: 'number', value: index });
      try {
        for (const s of stmt.body) this.execStatement(s);
      } catch (error) {
        if (error instanceof BreakSignal) break; // break：跳出整个循环
        throw error;
      }
    }
  }

  /** return：求值返回值并掷出 ReturnSignal，由 callFunction 接住 */
  private evalReturn(statement: ReturnStatement): void {
    const value = statement.value === null
      ? { kind: 'text', value: '' } as ModValue
      : this.evalExpr(statement.value);
    throw new ReturnSignal(value);
  }

  private evalCall(statement: CallStatement): void {
    const callee = statement.callee;
    // say / printf 仍是输出语句（已在解析期约束为 1 个参数）
    if (callee === 'say' || callee === 'printf') {
      const value = this.evalExpr(statement.args[0]);
      this.emit(`${this.valueToText(value)}\n`);
      return;
    }
    // 其余名字：先按用户函数，再按已加载的 SDK 函数解析
    const argValues = statement.args.map((arg) => this.evalExpr(arg));
    this.callFunction(callee, argValues, statement.span);
  }

  /**
   * 调用一个函数：优先用户定义，其次已加载的 SDK 函数；否则报错。
   * 用户函数用一层新的局部环境执行，参数名绑定到实参，结束后弹出。
   */
  private callFunction(name: string, args: ModValue[], span: SourceSpan): ModValue {
    const userFn = this.functions.get(name);
    if (userFn !== undefined) {
      if (args.length !== userFn.params.length) {
        throw new ModError(
          ModErrorCode.WrongArgumentCount,
          `函数 \`${name}\` 需要 ${userFn.params.length} 个参数，实际给了 ${args.length} 个`,
          span,
        );
      }
      const local = new Map<string, ModValue>();
      userFn.params.forEach((param, index) => local.set(param, args[index]));
      this.envStack.push(local);
      try {
        for (const s of userFn.body) this.execStatement(s);
      } catch (error) {
        if (error instanceof ReturnSignal) return error.value;
        throw error;
      } finally {
        this.envStack.pop();
      }
      // 没有 return：函数调用结果视为空文本
      return { kind: 'text', value: '' };
    }

    const builtin = this.builtins.get(name);
    if (builtin !== undefined) {
      return builtin(this, args);
    }

    throw new ModError(
      ModErrorCode.UnknownFunction,
      `找不到函数或 SDK 函数 \`${name}\`（可用函数需先 #incloud 对应模块，或先定义）`,
      span,
    );
  }

  /** 处理 #incloud：把目标模块的所有函数注册进运行器 */
  private execIncloud(stmt: IncloudStatement): void {
    const mod = BUILTIN_MODULES[stmt.module];
    if (mod === undefined) {
      throw new ModError(
        ModErrorCode.UnknownModule,
        `找不到内置模块 \`${stmt.module}\`（当前可用：gamemodmake）`,
        stmt.span,
      );
    }
    for (const fnName of Object.keys(mod)) {
      this.builtins.set(fnName, mod[fnName]);
    }
  }

  private evalExpr(expr: Expr): ModValue {
    switch (expr.kind) {
      case 'Number':
        return { kind: 'number', value: expr.value };
      case 'String':
        return { kind: 'text', value: expr.value };
      case 'Bool':
        return { kind: 'bool', value: expr.value };
      case 'Variable': {
        const found = this.getVar(expr.name);
        if (found !== undefined) return found;
        // 未定义变量：回退成名字本身当作文本（兼容 v0.1 裸文本语义）
        return { kind: 'text', value: expr.name };
      }
      case 'Unary': {
        const operand = this.evalExpr(expr.operand);
        if (expr.op === '-') {
          if (operand.kind !== 'number') {
            throw new ModError(
              ModErrorCode.TypeMismatch,
              `一元负号 - 只能用于数字，不能用于 ${describeValue(operand)}`,
              expr.span,
            );
          }
          return { kind: 'number', value: -operand.value };
        }
        // 一元 +：数值恒等（文本原样返回）
        return operand;
      }
      case 'Not': {
        return { kind: 'bool', value: !this.isTruthy(this.evalExpr(expr.operand)) };
      }
      case 'Compare': {
        const left = this.evalExpr(expr.left);
        const right = this.evalExpr(expr.right);
        return { kind: 'bool', value: this.compare(expr.op, left, right, expr.span) };
      }
      case 'CallExpr':
        return this.callFunction(expr.callee, expr.args.map((a) => this.evalExpr(a)), expr.span);
      case 'Binary': {
        const left = this.evalExpr(expr.left);
        const right = this.evalExpr(expr.right);
        if (expr.op === '+') {
          if (left.kind === 'number' && right.kind === 'number') {
            return { kind: 'number', value: left.value + right.value };
          }
          // 任一侧是文本就做拼接（数字也转成文本）
          return { kind: 'text', value: this.valueToText(left) + this.valueToText(right) };
        }
        // - * / 只接受数字
        if (left.kind !== 'number' || right.kind !== 'number') {
          throw new ModError(
            ModErrorCode.TypeMismatch,
            `运算符 ${expr.op} 只能用于数字，不能用于 ${describeValue(left)} 与 ${describeValue(right)}`,
            expr.span,
          );
        }
        if (expr.op === '-') {
          return { kind: 'number', value: left.value - right.value };
        }
        if (expr.op === '*') {
          return { kind: 'number', value: left.value * right.value };
        }
        // expr.op === '/'
        if (right.value === 0) {
          throw new ModError(ModErrorCode.DivisionByZero, '除数不能为 0', expr.span);
        }
        return { kind: 'number', value: left.value / right.value };
      }
    }
  }

  private valueToText(value: ModValue): string {
    if (value.kind === 'number') return String(value.value);
    if (value.kind === 'bool') return String(value.value);
    return value.value;
  }

  /** 真值判定：布尔按本身；数字非零为真；文本非空为真 */
  private isTruthy(value: ModValue): boolean {
    if (value.kind === 'bool') return value.value;
    if (value.kind === 'number') return value.value !== 0;
    return value.value !== '';
  }

  /** 比较两个值是否相等（同种类才可比，否则视为不等） */
  private valuesEqual(a: ModValue, b: ModValue): boolean {
    if (a.kind === 'number' && b.kind === 'number') return a.value === b.value;
    if (a.kind === 'text' && b.kind === 'text') return a.value === b.value;
    if (a.kind === 'bool' && b.kind === 'bool') return a.value === b.value;
    return false;
  }

  /** 比较运算：== != 支持任意值；< <= > >= 仅数字 */
  private compare(
    op: '==' | '!=' | '<' | '<=' | '>' | '>=',
    left: ModValue,
    right: ModValue,
    span: SourceSpan,
  ): boolean {
    if (op === '==') return this.valuesEqual(left, right);
    if (op === '!=') return !this.valuesEqual(left, right);
    // 关系运算只接受数字
    if (left.kind !== 'number' || right.kind !== 'number') {
      throw new ModError(
        ModErrorCode.TypeMismatch,
        `比较运算符 ${op} 只能用于数字，不能用于 ${describeValue(left)} 与 ${describeValue(right)}`,
        span,
      );
    }
    const a = left.value;
    const b = right.value;
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    if (op === '>') return a > b;
    return a >= b;
  }
}

/** break 的控制流信号：掷出后由最内层的 evalCycle 接住 */
class BreakSignal extends Error {
  constructor() {
    super('break');
    this.name = 'BreakSignal';
  }
}

/** return 的控制流信号：掷出后由 callFunction 接住，并带回返回值 */
class ReturnSignal extends Error {
  constructor(public readonly value: ModValue) {
    super('return');
    this.name = 'ReturnSignal';
  }
}

function describeValue(value: ModValue): string {
  if (value.kind === 'number') return `数字 ${value.value}`;
  if (value.kind === 'bool') return `布尔 ${value.value}`;
  return `文本 "${value.value}"`;
}
