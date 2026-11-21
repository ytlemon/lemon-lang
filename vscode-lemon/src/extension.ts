/**
 * Lemon VS Code 扩展。
 *
 * 职责：
 *  - 提供 .lemon1 文件的语法高亮、代码片段、括号配对（由 package.json 的 contributes 静态声明）
 *  - 在打开 / 编辑 / 保存时防抖调用 `lemon check --json --stdin`，把诊断映射为编辑器波浪线
 *  - 提供"运行当前文件""检查当前文件""打开 REPL 终端"三个命令
 *
 * 设计取舍：诊断直接复用解释器自身的词法与静态检查（唯一事实来源），
 * 而不是另写一套 LSP，行为因此永远与解释器一致，且无需维护额外协议层。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const LANGUAGE_ID = 'lemon';
const CONFIG_SECTION = 'lemon';

interface JsonDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  hint?: string;
}

interface JsonReport {
  ok: boolean;
  diagnostics: JsonDiagnostic[];
}

let collection: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** 按名称复用终端，避免每次点"运行"都堆一个新终端 */
const terminals = new Map<string, vscode.Terminal>();

function terminalFor(name: string): vscode.Terminal {
  const existing = terminals.get(name);
  if (existing !== undefined && existing.exitStatus === undefined) return existing;
  const created = vscode.window.createTerminal({ name, cwd: workspaceRoot() });
  terminals.set(name, created);
  return created;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Lemon');
  collection = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  context.subscriptions.push(output, collection);

  // 底部状态栏的常驻开始按钮：只要当前打开的是 .lemon1 文件就会出现
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'lemon.runFile';
  statusItem.text = '$(play) 运行 Lemon';
  statusItem.tooltip = '运行当前文件（.lemon1 / .lemon2 / .mod1，点击执行，等价于 Ctrl+Alt+R）';
  context.subscriptions.push(statusItem);

  const schedule = (document: vscode.TextDocument): void => {
    if (document.languageId !== LANGUAGE_ID) return;
    if (!isDiagnosticsEnabled()) return;

    const key = document.uri.toString();
    const existing = timers.get(key);
    if (existing !== undefined) clearTimeout(existing);

    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void checkDocument(document);
      }, debounceMs()),
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
    vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      const timer = timers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(key);
      }
      collection.delete(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) return;
      for (const document of vscode.workspace.textDocuments) schedule(document);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => updateStatusBar(editor?.document)),
  );

  updateStatusBar();

  context.subscriptions.push(
    // 代码内嵌按钮：在 main() 上方显示「▶ 运行 / ✓ 检查」，这是最显眼的一键入口
    vscode.languages.registerCodeLensProvider({ language: LANGUAGE_ID }, new LemonCodeLensProvider()),
    // 命令可带 URI 参数（来自资源管理器 / 编辑器右键 / 标题栏 / CodeLens），否则回退到当前活动编辑器
    vscode.commands.registerCommand('lemon.runFile', (uri?: vscode.Uri) => {
      void runFile(uri);
    }),
    vscode.commands.registerCommand('lemon.checkFile', (uri?: vscode.Uri) => {
      void checkFile(uri);
    }),
    vscode.commands.registerCommand('lemon.openRepl', () => {
      const terminal = terminalFor('Lemon REPL');
      terminal.show();
      terminal.sendText(quotePath(resolveExecutable()), true);
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      for (const [name, opened] of terminals) {
        if (opened === terminal) terminals.delete(name);
      }
    }),
  );

  for (const document of vscode.workspace.textDocuments) schedule(document);
}

export function deactivate(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

/* ------------------------------------------------------------------ */
/* 代码内嵌按钮（CodeLens）                                            */
/* ------------------------------------------------------------------ */

/**
 * 在 main() 声明那一行上方插入可点击的「▶ 运行 / ✓ 检查」。
 * 找不到 main() 时退化到文件首行，保证任何 .lemon1 文件都有入口。
 */
class LemonCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== LANGUAGE_ID) return [];

    const line = findMainLine(document);
    const range = new vscode.Range(line, 0, line, 0);
    const uri = document.uri;

    return [
      new vscode.CodeLens(range, {
        command: 'lemon.runFile',
        title: '▶ 运行',
        arguments: [uri],
      }),
      new vscode.CodeLens(range, {
        command: 'lemon.checkFile',
        title: '✓ 检查',
        arguments: [uri],
      }),
    ];
  }
}

