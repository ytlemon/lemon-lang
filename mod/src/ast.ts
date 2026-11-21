/**
 * lemonmod（.lemon2）语法树。
 *
 * v0.3 的程序形状：
 *   set <文件名> public{
 *       class public{
 *           #incloud gamemodmake        // 引入内置游戏 SDK 模块
 *           a = 1                       // 变量赋值（动态类型，可重复赋值）
 *           say(a)                      // 输出变量 / 表达式 / 裸文本 / 字符串
 *           if a > 1 { say(大) } else { say(小) }
 *           cycle(3) { say(i) }         // 循环：重复 3 次，体内 i 为 0..N-1
 *           cycle() { if i >= 3 { break } say(i) }   // 无限循环靠 break 结束
 *           def foo(a, b) { return a + b }   // 函数定义（def 或裸 foo(a,b){} 都行）
 *           modmain() {                 // 自动入口：运行模组时自动调用
 *               auther = dev
 *               game = "neno defender"
 *               spawnEnemy("boss", 2)   // 调用 SDK 函数 / 用户函数
 *               x = foo(1, 2)           // 表达式里也能调用函数，拿到 return 的值
 *           }
 *       }
 *   }
 */
import type { SourceSpan } from './errors';

/** 运行期值：动态类型，有数字、文本与布尔三种 */
export type ModValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'bool'; value: boolean };

/** 表达式：数字、字符串、变量、一元 / 二元运算、比较、逻辑非、括号分组 */
export type Expr =
  | { kind: 'Number'; value: number; span: SourceSpan }
  | { kind: 'String'; value: string; span: SourceSpan }
  | { kind: 'Variable'; name: string; span: SourceSpan }
  | { kind: 'Unary'; op: '+' | '-'; operand: Expr; span: SourceSpan }
  | { kind: 'Not'; operand: Expr; span: SourceSpan }
  | { kind: 'Binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr; span: SourceSpan }
  | { kind: 'Compare'; op: '==' | '!=' | '<' | '<=' | '>' | '>='; left: Expr; right: Expr; span: SourceSpan }
  | { kind: 'CallExpr'; callee: string; args: Expr[]; span: SourceSpan }
  | { kind: 'Bool'; value: boolean; span: SourceSpan };

export interface CallStatement {
  kind: 'Call';
  /** 被调用的名字：say / printf / 用户函数 / SDK 函数 */
  callee: string;
  /** 实参列表（任意表达式）；say/printf 在运行期限制为 1 个 */
  args: Expr[];
  span: SourceSpan;
}

/** 表达式里的函数调用：`foo(a, b)` —— 求值后得到函数 return 的值 */
export interface CallExpr {
  kind: 'CallExpr';
  callee: string;
  args: Expr[];
  span: SourceSpan;
}

export interface AssignStatement {
  kind: 'Assign';
  /** 变量名（裸词） */
  name: string;
  /** 右侧表达式 */
  value: Expr;
  span: SourceSpan;
}

export interface IfStatement {
  kind: 'If';
  /** 条件表达式（求值后按真值判定） */
  condition: Expr;
  /** `if` 成立时执行的语句块 */
  thenBody: Statement[];
  /** 0 个或多个 `elif` 分支（按顺序判定，首个为真者执行） */
  elifBodies: { condition: Expr; body: Statement[] }[];
  /** `else` 块；没有则为 null */
  elseBody: Statement[] | null;
  span: SourceSpan;
}

/**
 * cycle 循环（与 Lemon 的 cycle 同语义）：
 *   cycle(N)   执行 N 轮；N <= 0 时一轮都不执行
 *   cycle()    无限循环，只能靠 break（或运行期错误）结束
 *
 * 每一轮都会把轮次变量 `i`（从 0 开始）写入环境；break 跳出最内层的 cycle。
 */
export interface CycleStatement {
  kind: 'Cycle';
  /** 循环次数表达式；null 表示 cycle() —— 无限循环 */
  count: Expr | null;
  /** 循环体语句 */
  body: Statement[];
  /** `cycle(…)` 头部的位置，用于给次数错误附位置 */
  headerSpan: SourceSpan;
  span: SourceSpan;
}

/** break：跳出最内层的 cycle；只能写在 cycle 循环体里（由解析器保证） */
export interface BreakStatement {
  kind: 'Break';
  span: SourceSpan;
}

/** return：从函数返回；只能写在函数体里（由解析器保证）。value 为 null 表示裸 return */
export interface ReturnStatement {
  kind: 'Return';
  value: Expr | null;
  span: SourceSpan;
}

/** `#incloud 模块名`：引入一个内置 SDK 模块（运行期把它的函数注册进运行器） */
export interface IncloudStatement {
  kind: 'Incloud';
  /** 模块名，如 gamemodmake */
  module: string;
  span: SourceSpan;
}

/** `wait for build()`：触发构建（读取 mod 源 → 打包成 .lemonmod），并把 `build` 设为布尔结果 */
export interface WaitForBuildStatement {
  kind: 'WaitForBuild';
  span: SourceSpan;
}

/**
 * 函数定义：`name(p1, p2, ...) { 语句* }`。
 * 解析期只登记，不执行；运行期由调用（或自动入口 modmain）触发。
 */
export interface FunctionDef {
  kind: 'FunctionDef';
  name: string;
  params: string[];
  body: Statement[];
  span: SourceSpan;
}

export type Statement =
  | CallStatement
  | AssignStatement
  | IfStatement
  | CycleStatement
  | BreakStatement
  | IncloudStatement
  | FunctionDef
  | ReturnStatement
  | WaitForBuildStatement;

/**
 * 构建清单（.mod1）：`class mod to build { mod file() {...} build { become "..." } ... }`。
 * 声明要打包的 mod 源文件与产物名，并可在体内用 `wait for build()` 触发、用 `if build == true` 判断。
 */
export interface ModBuildManifest {
  kind: 'modBuild';
  /** `mod file() { <表达式> }`：求值后得到源文件名（相对 .mod1 所在目录） */
  source: Expr;
  /** `build { become <表达式> }`：求值后得到产物文件名（相对 .mod1 所在目录） */
  output: Expr;
  /** 清单体内的语句（含 `wait for build()` 与 `if` 等） */
  body: Statement[];
  span: SourceSpan;
}

/** lemonmod 顶层程序：普通运行文件，或 .mod1 构建清单 */
export type ModProgram = ModFile | ModBuildManifest;

export interface ModFile {
  /** 判别标签：普通运行文件 */
  kind: 'modFile';
  /** `set 文件名 public{` 里的文件名 */
  name: string;
  nameSpan: SourceSpan;
  /** `class public{ ... }` 里的语句（输出 与 赋值 混排） */
  statements: Statement[];
  span: SourceSpan;
}
