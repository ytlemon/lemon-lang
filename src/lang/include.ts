/**
 * `#incloud` 文件加载器。
 *
 * 位置：夹在"读文件"与"词法分析"之间。它把若干 `.lemon1` 文件缝成**一份源码**，
 * 再交给原有的 词法 → 语法 → 静态检查 → 求值 流水线，后者完全不知道多文件的存在。
 *
 *   #incloud web          启用内置能力模块（不产生任何源码）
 *   #incloud 工具.lemon1       把该文件的源码**并入**本程序
 *
 * 已定的四条规则：
 *  1) 路径写到行尾，`//` 注释自动剥掉，引号可有可无；
 *     名字以 `.lemon1` 结尾就一定按文件解析，否则先查能力模块、再试 `<名字>.lemon1`。
 *  2) 写在 `__init__` 之前的引入，内容会落到 `__init__ {` 之后——这是最常见的写法，
 *     被并入的 def / 变量本来就该待在初始化块里。写在 `__init__` 内部的则就地展开。
 *  3) 同一个文件只并入一次——A 引 B、B 引 C、A 又引 C 时 C 只出现一次，
 *     否则函数会被重复声明（菱形依赖是常态，不是错误）。
 *  4) 找不到目标时报错，并把"同目录下有哪些 .lemon1"一并列出来。
 *
 * 错误定位：合并后的每一行都记着它来自哪个文件的哪一行，因此报错依然指向
 * 用户真正写错的那一行（见 utils/source.ts 的 LineOrigin）。
 */
import { SourceFile, type LineOrigin, type Span } from '../utils/source';
import { ErrorCodes, LemonError } from './errors';
import { moduleBuiltins, MODULE_NAMES, MODULES, type CapabilityModule } from './modules';
import type { BuiltinFn } from './builtins';
import { tokenize } from './lexer';
import { LEGACY_SOURCE_EXTENSION, SOURCE_EXTENSION, Token, TokenKind } from './token';

/**
 * 加载器需要的三种文件系统能力。
 * 用接口而不是直接调 fs：测试可以喂内存文件，也避免语言核心被 Node API 绑死。
 */
export interface IncludeIo {
  /** 读文本；不存在或读不了返回 null */
  readText(path: string): string | null;
  /** 把 reference 按 fromFile 所在目录解析成可直接读取的路径 */
  resolvePath(fromFile: string, reference: string): string;
  /** fromFile 同目录下的文件名（用于"是不是想引它"的提示） */
  siblingsOf(fromFile: string): string[];
}

export interface IncludeResult {
  /** 缝合后的源码，带行来源映射 */
  source: SourceFile;
  /** 本次启用到的能力模块，按出现顺序 */
  modules: CapabilityModule[];
  /** 能力模块提供的全部内置函数 */
  builtins: ReadonlyMap<string, BuiltinFn>;
}

/**
 * 加载期失败。
 *
 * 带着"错误所在的那个文件"一起抛，因为错误可能发生在被引入的文件里——
 * 只给一个 LemonError 的话，上层只能拿入口文件去渲染，行号就全错了。
 */
export class IncludeFailure extends Error {
  constructor(
    readonly lemon: LemonError,
    readonly source: SourceFile,
  ) {
    super(lemon.message);
    this.name = 'IncludeFailure';
  }
}

/** 引入层数上限：正常程序远到不了，触发基本就是循环引入 */
const MAX_INCLUDE_DEPTH = 32;
/** 候选提示里最多列几个文件 */
const MAX_CANDIDATES = 8;

export function resolveIncludes(entryPath: string, text: string, io: IncludeIo): IncludeResult {
  return new IncludeLoader(io).run(entryPath, text);
}

/** 一段输出缓冲区；入口文件用主缓冲，延迟落地的引入先用临时缓冲攒着 */
interface Sink {
  lines: string[];
  origins: LineOrigin[];
}

class IncludeLoader {
  private readonly io: IncludeIo;
  /** 路径 → SourceFile，保证同一文件只构造一次（报错时能拿到稳定的文本与行表） */
  private readonly sources = new Map<string, SourceFile>();
  /** 已经并入过的文件路径（入口文件一开始就在里面） */
  private readonly included = new Set<string>();
  private readonly modules = new Map<string, CapabilityModule>();

  private readonly output: Sink = { lines: [], origins: [] };
  /** 入口文件里 `__init__ {` 那个左花括号所在的行；null 表示没写外壳 */
  private entryInjectAt: number | null = null;
  /** 攒着"要插到 __init__ 开头"的内容 */
  private pending: Sink | null = null;

