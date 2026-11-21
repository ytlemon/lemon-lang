/**
 * lemonmod VS Code 扩展。
 *
 * 职责：
 *  - .lemon2 / .mod1 的语法高亮、代码片段、括号配对（由 package.json 的 contributes 静态声明）
 *  - 打开 / 编辑 / 保存时防抖跑一遍 lemonmod 编译器，把诊断映射成波浪线
 *  - 「检查当前文件」命令 + CodeLens 入口（运行改由 lemon1 统一负责，本扩展不提供运行）
 *
 * 设计取舍：诊断与运行都**在扩展进程内**调用 mod/src 里的同一份实现
 * （唯一事实来源），因此不需要任何外部可执行文件、不需要 node 在 PATH 里，
 * 也不会出现「扩展说没问题、命令行却报错」的不一致。
 */
import * as vscode from 'vscode';
import { checkModSource, formatDiagnostic, type Diagnostic } from '../../src/index';

const LANGUAGE_ID = 'lemonmod';
const CONFIG_SECTION = 'lemonmod';

let collection: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Lemonmod');
  collection = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  context.subscriptions.push(output, collection);

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
        checkDocument(document);
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
  );

  context.subscriptions.push(
    // 代码内嵌按钮：在 class public{ 那一行上方显示「✓ 检查」
    vscode.languages.registerCodeLensProvider({ language: LANGUAGE_ID }, new LemonmodCodeLensProvider()),
    vscode.commands.registerCommand('lemonmod.checkFile', (uri?: vscode.Uri) => {
      void checkFile(uri);
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
 * 在 `class public{` 那一行上方插入可点击的「▶ 运行 / ✓ 检查」。
 * 外壳还没写全时退化到文件首行，保证任何 .lemon2 文件都有入口。
 */
class LemonmodCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== LANGUAGE_ID) return [];

    const line = findBodyLine(document);
    const range = new vscode.Range(line, 0, line, 0);
    const uri = document.uri;

    return [
      new vscode.CodeLens(range, { command: 'lemonmod.checkFile', title: '✓ 检查', arguments: [uri] }),
    ];
  }
}

function findBodyLine(document: vscode.TextDocument): number {
  for (let i = 0; i < document.lineCount; i += 1) {
    // 普通文件锚在 `class public {`，构建清单（.mod1）锚在 `class mod to build {`
    if (/^\s*class\s+(?:public|mod\s+to\s+(?:build|bulid))\s*\{/.test(document.lineAt(i).text)) {
      return i;
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* 诊断                                                                */
/* ------------------------------------------------------------------ */

function checkDocument(document: vscode.TextDocument, manual = false): void {
  const text = document.getText();
  const checked = checkModSource(text);
  const items = checked.diagnostics.map((item) => toDiagnostic(document, item));
  collection.set(document.uri, items);

  if (!manual) return;
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`Lemonmod：${document.fileName} 检查通过。`);
  } else {
    void vscode.window.showWarningMessage(
      `Lemonmod：发现 ${items.length} 个问题，详见「问题」面板。`,
    );
  }
}

function toDiagnostic(document: vscode.TextDocument, item: Diagnostic): vscode.Diagnostic {
  const { line, col, endLine, endCol } = item.span;
  const lastLine = Math.max(0, document.lineCount - 1);
  const startLine = clamp(line - 1, 0, lastLine);
  const stopLine = clamp((endLine ?? line) - 1, startLine, lastLine);
  const startColumn = Math.max(0, col - 1);
  const stopColumn = Math.max(0, (endCol ?? col + 1) - 1);

  const start = new vscode.Position(startLine, startColumn);
  const end =
    stopLine === startLine && stopColumn <= startColumn
      ? new vscode.Position(startLine, startColumn + 1)
      : new vscode.Position(stopLine, stopColumn);

  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(start, end),
    item.message,
    vscode.DiagnosticSeverity.Error,
  );
  diagnostic.code = item.code;
  diagnostic.source = 'lemonmod';
  return diagnostic;
}

/* ------------------------------------------------------------------ */
/* 命令实现                                                            */
/* ------------------------------------------------------------------ */

/** 确定要操作的文档：优先用调用方传入的 URI，其次取当前活动编辑器 */
async function resolveDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | null> {
  if (uri !== undefined && uri.scheme === 'file') {
    const opened = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
    if (opened !== undefined) return opened;
    return vscode.workspace.openTextDocument(uri);
  }

  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showWarningMessage('Lemonmod：请先打开一个 .lemon2 / .mod1 文件。');
    return null;
  }
  if (editor.document.languageId !== LANGUAGE_ID) {
    void vscode.window.showWarningMessage('Lemonmod：当前文件不是 lemonmod 源码（.lemon2 / .mod1）。');
    return null;
  }
  return editor.document;
}

/** 一键检查：复用实时诊断用的同一条通道，并弹出结果提示 */
async function checkFile(uri?: vscode.Uri): Promise<void> {
  const document = await resolveDocument(uri);
  if (document !== null) checkDocument(document, true);
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

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}
