/** 测试公共工具（非测试文件，node --test 不会把它当用例执行） */
import {
  analyze,
  analyzeSource,
  resolveIncludes,
  runSource,
  runSourceFile,
  type AnalyzeResult,
  type GameWindow,
  type WebPage,
} from '../src/index';
import type { Expr } from '../src/lang/ast';
import { LemonError, type Diagnostic } from '../src/lang/errors';
import { IncludeFailure, type IncludeIo } from '../src/lang/include';

/**
 * 把表达式压成便于断言的紧凑形状，例如 `1 + 2 * 3` → `['+', 1, ['*', 2, 3]]`。
 * 文本会带上引号以便与标识符区分。
 */
export function astShape(expr: Expr): unknown {
  switch (expr.kind) {
    case 'IntLit':
      return expr.value;
    case 'DoubleLit':
      return expr.value;
    case 'TextLit':
      return `"${expr.value}"`;
    case 'BoolLit':
      return expr.value;
    case 'Ident':
      return expr.name;
    case 'Call':
      return [expr.callee.name, ...expr.args.map(astShape)];
    case 'Binary':
      return [expr.op, astShape(expr.left), astShape(expr.right)];
    case 'Unary':
      return [expr.op, astShape(expr.operand)];
    case 'Member':
      return ['member', astShape(expr.object), expr.property];
    default:
      return '?';
  }
}

export interface RunOutcome {
  ok: boolean;
  stdout: string;
  diagnostics: Diagnostic[];
  error: LemonError | null;
}

/** 多文件 + 能力模块场景下的运行结果：额外带上启用的模块与 websets() 的页面 */
export interface FilesOutcome extends RunOutcome {
  /** websets() 描述出的页面；没写 websets() 时为 null */
  page: WebPage | null;
  /** game() 描述出的窗口；没写 game() 时为 null */
  game: GameWindow | null;
  /** 本次启用的能力模块名 */
  modules: string[];
}

export function runText(text: string, options: { path?: string; warnUnused?: boolean } = {}): RunOutcome {
  let stdout = '';
  const result = runSource(options.path ?? '<test>', text, {
    write: (chunk) => {
      stdout += chunk;
    },
    warnUnused: options.warnUnused,
  });
  return { ok: result.ok, stdout, diagnostics: result.diagnostics, error: result.error };
}

export function checkText(text: string, options: { warnUnused?: boolean } = {}): AnalyzeResult {
  return analyze('<test>', text, { warnUnused: options.warnUnused });
}

/** 把片段包进 __init__/main 外壳，便于只写关注的那几行 */
export function wrap(snippet: string): string {
  return `__init__ {\nmain() {\n${snippet}\n}\n}\n`;
}

export function errorCodes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
}

export function warningCodes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code);
}

/** 断言某段代码抛出 LemonError，并返回它以检查错误码 */
export function captureError(fn: () => unknown): LemonError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LemonError) return error;
    throw error;
  }
  throw new Error('期望抛出 LemonError，但调用正常返回了');
}

/** 断言某段代码抛出 IncludeFailure，并返回它以检查错误码与出错文件 */
export function captureIncludeFailure(fn: () => unknown): IncludeFailure {
  try {
    fn();
  } catch (error) {
    if (error instanceof IncludeFailure) return error;
    throw error;
  }
  throw new Error('期望抛出 IncludeFailure，但调用正常返回了');
}

/* ------------------------------------------------------------------ */
/* #incloud：用内存文件系统跑，测试不碰磁盘                            */
/* ------------------------------------------------------------------ */

function directoryOf(file: string): string {
  const at = file.lastIndexOf('/');
  return at === -1 ? '' : file.slice(0, at + 1);
}

/** 把 `{ '路径': '内容' }` 当成一个目录树，供 #incloud 解析 */
export function memoryIncludeIo(files: Record<string, string>): IncludeIo {
  const names = Object.keys(files);
  return {
    readText: (target) => files[target] ?? null,
    resolvePath: (fromFile, reference) => {
      const parts = `${directoryOf(fromFile)}${reference}`.split('/');
      const out: string[] = [];
      for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
      }
      return out.join('/');
    },
    siblingsOf: (fromFile) => {
      const dir = directoryOf(fromFile);
      return names.filter((name) => directoryOf(name) === dir).map((name) => name.slice(dir.length));
    },
  };
}

/** 以 entry 为入口跑一整套（加载 → 静态检查 → 求值） */
export function runFiles(
  entry: string,
  files: Record<string, string>,
  options: { warnUnused?: boolean } = {},
): FilesOutcome {
  const resolved = resolveFiles(entry, files);
  let stdout = '';
  const result = runSourceFile(resolved.source, {
    write: (chunk) => {
      stdout += chunk;
    },
    warnUnused: options.warnUnused,
    builtins: resolved.builtins,
    modules: enabledModules(resolved),
  });
  return {
    ok: result.ok,
    stdout,
    diagnostics: result.diagnostics,
    error: result.error,
    page: result.page,
    game: result.game,
    modules: resolved.modules.map((mod) => mod.name),
  };
}

/** 只做加载与静态检查（不执行），用于检查类型与提示文案 */
export function checkFiles(entry: string, files: Record<string, string>): AnalyzeResult {
  const resolved = resolveFiles(entry, files);
  return analyzeSource(resolved.source, {
    builtins: resolved.builtins,
    modules: enabledModules(resolved),
  });
}

/** `#incloud` 启用到的模块名，正好是静态检查需要的形状 */
function enabledModules(resolved: { modules: Array<{ name: string }> }): ReadonlySet<string> {
  return new Set(resolved.modules.map((mod) => mod.name));
}

/** 只做加载，拿到缝合后的源码与启用的能力模块（用于检查行来源映射） */
export function resolveFiles(entry: string, files: Record<string, string>) {
  return resolveIncludes(entry, files[entry] ?? '', memoryIncludeIo(files));
}
