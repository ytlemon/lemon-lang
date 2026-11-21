/**
 * 诊断渲染：把 Diagnostic / LemonError 渲染成人类可读的三段式输出，
 * 以及 `lemon check --json` 所需的稳定 JSON 契约。
 *
 * 输出示例：
 *   错误[E0307] 类型不匹配：text（文本）的值不能赋给 int（整数）变量 a
 *     --> examples/demo.lemon1:2:9
 *      |
 *    2 |     int a = 你好;
 *      |             ^^^^
 *      = 提示：若想保存文字，请把类型改为：text a = ...
 */
import type { SourceFile } from '../utils/source';
import { LemonError, type Diagnostic } from './errors';

export interface RenderOptions {
  color?: boolean;
  /** 运行期错误的调用栈 */
  frames?: Array<{ name: string; line: number; col: number }>;
}

const ESC = '\u001b[';

function paint(text: string, code: string, enabled: boolean): string {
  return enabled ? `${ESC}${code}m${text}${ESC}0m` : text;
}

export function shouldUseColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '') return true;
  return stream.isTTY === true;
}

export function renderDiagnostic(
  diag: Diagnostic,
  source: SourceFile | null,
  path: string,
  options: RenderOptions = {},
): string {
  const color = options.color === true;
  const label = diag.severity === 'error' ? '错误' : '警告';
  const headColor = diag.severity === 'error' ? '1;31' : '1;33';
  const lines: string[] = [];

  lines.push(
    `${paint(label, headColor, color)}${paint(`[${diag.code}]`, '2', color)} ${diag.message}`,
  );

  // 多文件编译（#incloud）时，diag.line 是缝合后源码的行号；
  // 必须还原成"真正写在哪一行"，否则用户在自己文件里根本找不到那一行。
  const origin = source?.locate(diag.line) ?? null;
  const shownPath = origin?.source.path ?? path;
  const shownLine = origin?.line ?? diag.line;

  const location = `${shownPath}:${shownLine}:${diag.col}`;
  lines.push(`  ${paint('-->', '36', color)} ${paint(location, '2', color)}`);

  if (source !== null && origin !== null && shownLine >= 1 && shownLine <= origin.source.lineCount) {
    const lineText = origin.source.lineText(shownLine);
    const gutter = String(shownLine);
    const pad = ' '.repeat(gutter.length);
    const caretPad = ' '.repeat(Math.max(0, diag.col - 1));
    const sameLine = diag.endLine === diag.line;
    const width = sameLine ? Math.max(1, diag.endCol - diag.col) : Math.max(1, lineText.length - diag.col + 1);
    const caret = '^'.repeat(Math.min(width, Math.max(1, lineText.length - diag.col + 1)));

    lines.push(`${paint(`${pad} |`, '2', color)}`);
    lines.push(`${paint(`${gutter} |`, '2', color)} ${lineText}`);
    lines.push(
      `${paint(`${pad} |`, '2', color)} ${caretPad}${paint(caret, diag.severity === 'error' ? '1;31' : '1;33', color)}`,
    );
  }

  if (diag.hint) {
    lines.push(`${paint('  = 提示：', '1;33', color)}${diag.hint}`);
  }

  if (options.frames && options.frames.length > 0) {
    lines.push(`${paint('  调用栈：', '2', color)}`);
    for (const frame of options.frames) {
      lines.push(`${paint('    · ', '2', color)}${frame.name} (第 ${frame.line} 行)`);
    }
  }

  return lines.join('\n');
}

export function renderDiagnostics(
  diagnostics: Diagnostic[],
  source: SourceFile | null,
  path: string,
  options: RenderOptions = {},
): string {
  return diagnostics.map((d) => renderDiagnostic(d, source, path, options)).join('\n\n');
}

export function renderLemonError(error: LemonError, source: SourceFile | null, path: string, options: RenderOptions = {}): string {
  return renderDiagnostic(error.toDiagnostic(), source, path, { ...options, frames: error.frames });
}

/** 统计信息：`1 个错误，2 个警告` */
export function summarize(diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} 个错误`);
  if (warnings > 0) parts.push(`${warnings} 个警告`);
  return parts.join('，');
}

/* ------------------------------------------------------------------ */
/* JSON 契约（编辑器插件依赖，需保持稳定）                              */
/* ------------------------------------------------------------------ */

export interface JsonDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  hint?: string;
}

export interface JsonReport {
  ok: boolean;
  diagnostics: JsonDiagnostic[];
}

export function toJsonDiagnostic(diag: Diagnostic): JsonDiagnostic {
  const out: JsonDiagnostic = {
    severity: diag.severity,
    code: diag.code,
    message: diag.message,
    line: diag.line,
    col: diag.col,
    endLine: diag.endLine,
    endCol: diag.endCol,
  };
  if (diag.hint) out.hint = diag.hint;
  return out;
}

export function formatJsonReport(ok: boolean, diagnostics: Diagnostic[]): string {
  const report: JsonReport = { ok, diagnostics: diagnostics.map(toJsonDiagnostic) };
  return JSON.stringify(report);
}