  private depth = 0;

  constructor(io: IncludeIo) {
    this.io = io;
  }

  run(entryPath: string, text: string): IncludeResult {
    this.included.add(entryPath);

    const entry = this.sourceOf(entryPath, text);
    const scanned = this.scan(entry);
    this.entryInjectAt = scanned.initBraceLine;
    this.expand(entry, entryPath, scanned.directives, this.output);
    this.flushPending(this.output); // 没找到 __init__ 时的兜底，别把内容弄丢

    const source = new SourceFile(entryPath, this.output.lines.join('\n'));
    source.origins = this.output.origins;

    return {
      source,
      modules: [...this.modules.values()],
      builtins: moduleBuiltins(this.modules.values()),
    };
  }

  /* ------------------------------ 缝合 ------------------------------ */

  /**
   * 把一个文件的每一行搬到 sink 里，遇到指令行则就地处替换。
   *
   * `sink` 是参数而不是固定字段：入口文件在 `__init__` 之前写的引入要先攒进
   * 临时缓冲，等走到 `__init__ {` 那一行之后再倒进去。
   */
  private expand(source: SourceFile, path: string, directives: Map<number, Token>, sink: Sink): void {
    const lines = source.text.split('\n');
    const isEntry = sink === this.output;

    for (let i = 0; i < lines.length; i += 1) {
      const lineNo = i + 1;
      const directive = directives.get(lineNo);

      if (directive === undefined) {
        sink.lines.push(lines[i]);
        sink.origins.push({ source, line: lineNo });
        // 走到 `__init__ {` 这一行之后，把攒着的引入内容倒进初始化块
        if (isEntry && lineNo === this.entryInjectAt) this.flushPending(sink);
        continue;
      }

      const defer = isEntry && this.entryInjectAt !== null && lineNo < this.entryInjectAt;
      this.applyDirective(directive, source, path, defer ? this.pendingSink() : sink);
    }
  }

  /**
   * 扫一遍文件：收集 `#incloud` 的位置，顺便看看 `__init__` 的左花括号在哪一行。
   *
   * 走的是真正的词法器，所以注释里的、字符串里的 `#incloud` 都不会被算进来；
   * 词法错误也会在这里提前暴露（包成 IncludeFailure 指回本文件）。
   */
  private scan(source: SourceFile): { directives: Map<number, Token>; initBraceLine: number | null } {
    let tokens: Token[];
    try {
      tokens = tokenize(source);
    } catch (error) {
      if (error instanceof LemonError) throw new IncludeFailure(error, source);
      throw error;
    }

    const directives = new Map<number, Token>();
    for (const token of tokens) {
      if (token.kind === TokenKind.Directive) directives.set(token.span.line, token);
    }

    let initBraceLine: number | null = null;
    for (let i = 0; i < tokens.length - 1; i += 1) {
      if (tokens[i].kind !== TokenKind.KwInit) continue;
      const next = tokens[i + 1];
      initBraceLine = next.kind === TokenKind.LBrace ? next.span.line : null;
      break;
    }

    return { directives, initBraceLine };
  }

  private applyDirective(token: Token, source: SourceFile, path: string, sink: Sink): void {
    const name = String(token.value ?? '');
    const span: Span = token.argSpan ?? token.span;

    // 旧后缀：专门说清楚，否则只会报"找不到 工具.lemon1"让人一头雾水
    if (name.endsWith(LEGACY_SOURCE_EXTENSION)) {
      throw new IncludeFailure(
        new LemonError({
          code: ErrorCodes.INCLUDE_BAD_TARGET,
          phase: 'usage',
          message: `Lemon 源文件的后缀已从 ${LEGACY_SOURCE_EXTENSION} 改为 ${SOURCE_EXTENSION}`,
          span,
          hint: `把 ${name} 改成 ${name.slice(0, -LEGACY_SOURCE_EXTENSION.length)}${SOURCE_EXTENSION}，并把文件本身也改个名`,
        }),
        source,
      );
    }

    if (!name.endsWith(SOURCE_EXTENSION)) {
      // 能力模块优先于同名文件：模块名是语言层面的固定名词，不该被目录里的
      // 同名源文件悄悄顶掉。真要引那个文件，写成 #incloud web.lemon1 就行。
      const mod = MODULES.get(name);
      if (mod !== undefined) {
        if (!this.modules.has(mod.name)) this.modules.set(mod.name, mod);
        return; // 指令这一行不产出源码
      }
      if (hasExtension(name)) {
        throw new IncludeFailure(
          new LemonError({
            code: ErrorCodes.INCLUDE_BAD_TARGET,
            phase: 'usage',
            message: `不能引入 ${name}：Lemon 只支持 ${SOURCE_EXTENSION} 源文件`,
            span,
            hint: `#incloud 可以引内置能力模块（当前可用：${MODULE_NAMES}）或 ${SOURCE_EXTENSION} 源文件；JSON、文本这类数据文件暂不支持`,
          }),
          source,
        );
      }
    }

    const target = this.io.resolvePath(
      path,
      name.endsWith(SOURCE_EXTENSION) ? name : `${name}${SOURCE_EXTENSION}`,
    );
    const text = this.io.readText(target);
    if (text === null) throw new IncludeFailure(this.notFound(name, span, path), source);

    if (this.included.has(target)) return; // 同一文件只并入一次
    if (this.depth >= MAX_INCLUDE_DEPTH) throw new IncludeFailure(this.tooDeep(span), source);

    this.included.add(target);
    this.depth += 1;
    try {
      const included = this.sourceOf(target, text);
      const scanned = this.scan(included);
      if (scanned.initBraceLine !== null) throw new IncludeFailure(this.hasInit(name, span), source);
      this.expand(included, target, scanned.directives, sink);
    } finally {
      this.depth -= 1;
    }
  }

