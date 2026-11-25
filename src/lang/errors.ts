/**
 * 错误码与统一诊断载体。
 *
 * 错误码分层：
 *   E01xx  词法错误
 *   E02xx  语法错误
 *   E03xx  静态检查错误
 *   E04xx  运行期错误
 *   E05xx  引入错误（#incloud）
 *   E09xx  使用方式错误（CLI 层）
 */
import type { Span } from '../utils/source';

export const ErrorCodes = {
  /* ---------- 词法 E01xx ---------- */
  RESERVED_SYMBOL: 'E0102',
  BAD_NUMBER: 'E0103',
  UNTERMINATED_STRING: 'E0104',
  BAD_ESCAPE: 'E0105',
  UNTERMINATED_COMMENT: 'E0106',
  DIRECTIVE_SYNTAX: 'E0107',

  /* ---------- 语法 E02xx ---------- */
  UNEXPECTED_TOKEN: 'E0201',
  EXPECTED_TOKEN: 'E0202',
  BREAK_OUTSIDE_LOOP: 'E0203',
  RETURN_OUTSIDE_FUNC: 'E0204',
  LIST_REF_SHAPE: 'E0205',
  MISSING_STATEMENT_END: 'E0206',
  DIRECTIVE_NOT_ALLOWED: 'E0207',

  /* ---------- 结构与静态检查 E03xx ---------- */
  MISSING_INIT: 'E0301',
  MULTIPLE_INIT: 'E0302',
  MISSING_MAIN: 'E0303',
  NOT_A_STATEMENT: 'E0304',
  NESTED_DEF: 'E0305',
  DUPLICATE_DECL: 'E0306',
  TYPE_MISMATCH: 'E0307',
  UNDEFINED_FUNCTION: 'E0308',
  NOT_A_FUNCTION: 'E0309',
  ARG_COUNT: 'E0310',
  SAY_ARITY: 'E0311',
  SIMILAR_NAME: 'E0312',
  MAIN_PARAMS: 'E0313',
  DUPLICATE_PARAM: 'E0314',
  DIVIDE_BY_ZERO_STATIC: 'E0315',
  NEGATIVE_EXPONENT_STATIC: 'E0316',
  INVALID_MEMBER: 'E0317',
  CONDITION_TYPE: 'E0318',
  CYCLE_COUNT_TYPE: 'E0319',
  NEGATIVE_CYCLE_COUNT_STATIC: 'E0320',
  INVALID_ARGUMENT: 'E0321',
  MISSPELLED_LITERAL: 'E0322',
  WEBSETS_MODULE: 'E0323',
  WEBSETS_SHAPE: 'E0324',
  WEBSETS_ELEMENT: 'E0325',
  LIST_NAME: 'E0326',
  LIST_INDEX: 'E0327',
  RETURN_VALUE_IN_MAIN: 'E0328',
  LIST_OP_TARGET: 'E0329',
  LIST_DELETE_NAMED: 'E0330',
  FILE_READ_NO_NAME: 'E0331',
  FILE_READ_NO_TARGET: 'E0332',
  FILE_WRITE_NO_NAME: 'E0333',
  FILE_WRITE_NO_SOURCE: 'E0334',
  GAME_MODULE: 'E0335',
  GAME_SHAPE: 'E0336',
  GAME_ELEMENT: 'E0337',
  GAME_ASSIGN: 'E0338',
  CLASS_MODULE: 'E0339',
  CLASS_SHAPE: 'E0340',
  CLASS_ELEMENT: 'E0341',
  CLASS_NAME: 'E0342',
  CLASS_SELF: 'E0343',
  SAY_BARE_TEXT: 'E0344',
  FILESKILL_MODULE: 'E0345',
  FILESKILL_SHAPE: 'E0346',
  FILESKILL_PATH: 'E0347',
  /** div 的属性（in / color）写得不对：名字不认识、重复、缺分隔等 */
  WEBSETS_PROPS: 'E0348',
  /** buildexe 缺少可打包的 websets() / game() 页面 */
  BUILD_MODULE: 'E0349',
  /** buildexe 右侧的文件名不是 text */
  BUILD_FILENAME: 'E0350',

  /* ---------- 运行期 E04xx ---------- */
  UNDEFINED_VAR: 'E0401',
  RUNTIME_TYPE: 'E0402',
  RECURSION_DEPTH: 'E0403',
  UNCAUGHT: 'E0404',
  DIVIDE_BY_ZERO: 'E0405',
  INT_OVERFLOW: 'E0406',
  NEGATIVE_EXPONENT: 'E0407',
  NON_FINITE_RESULT: 'E0408',
  NEGATIVE_CYCLE_COUNT: 'E0409',
  KEYBOARD_UNAVAILABLE: 'E0410',
  INPUT_ENDED: 'E0411',
  NEGATIVE_DURATION: 'E0412',
  OPEN_URL_FAILED: 'E0413',
  FETCH_FAILED: 'E0414',
  INDEX_OUT_OF_RANGE: 'E0415',
  LIST_ELEMENT_NOT_FOUND: 'E0416',
  CD_FAILED: 'E0417',
  RUN_FAILED: 'E0418',
  DELETE_FAILED: 'E0419',
  FILESKILL_ESCAPE: 'E0420',

  /* ---------- 引入 E05xx ---------- */
  INCLUDE_NOT_FOUND: 'E0501',
  INCLUDE_BAD_TARGET: 'E0502',
  INCLUDE_TOO_DEEP: 'E0503',
  INCLUDE_HAS_INIT: 'E0504',

  /* ---------- 使用方式 E09xx ---------- */
  FILE_NOT_FOUND: 'E0902',
  READ_FAILED: 'E0903',
  WRITE_FAILED: 'E0904',
} as const;

export type Phase = 'lex' | 'parse' | 'check' | 'runtime' | 'usage';

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** 可选修复建议 */
  hint?: string;
}

/** 运行期调用栈帧（仅 Lemon 层，不暴露宿主堆栈） */
export interface Frame {
  name: string;
  line: number;
  col: number;
}

export interface LemonErrorOptions {
  code: string;
  message: string;
  phase: Phase;
  span: Span;
  hint?: string;
  frames?: Frame[];
}

export class LemonError extends Error {
  readonly code: string;
  readonly phase: Phase;
  readonly span: Span;
  readonly hint?: string;
  readonly frames: Frame[];

  constructor(options: LemonErrorOptions) {
    super(options.message);
    this.name = 'LemonError';
    this.code = options.code;
    this.phase = options.phase;
    this.span = options.span;
    this.hint = options.hint;
    this.frames = options.frames ?? [];
  }

  toDiagnostic(): Diagnostic {
    const diag: Diagnostic = {
      severity: 'error',
      code: this.code,
      message: this.message,
      line: this.span.line,
      col: this.span.col,
      endLine: this.span.endLine,
      endCol: this.span.endCol,
    };
    if (this.hint) diag.hint = this.hint;
    return diag;
  }
}

/** 无效 span（用于无法定位的错误，如整文件级别的用法错误） */
export function wholeFileSpan(): Span {
  return { line: 1, col: 1, endLine: 1, endCol: 1, start: 0, end: 0 };
}
