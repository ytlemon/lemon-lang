/**
 * 命令行入口。
 *
 * 退出码契约：0 成功 / 1 语言错误 / 2 用法错误。
 * 输出契约：程序输出走 stdout，诊断与错误走 stderr；
 * `check --json` 保证 stdout 上只有一份合法 JSON，供编辑器插件稳定解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  analyzeSource,
  describePage,
  openInBrowser,
  renderGameHtml,
  renderHtml,
  runSource,
  runSourceFile,
  SourceFile,
  type GameWindow,
  type WebPage,
} from './index';
import type { BuiltinFn } from './lang/builtins';
import type { CheckOptions } from './lang/checker';
import { IncludeFailure, resolveIncludes, type IncludeIo } from './lang/include';
import {
  formatJsonReport,
  renderDiagnostic,
  renderDiagnostics,
  renderLemonError,
  shouldUseColor,
  summarize,
} from './lang/diagnostics';
import { ErrorCodes, LemonError, type Diagnostic } from './lang/errors';
import { formatAst, formatTokens } from './lang/printer';
import { tokenize } from './lang/lexer';
import { startRepl } from './repl';
import { parseArgs } from './utils/args';
import { createLazyKeyboard, KeyboardInterrupt, type KeyboardSource } from './utils/keyboard';
import { VERSION } from './version';
import { checkModSource, runModSource, isModExt, formatDiagnostic as formatModDiagnostic } from '../mod/src/index';

export const EXIT_OK = 0;
export const EXIT_LANGUAGE_ERROR = 1;
export const EXIT_USAGE = 2;
/** 用户在程序运行中按了 Ctrl+C（raw 模式下没有 SIGINT，由键盘层转成这个码） */
export const EXIT_INTERRUPT = 130;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  color: boolean;
  /** 注入 REPL 读取器（测试用）；缺省时从 stdin 读取 */
  readLine?: () => Promise<string | null>;
  closeInput?: () => void;
  /** 注入标准输入内容（check --stdin 用）；缺省时真实读取 fd 0 */
  readStdin?: () => string | null;
}

export function defaultIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    color: shouldUseColor(process.stdout),
  };
}

const COMMANDS = ['run', 'check', 'eval', 'ast', 'tokens', 'repl', 'help', 'version'] as const;
const FLAGS = [
  '--json',
  '--warn-unused',
  '--no-color',
  '--no-open',
  '--stdin',
  '--help',
  '-h',
  '--version',
  '-v',
] as const;

/** 帮助里"命令 → 说明"两列的分界：左侧命令占满这么多**显示列** */
const HELP_COLUMN = 33;

