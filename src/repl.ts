/**
 * 交互式 REPL。
 *
 *  - 跨行共享同一会话：后输入的内容可以引用先前声明的变量与函数；
 *  - 花括号 / 字符串 / 注释未闭合时自动续行，不会误报语法错误；
 *  - 裸表达式会回显其结果，方便随手试值；
 *  - 支持 :help / :symbols / :ast / :reset / :quit。
 */
import { SourceFile } from './utils/source';
import type { CheckOptions } from './lang/checker';
import { renderDiagnostic, renderLemonError } from './lang/diagnostics';
import { Session } from './lang/session';
import { formatStatements } from './lang/printer';
import { parseStatements } from './lang/parser';
import { LemonError } from './lang/errors';
import { VERSION } from './version';

export interface ReplOptions {
  write(text: string): void;
  writeError(text: string): void;
  writePrompt(text: string): void;
  readLine(): Promise<string | null>;
  color: boolean;
  check?: CheckOptions;
}

const PROMPT = 'lemon> ';
const CONTINUE_PROMPT = '  ... ';

export function banner(): string {
  return [
    `Lemon v${VERSION} 交互式解释器`,
    '输入 :help 查看帮助，:quit 退出。语句可跨行，花括号未闭合时自动续行。',
    '',
  ].join('\n');
}

const HELP = [
  '命令：',
  '  :help        显示本帮助',
  '  :symbols     列出当前会话已声明的名字',
  '  :ast [代码]  打印语法树；不带参数则打印当前缓冲内容',
  '  :reset       清空所有绑定，重新开始',
  '  :quit        退出（Ctrl+C 亦可）',
  '',
  '示例：',
  '  int a = 1',
  '  say("你好")',
  '  def greet(name) { say(name) }',
  '  greet(小明)',
  '',
].join('\n');

export async function startRepl(options: ReplOptions): Promise<number> {
  let session = new Session({ write: options.write, check: options.check });
  let buffer: string[] = [];
  let continued = false;

  options.write(banner());

  for (;;) {
    options.writePrompt(continued ? CONTINUE_PROMPT : PROMPT);
    const line = await options.readLine();

    if (line === null) {
      // EOF：把尚未闭合的缓冲内容尝试执行一次，便于管道输入
      if (buffer.length > 0) {
        executeFragment(options, session, buffer.join('\n'));
        buffer = [];
      }
      options.write('\n');
      return 0;
    }

    if (buffer.length === 0) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (trimmed.startsWith(':')) {
        const action = handleCommand(options, trimmed, session, buffer);
        if (action === 'quit') return 0;
        if (action === 'reset') session = new Session({ write: options.write, check: options.check });
        if (typeof action === 'object') buffer = action.buffer;
        continue;
      }
    }

    buffer.push(line);
    if (!isBalanced(buffer.join('\n'))) {
      continued = true;
      continue;
    }

    continued = false;
    const text = buffer.join('\n');
    buffer = [];
    executeFragment(options, session, text);
  }
}

function executeFragment(options: ReplOptions, session: Session, text: string): void {
  const source = new SourceFile('<repl>', text);
  const result = session.execute(source);
  if (result.ok) return;

  if (result.error !== null) {
    options.writeError(`${renderLemonError(result.error, source, '<repl>', { color: options.color })}\n`);
    return;
  }
  for (const diag of result.diagnostics) {
    options.writeError(`${renderDiagnostic(diag, source, '<repl>', { color: options.color })}\n\n`);
  }
}

type CommandAction = 'quit' | 'reset' | 'continue' | { buffer: string[] };

function handleCommand(
  options: ReplOptions,
  line: string,
  session: Session,
  buffer: string[],
): CommandAction {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case 'help':
      options.write(HELP);
      return 'continue';
    case 'quit':
    case 'exit':
      return 'quit';
    case 'reset':
      options.write('已清空所有绑定。\n');
      return 'reset';
    case 'symbols': {
      const names = session.symbolNames();
      options.write(names.length === 0 ? '（暂无绑定）\n' : `${names.join('  ')}\n`);
      return 'continue';
    }
    case 'ast': {
      const inline = rest.join(' ');
      const text = inline.length > 0 ? inline : buffer.join('\n');
      if (text.trim() === '') {
        options.writeError('没有可解析的内容。用法：:ast int a = 1\n');
        return inline.length > 0 ? 'continue' : { buffer };
      }
      const source = new SourceFile('<repl>', text);
      try {
        options.write(`${formatStatements(parseStatements(source))}\n`);
      } catch (error) {
        if (error instanceof LemonError) {
          options.writeError(`${renderLemonError(error, source, '<repl>', { color: options.color })}\n`);
        } else {
          options.writeError(`${String(error)}\n`);
        }
      }
      return inline.length > 0 ? 'continue' : { buffer: [] };
    }
    default:
      options.writeError(`未知命令 :${cmd}，输入 :help 查看帮助。\n`);
      return 'continue';
  }
}

/**
 * 判断一段文本是否"结构完整"：花括号配平，且不处于未闭合的字符串/注释之中。
 * 仅用于决定是否继续等待输入，判定宽松——真正的问题交给解析器报错。
 */
export function isBalanced(text: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      let commentDepth = 1;
      i += 2;
      while (i < text.length && commentDepth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          commentDepth += 1;
          i += 2;
          continue;
        }
        if (text[i] === '*' && text[i + 1] === '/') {
          commentDepth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      if (commentDepth > 0) return false;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) return false;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return depth <= 0;
}
