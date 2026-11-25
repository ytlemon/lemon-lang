/**
 * AST 节点定义。所有节点携带 span，保证任意层级错误都能精确定位。
 */
import type { Span } from '../utils/source';

export type LemonType =
  | 'int'
  | 'double'
  | 'text'
  | 'bool'
  | 'error'
  | 'unit'
  | 'any'
  | 'list'
  | 'object';

export type Expr =
  | IntLit
  | DoubleLit
  | TextLit
  | BoolLit
  | Ident
  | Call
  | Binary
  | Unary
  | Member
  | MethodCall
  | Index
  | ListRef;

/**
 * 列表引用 `list(X)`。
 *
 * X 有两种写法，含义不同：
 *   - **整数编号** `list(1)`、`list(2)` —— 全局编号槽，用到就存在，永远不会"未声明"
 *   - **标识符** `list(分数)` —— 引用那个命名列表变量，与直接写 `分数` 等价
 *
 * 它是个普通的**表达式**，所以 `say(list(1))`、`len(list(1))`、`list(1)[0]`
 * 都能用；add / del / file / clear 四个操作也统一以它为作用对象，
 * 因此两者的作用对象写法完全一致。
 */
export interface ListRef {
  kind: 'ListRef';
  /** 编号槽的编号；命名引用时为 null */
  slot: number | null;
  /** 命名引用的名字；编号槽时为空串 */
  name: string;
  /** 编号或名字本身的位置（"名字不是列表"之类错误指向它） */
  targetSpan: Span;
  span: Span;
}

/**
 * 下标读取 `列表[下标]`。
 *
 * 下标从 0 开始；元素类型记作 `any`（块式字面量允许混合类型），
 * 因此 `列表[0]` 的静态类型是 `any`，与函数参数同样交给运行期判定。
 */
export interface Index {
  kind: 'Index';
  object: Expr;
  index: Expr;
  /** `[` 的位置，报"下标越界"之类错误时指向它比指向整段更清楚 */
  bracketSpan: Span;
  span: Span;
}

/**
 * 成员访问 `对象.字段`。目前只有错误值支持：
 * code（text）、line（int）、message（text）。
 */
export interface Member {
  kind: 'Member';
  object: Expr;
  property: string;
  propertySpan: Span;
  span: Span;
}

/**
 * 方法调用 `对象.方法(实参...)`。
 *
 * 与普通调用不同：普通函数直接 `名字(...)`，而类的方法要先有个对象，
 * 调用时会把对象绑定到方法第一个参数 `self` 上。
 */
export interface MethodCall {
  kind: 'MethodCall';
  object: Expr;
  method: string;
  methodSpan: Span;
  args: Expr[];
  span: Span;
}

/**
 * 支持的二元运算符。
 *   算术：'+' '-' '*' '/' '**'
 *   比较：'==' '!=' '<' '<=' '>' '>='    （结果类型固定为 bool）
 *   逻辑：'&&' '||'                     （短路求值，两侧都必须为 bool）
 */
export type BinaryOp = '+' | '-' | '*' | '/' | '**' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';

export const COMPARISON_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>=']);
export const LOGICAL_OPS: ReadonlySet<string> = new Set(['&&', '||']);

/** 一元运算符：取负、取正与逻辑非 */
export type UnaryOp = '-' | '+' | '!';

/**
 * 一元运算。优先级高于 '*' '/'，因此 -2 * 3 = (-2) * 3。
 * `-1` 会解析成 Unary('-', IntLit 1)，而不是负数 NumLit——
 * 这样 -x、-(a + b) 与 -1 走的是同一条路径。
 * `+x` 是数值恒等（保持类型），不会做类型转换。
 */
export interface Unary {
  kind: 'Unary';
  op: UnaryOp;
  operand: Expr;
  span: Span;
}

/**
 * 二元运算。优先级：'*' '/' 高于 '+' '-'，同级左结合。
 * 括号不产生节点，仅改变树形。
 */
export interface Binary {
  kind: 'Binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
  span: Span;
}

export interface IntLit {
  kind: 'IntLit';
  value: number;
  raw: string;
  span: Span;
}

export interface DoubleLit {
  kind: 'DoubleLit';
  value: number;
  raw: string;
  /** 带时间单位书写时为该单位（如 1min 的 'min'）；value 已是换算后的秒数 */
  durationUnit?: string;
  span: Span;
}