/** 仅当活动文件是 Lemon 源码（.lemon1）或 lemonmod 程序（.lemon2 / .mod1）时显示状态栏开始按钮 */
function updateStatusBar(document?: vscode.TextDocument): void {
  const active = document ?? vscode.window.activeTextEditor?.document;
  if (active !== undefined && (active.languageId === LANGUAGE_ID || active.languageId === 'lemonmod')) {
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

function findMainLine(document: vscode.TextDocument): number {
  for (let i = 0; i < document.lineCount; i += 1) {
    if (/^\s*main\s*\(/.test(document.lineAt(i).text)) return i;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* 诊断                                                                */
/* ------------------------------------------------------------------ */

async function checkDocument(document: vscode.TextDocument, manual = false): Promise<void> {
  const executable = resolveExecutable();
  const outcome = await runCheck(executable, document.getText(), document.fileName);

  if (outcome === null) {
    collection.delete(document.uri);
    if (manual) {
      void vscode.window.showErrorMessage(
        `无法执行「${executable}」。请在设置 lemon.executablePath 中填写 lemon 可执行文件的完整路径，或执行 npm run exe 生成。`,
      );
    }
    return;
  }

  const items = outcome.diagnostics.map((item) => toDiagnostic(document, item));
  collection.set(document.uri, items);

  if (manual) {
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Lemon：检查通过，未发现问题。');
    } else {
      void vscode.window.showWarningMessage(`Lemon：发现 ${items.length} 个问题，详见"问题"面板。`);
    }
  }
}

function runCheck(executable: string, text: string, displayName: string): Promise<{ diagnostics: JsonDiagnostic[] } | null> {
  return new Promise((resolve) => {
    const child = spawn(executable, ['check', '--json', '--stdin', displayName], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: { diagnostics: JsonDiagnostic[] } | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.on('error', (error) => {
      output.appendLine(`[启动失败] ${executable}: ${error.message}`);
      finish(null);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', () => {
      if (stderr.trim().length > 0) output.appendLine(stderr.trim());
      const payload = stdout.trim();
      if (payload.length === 0) {
        output.appendLine('[空输出] lemon check 没有返回任何内容');
        finish(null);
        return;
      }
      try {
        const report = JSON.parse(payload) as JsonReport;
        finish({ diagnostics: Array.isArray(report.diagnostics) ? report.diagnostics : [] });
      } catch (error) {
        output.appendLine(`[解析失败] 无法解析诊断 JSON：${payload.slice(0, 500)}`);
        finish(null);
      }
    });

    // 把缓冲区内容通过 stdin 交给解释器，未保存的改动也能立即得到诊断
    child.stdin?.end(text);
  });
}

function toDiagnostic(document: vscode.TextDocument, item: JsonDiagnostic): vscode.Diagnostic {
  const lastLine = Math.max(0, document.lineCount - 1);
  const startLine = clamp(item.line - 1, 0, lastLine);
  const endLine = clamp((item.endLine ?? item.line) - 1, startLine, lastLine);
  const start = new vscode.Position(startLine, Math.max(0, item.col - 1));
  const endColumn = Math.max(0, (item.endCol ?? item.col + 1) - 1);
  const end =
    endLine === startLine && endColumn <= Math.max(0, item.col - 1)
      ? new vscode.Position(startLine, Math.max(0, item.col))
      : new vscode.Position(endLine, endColumn);

  const severity =
    item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
  const message = item.hint ? `${item.message}｜提示：${item.hint}` : item.message;
  const diagnostic = new vscode.Diagnostic(new vscode.Range(start, end), message, severity);
  diagnostic.code = item.code;
  diagnostic.source = 'lemon';
  return diagnostic;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function isDiagnosticsEnabled(): boolean {
  return configuration().get<boolean>('diagnostics.enable', true);
}

function debounceMs(): number {
  return Math.max(0, configuration().get<number>('diagnostics.debounceMs', 300));
}

function workspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

/* ------------------------------ 命令实现 ------------------------------ */

/** 确定要操作的文档：优先用调用方传入的 URI，其次取当前活动编辑器 */
async function resolveDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | null> {
  if (uri !== undefined && uri.scheme === 'file') {
    const opened = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
    if (opened !== undefined) return opened;
    return vscode.workspace.openTextDocument(uri);
  }

  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showWarningMessage('Lemon：请先打开一个 .lemon1 / .lemon2 / .mod1 文件。');
    return null;
  }
  // lemon1 源码（.lemon1）与 lemonmod 程序（.lemon2 运行文件 / .mod1 构建清单）都交给
  // lemon1 可执行文件统一运行——后者走内置的 lemonmod 解释器，能就地执行与打包。
  if (editor.document.languageId !== LANGUAGE_ID && editor.document.languageId !== 'lemonmod') {
    void vscode.window.showWarningMessage('Lemon：当前文件不是 Lemon 源码（.lemon1 / .lemon2 / .mod1）。');
    return null;
  }
  return editor.document;
}

/** 一键运行：保存未保存内容，在复用的终端里执行 lemon run */
async function runFile(uri?: vscode.Uri): Promise<void> {
  const document = await resolveDocument(uri);
  if (document === null) return;

  if (document.isDirty) await document.save();

  const terminal = terminalFor('Lemon');
  terminal.show();
  terminal.sendText(`${quotePath(resolveExecutable())} run ${quotePath(document.uri.fsPath)}`, true);
}

/** 一键检查：复用实时诊断用的同一条通道，并弹出结果提示 */
async function checkFile(uri?: vscode.Uri): Promise<void> {
  const document = await resolveDocument(uri);
  if (document !== null) await checkDocument(document, true);
}

/** 未显式配置时，优先使用工作区内的构建产物，其次交给 PATH */
function resolveExecutable(): string {
  const configured = configuration().get<string>('executablePath', 'lemon').trim();
  if (configured.length > 0 && configured !== 'lemon') return configured;

  const root = workspaceRoot();
  if (root !== undefined) {
    const names = process.platform === 'win32' ? ['lemon.exe', 'lemon.cmd', 'lemon'] : ['lemon'];
    for (const name of names) {
      const candidate = path.join(root, 'dist', name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return configured.length > 0 ? configured : 'lemon';
}

/** 终端里执行时给路径加引号，避免空格导致参数被拆开 */
function quotePath(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}
