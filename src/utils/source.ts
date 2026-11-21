/**
 * 源码文件抽象：负责文本持有、offset ↔ (line, col) 换算与行缓存。
 *
 * 约定：line 与 col 均从 1 开始计数，col 以 UTF-16 code unit 计（与编辑器一致）。
 */

export interface Position {
  /** 1-based 行号 */
  line: number;
  /** 1-based 列号 */
  col: number;
}

export interface Span extends Position {
  /** 结束行（含），1-based */
  endLine: number;
  /** 结束列（不含），1-based */
  endCol: number;
  /** 起始 offset（UTF-16 code unit） */
  start: number;
  /** 结束 offset（不含） */
  end: number;
}

export function spanFrom(start: Position, end: Position, startOffset: number, endOffset: number): Span {
  return {
    line: start.line,
    col: start.col,
    endLine: end.line,
    endCol: end.col,
    start: startOffset,
    end: endOffset,
  };
}

/**
 * 一行的来源。
 *
 * 只有多文件编译（`#incloud` 把别的 .lemon1 并入本文件）才用得上：
 * 合并后的源码里第 N 行其实来自某个真实文件的第 M 行，
 * 报错时必须把它还原回去，否则行号对不上、用户根本找不到问题。
 */
export interface LineOrigin {
  source: SourceFile;
  /** 该行在 source 里的行号（1-based） */
  line: number;
}

export class SourceFile {
  readonly path: string;
  readonly text: string;

  /**
   * 每行的来源，第 i 项对应本文件的第 i+1 行。
   * 单文件编译时为 null（默认），由 #incloud 加载器在多文件编译时填入。
   */
  origins: LineOrigin[] | null = null;

  /** lineStarts[i] = 第 i+1 行首字符的 offset */
  private readonly lineStarts: number[];

  constructor(path: string, text: string) {
    this.path = path;
    // 去掉 UTF-8 BOM：Windows 记事本等编辑器可能写入 BOM，
    // 若不剥离会被当成非法字符报错。剥离后再归一化换行，
    // 这样 offset 与列号始终与"不含 BOM 的文本"保持一致。
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    this.text = withoutBom.replace(/\r\n?/g, '\n');
    this.lineStarts = computeLineStarts(this.text);
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** 由 offset 求 (line, col) */
  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: clamped - this.lineStarts[lo] + 1 };
  }

  /** 取第 line 行文本（1-based，不含换行符）；越界返回空串 */
  lineText(line: number): string {
    if (line < 1 || line > this.lineStarts.length) return '';
    const start = this.lineStarts[line - 1];
    const end = line < this.lineStarts.length ? this.lineStarts[line] - 1 : this.text.length;
    return this.text.slice(start, end);
  }

  /** 取指定范围文本（用于错误片段与 `--json` 的 excerpt） */
  slice(start: number, end: number): string {
    return this.text.slice(Math.max(0, start), Math.max(0, end));
  }

  /**
   * 把本文件的行号还原成"它真正来自哪个文件、哪一行"。
   * 单文件编译（origins 为 null）时返回自身，调用方无需分支。
   */
  locate(line: number): LineOrigin {
    let source: SourceFile = this;
    let current = line;
    // 正常只会走一跳（各文件自己的 origins 恒为 null）；加个上界纯粹是防呆
    for (let guard = 0; guard < 16 && source.origins !== null; guard += 1) {
      const origin = source.origins[current - 1];
      if (origin === undefined) break;
      source = origin.source;
      current = origin.line;
    }
    return { source, line: current };
  }
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}
