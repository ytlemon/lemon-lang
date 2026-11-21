/**
 * 词法分析器：手写单趟字符扫描，O(n)。
 *
 * 设计要点：
 *  1) 不发射 Newline token —— 语句分隔由解析器基于 token 的 line 信息判定（ASI）。
 *  2) 裸文本字面量：遇到「既不是标点也不是空白」的字符序列时先扫描成词，
 *     能匹配标识符规则的产出 Ident，否则直接产出 Text（如 `你好，世界`）。
 *  3) 尚未支持的符号（+ - * / 等）给出针对性中文提示，而不是笼统的"非法字符"。
 */
import { SourceFile, type Span } from '../utils/source';
import { DURATION_UNIT_HINT, matchDurationUnit } from './duration';
import { ErrorCodes, LemonError } from './errors';
import { DIRECTIVE_NAME, KEYWORDS, Token, TokenKind } from './token';

/** ASCII 标点——遇到即终止"裸词"扫描 */
const ASCII_DELIMITERS = new Set<string>([
  '(', ')', '{', '}', '[', ']',
  ',', ';', '=',
  '<', '>', '!',
  '+', '-', '*', '/', '%',
  '&', '|', '^', '~', '?', ':',
  '.', '#', '@', '\\', '`', "'", '"',
]);

/** 标识符：Unicode 字母/下划线开头，后接字母、数字、下划线（因此中文名合法） */
const IDENT_RE = /^[\p{L}\p{Nl}_][\p{L}\p{N}_]*$/u;
const IDENT_START_RE = /[\p{L}\p{Nl}_]/u;
/** 标识符后续字符（含数字）——判断一个字符是否"紧贴着一个词" */
const IDENT_PART_RE = /[\p{L}\p{N}_]/u;

/**
 * 全角语法符号 —— 中文输入法下极易误敲。
 *
 * 只收「括号类」与「分号」：全角逗号 `，` 与冒号 `：` 常出现在中文裸文本里
 * （`say(你好，世界)` 是合法写法），把裸文本整段当文本、只对括号类给出提示。
 */
const FULL_WIDTH_SYNTAX = new Map<string, string>([
  ['（', '('],
  ['）', ')'],
  ['｛', '{'],
  ['｝', '}'],
  ['；', ';'],
]);

/** 未支持符号的针对性提示 */
const RESERVED_HINTS = new Map<string, string>([
  ['%', 'Lemon 暂不支持取余运算；目前可用的运算符只有 + - * / **'],
  ['&', '若要表示"并且"，请写 &&'],
  ['|', '若要表示"或者"，请写 ||'],
  [
    ':',
    '「:」不是 Lemon 的语法符号；含 : 的文本要加引号，例如 openUrl("https://example.com")、to "localhost:9000"',
  ],
]);

export function tokenize(src: SourceFile): Token[] {
  return new Lexer(src).tokenize();
}

class Lexer {
  private readonly src: SourceFile;
  private readonly text: string;
  private offset = 0;
  private readonly tokens: Token[] = [];

  constructor(src: SourceFile) {
    this.src = src;
    this.text = src.text;
  }

