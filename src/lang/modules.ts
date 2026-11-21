/**
 * 能力模块表 —— `#incloud <模块名>` 启用的一组内置函数。
 *
 * 设计取向：
 *  1) 模块只是"一批内置函数"的命名集合，不是变量、不是值、也没有命名空间。
 *     启用后其中的函数直接按名字可用（`#incloud web` 之后就能写 openUrl(...)），
 *     与 say / sleep 这些自带内置完全同级——同样的静态检查、同样的运行期错误。
 *  2) 没写 #incloud 就用模块里的函数，会在静态检查阶段报"未定义的函数"，
 *     并明确提示"它来自哪个模块、要补哪一行"。
 *  3) 模块名与 .lemon1 文件名不冲突：`#incloud web` 永远先按模块解析；
 *     要引入同名的源文件，写成 `#incloud web.lemon1` 即可。
 *
 * 新增模块只需在 MODULES 里加一项，静态检查与求值器会自动识别。
 */
import { spawnSync } from 'node:child_process';

import type { Span } from '../utils/source';
import type { BuiltinContext, BuiltinFn } from './builtins';
import { ErrorCodes, LemonError, wholeFileSpan } from './errors';
import { UNIT, type Value } from './value';

/**
 * 解锁 `websets()` 构造的能力模块。
 * 把这个映射放在模块表旁边，静态检查就不必硬编码模块名。
 */
export const WEBSETS_MODULE = 'web';

/**
 * 解锁 `game()` 构造与 `game.running` / `game.quit` 运行状态的能力模块。
 * 与 websets 一样，构造本身不是函数，只能靠模块名判断是否解锁。
 */
export const GAME_MODULE = 'game';

/**
 * 解锁 `class` 构造与类实例（字段 + 方法）的能力模块。
 * 构造本身不是函数，只能靠模块名判断是否解锁。
 */
export const CLASS_MODULE = 'class';

/**
 * 解锁 `cd { ... }` / `running` / `delete` 三条文件操作语句的能力模块。
 *
 * ⚠️ 这个模块能**删除文件**、**运行程序**，是语言里最危险的能力：
 * `running` / `delete` 只能写在 `cd { ... }` 块里，且目标必须落在该目录内
 * （`..` 或绝对路径逃逸会被拒），但仍然请只在可信的代码里启用它。
 */
export const FILESKILL_MODULE = 'fileskill';

export interface CapabilityModule {
  /** 模块名：`#incloud <这个名字>` */
  name: string;
  /** 一句话说明，出现在"未定义的函数"提示与 lemon --help 里 */
  summary: string;
  functions: BuiltinFn[];
}

/* ------------------------------------------------------------------ */
/* web：网页能力                                                       */
/* ------------------------------------------------------------------ */

/** 抓取超时（毫秒）——网页卡住时不能把解释器一起拖死 */
const FETCH_TIMEOUT_MS = 15_000;
/** 单次抓取的正文上限：超了就报错，避免一个超大页面把内存吃光 */
const FETCH_MAX_BYTES = 4 * 1024 * 1024;

/** 取出并校验一个 http(s) 网址参数 */
function urlOperand(args: Value[], name: string, span: Span): string {
  const value = args[0];
  if (value === undefined || value.kind !== 'text') {
    throw new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: `${name} 需要一个文本网址`,
      span,
      hint: `写法：${name}(https://example.com)`,
    });
  }
  if (!/^https?:\/\//i.test(value.value)) {
    throw new LemonError({
      code: ErrorCodes.INVALID_ARGUMENT,
      phase: 'runtime',
      message: `${name} 只接受 http:// 或 https:// 开头的网址`,
      span,
      hint: `这里收到的内容是：${value.value}`,
    });
  }
  return value.value;
}

/**
 * 用系统默认浏览器打开一个地址（`http(s)://` 或 `file://` 都行）。
 *
 * 用同步 spawn 而不是 detached：打开动作本身是"立刻返回"的（浏览器在后台跑），
 * 同步等待能顺带把"系统里根本没有打开命令"这类失败当场报出来，
 * 而不是悄悄丢了让用户干等。
 *
 * 抽成公开函数是因为 CLI 也要用它：websets() 生成 .html 之后同样要打开浏览器。
 */
export function openInBrowser(url: string, span?: Span): void {
  const command =
    process.platform === 'win32'
      ? { file: 'cmd', argv: ['/c', 'start', '', url] }
      : { file: process.platform === 'darwin' ? 'open' : 'xdg-open', argv: [url] };

  const result = spawnSync(command.file, command.argv, {
    stdio: 'ignore',
    timeout: 5_000,
    windowsHide: true,
  });

  if (result.error !== undefined) {
    const missing = result.error.message.includes('ENOENT');
    throw new LemonError({
      code: ErrorCodes.OPEN_URL_FAILED,
      phase: 'runtime',
      message: missing
        ? `当前系统里找不到用来打开网页的命令（${command.file}）`
        : `打不开浏览器：${result.error.message}`,
      span: span ?? wholeFileSpan(),
      hint: '打开浏览器依赖系统自带的命令：Windows 的 start、macOS 的 open、Linux 的 xdg-open',
    });
  }
}

