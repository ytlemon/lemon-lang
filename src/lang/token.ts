/**
 * Token 定义与关键字表。
 */
import type { Span } from '../utils/source';

export enum TokenKind {
  /* 字面量 */
  Int = 'int',
  Double = 'double',
  Text = 'text',
  Ident = 'ident',

  /* 关键字 */
  KwInit = '__init__',
  KwDef = 'def',
  KwMain = 'main',
  KwTry = 'try',
  KwCatch = 'catch',
  KwIf = 'if',
  KwElif = 'elif',
  KwElse = 'else',
  KwCycle = 'cycle',
  KwBreak = 'break',
  /* 已预留、尚未实现——被抢占后不会变成"裸文本"，解析器会给出明确提示 */
  KwWhile = 'while',
  KwFor = 'for',
  KwReturn = 'return',
  KwContinue = 'continue',
  KwIntType = 'int_type',
  KwDoubleType = 'double_type',
  KwTextType = 'text_type',
  KwBoolType = 'bool_type',
  KwTrue = 'true',
  KwFalse = 'false',

  /* 运算符 */
  Plus = '+',
  Minus = '-',
  Star = '*',
  StarStar = '**',
  Slash = '/',
  EqEq = '==',
  NotEq = '!=',
  Lt = '<',
  Le = '<=',
  Gt = '>',
  Ge = '>=',
  AndAnd = '&&',
  OrOr = '||',
  Bang = '!',

  /* 标点 */
  LParen = '(',
  RParen = ')',
  LBrace = '{',
  RBrace = '}',
  LBracket = '[',
  RBracket = ']',
  Comma = ',',
  Assign = '=',
  Semi = ';',
  Dot = '.',

  /* 结构 */
  Eof = 'eof',

  /**
   * `#incloud` 指令。
   * 它由**文件加载器**（lang/include.ts）消费，不会进入语法树；
   * 只有在 eval / REPL 这类没有文件上下文的场景才会被解析器看到并报错。
   */
  Directive = 'directive',
}

/**
 * 唯一支持的文件指令名——源码里写作 `#incloud`。
 * 单词本身就带着"引入"的意思，因此不再另设 `#include` 之类的别名。
 */
export const DIRECTIVE_NAME = 'incloud';

/**
 * Lemon 源文件后缀。
 *
 * 只有三处真正依赖它：`#incloud` 判断"这是不是源文件"、补齐缺省后缀、
 * 以及列出同目录候选。其余地方（CLI 读文件、编辑器关联）都只是文案。
 */
export const SOURCE_EXTENSION = '.lemon1';

/**
 * 改后缀之前的旧后缀。
 *
 * 不复用、也不静默兼容——碰到时专门报一条"后缀已改"的提示，
 * 否则用户只会看到"找不到 工具.lemon1"而不知道发生了什么。
 */
export const LEGACY_SOURCE_EXTENSION = '.l';

export interface Token {
  kind: TokenKind;
  /** 源码原文 */
  lexeme: string;
  /**
   * 语义值：数字字面量为 number，文本字面量为已解转义的 string，
   * Directive 为指令参数（已去掉引号与行尾注释的字符串）。
   */
  value?: number | string;
  /** 带时间单位的数字字面量（如 1min）所带的单位名 */
  durationUnit?: string;
  /** Directive 专用：参数的精确位置（报"找不到文件"时指向它而不是整行） */
  argSpan?: Span;
  span: Span;
}

/** 关键字表——标识符扫描后查表，O(1) */
export const KEYWORDS = new Map<string, TokenKind>([
  ['__init__', TokenKind.KwInit],
  ['def', TokenKind.KwDef],
  ['main', TokenKind.KwMain],
  ['try', TokenKind.KwTry],
  ['catch', TokenKind.KwCatch],
  ['if', TokenKind.KwIf],
  ['elif', TokenKind.KwElif],
  ['else', TokenKind.KwElse],
  ['cycle', TokenKind.KwCycle],
  ['break', TokenKind.KwBreak],
  ['while', TokenKind.KwWhile],
  ['for', TokenKind.KwFor],
  ['return', TokenKind.KwReturn],
  ['continue', TokenKind.KwContinue],
  ['int', TokenKind.KwIntType],
  ['double', TokenKind.KwDoubleType],
  ['text', TokenKind.KwTextType],
  ['bool', TokenKind.KwBoolType],
  ['true', TokenKind.KwTrue],
  ['false', TokenKind.KwFalse],
]);

/** 类型关键字 → 类型名 */
export const TYPE_KEYWORDS = new Map<TokenKind, 'int' | 'double' | 'text' | 'bool'>([
  [TokenKind.KwIntType, 'int'],
  [TokenKind.KwDoubleType, 'double'],
  [TokenKind.KwTextType, 'text'],
  [TokenKind.KwBoolType, 'bool'],
]);

export function isTypeKeyword(kind: TokenKind): boolean {
  return TYPE_KEYWORDS.has(kind);
}

/** 运算符 Token 集合（供报错文案与解析器共用） */
export const OPERATOR_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  TokenKind.Plus,
  TokenKind.Minus,
  TokenKind.Star,
  TokenKind.StarStar,
  TokenKind.Slash,
  TokenKind.EqEq,
  TokenKind.NotEq,
  TokenKind.Lt,
  TokenKind.Le,
  TokenKind.Gt,
  TokenKind.Ge,
  TokenKind.AndAnd,
  TokenKind.OrOr,
  TokenKind.Bang,
]);

/** 供报错时展示的 token 友好名称 */
export function describeToken(kind: TokenKind): string {
  switch (kind) {
    case TokenKind.Eof:
      return '文件结尾';
    case TokenKind.Ident:
      return '标识符';
    case TokenKind.Int:
      return '整数';
    case TokenKind.Double:
      return '小数';
    case TokenKind.Text:
      return '文本';
    case TokenKind.KwTrue:
    case TokenKind.KwFalse:
      return 'bool 字面量';
    case TokenKind.Directive:
      return `#${DIRECTIVE_NAME} 指令`;
    default:
      if (OPERATOR_KINDS.has(kind)) return `运算符 '${kind}'`;
      return `'${kind}'`;
  }
}