export interface TextLit {
  kind: 'TextLit';
  value: string;
  /** true 表示源码中未加引号的裸文本（如 say(你好) 中的 你好） */
  bare: boolean;
  raw: string;
  span: Span;
}

/** bool 字面量：true / false（关键字，不参与"裸文本"判定） */
export interface BoolLit {
  kind: 'BoolLit';
  value: boolean;
  raw: string;
  span: Span;
}

/**
 * 名字解析结果。由静态检查器写入 Ident 节点，求值器直接读取。
 *
 * 之所以挂在 AST 节点而不是放在检查结果表里：函数体的 AST 会随闭包跨越
 * 多次检查（REPL 逐段输入），挂在节点上才能保证跨片段仍然携带解析信息。
 */
export type NameResolution =
  | { kind: 'variable'; type: LemonType; line: number }
  | { kind: 'function'; decl: FuncDecl }
  | { kind: 'builtin'; name: string }
  | { kind: 'bareText' };

export interface Ident {
  kind: 'Ident';
  name: string;
  span: Span;
  /** 由静态检查器填充；未经过检查时为 undefined（等价于裸文本） */
  resolution?: NameResolution;
}

export interface Call {
  kind: 'Call';
  callee: Ident;
  args: Expr[];
  span: Span;
}

export type Stmt =
  | VarDecl
  | ListDecl
  | ListOp
  | FuncDecl
  | ExprStmt
  | TryStmt
  | IfStmt
  | CycleStmt
  | BreakStmt
  | ReturnStmt
  | WebSetsDecl
  | GameDecl
  | BuildExeDecl
  | ClassDecl
  | AssignStmt
  | OutputStmt
  | CdStmt
  | RunningStmt
  | DeleteStmt
  | FileReadStmt
  | FileSaveStmt;

/* ------------------------------------------------------------------ */
/* list(名字) { ... }：块式列表声明                                     */
/* ------------------------------------------------------------------ */

/**
 * 块式列表声明。
 *
 *   list(分数) {
 *       90
 *       85
 *       及格线
 *   }
 *
 * `list` 是**上下文关键字**（和 `websets` / `button` / `to` 一样）：
 * 只有「标识符 list 紧跟 `(`」才成立，所以 `say(list)`、`int list = 1`
 * 这类既有写法不受影响。
 *
 * 它同时是一条**声明**：括号里那个名字会被绑定成类型 `list` 的变量，
 * 因此必须写在能声明变量的位置（`__init__` 顶层或各种块内），
 * 作用域规则与 `int a = 1` 完全相同。
 *
 * 元素是任意表达式，逐个求值后按书写顺序装进列表。
 */
export interface ListDecl {
  kind: 'ListDecl';
  /** 编号槽：`list(1) { ... }` / `add list(1)`；命名声明时为 null */
  slot: number | null;
  /** 命名声明 `list(分数) { ... }`；编号槽时为空串 */
  name: string;
  nameSpan: Span;
  elements: Expr[];
  /** `list` 关键字自身的位置，用于"名字不合法"之类错误的定位兜底 */
  keywordSpan: Span;
  span: Span;
}

/**
 * 列表操作，作用对象统一写作 `list(X)`：
 *
 *   add[元素] to list(X)     往末尾追加一个元素
 *   del[元素] to list(X)     删掉第一个与它相等的元素（找不到报 E0416）
 *   del list(X)              删掉整个列表（只能用于编号槽，见下）
 *   file list(X)             一行一个元素，全部 say 出来
 *   clear list(X)            清空内容（列表本身还在）
 *
 * 建空列表 `add list(X)` 不走这里——它就是"元素为空的 ListDecl"，
 * 没有单独节点（见 parseListDecl 的 addSpan 参数）。
 *
 * 操作名特意写全（addElement / delElement / deleteList），因为 `add` 与 `del`
 * 各自都有"操作整个列表"和"操作一个元素"两种形态，简写会读不清。
 */
export type ListOpKind = 'addElement' | 'delElement' | 'deleteList' | 'file' | 'clear';

export interface ListOp {
  kind: 'ListOp';
  op: ListOpKind;
  target: ListRef;
  /** 追加 / 删除元素时的元素表达式；其余操作为 null */
  element: Expr | null;
  /** 操作关键字自身的位置 */
  opSpan: Span;
  span: Span;
}

/* ------------------------------------------------------------------ */
/* websets()：与 main() 平级的第二个入口                                */
/* ------------------------------------------------------------------ */