  tokenize(): Token[] {
    while (true) {
      this.skipInlineWhitespace();
      if (this.offset >= this.text.length) break;
      const start = this.offset;
      const ch = this.text[this.offset];
      const code = this.text.charCodeAt(this.offset);

      if (code === 10 /* \n */) {
        this.offset += 1;
        continue; // 换行不产生 token，行号信息已编码在 span 中
      }
      if (ch === '"') {
        this.scanString(start);
        continue;
      }
      if (isDigit(code)) {
        this.scanNumber(start);
        continue;
      }
      if (ch === '/' && this.text[this.offset + 1] === '/') {
        this.skipLineComment();
        continue;
      }
      if (ch === '/' && this.text[this.offset + 1] === '*') {
        this.skipBlockComment(start);
        continue;
      }
      if (ch === '#') {
        // `#` 有两个含义：`#incloud` 指令，或颜色字面量 `#rrggbb` / `#rgb`。
        // 颜色优先判定——它不是行首独占的，`color=#ffffff` 里就不会落在行首。
        const colorEnd = this.colorLiteralEnd(start);
        if (colorEnd !== null) {
          this.offset = colorEnd;
          const lexeme = this.src.slice(start, colorEnd);
          this.tokens.push({
            kind: TokenKind.Text,
            lexeme,
            value: lexeme,
            span: this.makeSpan(start, colorEnd),
          });
          continue;
        }
        this.scanDirective(start);
        continue;
      }

      switch (ch) {
        case '(':
          this.pushSingle(TokenKind.LParen, start);
          continue;
        case ')':
          this.pushSingle(TokenKind.RParen, start);
          continue;
        case '{':
          this.pushSingle(TokenKind.LBrace, start);
          continue;
        case '}':
          this.pushSingle(TokenKind.RBrace, start);
          continue;
        case '[':
          this.pushSingle(TokenKind.LBracket, start);
          continue;
        case ']':
          this.pushSingle(TokenKind.RBracket, start);
          continue;
        case ',':
          this.pushSingle(TokenKind.Comma, start);
          continue;
        case '=':
          if (this.text[this.offset + 1] === '=') this.pushPair(TokenKind.EqEq, start);
          else this.pushSingle(TokenKind.Assign, start);
          continue;
        case '!':
          if (this.text[this.offset + 1] === '=') this.pushPair(TokenKind.NotEq, start);
          else this.pushSingle(TokenKind.Bang, start);
          continue;
        case '<':
          if (this.text[this.offset + 1] === '=') this.pushPair(TokenKind.Le, start);
          else this.pushSingle(TokenKind.Lt, start);
          continue;
        case '>':
          if (this.text[this.offset + 1] === '=') this.pushPair(TokenKind.Ge, start);
          else this.pushSingle(TokenKind.Gt, start);
          continue;
        case '&':
          if (this.text[this.offset + 1] === '&') {
            this.pushPair(TokenKind.AndAnd, start);
            continue;
          }
          break;
        case '|':
          if (this.text[this.offset + 1] === '|') {
            this.pushPair(TokenKind.OrOr, start);
            continue;
          }
          break;
        case ';':
          this.pushSingle(TokenKind.Semi, start);
          continue;
        case '.':
          // 数字里的小数点由 scanNumber 处理，走到这里一定是成员访问的点号
          this.pushSingle(TokenKind.Dot, start);
          continue;
        case '+':
          this.pushSingle(TokenKind.Plus, start);
          continue;
        case '-':
          this.pushSingle(TokenKind.Minus, start);
          continue;
        case '*':
          // '**' 是乘方，优先于单个 '*'
          if (this.text[this.offset + 1] === '*') {
            this.offset += 2;
            this.tokens.push({
              kind: TokenKind.StarStar,
              lexeme: '**',
              span: this.makeSpan(start, this.offset),
            });
            continue;
          }
          this.pushSingle(TokenKind.Star, start);
          continue;
        case '/':
          // '//' 与 '/*' 已在上面按注释处理过，走到这里一定是除号
          this.pushSingle(TokenKind.Slash, start);
          continue;
        default:
          break;
      }

      if (ASCII_DELIMITERS.has(ch)) {
        throw this.error(
          ErrorCodes.RESERVED_SYMBOL,
          `暂不支持的符号 '${ch}'`,
          start,
          this.offset + 1,
          RESERVED_HINTS.get(ch),
        );
      }

      this.scanWord(start);
    }

    const eofSpan = this.makeSpan(this.text.length, this.text.length);
    this.tokens.push({ kind: TokenKind.Eof, lexeme: '', span: eofSpan });
    return this.tokens;
  }

  /* ------------------------------------------------------------------ */
  /* 扫描子过程                                                          */
  /* ------------------------------------------------------------------ */

  private skipInlineWhitespace(): void {
    while (this.offset < this.text.length) {
      const ch = this.text[this.offset];
      if (ch === '\n') break; // 换行由主循环处理，以便正确累计行号
      if (WHITESPACE_RE.test(ch)) {
        this.offset += 1;
        continue;
      }
      break;
    }
  }

  private skipLineComment(): void {
    this.offset += 2;
    while (this.offset < this.text.length && this.text.charCodeAt(this.offset) !== 10) {
      this.offset += 1;
    }
  }

  private skipBlockComment(start: number): void {
    this.offset += 2;
    let depth = 1;
    while (this.offset < this.text.length) {
      const ch = this.text[this.offset];
      const next = this.text[this.offset + 1];
      if (ch === '/' && next === '*') {
        depth += 1;
        this.offset += 2;
        continue;
      }
      if (ch === '*' && next === '/') {
        depth -= 1;
        this.offset += 2;
        if (depth === 0) return;
        continue;
      }
      this.offset += 1;
    }
    throw this.error(
      ErrorCodes.UNTERMINATED_COMMENT,
      '块注释未闭合，缺少配对的 */',
      start,
      this.text.length,
      '可使用 // 写单行注释',
    );
  }

