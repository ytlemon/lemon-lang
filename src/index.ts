/**
 * Lemon 语言对外 API。
 *
 * 典型用法：
 *   const result = runSource('demo.lemon1', '文本', { write: (t) => process.stdout.write(t) });
 *   if (!result.ok) console.error(result.diagnostics);
 */
import type { Program } from './lang/ast';
import type { BuiltinFn, KeyboardInput } from './lang/builtins';
import { checkProgram, type CheckOptions, type CheckResult } from './lang/checker';
import { type Diagnostic } from './lang/errors';
import { Env } from './lang/env';
import { Evaluator } from './lang/eval';
import { LemonError } from './lang/errors';
import type { GameWindow } from './lang/gamepage';
import { parseProgram } from './lang/parser';
import type { WebPage } from './lang/webpage';
import { SourceFile } from './utils/source';

export { SourceFile } from './utils/source';
export type { LineOrigin } from './utils/source';
export { tokenize } from './lang/lexer';
export { parseProgram, parseStatements } from './lang/parser';
export { checkProgram, checkFragment } from './lang/checker';
export type { CheckResult, CheckOptions, SymbolInfo, NameResolution } from './lang/checker';
export { Evaluator, DEFAULT_MAX_DEPTH } from './lang/eval';
export type { KeyboardInput } from './lang/builtins';
export { normalizeKeyName, decodeKeys, KEY_NAME_HINT, INTERRUPT_KEY } from './lang/keys';
export {
  createLazyKeyboard,
  createTerminalKeyboard,
  KeyboardInterrupt,
} from './utils/keyboard';
export type { KeyboardSource, KeyboardOptions } from './utils/keyboard';
export { Env } from './lang/env';
export { Session } from './lang/session';
export { resolveIncludes, IncludeFailure } from './lang/include';
export type { IncludeIo, IncludeResult } from './lang/include';
export {
  MODULES,
  MODULE_NAMES,
  moduleBuiltins,
  moduleOfFunction,
  openInBrowser,
  WEBSETS_MODULE,
  GAME_MODULE,
  CLASS_MODULE,
  FILESKILL_MODULE,
} from './lang/modules';
export type { CapabilityModule } from './lang/modules';
export { buttonNode, describePage, makePage, renderHtml, resolveHref } from './lang/webpage';
export type {
  WebButtonNode,
  WebDivNode,
  WebNode,
  WebPage,
  WebRect,
  WebTextNode,
} from './lang/webpage';
export { DEFAULT_GAME_TITLE, renderGameHtml } from './lang/gamepage';
export type { GameWindow } from './lang/gamepage';
export { DIRECTIVE_NAME, LEGACY_SOURCE_EXTENSION, SOURCE_EXTENSION } from './lang/token';
export { displayValue, UNIT } from './lang/value';
export type { Value } from './lang/value';
export { LemonError, ErrorCodes } from './lang/errors';
export type { Diagnostic, Frame } from './lang/errors';
export { formatAst, formatStatements, formatTokens } from './lang/printer';
export {
  formatJsonReport,
  renderDiagnostic,
  renderDiagnostics,
  renderLemonError,
  summarize,
  shouldUseColor,
} from './lang/diagnostics';
export { VERSION } from './version';

export interface AnalyzeResult {
  source: SourceFile;
  program: Program | null;
  check: CheckResult | null;
  error: LemonError | null;
  diagnostics: Diagnostic[];
}

/**
 * 词法 + 语法 + 静态检查，不执行。
 *
 * 已经拿到 SourceFile 时用这个版本——多文件编译（#incloud）由加载器把若干
 * 文件缝成一份带行来源映射的源码，直接喂进来即可。
 */
export function analyzeSource(source: SourceFile, options: CheckOptions = {}): AnalyzeResult {
  let program: Program;
  try {
    program = parseProgram(source);
  } catch (error) {
    if (error instanceof LemonError) {
      return { source, program: null, check: null, error, diagnostics: [error.toDiagnostic()] };
    }
    throw error;
  }

  const check = checkProgram(program, options);
  return { source, program, check, error: null, diagnostics: check.diagnostics };
}