/** button 里的跳转目标：`to <地址>` */
export interface WebTo {
  kind: 'WebTo';
  /** 目标地址表达式，静态检查要求它是 text（可以来自变量） */
  target: Expr;
  span: Span;
}

/**
 * 一个按钮。
 *
 * `to` 为 null 表示用户忘了写——不在这里直接报错，留给静态检查统一给提示
 * （解析阶段报错会让人以为是语法问题，其实只是漏了一项）。
 */
export interface WebButton {
  kind: 'WebButton';
  to: WebTo | null;
  span: Span;
}

/** div 的位置盒子：`in (x1,y1;x2,y2)`，两点分别是左上与右下 */
export interface WebBox {
  kind: 'WebBox';
  /** 左上角横坐标 */
  left: Expr;
  /** 左上角纵坐标 */
  top: Expr;
  /** 右下角横坐标 */
  right: Expr;
  /** 右下角纵坐标 */
  bottom: Expr;
  span: Span;
}

/**
 * div 里的一段文本内容。
 *
 * 语法上它就是一条表达式（裸文本 / 字符串 / 变量名都可以），求值后按 text 渲染。
 */
export interface WebText {
  kind: 'WebText';
  value: Expr;
  span: Span;
}

/**
 * `div (in (x1,y1;x2,y2); color=#rrggbb) { 子元素... }`。
 *
 * `box` 为 null 表示没写 `in`——那这个 div 就按普通块级元素排布，不做绝对定位；
 * `color` 为 null 表示没写 `color`。两者都可以省略，`div { ... }` 就是纯容器。
 */
export interface WebDiv {
  kind: 'WebDiv';
  box: WebBox | null;
  /** `color=<颜色>`；颜色字面量是文本，所以这里是一个 text 表达式 */
  color: Expr | null;
  children: WebElement[];
  span: Span;
}

/** v1 有 button；div 是带位置盒子与颜色的容器，可以嵌子元素；还可直接写文本 */
export type WebElement = WebButton | WebDiv | WebText;

/** web.init() 块：页面的根容器，元素都写在它里面 */
export interface WebInit {
  kind: 'WebInit';
  elements: WebElement[];
  span: Span;
}

/**
 * `websets()` —— 声明式地描述一个网页。
 *
 *   websets() {
 *       web.init() {
 *           button {
 *               to "localhost:9000"
 *           }
 *       }
 *   }
 *
 * 与 `main()` 同级（`__init__` 顶层），不能带参数、至多一个、可以完全不写
 * （那就是纯终端程序）。整个构造由 `#incloud web` 解锁，否则报 E0323。
 *
 * 它是**声明**不是执行：`__init__` 顶层语句与 `main()` 都跑完之后，
 * 才按这份描述求出页面并交给宿主（CLI 负责写 .html 并打开浏览器）。
 */
export interface WebSetsDecl {
  kind: 'WebSets';
  /** web.init() 块；缺失时为 null，由静态检查报 E0324 */
  init: WebInit | null;
  nameSpan: Span;
  span: Span;
}

/* ------------------------------------------------------------------ */
/* game()：与 main() 平级的第二个入口（声明式游戏窗口）                  */
/* ------------------------------------------------------------------ */

/**
 * `display.win(宽, 高)` —— 声明窗口画布尺寸。
 * 两个参数都必须是 int。
 */
export interface DisplayWin {
  kind: 'DisplayWin';
  width: Expr;
  height: Expr;
  span: Span;
}

/** `display.head(标题)` —— 声明窗口标题，参数必须是 text。 */
export interface DisplayHead {
  kind: 'DisplayHead';
  title: Expr;
  span: Span;
}

/** game.init() 里目前只有这两个元素 */
export type GameElement = DisplayWin | DisplayHead;

/** game.init() 块：窗口的根容器，元素都写在它里面 */
export interface GameInit {
  kind: 'GameInit';
  elements: GameElement[];
  span: Span;
}

/**
 * `game()` —— 声明式地描述一个游戏窗口。
 *
 *   game() {
 *       game.init() {
 *           display.win(1000, 800)
 *           display.head("lemon")
 *       }
 *   }
 *
 * 与 `main()` 同级（`__init__` 顶层），不能带参数、至多一个。由 `#incloud game`
 * 解锁，否则报 E0335。它是**声明**不是执行：`__init__` 顶层语句与 `main()` 都跑完后，
 * 才按这份描述生成自包含的 .html（CLI 负责落盘并打开浏览器）。
 *
 * 运行状态 `game.running` / `game.quit`（bool）由 `AssignStmt` 在 main() 里读写。
 */
