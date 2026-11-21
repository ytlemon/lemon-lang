/**
 * lemonmod（.lemon2）词法单元定义。
 *
 * v0.1 只有「文件外壳 + 输出语句」这一小块，所以词法单元也很少：
 * 关键字、名字、裸文本统一都是 `word`，由语法分析阶段再分辨。
 */

export type TokenKind =
  | 'word' // 裸词：关键字 set/class/public、文件名、函数名、变量名
  | 'string' // "..." 字符串字面量
  | 'number' // 数字字面量（整数 / 小数）
  | 'lbrace' // {
  | 'rbrace' // }
  | 'lparen' // (
  | 'rparen' // )
  | 'comma' // ,
  | 'semicolon' // ;
  | 'assign' // =
  | 'plus' // +
  | 'minus' // -
  | 'star' // *
  | 'slash' // /
  | 'eqeq' // ==
  | 'noteq' // !=
  | 'lt' // <
  | 'lte' // <=
  | 'gt' // >
  | 'gte' // >=
  | 'not' // !
  | 'incloud' // #incloud 指令（模块名作为下一条 word）
  | 'bool' // true / false 布尔字面量
  | 'newline' // 换行（语句分隔符之一）
  | 'eof';

export interface Token {
  kind: TokenKind;
  /** 原始文本；string 含引号，newline 为 "\n"，eof 为空串 */
  text: string;
  /** 语义值：string 为去掉引号并解转义后的内容；word 即其本身 */
  value: string;
  /** 1-based 起始行 */
  line: number;
  /** 1-based 起始列 */
  col: number;
  /** 1-based 结束行（含） */
  endLine: number;
  /** 1-based 结束列（不含） */
  endCol: number;
}

export function tokenSpan(token: Token): {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
} {
  return { line: token.line, col: token.col, endLine: token.endLine, endCol: token.endCol };
}
