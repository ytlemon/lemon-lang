/**
 * lemonmod（.lemon2）对外 API。
 *
 * 典型用法：
 *   const result = runModSource('demo.lemon2', text);
 *   if (result.ok) process.stdout.write(result.stdout);
 *   else console.error(result.diagnostics);
 */
import type { ModBuildManifest, ModFile, ModProgram, ModValue } from './ast';
import { ModError, ModErrorCode, type Diagnostic, type SourceSpan } from './errors';
import { Interpreter, type WriteFn } from './interpreter';
import { parseModFile } from './parser';
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';

export { tokenize } from './lexer';
export { parseModFile, OUTPUT_FUNCTIONS } from './parser';
export { Interpreter } from './interpreter';
export type { WriteFn } from './interpreter';
export { ModError, ModErrorCode, formatDiagnostic } from './errors';
export type { Diagnostic, SourceSpan } from './errors';
export type { AssignStatement, CallStatement, Expr, FunctionDef, IfStatement, IncloudStatement, ModBuildManifest, ModFile, ModProgram, ModValue, Statement } from './ast';
export { BUILTIN_MODULES } from './sdk';
export type { BuiltinFn } from './sdk';

/** lemonmod 源文件后缀（运行时 / 普通 mod） */
export const MOD_EXTENSION = '.lemon2';
/** lemonmod 构建清单后缀（class mod to build { ... }） */
export const MOD1_EXTENSION = '.mod1';

/** 判断一个文件名是否为 lemonmod 程序（.lemon2 普通运行文件，或 .mod1 构建清单） */
export function isModExt(name: string): boolean {
  return /\.lemon2$/i.test(name) || /\.mod1$/i.test(name);
}

/** .lemonmod 二进制包的魔数头（ASCII "LMNMOD1"） */
export const LEMONMOD_MAGIC = 'LMNMOD1';

/** 一份 .lemonmod 二进制包解开后的内容 */
export interface LemonmodPackage {
  format: 'lemonmod';
  version: number;
  /** 被打包的 mod 源文件名（相对 .mod1 所在目录） */
  source: string;
  /** mod 名（来自 set 声明；普通程序为 null） */
  modName: string | null;
  /** 顶层变量与 modmain 公开配置 */
  vars: { [key: string]: unknown };
  /** 运行期累积的游戏状态 */
  gameState: { [key: string]: unknown };
}

/**
 * 读取一份 .lemonmod 二进制包（由 `wait for build()` 生成）。
 * 文件结构：魔数头 `LMNMOD1` + 4 字节大端负载长度 + gzip(JSON)。
 * 解析失败（不是合法包 / 内容被改动损坏）会抛 ModError。
 */
const NO_SPAN: SourceSpan = { line: 0, col: 0, endLine: 0, endCol: 0 };
export function loadLemonmod(filePath: string): LemonmodPackage {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (error) {
    throw new ModError(ModErrorCode.IOError, `读不到 lemonmod 包：${(error as Error).message}`, NO_SPAN);
  }
  const header = Buffer.from(LEMONMOD_MAGIC);
  if (buf.length < header.length + 4 || !buf.subarray(0, header.length).equals(header)) {
    throw new ModError(ModErrorCode.IOError, '这不是合法的 .lemonmod 二进制包（魔数不匹配）。', NO_SPAN);
  }
  const len = buf.readUInt32BE(header.length);
  const body = buf.subarray(header.length + 4, header.length + 4 + len);
  if (body.length !== len) {
    throw new ModError(ModErrorCode.IOError, 'lemonmod 包截断或长度不符。', NO_SPAN);
  }
  let json: string;
  try {
    json = zlib.gunzipSync(body).toString('utf8');
  } catch {
    throw new ModError(ModErrorCode.IOError, 'lemonmod 包解压失败（内容已损坏）。', NO_SPAN);
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(json);
  } catch {
    throw new ModError(ModErrorCode.IOError, 'lemonmod 包内部数据无法解析。', NO_SPAN);
  }
  if (typeof pkg !== 'object' || pkg === null || (pkg as { format?: unknown }).format !== 'lemonmod') {
    throw new ModError(ModErrorCode.IOError, 'lemonmod 包格式字段不正确。', NO_SPAN);
  }
  return pkg as LemonmodPackage;
}

export interface CheckResult {
  file: ModProgram | null;
  error: ModError | null;
  diagnostics: Diagnostic[];
}

/** 只做词法 + 语法分析，不执行 */
export function checkModSource(text: string): CheckResult {
  try {
    const file = parseModFile(text);
    return { file, error: null, diagnostics: [] };
  } catch (error) {
    if (error instanceof ModError) {
      return { file: null, error, diagnostics: [error.toDiagnostic()] };
    }
    throw error;
  }
}

export interface RunOptions {
  /** 输出写入器；缺省时只把文本攒在 result.stdout 里 */
  write?: WriteFn;
  /** 文件 IO 基准目录：.mod1 构建清单里相对路径（源 / 产物）都基于它解析 */
  baseDir?: string;
}

export interface RunResult {
  ok: boolean;
  /** 本次运行输出的全部文本（无论 ok 与否，出错前已输出的部分也保留） */
  stdout: string;
  file: ModProgram | null;
  error: ModError | null;
  diagnostics: Diagnostic[];
  /** 运行结束后顶层变量（全局环境）的快照，供 .mod1 构建打包使用 */
  vars: { [key: string]: ModValue };
  /** 运行结束后累积的游戏状态 */
  gameState: { [key: string]: unknown };
}

/** 词法 + 语法 + 执行一份 lemonmod 源码 */
export function runModSource(text: string, options: RunOptions = {}): RunResult {
  const checked = checkModSource(text);
  if (checked.file === null) {
    return {
      ok: false,
      stdout: '',
      file: null,
      error: checked.error,
      diagnostics: checked.diagnostics,
      vars: {},
      gameState: {},
    };
  }

  const interpreter = new Interpreter({ write: options.write, baseDir: options.baseDir });
  try {
    interpreter.run(checked.file);
  } catch (error) {
    if (error instanceof ModError) {
      return {
        ok: false,
        stdout: interpreter.output,
        file: checked.file,
        error,
        diagnostics: [error.toDiagnostic()],
        vars: interpreter.globals,
        gameState: interpreter.gameState,
      };
    }
    throw error;
  }

  return {
    ok: true,
    stdout: interpreter.output,
    file: checked.file,
    error: null,
    diagnostics: [],
    vars: interpreter.globals,
    gameState: interpreter.gameState,
  };
}