  /**
   * 颜色字面量 `#rrggbb` / `#rgb` 的结束位置；不是颜色时返回 null。
   *
   * 与 `#incloud` 共用 `#`，靠"后面正好 3 位或 6 位十六进制、且后面不再紧贴
   * 字母数字"来区分：`#incloud` 的 incloud 不是十六进制，天然不会撞上。
   *
   * 语义上颜色就是一段文本（值为 "#ffffff"），所以直接产出 Text token——
   * 不新增 TokenKind，语法树 / 类型检查 / 求值都不用为它加分支。
   */
  private colorLiteralEnd(start: number): number | null {
    let i = start + 1;
    while (i < this.text.length && isHexDigit(this.text.charCodeAt(i))) i += 1;
    const digits = i - (start + 1);
    if (digits !== 3 && digits !== 6) return null;
    const following = this.text[i];
    if (following !== undefined && IDENT_PART_RE.test(following)) return null;
    return i;
  }

  /**
   * `#incloud` 指令。
   *
   * 只在**行首**（前面允许有空格/制表符）才成立，参数一直取到行尾：
   *
   *   #incloud web              // 启用内置能力模块
   *   #incloud 工具.lemon1           // 并入同目录的源文件
   *   #incloud "package.json"   // 引号可有可无
   *
   * 之所以由词法层来认（而不是在文本上做替换）：这样字符串与注释里的
   * `#incloud` 天然不会被误当成指令，`say("#incloud web")` 就只是普通文本。
   *
   * 指令本身不产生语法树节点——加载器（lang/include.ts）会把它消费掉。
   */
  private scanDirective(start: number): void {
    if (!this.atLineStart(start)) {
      throw this.error(
        ErrorCodes.DIRECTIVE_SYNTAX,
        `#${DIRECTIVE_NAME} 必须独占一行`,
        start,
        start + 1,
        `写法：在行首写 #${DIRECTIVE_NAME} 模块名或文件名；行内注释请用 //`,
      );
    }

    const nameEnd = this.scanRunEnd(start + 1);
    const typed = this.src.slice(start + 1, nameEnd);
    if (typed !== DIRECTIVE_NAME) {
      throw this.error(
        ErrorCodes.DIRECTIVE_SYNTAX,
        `Lemon 不认识 '#${typed}'`,
        start,
        Math.max(nameEnd, start + 1),
        typed === 'include'
          ? `Lemon 的引入指令是 #${DIRECTIVE_NAME}（不是 #include）`
          : `Lemon 只有 #${DIRECTIVE_NAME} 这一条指令，例如：#${DIRECTIVE_NAME} web`,
      );
    }

    // 参数：跳过指令名后的空白，一直取到行尾
    let argStart = nameEnd;
    while (argStart < this.text.length && (this.text[argStart] === ' ' || this.text[argStart] === '\t')) {
      argStart += 1;
    }
    let lineEnd = argStart;
    while (lineEnd < this.text.length && this.text.charCodeAt(lineEnd) !== 10 /* \n */) {
      lineEnd += 1;
    }

    const body = stripTrailingComment(this.text.slice(argStart, lineEnd));
    const indent = body.length - body.trimStart().length;
    const raw = body.trim();
    const argSpan = this.makeSpan(argStart + indent, argStart + indent + raw.length);

    // 参数写成空：`#incloud` 后面什么都没写
    if (raw === '') {
      throw this.error(
        ErrorCodes.DIRECTIVE_SYNTAX,
        `#${DIRECTIVE_NAME} 后面要写引入的目标`,
        start,
        lineEnd,
        `可以写内置能力模块名（如 web），或 .lemon1 源文件路径（如 工具.lemon1）`,
      );
    }

    this.offset = lineEnd;
    this.tokens.push({
      kind: TokenKind.Directive,
      lexeme: this.src.slice(start, lineEnd),
      value: unquote(raw),
      argSpan,
      span: this.makeSpan(start, lineEnd),
    });
  }

  /** 该位置是否是"逻辑行首"——前面只有空格/制表符（或就是文件开头） */
  private atLineStart(from: number): boolean {
    for (let i = from - 1; i >= 0; i -= 1) {
      const ch = this.text[i];
      if (ch === ' ' || ch === '\t') continue;
      return ch === '\n';
    }
    return true;
  }