/**
 * 终端显示宽度：CJK 字符占两列。
 *
 * 必须按显示宽度补空格，不能直接用 String.padEnd——`<文件.lemon1>` 是 11 个
 * 字符但占 13 列，只按字符数补的话含中文的那几行会整体错位。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return width;
}

/** 占两列的字符区段（CJK 与常用全角标点），够覆盖帮助文本里会出现的字符 */
const WIDE_CHAR_RE =
  /[\u1100-\u115f\u2e80-\u303f\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u;

/**
 * 帮助文本里的一行：左侧命令左对齐到固定显示列，说明从同一列开始。
 *
 * 用计算代替手敲空格——命令名一长（比如后缀从 .l 变成 .lemon1），
 * 手敲出来的对齐就会整体错位，而且几乎没人会回头修。
 * 至少留 2 个空格，免得最长的那个命令和说明粘在一起。
 */
function helpRow(left: string, description: string): string {
  const pad = Math.max(2, HELP_COLUMN - displayWidth(left));
  return `  ${left}${' '.repeat(pad)}${description}`;
}

const HELP = `Lemon 编程语言 v${VERSION}

用法：
${helpRow('lemon', '进入交互式 REPL')}
${helpRow('lemon <文件.lemon1>', '运行脚本（等价于 lemon run）')}
${helpRow('lemon run <文件.lemon1>', '运行脚本')}
${helpRow('lemon <文件.lemon2>', '运行 lemonmod（.lemon2）程序')}
${helpRow('    --no-open', '只生成 websets() 的 .html，不打开浏览器')}
${helpRow('lemon check [选项] <文件.lemon1>', '只做词法与静态检查')}
${helpRow('    --json', '以 JSON 输出诊断（编辑器插件依赖此格式）')}
${helpRow('    --stdin', '从标准输入读取源码（编辑器插件用）')}
${helpRow('    --warn-unused', '额外提示"声明后从未使用"')}
${helpRow('lemon eval "<代码>"', '求值一段代码片段')}
${helpRow('lemon ast <文件.lemon1>', '打印语法树（调试）')}
${helpRow('lemon tokens <文件.lemon1>', '打印词法单元（调试）')}
${helpRow('lemon help | --help', '显示本帮助')}
${helpRow('lemon version | --version', '显示版本')}

退出码：
  0    成功
  1    语言错误（编译期或运行期）
  2    用法错误
  130  运行中被 Ctrl+C 中断

示例：
  lemon examples/hello.lemon1
  lemon check --json examples/hello.lemon1
  lemon eval 'say("你好")'

语言速览：
  __init__ {
      int a = 1
      double b = 1.23
      text c = 你好          // 裸文本：不加引号就是字符串
      bool ok = a > 0         // bool 只有 true / false

      def greet(name) {
          say(name)
      }

      main() {
          say("你好")        // say 的文本要加引号；变量 say(a) 不用
          say(a)
          greet(小明)

          // if 的条件必须是 bool：比较（== != < <= > >=）与逻辑（&& || !）
          if a > 10 && ok {
              say("大")
          } elif a == 0 {
              say("零")
          } else {
              say("小")
          }

          // cycle(N) 重复 N 次，i 从 0 递增；cycle() 是无限循环，用 break 结束
          cycle(3) {
              say(i)
          }
          cycle() {
              if i >= 5 {
                  break
              }
              say(i)
          }
      }
  }

函数与返回值：
  def 加(a, b) { return a + b }
  say(加(2, 3))    // 5；返回值就是个普通的值，能放在任何表达式位置
  return 一执行函数立刻结束；光秃秃的 return 表示"到此为止"
  有带值 return 的函数，调用结果是 any；没有 return 的仍是 unit（无值）
  main() 里只允许光秃秃的 return（提前结束程序）

内置函数：
  say(值)        输出一个值并换行
  keyboard(键)   非阻塞：这个键自上次读取后有没有被按过（读过就清零）
  waitKey(键)    阻塞：停在这一行直到该键被按下
  sleep(秒数)    暂停；单位是秒（sleep(1) 停 1 秒，sleep(1000) 就是 1000 秒）
  len(列表)      列表里元素的个数
  键名：单个字符（w、a、1）或 space / enter / esc / up / down / left / right / tab / backspace
  时间单位：500ms / 2s / 1min / 1.5h，统一换算成秒的 double
  注意：keyboard / waitKey 需要真实终端，管道与重定向里会报 E0410

列表（list）：
  两种写法，操作语法完全一样：
      list(分数) { 元素 换行 元素 }   命名列表，就是个普通变量
      list(1)                        编号槽，全局容器，用到就存在
  声明与元素：一行一个元素，元素是任意表达式、类型可混；add list(1) 建空列表
  操作（add 与 del 各有两种形态，看后面跟 [ 还是 list (）：
      add[元素] to list(X)   追加一个元素
      del[元素] to list(X)   删掉第一个相等的元素（找不到报 E0416）
      del list(X)            删掉整个列表（只能用于编号槽）
      file list(X)           一行一个元素全部输出
      clear list(X)          清空内容（列表还在）
  取值：list(X)[0]（从 0 开始，越界报 E0415）；长度：len(list(X))
  say(list(X)) 输出 [90, 85]；没有方括号字面量，[ ] 只用来取下标
  列表可变，同名再声明是覆盖；在函数里 add 到编号槽，函数外也读得到
  list / add / del / file / clear 都是上下文关键字：text list = 1、say(file) 照常工作

引入（#incloud）：
  写在行首、独占一行，行尾可以跟 // 注释
${helpRow('#incloud web', '启用内置能力模块（当前可用：web、game、class、fileskill）')}
${helpRow('#incloud 工具.lemon1', '把同目录的 工具.lemon1 源码就地并入本程序')}
${helpRow('#incloud "工具.lemon1"', '路径加引号也行；直接写 工具 会补上 .lemon1')}
  被并入的 .lemon1 只写 def 与变量，不要写 __init__ / main；同一个文件只并入一次
  web 模块：openUrl(网址) 用浏览器打开、fetchText(网址) 取回网页正文（text）

网页（websets，需要 #incloud web）：
  websets 与 main() 同级，声明式描述一个页面；main() 跑完后生成同名 .html 并打开
  websets() {
      web.init() {
          button {
              to "localhost:9000"    // 地址要加引号；没写 http:// 会自动补
          }
          div (in (0,0;256,256); color=#ffffff) {   // 位置盒子 in(x1,y1;x2,y2)，颜色用 # 字面量
              你好                                    // 里面可以写文本、再套 div、或放 button
          }
      }
  }

游戏窗口（game，需要 #incloud game）：
  game 与 main() 同级，声明式描述一个窗口；main() 跑完后生成 <入口名>.game.html 并打开
  game() {
      game.init() {
          display.win(1000, 800)     // 画布尺寸（int × int）
          display.head("lemon")      // 窗口标题（text）
      }
  }
  运行状态：game.running / game.quit（bool），可写 game.running = true（唯一允许的重新赋值）

类（class，需要 #incloud class）：
  class 与 main() 同级，把字段与方法打包成一个类；用 类名(值...) 按字段顺序构造
  class 学生 {
      text 名字
      int 年龄
      def 名字(self) { return self.名字 }     // 第一个参数是接收者 self
  }
  学生 s = 学生("小明", 18)                  // 类名当类型
  say(s.名字)                                // 读字段；s.名字(...) 调方法

输入与分级输出：
  ask(提示词)             读用户输入的一行文本（需真实终端，否则报 E0410）
  output "[error]出错了"  按开头 [error]/[warning]/[log] 分流：error/warning → stderr，log → stdout

文件能力（fileskill，需要 #incloud fileskill —— ⚠️ 会真删文件、真运行程序）：
  cd "目录" { ... }       锁定一个目录，块内的 running / delete 都以它为基准
  running "start.bat"     在 cd 目录里运行一个文件（文件名要加引号，输出原样转发）
  delete "临时.txt"       删除 cd 目录里的一个文件（只删文件，不删文件夹、不递归）
  安全边界：running / delete 只能写在 cd 块里，且目标不能逃出该目录（.. / 绝对路径报 E0420）
  Windows 路径在字符串里写 "e:/dir" 或 "e:\\dir"（"e:\dir" 里的 \d 会被当成转义）
`;

export async function main(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const parsed = parseArgs(argv, { commands: COMMANDS, flags: FLAGS });

  if (parsed.flags.has('--no-color')) io = { ...io, color: false };

  if (parsed.flags.has('--help') || parsed.flags.has('-h') || parsed.command === 'help') {
    io.stdout(HELP);
    return EXIT_OK;
  }
  if (parsed.flags.has('--version') || parsed.flags.has('-v') || parsed.command === 'version') {
    io.stdout(`lemon ${VERSION}\n`);
    return EXIT_OK;
  }
  if (parsed.error !== null) return usageError(io, parsed.error);

  const checkOptions: CheckOptions = { warnUnused: parsed.flags.has('--warn-unused') };
  // websets() 生成的页面默认会用浏览器打开；--no-open 只落盘，脚本与 CI 用得上
  const openBrowser = !parsed.flags.has('--no-open');

  switch (parsed.command) {
    case null:
      // `lemon foo.lemon1` 简写为 run
      if (parsed.positionals.length === 0) return runRepl(io, checkOptions);
      if (parsed.positionals.length === 1) {
        return runFile(io, parsed.positionals[0], checkOptions, openBrowser);
      }
      return usageError(io, `无法同时运行多个文件：${parsed.positionals.join(' ')}`);
    case 'repl':
      return runRepl(io, checkOptions);
    case 'run': {
      if (parsed.positionals.length !== 1) return usageError(io, 'run 需要且仅需要一个文件路径');
      return runFile(io, parsed.positionals[0], checkOptions, openBrowser);
    }
    case 'check': {
      const json = parsed.flags.has('--json');
      if (parsed.flags.has('--stdin')) {
        // 编辑器插件用：直接检查缓冲区内容，无需先在磁盘落盘
        const text = (io.readStdin ?? readStdin)();
        if (text === null) return usageError(io, '无法从标准输入读取源码');
        const name = parsed.positionals[0] ?? '<stdin>';
        return runCheck(io, name, text, json, checkOptions);
      }
      if (parsed.positionals.length !== 1) return usageError(io, 'check 需要且仅需要一个文件路径');
      return checkFile(io, parsed.positionals[0], json, checkOptions);
    }
    case 'eval': {
      if (parsed.positionals.length === 0) return usageError(io, "eval 需要一段代码，例如 lemon eval 'say(\"你好\")'");
      return evalSnippet(io, parsed.positionals.join(' '), checkOptions);
    }
    case 'ast': {
      if (parsed.positionals.length !== 1) return usageError(io, 'ast 需要且仅需要一个文件路径');
      return astFile(io, parsed.positionals[0], checkOptions);
    }
    case 'tokens': {
      if (parsed.positionals.length !== 1) return usageError(io, 'tokens 需要且仅需要一个文件路径');
      return tokensFile(io, parsed.positionals[0]);
    }
    default:
      return usageError(io, `未知命令 ${parsed.command}`);
  }
}

/* ------------------------------------------------------------------ */
/* 子命令实现                                                          */
/* ------------------------------------------------------------------ */

/**
 * 带键盘源执行一段程序：负责创建、清理，并把 Ctrl+C 转成中断退出码。
 *
 * 键盘源是**惰性**的——程序不用 keyboard / waitKey 就完全不会碰终端（不改 raw 模式、
 * 不起读取线程），因此普通脚本的行为与以前完全一致。
 */
/**
 * 构造一个"读一行"函数，供 `read in answer` 交互式选段使用。
 * 真实终端（isTTY）下先打印提示、再同步读入一行；管道 / 重定向下返回 null，
 * 让运行期报 E0410——与 keyboard / waitKey 同一条"需要真实终端"的语义。
 */
function makeReadLine(): (prompt: string) => string | null {
  return (prompt: string): string | null => {
    if (!process.stdin.isTTY) return null;
    process.stdout.write(prompt);
    const buf = Buffer.alloc(1024);
    let data = '';
    for (;;) {
      let n: number;
      try {
        n = fs.readSync(0, buf, 0, buf.length, null);
      } catch {
        return data.length > 0 ? data : null;
      }
      if (n <= 0) return data.length > 0 ? data : null;
      const chunk = buf.toString('utf8', 0, n);
      const nl = chunk.indexOf('\n');
      if (nl >= 0) {
        data += chunk.slice(0, nl);
        break;
      }
      data += chunk;
      if (data.length > 1 << 20) break; // 安全阀：防止异常输入撑爆内存
    }
    return data;
  };
}

/**
 * 带键盘源执行一段程序：负责创建、清理，并把 Ctrl+C 转成中断退出码。
 *
 * 键盘源是**惰性**的——程序不用 keyboard / waitKey 就完全不会碰终端（不改 raw 模式、
 * 不起读取线程），因此普通脚本的行为与以前完全一致。
 */
function runWithKeyboard<T>(io: CliIo, run: (keyboard: KeyboardSource) => T): T | number {
  const keyboard = createLazyKeyboard();
  try {
    return run(keyboard);
  } catch (error) {
    if (error instanceof KeyboardInterrupt) {
      io.stderr('\n已中断（Ctrl+C）。\n');
      return EXIT_INTERRUPT;
    }
    throw error;
  } finally {
    keyboard.close();
  }
}

function runFile(io: CliIo, file: string, checkOptions: CheckOptions, openBrowser: boolean): number {
  if (isModFile(file)) return runModFile(io, file);
  const loaded = loadFile(io, file);
  if (loaded === null) return EXIT_USAGE;

  const bundled = loadWithIncludes(file, loaded);
  if (!bundled.ok) return reportIncludeFailure(io, bundled);

  const outcome = runWithKeyboard(io, (keyboard) =>
    runSourceFile(bundled.source, {
      write: io.stdout,
      writeError: io.stderr,
      warnUnused: checkOptions.warnUnused,
      keyboard,
      readLine: makeReadLine(),
      builtins: bundled.builtins,
      modules: bundled.modules,
    }),
  );
  if (typeof outcome === 'number') return outcome;
  const result = outcome;

  // websets() 的产出：main() 已经跑完，这里把页面落到 .html
  if (result.ok && result.page !== null) writePage(io, file, result.page, openBrowser);
  // game() 的产出：落到 <入口名>.game.html，并按需用浏览器打开
  if (result.ok && result.game !== null) writeGame(io, file, result.game, openBrowser);

  if (result.ok) {
    if (result.diagnostics.length > 0) {
      io.stderr(`${renderDiagnostics(result.diagnostics, result.source, file, { color: io.color })}\n`);
    }
    return EXIT_OK;
  }

  io.stderr(`${formatFailure(result.error, result.diagnostics, result.source, file, io.color)}\n`);
  return EXIT_LANGUAGE_ERROR;
}

function checkFile(io: CliIo, file: string, json: boolean, checkOptions: CheckOptions): number {
  if (isModFile(file)) return checkModFile(io, file, json);
  const loaded = loadFile(io, file, json);
  if (loaded === null) return EXIT_USAGE;
  return runCheck(io, file, loaded, json, checkOptions);
}

/** 是否 lemonmod（.lemon2 运行文件，或 .mod1 构建清单）源文件 */
function isModFile(file: string): boolean {
  return isModExt(file);
}

/** 用 lemonmod 解释器运行一份 .lemon2 / .mod1 源码（输出实时写入 io.stdout） */
function runModFile(io: CliIo, file: string): number {
  const loaded = loadFile(io, file);
  if (loaded === null) return EXIT_USAGE;
  const result = runModSource(loaded, { write: io.stdout, baseDir: path.dirname(file) });
  for (const diag of result.diagnostics) {
    io.stderr(`${formatModDiagnostic(diag, file, loaded)}\n`);
  }
  return result.ok ? EXIT_OK : EXIT_LANGUAGE_ERROR;
}

/** 加载并用 lemonmod 检查一份 .lemon2 文件 */
function checkModFile(io: CliIo, file: string, json: boolean): number {
  const loaded = loadFile(io, file, json);
  if (loaded === null) return EXIT_USAGE;
  return checkModText(io, file, loaded, json);
}

/** lemonmod 的检查渲染：文件模式与 --stdin 模式共用 */
function checkModText(io: CliIo, file: string, text: string, json: boolean): number {
  const checked = checkModSource(text);
  const diagnostics = checked.diagnostics;
  const hasError = diagnostics.length > 0;
  if (json) {
    const mapped = diagnostics.map((d) => ({
      severity: 'error' as const,
      code: d.code,
      message: d.message,
      line: d.span.line,
      col: d.span.col,
      endLine: d.span.endLine,
      endCol: d.span.endCol,
    }));
    io.stdout(`${formatJsonReport(!hasError, mapped)}\n`);
    return hasError ? EXIT_LANGUAGE_ERROR : EXIT_OK;
  }
  if (hasError) {
    for (const d of diagnostics) io.stderr(`${formatModDiagnostic(d, file, text)}\n`);
    io.stderr(`\n发现 ${diagnostics.length} 个问题。\n`);
    return EXIT_LANGUAGE_ERROR;
  }
  io.stdout(`✔ ${file} 检查通过\n`);
  return EXIT_OK;
}

/** check 的实际实现：文件模式与 --stdin 模式共用 */
function runCheck(io: CliIo, file: string, text: string, json: boolean, checkOptions: CheckOptions): number {
  if (isModFile(file)) return checkModText(io, file, text, json);
  const bundled = loadWithIncludes(file, text);
  if (!bundled.ok) {
    // --json 契约：stdout 上只能出现一份合法 JSON，因此失败也要走同一条出口
    if (json) {
      io.stdout(`${formatJsonReport(false, [bundled.error.toDiagnostic()])}\n`);
    } else {
      io.stderr(
        `${renderLemonError(bundled.error, bundled.source, bundled.source.path, { color: io.color })}\n`,
      );
    }
    return EXIT_LANGUAGE_ERROR;
  }

  const analysis = analyzeSource(bundled.source, {
    ...checkOptions,
    builtins: bundled.builtins,
    modules: bundled.modules,
  });
  const hasError = analysis.program === null || analysis.diagnostics.some((d) => d.severity === 'error');

  if (json) {
    io.stdout(`${formatJsonReport(!hasError, analysis.diagnostics)}\n`);
    return hasError ? EXIT_LANGUAGE_ERROR : EXIT_OK;
  }

  if (hasError) {
    io.stderr(`${renderDiagnostics(analysis.diagnostics, analysis.source, file, { color: io.color })}\n`);
    io.stderr(`\n${summarize(analysis.diagnostics)}。\n`);
    return EXIT_LANGUAGE_ERROR;
  }

  if (analysis.diagnostics.length > 0) {
    io.stderr(`${renderDiagnostics(analysis.diagnostics, analysis.source, file, { color: io.color })}\n`);
    io.stdout(`✔ ${file} 检查通过（另有 ${summarize(analysis.diagnostics)}）\n`);
    return EXIT_OK;
  }
  io.stdout(`✔ ${file} 检查通过\n`);
  return EXIT_OK;
}

function evalSnippet(io: CliIo, code: string, checkOptions: CheckOptions): number {
  // 包一层入口执行，再把行号映射回用户输入的坐标（用户代码从包装文本第 2 行开始）
  const wrapped = `__init__ { main() {\n${code}\n} }\n`;
  const outcome = runWithKeyboard(io, (keyboard) =>
    runSource('<eval>', wrapped, {
      write: io.stdout,
      warnUnused: checkOptions.warnUnused,
      keyboard,
      readLine: makeReadLine(),
    }),
  );
  if (typeof outcome === 'number') return outcome;
  const result = outcome;

  if (result.ok) return EXIT_OK;

  const userSource = new SourceFile('<eval>', code);
  const shiftLine = (line: number): number => (line >= 2 ? line - 1 : 1);
  const shiftDiagnostic = (diag: Diagnostic): Diagnostic => ({
    ...diag,
    line: shiftLine(diag.line),
    endLine: shiftLine(diag.endLine),
  });

  if (result.error !== null) {
    const rendered = renderDiagnostic(shiftDiagnostic(result.error.toDiagnostic()), userSource, '<eval>', {
      color: io.color,
      frames: result.error.frames.map((frame) => ({ ...frame, line: shiftLine(frame.line) })),
    });
    io.stderr(`${rendered}\n`);
    return EXIT_LANGUAGE_ERROR;
  }

  const diagnostics = result.diagnostics.map(shiftDiagnostic);
  io.stderr(`${renderDiagnostics(diagnostics, userSource, '<eval>', { color: io.color })}\n`);
  io.stderr(`\n${summarize(diagnostics)}。\n`);
  return EXIT_LANGUAGE_ERROR;
}

function astFile(io: CliIo, file: string, checkOptions: CheckOptions): number {
  const loaded = loadFile(io, file);
  if (loaded === null) return EXIT_USAGE;

  const bundled = loadWithIncludes(file, loaded);
  if (!bundled.ok) return reportIncludeFailure(io, bundled);

  const analysis = analyzeSource(bundled.source, {
    ...checkOptions,
    builtins: bundled.builtins,
    modules: bundled.modules,
  });
  if (analysis.program === null) {
    io.stderr(`${renderDiagnostics(analysis.diagnostics, analysis.source, file, { color: io.color })}\n`);
    return EXIT_LANGUAGE_ERROR;
  }
  io.stdout(`${formatAst(analysis.program)}\n`);
  if (analysis.diagnostics.length > 0) {
    io.stderr(`${renderDiagnostics(analysis.diagnostics, analysis.source, file, { color: io.color })}\n`);
  }
  return EXIT_OK;
}

function tokensFile(io: CliIo, file: string): number {
  const loaded = loadFile(io, file);
  if (loaded === null) return EXIT_USAGE;

  const source = new SourceFile(file, loaded);
  try {
    io.stdout(`${formatTokens(tokenize(source))}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof LemonError) {
      io.stderr(`${renderLemonError(error, source, file, { color: io.color })}\n`);
      return EXIT_LANGUAGE_ERROR;
    }
    throw error;
  }
}

async function runRepl(io: CliIo, checkOptions: CheckOptions): Promise<number> {
  const reader = io.readLine !== undefined ? null : createStdinReader();
  try {
    return await startRepl({
      write: io.stdout,
      writeError: io.stderr,
      writePrompt: io.stdout,
      readLine: io.readLine ?? reader!.readLine,
      color: io.color,
      check: checkOptions,
    });
  } finally {
    if (reader !== null) reader.close();
    io.closeInput?.();
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 加载 `#incloud` 的结果：成功给缝合后的源码与启用的能力模块，失败给错误与它所在的文件 */
type IncludeStep =
  | {
      ok: true;
      source: SourceFile;
      builtins: ReadonlyMap<string, BuiltinFn>;
      modules: ReadonlySet<string>;
    }
  | { ok: false; error: LemonError; source: SourceFile };

/** 把 `#incloud` 缝进来（没有指令时是零开销的直通） */
function loadWithIncludes(file: string, text: string): IncludeStep {
  try {
    const resolved = resolveIncludes(file, text, nodeIncludeIo());
    return {
      ok: true,
      source: resolved.source,
      builtins: resolved.builtins,
      modules: new Set(resolved.modules.map((mod) => mod.name)),
    };
  } catch (error) {
    if (error instanceof IncludeFailure) return { ok: false, error: error.lemon, source: error.source };
    throw error;
  }
}

/**
 * websets() 的产出落地：写到与入口同名的 `.html`，再按需用浏览器打开。
 *
 * 页面写不出去（磁盘只读、路径不可写）**不算程序运行失败**——main() 的输出
 * 已经完成、退出码仍是 0，这里只报一句提示。
 */
function writePage(io: CliIo, entry: string, page: WebPage, openBrowser: boolean): void {
  const target = `${entry.replace(/\.lemon1$/i, '')}.html`;
  const title = path.basename(target).replace(/\.html$/i, '');

  try {
    fs.writeFileSync(target, renderHtml(page, title), 'utf8');
  } catch (error) {
    io.stderr(`无法写入页面 ${target}：${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }

  io.stdout(`已生成页面 ${target}（${describePage(page)}）\n`);
  if (!openBrowser) return;

  try {
    openInBrowser(pathToFileURL(path.resolve(target)).href);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * game() 的产出落地：写到 `<入口名>.game.html`，再按需用浏览器打开。
 * 与 writePage 同理，写不出去不算运行失败。
 */
function writeGame(io: CliIo, entry: string, game: GameWindow, openBrowser: boolean): void {
  const target = `${entry.replace(/\.lemon1$/i, '')}.game.html`;

  try {
    fs.writeFileSync(target, renderGameHtml(game), 'utf8');
  } catch (error) {
    io.stderr(`无法写入游戏窗口 ${target}：${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }

  io.stdout(`已生成游戏窗口 ${target}（${game.width}×${game.height}，标题 ${game.title}）\n`);
  if (!openBrowser) return;

  try {
    openInBrowser(pathToFileURL(path.resolve(target)).href);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** 引入失败：错误可能发生在被引入的文件里，所以渲染要认 error.source */
function reportIncludeFailure(io: CliIo, failure: { error: LemonError; source: SourceFile }): number {
  io.stderr(`${renderLemonError(failure.error, failure.source, failure.source.path, { color: io.color })}\n`);
  return EXIT_LANGUAGE_ERROR;
}

/** 真实文件系统版的 IncludeIo；相对路径统一按 cwd 归一，报错时展示得短一些 */
function nodeIncludeIo(): IncludeIo {
  return {
    readText: (target) => {
      try {
        return fs.readFileSync(target, 'utf8');
      } catch {
        return null;
      }
    },
    resolvePath: (fromFile, reference) => {
      const abs = path.resolve(path.dirname(path.resolve(fromFile)), reference);
      const rel = path.relative(process.cwd(), abs);
      // 统一用 / 展示：Windows 上 path.relative 会给出反斜杠，和入口文件
      // 手写的写法对不上，同一条报错里混着两种分隔符很难看
      return (rel !== '' && !rel.startsWith('..') ? rel : abs).split(path.sep).join('/');
    },
    siblingsOf: (fromFile) => {
      try {
        return fs.readdirSync(path.dirname(path.resolve(fromFile)));
      } catch {
        return [];
      }
    },
  };
}

function loadFile(io: CliIo, file: string, silent = false): string | null {
  if (!fs.existsSync(file)) {
    if (silent) {
      io.stdout(
        `${formatJsonReport(false, [
          {
            severity: 'error',
            code: ErrorCodes.FILE_NOT_FOUND,
            message: `找不到文件：${file}`,
            line: 1,
            col: 1,
            endLine: 1,
            endCol: 1,
            hint: '请确认路径是否正确，Lemon 源文件后缀为 .lemon1',
          },
        ])}\n`,
      );
      return null;
    }
    usageError(io, `找不到文件：${file}`);
    return null;
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (silent) {
      io.stdout(
        `${formatJsonReport(false, [
          {
            severity: 'error',
            code: ErrorCodes.READ_FAILED,
            message: `无法读取文件：${file}`,
            line: 1,
            col: 1,
            endLine: 1,
            endCol: 1,
            hint: error instanceof Error ? error.message : String(error),
          },
        ])}\n`,
      );
      return null;
    }
    usageError(io, `无法读取文件：${file}（${error instanceof Error ? error.message : String(error)}）`);
    return null;
  }
}

function formatFailure(
  error: LemonError | null,
  diagnostics: Diagnostic[],
  source: SourceFile,
  file: string,
  color: boolean,
): string {
  if (error !== null) return renderLemonError(error, source, file, { color });
  return `${renderDiagnostics(diagnostics, source, file, { color })}\n\n${summarize(diagnostics)}。`;
}

function usageError(io: CliIo, message: string): number {
  io.stderr(`用法错误：${message}\n试试 lemon --help 查看用法。\n`);
  return EXIT_USAGE;
}

/** 同步读取标准输入；失败返回 null（由调用方转成用法错误） */
function readStdin(): string | null {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

interface StdinReader {
  readLine(): Promise<string | null>;
  close(): void;
}

function createStdinReader(): StdinReader {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });

  const queue: string[] = [];
  let pending: ((value: string | null) => void) | null = null;
  let closed = false;

  rl.on('line', (line) => {
    if (pending !== null) {
      const resolve = pending;
      pending = null;
      resolve(line);
      return;
    }
    queue.push(line);
  });

  rl.on('close', () => {
    closed = true;
    if (pending !== null) {
      const resolve = pending;
      pending = null;
      resolve(null);
    }
  });

  return {
    readLine: () =>
      new Promise<string | null>((resolve) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        if (closed) {
          resolve(null);
          return;
        }
        pending = resolve;
      }),
    close: () => {
      rl.close();
    },
  };
}
