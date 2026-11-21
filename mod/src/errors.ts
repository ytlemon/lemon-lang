/**
 * lemonmod 的错误与诊断。
 *
 * 错误码分组：
 *   M01xx 文件外壳（set / class 那两行）相关
 *   M02xx 语句相关
 *   M03xx 词法相关
 *   M04xx 求值相关（类型 / 除零 / 表达式残缺）
 *   M05xx 打包 / IO / 二进制 .lemonmod 包相关
 */

export interface SourceSpan {
  /** 1-based */
  line: number;
  /** 1-based */
  col: number;
  /** 1-based，含 */
  endLine: number;
  /** 1-based，不含 */
  endCol: number;
}

export interface Diagnostic {
  severity: 'error';
  code: string;
  message: string;
  span: SourceSpan;
}

export const ModErrorCode = {
  /** 文件必须以 `set <文件名> public{` 开头 */
  ExpectedSet: 'M0101',
  /** `set` 后面要跟文件名 */
  ExpectedFileName: 'M0102',
  /** 文件名后面必须是 `public` */
  ExpectedPublic: 'M0103',
  /** 文件声明后面必须是 `{` */
  ExpectedFileBody: 'M0104',
  /** `{` 里面必须写 `class public{` */
  ExpectedClass: 'M0105',
  /** `class` 后面必须是 `public` */
  ExpectedClassPublic: 'M0106',
  /** `class public` 后面必须是 `{` */
  ExpectedClassBody: 'M0107',
  /** 少了收尾的 `}` */
  ExpectedCloseBrace: 'M0108',
  /** 文件声明结束后还有多余内容 */
  UnexpectedTrailing: 'M0109',

  /** 未知语句：v0.1 只有 say / printf */
  UnknownStatement: 'M0201',
  /** 函数名后面必须是 `(` */
  ExpectedOpenParen: 'M0202',
  /** 需要参数（裸文本或字符串） */
  ExpectedArgument: 'M0203',
  /** 参数后面必须是 `)` */
  ExpectedCloseParen: 'M0204',
  /** v0.1 每个输出语句只支持 1 个参数 */
  TooManyArguments: 'M0205',
  /** 语句之间需要换行或分号 */
  ExpectedStatementEnd: 'M0206',
  /** `if` 条件后必须写 `{` */
  ExpectedIfBody: 'M0208',
  /** `elif` 条件后必须写 `{` */
  ExpectedElifBody: 'M0211',
  /** `else` 后面必须写 `{` */
  ExpectedElseBody: 'M0212',
  /** 块（then/elif/else/初始化块）缺少收尾的 `}` */
  ExpectedBlockClose: 'M0209',
  /** `cycle` 的次数后面必须写 `{` */
  ExpectedCycleBody: 'M0214',
  /** break 只能写在 cycle 循环体里 */
  BreakOutsideLoop: 'M0213',
  /** `#incloud` 后面缺少模块名 */
  ExpectedIncloudModule: 'M0215',
  /** 找不到对应的内置模块 */
  UnknownModule: 'M0216',
  /** 找不到对应的函数（用户函数或 SDK 函数） */
  UnknownFunction: 'M0217',
  /** 函数调用参数个数与定义不匹配 */
  WrongArgumentCount: 'M0218',
  /** 函数参数名必须是裸词 */
  ExpectedParamName: 'M0219',
  /** 函数定义后面必须写 `{` */
  ExpectedFunctionBody: 'M0220',
  /** `return` 只能写在函数体里 */
  ReturnOutsideFunction: 'M0221',
  /** `def` 后面要写函数名 */
  ExpectedFunctionName: 'M0222',

  /** 字符串没有闭合 */
  UnterminatedString: 'M0301',
  /** 非法字符 */
  UnexpectedCharacter: 'M0302',

  /** 表达式残缺（条件 / 运算子缺操作数） */
  ExpectedExpression: 'M0403',
  /** 类型不匹配（文本参与 - * / 或关系运算，或非数字比较） */
  TypeMismatch: 'M0401',
  /** 除数为 0 */
  DivisionByZero: 'M0402',
  /** cycle 的次数必须是数字（实际是文本 / 布尔等非数字值） */
  CycleCountType: 'M0405',
  /** cycle 的次数不能为负 */
  NegativeCycleCount: 'M0404',

  /** 读不到文件 / 包损坏 / 魔数或格式不符（.lemonmod 二进制包相关） */
  IOError: 'M0501',
} as const;

export class ModError extends Error {
  readonly code: string;
  readonly span: SourceSpan;

  constructor(code: string, message: string, span: SourceSpan) {
    super(message);
    this.name = 'ModError';
    this.code = code;
    this.span = span;
  }

  toDiagnostic(): Diagnostic {
    return { severity: 'error', code: this.code, message: this.message, span: this.span };
  }
}

function lineText(text: string, line: number): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines[line - 1] ?? '';
}

/**
 * 渲染成带源码片段的诊断文本，形如：
 *   demo.lemon2:1:1: error M0101: 文件必须以 `set <文件名> public{` 开头
 *     1 | class public{
 *       | ^
 */
export function formatDiagnostic(diagnostic: Diagnostic, filePath: string, text: string): string {
  const { line, col, endCol } = diagnostic.span;
  const head = `${filePath}:${line}:${col}: error ${diagnostic.code}: ${diagnostic.message}`;
  const source = lineText(text, line);
  if (source === '') return head;
  const gutter = String(line);
  const pad = ' '.repeat(gutter.length);
  const width = Math.max(1, endCol - col);
  const caretCol = Math.max(0, col - 1);
  return [
    head,
    `  ${gutter} | ${source}`,
    `  ${pad} | ${' '.repeat(caretCol)}${'^'.repeat(width)}`,
  ].join('\n');
}