export interface GameDecl {
  kind: 'Game';
  /** game.init() 块；缺失时为 null，由静态检查报 E0336 */
  init: GameInit | null;
  nameSpan: Span;
  span: Span;
}

/* ------------------------------------------------------------------ */
/* buildexe = 文件名：把 websets() / game() 的页面打包成 exe             */
/* ------------------------------------------------------------------ */

/**
 * `buildexe = 文件名` —— 声明本次运行的打包目标。
 *
 *   buildexe = 我的游戏
 *
 * 与 `main()` / `websets()` / `game()` 同级（`__init__` 顶层），至多一个。
 * 右侧必须求值为 text（裸文本或引号字符串都行）；宿主（CLI）在 main() 跑完、
 * 页面生成后，把页面内容打包成一个同名 .exe。
 *
 * 它同时决定内置 bool 变量 `build` 的值：写了这个声明就为 true，否则为 false。
 * 因此 `if build == true { ... }`（或兼容写法 `if build = true { ... }`）
 * 只在真正会打包时成立。打包需要 `#incloud web` 或 `#incloud game` 才能
 * 提供可打包的页面，否则报 E0349。
 */
export interface BuildExeDecl {
  kind: 'BuildExe';
  /** 输出文件名表达式（求值为 text） */
  filename: Expr;
  /** `buildexe` 这处声明的位置 */
  nameSpan: Span;
  span: Span;
}

/**
 * 赋值语句（目前只允许写 `game.running` / `game.quit`）。
 *
 *   game.running = True
 *
 * Lemon 的普通变量仍然不可重新赋值——这个赋值只面向 game 这个内置命名空间的
 * 运行状态字段，值必须是 bool。对象不是 `game` 或字段不认识时，静态检查报 E0338。
 */
export interface AssignStmt {
  kind: 'Assign';
  /** 被赋值的对象，目前只能是 `game` */
  target: Ident;
  /** 字段名：running / quit */
  property: string;
  propertySpan: Span;
  value: Expr;
  span: Span;
}

/**
 * 带级别的输出语句：`output "[error]出错了"`。
 *
 * 文本开头的 `[error]` / `[warning]` / `[log]` 决定输出级别：
 *   error / warning → 走 stderr；log 或没有标记 → 走 stdout。
 * 标记本身会原样打印（不剥离）。文字必须是 text。
 */
export interface OutputStmt {
  kind: 'Output';
  value: Expr;
  span: Span;
}

/* ------------------------------------------------------------------ */
/* read{...} / write{...}：文件读写块                                    */
/* ------------------------------------------------------------------ */

/**
 * `read in ...` 的一个目标（落点）。
 *
 *   { kind: 'list', ref }   把读到的每一行作为一个文本元素存进列表
 *   { kind: 'say' }         把读到的内容原样打印出来
 *
 * `read in answer` 不是目标——它是"交互式选段"的开关（见 FileRead.interactive），
 * 表示运行时在终端弹问要读哪一部分；它本身不决定内容去哪，必须配合上面的目标。
 */
export type ReadTarget =
  | { kind: 'list'; ref: ListRef }
  | { kind: 'say' };

/**
 * 读取文件块。
 *
 *   read {
 *       name = "1.txt"          // 文件名（字符串表达式，可用变量）
 *       according = "utf-8"     // 编码，可省略，默认 utf-8
 *       read in list(1)         // 逐行读进 list(1)
 *       read in say             // 同时打印内容
 *       read in answer          // （可选）交互式选段：终端问"读哪一部分"
 *   }
 *
 * `name` 与 `according` 是块内专用的配置键（不是变量）；`read in ...` 决定内容去哪。
 * 一次读取只做一次 IO，结果按目标扇出（可同时存列表 + 打印）。
 * 缺少 `name` 或缺任何目标，静态检查直接拦下（E0331 / E0332）。
 */
export interface FileReadStmt {
  kind: 'FileRead';
  /** 文件名表达式；块里没写 name 时为 null（交给静态检查报 E0331） */
  name: Expr | null;
  /** 编码表达式；null 表示使用默认 utf-8 */
  encoding: Expr | null;
  /** 落点：list(X) 和/或 say，至少一个（否则 E0332） */
  targets: ReadTarget[];
  /** 是否交互式选段（read in answer 出现过） */
  interactive: boolean;
  span: Span;
}