/** 词法 + 语法 + 静态检查，不执行 */
export function analyze(path: string, text: string, options: CheckOptions = {}): AnalyzeResult {
  return analyzeSource(new SourceFile(path, text), options);
}

export interface RunSourceOptions {
  write(text: string): void;
  /** stderr 写入器；缺省时 output 的 error / warning 级别也走 write */
  writeError?: (text: string) => void;
  warnUnused?: boolean;
  maxCallDepth?: number;
  /** 复用已有环境（多次 run 时保持绑定） */
  env?: Env;
  /** 键盘输入源；缺省时 keyboard / waitKey 报"当前环境拿不到键盘" */
  keyboard?: KeyboardInput;
  /** 行输入源；供 `read in answer` 交互式选段用，缺省时交互式读取报 E0410 */
  readLine?: (prompt: string) => string | null;
  /** `#incloud <模块名>` 启用的能力模块所提供的内置函数 */
  builtins?: ReadonlyMap<string, BuiltinFn>;
  /** `#incloud` 启用到的能力模块名；`websets()` 靠它判断是否解锁 */
  modules?: ReadonlySet<string>;
}

export interface RunResult {
  source: SourceFile;
  ok: boolean;
  diagnostics: Diagnostic[];
  error: LemonError | null;
  env: Env;
  /**
   * `websets()` 描述出的页面；没写 websets() 或运行失败时为 null。
   * 求值器只负责算出这份数据，写 .html 与打开浏览器由宿主自己决定。
   */
  page: WebPage | null;
  /**
   * `game()` 描述出的窗口；没写 game() 或运行失败时为 null。
   * 与 page 同理：求值器只算数据，落盘 .html 与打开浏览器由宿主决定。
   */
  game: GameWindow | null;
  /**
   * `buildexe = 文件名` 求出的 exe 目标文件名；没写声明或运行失败时为 null。
   * 与 page / game 同理：求值器只产出文件名，实际打包由宿主（CLI）完成。
   */
  buildExe: string | null;
}

/** 完整执行一份已加载的源码：静态检查通过后才运行 */
export function runSourceFile(source: SourceFile, options: RunSourceOptions): RunResult {
  const analysis = analyzeSource(source, {
    warnUnused: options.warnUnused,
    builtins: options.builtins,
    modules: options.modules,
  });

  if (analysis.program === null || analysis.check === null || analysis.check.hasErrors) {
    return {
      source: analysis.source,
      ok: false,
      diagnostics: analysis.diagnostics,
      error: analysis.error,
      env: options.env ?? new Env(),
      page: null,
      game: null,
      buildExe: null,
    };
  }

  const env = options.env ?? new Env();
  const evaluator = new Evaluator({
    write: options.write,
    writeError: options.writeError,
    maxCallDepth: options.maxCallDepth,
    keyboard: options.keyboard,
    readLine: options.readLine,
    builtins: options.builtins,
  });

  try {
    evaluator.runProgram(analysis.program, env);
  } catch (error) {
    if (error instanceof LemonError) {
      return {
        source: analysis.source,
        ok: false,
        diagnostics: [error.toDiagnostic()],
        error,
        env,
        page: null,
        game: null,
        buildExe: null,
      };
    }
    throw error;
  }

  return {
    source: analysis.source,
    ok: true,
    diagnostics: analysis.diagnostics,
    error: null,
    env,
    page: evaluator.webPage,
    game: evaluator.gameWindow,
    buildExe: evaluator.exeTarget,
  };
}

/** 完整执行一段源码：静态检查通过后才运行 */
export function runSource(path: string, text: string, options: RunSourceOptions): RunResult {
  return runSourceFile(new SourceFile(path, text), options);
}