  private scanString(start: number): void {
    this.offset += 1; // 跳过开引号
    let out = '';
    while (true) {
      if (this.offset >= this.text.length) {
        throw this.error(
          ErrorCodes.UNTERMINATED_STRING,
          '字符串未闭合，缺少配对的 "',
          start,
          this.text.length,
          '若想输出中文，也可以写裸文本（say 里要加引号，如 say("你好")）',
        );
      }
      const ch = this.text[this.offset];
      if (ch === '"') {
        this.offset += 1;
        break;
      }
      if (ch === '\\') {
        out += this.readEscape();
        continue;
      }
      out += ch;
      this.offset += 1;
    }
    const span = this.makeSpan(start, this.offset);
    this.tokens.push({ kind: TokenKind.Text, lexeme: this.src.slice(start, this.offset), value: out, span });
  }

  private readEscape(): string {
    const escStart = this.offset;
    this.offset += 1; // 跳过反斜杠
    if (this.offset >= this.text.length) {
      throw this.error(ErrorCodes.BAD_ESCAPE, '转义符不完整', escStart, this.offset);
    }
    const ch = this.text[this.offset];
    const simple = SIMPLE_ESCAPES.get(ch);
    if (simple !== undefined) {
      this.offset += 1;
      return simple;
    }
    if (ch === 'u') {
      const braceStart = this.offset + 1;
      if (this.text[braceStart] !== '{') {
        throw this.error(
          ErrorCodes.BAD_ESCAPE,
          'Unicode 转义格式应为 \\u{XXXX}',
          escStart,
          this.offset + 2,
        );
      }
      const close = this.text.indexOf('}', braceStart + 1);
      if (close === -1) {
        throw this.error(ErrorCodes.BAD_ESCAPE, 'Unicode 转义缺少 }', escStart, this.offset + 2);
      }
      const hex = this.text.slice(braceStart + 1, close);
      if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) {
        throw this.error(ErrorCodes.BAD_ESCAPE, `Unicode 转义内容非法：${hex}`, escStart, close + 1);
      }
      const code = Number.parseInt(hex, 16);
      if (code > 0x10ffff) {
        throw this.error(ErrorCodes.BAD_ESCAPE, `Unicode 码点超出范围：${hex}`, escStart, close + 1);
      }
      this.offset = close + 1;
      return String.fromCodePoint(code);
    }
    throw this.error(
      ErrorCodes.BAD_ESCAPE,
      `无法识别的转义符 \\${ch}`,
      escStart,
      this.offset + 1,
      '支持 \\n \\t \\r \\\\ \\" \\0 与 \\u{XXXX}',
    );
  }

  private scanNumber(start: number): void {
    while (this.offset < this.text.length && isDigit(this.text.charCodeAt(this.offset))) {
      this.offset += 1;
    }
    let isDouble = false;

    if (this.text[this.offset] === '.') {
      if (!isDigit(this.text.charCodeAt(this.offset + 1))) {
        throw this.error(
          ErrorCodes.BAD_NUMBER,
          '小数点后缺少数字',
          start,
          this.offset + 1,
          '如需小数请写成 1.0 或 1.23',
        );
      }
      isDouble = true;
      this.offset += 1;
      while (this.offset < this.text.length && isDigit(this.text.charCodeAt(this.offset))) {
        this.offset += 1;
      }
    }

    const expCh = this.text[this.offset];
    if (expCh === 'e' || expCh === 'E') {
      let probe = this.offset + 1;
      const sign = this.text[probe];
      if (sign === '+' || sign === '-') probe += 1;
      if (isDigit(this.text.charCodeAt(probe))) {
        isDouble = true;
        this.offset = probe;
        while (this.offset < this.text.length && isDigit(this.text.charCodeAt(this.offset))) {
          this.offset += 1;
        }
      }
    }

    // 时间单位后缀：500ms / 2s / 1min / 1h → 统一换算成"多少秒"的 double
    const unit = matchDurationUnit(this.text, this.offset);
    if (unit !== null) {
      const base = Number(this.src.slice(start, this.offset));
      if (!Number.isFinite(base)) {
        throw this.error(ErrorCodes.BAD_NUMBER, `数字超出可表示范围：${this.src.slice(start, this.offset)}`, start, this.offset);
      }
      this.offset += unit.length;
      this.tokens.push({
        kind: TokenKind.Double,
        lexeme: this.src.slice(start, this.offset),
        value: base * unit.seconds,
        durationUnit: unit.unit,
        span: this.makeSpan(start, this.offset),
      });
      return;
    }

    const following = this.text[this.offset];
    if (following !== undefined && IDENT_START_RE.test(following)) {
      const runEnd = this.scanRunEnd(this.offset);
      throw this.error(
        ErrorCodes.BAD_NUMBER,
        `数字后面不能直接跟字符：${this.src.slice(start, runEnd)}`,
        start,
        runEnd,
        `${DURATION_UNIT_HINT}；若要输出这类文字，请用引号包起来，例如 "1元"`,
      );
    }

    const raw = this.src.slice(start, this.offset);
    const span = this.makeSpan(start, this.offset);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw this.error(ErrorCodes.BAD_NUMBER, `数字超出可表示范围：${raw}`, start, this.offset);
    }
    if (!isDouble && !Number.isSafeInteger(value)) {
      throw this.error(
        ErrorCodes.BAD_NUMBER,
        `整数超出安全范围（±9007199254740991）：${raw}`,
        start,
        this.offset,
        '超大数值请改用 double 类型',
      );
    }
    this.tokens.push({
      kind: isDouble ? TokenKind.Double : TokenKind.Int,
      lexeme: raw,
      value,
      span,
    });
  }

  /** 扫描一段"裸词"：止于空白或 ASCII 标点 */
  private scanWord(start: number): void {
    this.offset = this.scanRunEnd(start);
    const raw = this.src.slice(start, this.offset);
    const span = this.makeSpan(start, this.offset);
    const keyword = KEYWORDS.get(raw);
    if (keyword !== undefined) {
      this.tokens.push({ kind: keyword, lexeme: raw, span });
      return;
    }
    if (IDENT_RE.test(raw)) {
      this.tokens.push({ kind: TokenKind.Ident, lexeme: raw, span });
      return;
    }

    // 全角括号/分号：几乎都是在中文输入法下写语法符号，单独给出明确提示。
    // 全角逗号与冒号不在此列——它们是中文裸文本的常见内容。
    for (let i = 0; i < raw.length; i += 1) {
      const halfWidth = FULL_WIDTH_SYNTAX.get(raw[i]);
      if (halfWidth === undefined) continue;
      const at = start + i;
      throw this.error(
        ErrorCodes.RESERVED_SYMBOL,
        `'${raw[i]}' 是全角符号，不能作为语法符号`,
        at,
        at + 1,
        `语法括号与分号必须用半角，这里应写成 '${halfWidth}'；若要输出这段文字，请用引号包起来，例如 "..."`,
      );
    }

    // 裸文本：不加引号直接当字符串
    this.tokens.push({ kind: TokenKind.Text, lexeme: raw, value: raw, span });
  }

  private scanRunEnd(from: number): number {
    let i = from;
    while (i < this.text.length) {
      const ch = this.text[i];
      if (WHITESPACE_RE.test(ch)) break;
      if (ASCII_DELIMITERS.has(ch)) break;
      i += 1;
    }
    return i;
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  private pushSingle(kind: TokenKind, start: number): void {
    this.offset += 1;
    this.tokens.push({ kind, lexeme: this.src.slice(start, this.offset), span: this.makeSpan(start, this.offset) });
  }

  /** 双字符运算符：== != <= >= && || —— 调用方需先确认第二个字符匹配 */
  private pushPair(kind: TokenKind, start: number): void {
    this.offset += 2;
    this.tokens.push({ kind, lexeme: this.src.slice(start, this.offset), span: this.makeSpan(start, this.offset) });
  }

  private makeSpan(start: number, end: number): Span {
    const a = this.src.positionAt(start);
    const b = this.src.positionAt(end);
    return { line: a.line, col: a.col, endLine: b.line, endCol: b.col, start, end };
  }

  private error(code: string, message: string, start: number, end: number, hint?: string): LemonError {
    return new LemonError({ code, message, phase: 'lex', span: this.makeSpan(start, end), hint });
  }
}

const SIMPLE_ESCAPES = new Map<string, string>([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['\\', '\\'],
  ['"', '"'],
  ['0', '\0'],
]);

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** 十六进制数字：0-9 a-f A-F */
function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) /* 0-9 */ ||
    (code >= 97 && code <= 102) /* a-f */ ||
    (code >= 65 && code <= 70) /* A-F */
  );
}

/**
 * 剥掉行尾的 `//` 注释。
 *
 * 只有「行首的 //」或「空白 + //」才算注释起点，因此 `lib//工具.lemon1` 这类路径
 * 不会被误伤（它前面没有空白），而 `#incloud // 先留着` 会被剥成空参数并报错。
 */
function stripTrailingComment(text: string): string {
  const at = text.search(/(^|\s)\/\//u);
  return at === -1 ? text : text.slice(0, at);
}

/** 去掉成对的引号（`"package.json"` → `package.json`）；没成对就原样返回 */
function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

/** 空白判定：包含全角空格等 Unicode 空白；调用方需先排除 \n */
const WHITESPACE_RE = /\s/u;