/**
 * 写入文件块。
 *
 *   write {
 *       name = "1.txt"
 *       according = "utf-8"
 *       write in list(1)        // 列表每个元素写一行（覆盖写）
 *   }
 *
 * 序列化方式刻意与 `file list(X)` / `read in list(1)` 对称：每个元素一行，
 * 读回来能原样还原。覆盖写（不追加）。缺 `name` 或缺 `write in list(X)`
 * 静态检查拦下（E0333 / E0334）。
 */
export interface FileSaveStmt {
  kind: 'FileSave';
  name: Expr | null;
  encoding: Expr | null;
  /** 要写出的列表引用 */
  source: ListRef | null;
  span: Span;
}

/**
 * 轮次变量的固定名字。
 *
 * `cycle(N)` 与 `cycle()` 都会在循环体内绑定这个名字：`cycle(N)` 里它依次是
 * `0 .. N-1`，`cycle()` 里从 0 开始一直递增。它和函数参数一样会遮蔽外层的同名变量。
 */
export const LOOP_INDEX_NAME = 'i';

/**
 * 编号槽在环境里的键名前缀。
 *
 * 用 `#` 开头：它不是标识符的合法字符（`#` 是 `#incloud` 的引导符），
 * 所以槽名永远不可能撞上用户变量。REPL 的 `:symbols` 会按这个前缀过滤掉。
 */
export const SLOT_KEY_PREFIX = '#slot';

/** 编号槽 → 环境键名 */
export function slotKey(slot: number): string {
  return `${SLOT_KEY_PREFIX}${slot}`;
}

/**
 * cycle 循环。
 *
 *   cycle(3) { ... }   重复 3 次，体内 i 依次为 0 1 2
 *   cycle()  { ... }   无限循环，体内 i 一直递增，用 break 跳出
 *
 * 循环体每轮都是**全新的作用域**，因此体内声明的变量不会带到下一轮。
 * 次数必须是 int：0 或负数之外的负值在运行前（字面量）或运行期报错。
 */
export interface CycleStmt {
  kind: 'CycleStmt';
  /** 循环次数；null 表示 cycle() —— 无限循环 */
  count: Expr | null;
  body: Stmt[];
  /** `cycle(…)` 头部的位置，用于给隐含的轮次变量附位置信息 */
  headerSpan: Span;
  span: Span;
}

/** break：跳出最内层的 cycle 循环；只能出现在循环体内（由解析器保证） */
export interface BreakStmt {
  kind: 'BreakStmt';
  span: Span;
}

/**
 * return：从函数里带一个值回去，或者提前收工。
 *
 *   return 表达式      带值返回，函数调用的结果就是它
 *   return             不带值：在普通函数里表示"返回 unit"，在 main() 里表示提前结束程序
 *
 * 它是**语句**而不是表达式（Lemon 不搞"一切皆表达式"）。这样类型规则能保持简单：
 * `int a = return 1` 这种写法在语法层就不成立，不用在类型检查里再兜一遍。
 */
export interface ReturnStmt {
  kind: 'ReturnStmt';
  /** 返回值；null 表示光秃秃的 return */
  value: Expr | null;
  span: Span;
}

/**
 * 条件分支的一条支线。
 * `condition === null` 表示这是 `else` 分支（必定是最后一条，且 body 一定执行）。
 * 每个分支体都是独立作用域，与 try / catch 一致。
 */
export interface IfBranch {
  kind: 'if' | 'elif' | 'else';
  /** 分支条件；else 分支为 null */
  condition: Expr | null;
  body: Stmt[];
  /** 分支体右花括号的位置 */
  closeSpan: Span;
}

/**
 * if / elif / else。
 *
 *   if 条件 { ... }
 *   elif 条件 { ... }
 *   else { ... }
 *
 * 条件是**不带括号**的表达式，且类型必须是 bool（比较与逻辑运算的结果就是 bool）。
 * `elif` 可以出现任意多次；`else` 至多一次且必须在最后。
 */
export interface IfStmt {
  kind: 'IfStmt';
  branches: IfBranch[];
  span: Span;
}

/**
 * try / catch。
 * try 与 catch 各自是独立作用域；catch 把捕获到的错误值绑定到 catchName。
 * 只能捕获运行期错误——语法与类型错误在程序开始执行前就已中止。
 */