function builtinOpenUrl(args: Value[], _ctx: BuiltinContext, nameSpan: Span): Value {
  openInBrowser(urlOperand(args, 'openUrl', nameSpan), nameSpan);
  return UNIT;
}

/**
 * fetchText(url)：取回网页正文。
 *
 * 求值器是同步的（与 sleep 一致，不需要事件循环），所以这里用 `curl` 子进程
 * 而不是 fetch —— 后者只能异步，硬塞进同步求值器会把整条执行链改成 Promise。
 * 代价是依赖系统里的 curl，缺了会给出明确的报错而不是静默失败。
 */
function builtinFetchText(args: Value[], _ctx: BuiltinContext, nameSpan: Span): Value {
  const url = urlOperand(args, 'fetchText', nameSpan);

  const result = spawnSync('curl', ['-fsSL', '--max-time', '15', url], {
    encoding: 'utf8',
    timeout: FETCH_TIMEOUT_MS + 2_000,
    maxBuffer: FETCH_MAX_BYTES,
    windowsHide: true,
  });

  if (result.error !== undefined) {
    throw fetchFailure(result.error, nameSpan);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split('\n').pop() ?? '';
    throw new LemonError({
      code: ErrorCodes.FETCH_FAILED,
      phase: 'runtime',
      message: `抓取失败：${detail === '' ? `curl 退出码 ${String(result.status)}` : detail}`,
      span: nameSpan,
      hint: '常见原因：网址写错、服务器返回 4xx / 5xx、或本机网络不通',
    });
  }

  return { kind: 'text', value: result.stdout ?? '' };
}

function fetchFailure(error: Error & { code?: string }, span: Span): LemonError {
  if (error.code === 'ENOENT') {
    return new LemonError({
      code: ErrorCodes.FETCH_FAILED,
      phase: 'runtime',
      message: '抓取网页需要系统里的 curl 命令，但找不到它',
      span,
      hint: 'Windows 10 1803+ / macOS / 主流 Linux 都自带 curl；若确实没有，请先安装 curl',
    });
  }
  if (error.code === 'ENOBUFS') {
    return new LemonError({
      code: ErrorCodes.FETCH_FAILED,
      phase: 'runtime',
      message: `网页太大，超过 ${FETCH_MAX_BYTES / 1024 / 1024} MB 上限`,
      span,
      hint: 'fetchText 面向文本页面；抓大文件请改用别的工具',
    });
  }
  return new LemonError({
    code: ErrorCodes.FETCH_FAILED,
    phase: 'runtime',
    message: `抓取网页超时（超过 ${FETCH_TIMEOUT_MS / 1000} 秒）`,
    span,
    hint: '网址能打开吗？也可以之后用 try / catch 兜住这类失败',
  });
}

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

export const MODULES: ReadonlyMap<string, CapabilityModule> = new Map<string, CapabilityModule>([
  [
    'web',
    {
      name: 'web',
      summary: '网页能力：打开浏览器、抓取网页正文',
      functions: [
        {
          name: 'openUrl',
          paramTypes: ['text'],
          minArgs: 1,
          maxArgs: 1,
          returns: 'unit',
          arityHint: '写法：openUrl(https://example.com)',
          paramHints: ['需要一个 http:// 或 https:// 开头的网址'],
          invoke: builtinOpenUrl,
        },
        {
          name: 'fetchText',
          paramTypes: ['text'],
          minArgs: 1,
          maxArgs: 1,
          returns: 'text',
          arityHint: '写法：fetchText(https://example.com)',
          paramHints: ['需要一个 http:// 或 https:// 开头的网址'],
          invoke: builtinFetchText,
        },
      ],
    },
  ],
  [
    GAME_MODULE,
    {
      name: GAME_MODULE,
      summary: '游戏能力：game() 声明窗口画布（game.init + display.win / display.head）与 game.running / game.quit 运行状态',
      functions: [],
    },
  ],
  [
    CLASS_MODULE,
    {
      name: CLASS_MODULE,
      summary: '类能力：class 名字 { 字段 方法 }，用 类名(值...) 构造对象，对象.字段 / 对象.方法(...) 访问',
      functions: [],
    },
  ],
  [
    FILESKILL_MODULE,
    {
      name: FILESKILL_MODULE,
      summary: '文件能力（⚠️ 可删文件 / 运行程序）：cd "目录" { running "文件"  delete "文件" }，操作限定在该目录内',
      functions: [],
    },
  ],
]);

/** 供提示文案使用的模块名清单，如 `web` */
export const MODULE_NAMES: string = [...MODULES.keys()].join('、');

/** 把若干能力模块展开成「函数名 → 内置函数」表 */
export function moduleBuiltins(modules: Iterable<CapabilityModule>): ReadonlyMap<string, BuiltinFn> {
  const out = new Map<string, BuiltinFn>();
  for (const mod of modules) {
    for (const fn of mod.functions) out.set(fn.name, fn);
  }
  return out;
}

/** 某个函数名属于哪个模块；不属于任何模块时返回 null */
export function moduleOfFunction(name: string): CapabilityModule | null {
  for (const mod of MODULES.values()) {
    if (mod.functions.some((fn) => fn.name === name)) return mod;
  }
  return null;
}