  private pendingSink(): Sink {
    if (this.pending === null) this.pending = { lines: [], origins: [] };
    return this.pending;
  }

  private flushPending(sink: Sink): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    for (const line of pending.lines) sink.lines.push(line);
    for (const origin of pending.origins) sink.origins.push(origin);
  }

  private sourceOf(path: string, text: string): SourceFile {
    const cached = this.sources.get(path);
    if (cached !== undefined) return cached;
    const source = new SourceFile(path, text);
    this.sources.set(path, source);
    return source;
  }

  /* ------------------------------ 报错 ------------------------------ */

  private notFound(name: string, span: Span, path: string): LemonError {
    const hints: string[] = [`可用模块：${MODULE_NAMES}`];

    const candidates = this.candidatesFor(name, path);
    if (candidates.length > 0) hints.push(`同目录下的源文件：${candidates.join('、')}`);
    else {
      hints.push(
        `被引入的文件要和本文件放在同一个目录（或写成相对路径，如 lib/工具${SOURCE_EXTENSION}）`,
      );
    }

    return new LemonError({
      code: ErrorCodes.INCLUDE_NOT_FOUND,
      phase: 'usage',
      message: `找不到 ${name}`,
      span,
      hint: hints.join('；'),
    });
  }

  /**
   * 同目录下的 .lemon1 候选，越像写错的那个排越前。
   * 纯按字母序排的话，目录一大，"想引的那个"就被挤到 8 名开外了，等于没提示。
   */
  private candidatesFor(name: string, path: string): string[] {
    const ext = SOURCE_EXTENSION.length;
    const base = name.endsWith(SOURCE_EXTENSION) ? name.slice(0, -ext) : name;
    const score = (file: string): number => {
      const stem = file.slice(0, -ext);
      if (stem === base) return 2;
      const chars = new Set([...stem]);
      for (const ch of base) if (chars.has(ch)) return 1;
      return 0;
    };
    return this.io
      .siblingsOf(path)
      .filter((file) => file.endsWith(SOURCE_EXTENSION))
      .sort((a, b) => score(b) - score(a) || (a < b ? -1 : 1))
      .slice(0, MAX_CANDIDATES);
  }

  private hasInit(name: string, span: Span): LemonError {
    return new LemonError({
      code: ErrorCodes.INCLUDE_HAS_INIT,
      phase: 'usage',
      message: `被引入的 ${name} 里不能再写 __init__`,
      span,
      hint: `被引入的 ${SOURCE_EXTENSION} 是"零件"：只写 def 与变量就行，__init__ 与 main() 由入口文件负责`,
    });
  }

  private tooDeep(span: Span): LemonError {
    return new LemonError({
      code: ErrorCodes.INCLUDE_TOO_DEEP,
      phase: 'usage',
      message: `#incloud 层数过深（超过 ${MAX_INCLUDE_DEPTH} 层）`,
      span,
      hint: '两个文件互相 #incloud 会绕不出来，请检查它们之间的引入关系',
    });
  }
}

/** 名字带扩展名（`.json`、`.txt`…）——用来把"非源文件的数据文件"和"忘写扩展名"区分开 */
function hasExtension(name: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/u.test(name);
}