export interface TryStmt {
  kind: 'TryStmt';
  body: Stmt[];
  catchName: string;
  catchNameSpan: Span;
  catchBody: Stmt[];
  span: Span;
}

export interface VarDecl {
  kind: 'VarDecl';
  typeName: 'int' | 'double' | 'text' | 'bool';
  /**
   * 类类型声明（`Student stu = ...`）时的类名；普通声明为 null，
   * 此时看 typeName。非 null 时 typeName 无意义。
   */
  className: string | null;
  name: string;
  nameSpan: Span;
  initializer: Expr;
  span: Span;
}

export interface Param {
  name: string;
  span: Span;
}

export interface FuncDecl {
  kind: 'FuncDecl';
  /** 函数名；main 声明时固定为 'main' */
  name: string;
  nameSpan: Span;
  params: Param[];
  body: Stmt[];
  bodySpan: Span;
  /** true 表示这是 main() 主程序声明 */
  isMain: boolean;
  span: Span;
}

export interface ExprStmt {
  kind: 'ExprStmt';
  expr: Expr;
  span: Span;
}

/* ------------------------------------------------------------------ */
/* class：字段 + 方法的“数据 + 行为”封装                                */
/* ------------------------------------------------------------------ */

/**
 * 类里的一个字段：`text 名字`。只声明类型与名字，没有初始值——
 * 构造 `类名(值1, 值2)` 时按字段的书写顺序把实参填进来。
 */
export interface ClassField {
  kind: 'ClassField';
  name: string;
  nameSpan: Span;
  typeName: 'int' | 'double' | 'text' | 'bool';
  span: Span;
}

/**
 * 类里的一个方法：`def 名字(self, 参数...) { 体 }`。
 * 第一个参数固定是 `self`（调用时绑定到对象），其余与普通函数一致。
 */
export interface ClassMethod {
  kind: 'ClassMethod';
  name: string;
  nameSpan: Span;
  params: Param[];
  body: Stmt[];
  bodySpan: Span;
  span: Span;
}

/**
 * `class 名字 { 字段... 方法... }` —— 与 `main()` 同级（`__init__` 顶层），
 * 由 `#incloud class` 解锁。字段顺序决定构造时实参的顺序。
 */
export interface ClassDecl {
  kind: 'Class';
  name: string;
  nameSpan: Span;
  fields: ClassField[];
  methods: ClassMethod[];
  span: Span;
}

/* ------------------------------------------------------------------ */
/* fileskill：cd / running / delete                                     */
/* ------------------------------------------------------------------ */

/**
 * `cd <目录> { 语句... }` —— 进入一个目录。
 *
 * 块内的 `running` / `delete` 都以它为基准，且**不允许逃出该目录**
 * （`..`、绝对路径都会被拒）。目录表达式必须是文本。
 *
 * 由 `#incloud fileskill` 解锁；块内还会再嵌套 `cd`。
 */
export interface CdStmt {
  kind: 'Cd';
  path: Expr;
  body: Stmt[];
  span: Span;
}

/**
 * `running "<文件>"` —— 在当前 `cd` 目录里运行一个文件（`.bat` / `.cmd` / `.exe` …）。
 * 只能写在 `cd { ... }` 里，且文件必须落在该目录内。
 */
export interface RunningStmt {
  kind: 'Running';
  file: Expr;
  span: Span;
}

/**
 * `delete "<文件>"` —— 删除当前 `cd` 目录里的一个文件。
 * 只能写在 `cd { ... }` 里；**只删文件**，不删目录、不递归。
 */
export interface DeleteStmt {
  kind: 'Delete';
  file: Expr;
  span: Span;
}

export interface Program {
  /** __init__ 块内的语句，按源码顺序 */
  statements: Stmt[];
  /** __init__ 块的 span（用于缺块报错时兜底定位） */
  initSpan: Span;
  /** main 声明；静态检查阶段若缺失会报错，故运行时一定存在 */
  main: FuncDecl | null;
  /** 顶层函数声明（不含 main），按声明顺序 */
  functions: FuncDecl[];
  /** websets() 声明；没写时为 null（纯终端程序） */
  websets: WebSetsDecl | null;
  /** game() 声明；没写时为 null */
  game: GameDecl | null;
  /** buildexe 声明；没写时为 null（不打包） */
  buildExe: BuildExeDecl | null;
  /** class 声明，按书写顺序 */
  classes: ClassDecl[];
}
