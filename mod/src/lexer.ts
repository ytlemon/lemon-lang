/**
 * lemonmod（.lemon2）词法分析。
 *
 * 规则（v0.1）：
 *   - 空行/空格/Tab 忽略
 *   - `//` 到行尾是注释
 *   - 换行是一个独立词法单元，供语句断句
 *   - `"..."` 是字符串（支持 \n \t \" \\ 转义）
 *   - 其余连续字母/数字/下划线/汉字算一个裸词（关键字、文件名、裸文本都用它）
 *   - `{ } ( ) , ; = + - * /` 各是一个词法单元
 *   - `123` / `12.5` 是数字字面量（number）
 */
import { ModError, ModErrorCode, type SourceSpan } from './errors';
import type { Token } from './token';

// 裸词可以以数字开头：裸文本参数里 `say(123)` 这种写法要能用
// 注意：纯数字（可含一个小数点）会被单独识别成 number 字面量，见下方 word 分支
const WORD_START = /[\p{L}\p{N}_]/u;
const WORD_PART = /[\p{L}\p{N}_.]/u;

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

export function tokenize(input: string): Token[] {
  // 与 Lemon 的 SourceFile 保持一致：剥掉 BOM，统一换行，保证列号稳定
  const text = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replace(/\r\n?/g, '\n');
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let col = 1;

  const spanFrom = (startLine: number, startCol: number): SourceSpan => ({
    line: startLine,
    col: startCol,
    endLine: line,
    endCol: col,
  });

  const advance = (): void => {
    if (text[offset] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    offset += 1;
  };

  const push = (
    kind: Token['kind'],
    startOffset: number,
    startLine: number,
    startCol: number,
    value: string,
  ): void => {
    tokens.push({
      kind,
      text: text.slice(startOffset, offset),
      value,
      line: startLine,
      col: startCol,
      endLine: line,
      endCol: col,
    });
  };

  while (offset < text.length) {
    const ch = text[offset];

    if (ch === ' ' || ch === '\t') {
      advance();
      continue;
    }

    if (ch === '\n') {
      const startOffset = offset;
      const startLine = line;
      const startCol = col;
      advance();
      push('newline', startOffset, startLine, startCol, '\n');
      continue;
    }

    if (ch === '/' && text[offset + 1] === '/') {
      while (offset < text.length && text[offset] !== '\n') advance();
      continue;
    }

    // 运算符（含多字符）：== != < <= > >= = ! + - * /
    // 注意：`//` 已被上面的注释分支吃掉，落到这里的单个 `/` 即除法
    if (ch === '=') {
      if (text[offset + 1] === '=') {
        const startOffset = offset, startLine = line, startCol = col;
        advance(); advance();
        push('eqeq', startOffset, startLine, startCol, '==');
      } else {
        const startOffset = offset, startLine = line, startCol = col;
        advance();
        push('assign', startOffset, startLine, startCol, '=');
      }
      continue;
    }
    if (ch === '!') {
      if (text[offset + 1] === '=') {
        const startOffset = offset, startLine = line, startCol = col;
        advance(); advance();
        push('noteq', startOffset, startLine, startCol, '!=');
      } else {
        const startOffset = offset, startLine = line, startCol = col;
        advance();
        push('not', startOffset, startLine, startCol, '!');
      }
      continue;
    }
    if (ch === '<') {
      if (text[offset + 1] === '=') {
        const startOffset = offset, startLine = line, startCol = col;
        advance(); advance();
        push('lte', startOffset, startLine, startCol, '<=');
      } else {
        const startOffset = offset, startLine = line, startCol = col;
        advance();
        push('lt', startOffset, startLine, startCol, '<');
      }
      continue;
    }
    if (ch === '>') {
      if (text[offset + 1] === '=') {
        const startOffset = offset, startLine = line, startCol = col;
        advance(); advance();
        push('gte', startOffset, startLine, startCol, '>=');
      } else {
        const startOffset = offset, startLine = line, startCol = col;
        advance();
        push('gt', startOffset, startLine, startCol, '>');
      }
      continue;
    }
    if (ch === '+') { const startOffset = offset, startLine = line, startCol = col; advance(); push('plus', startOffset, startLine, startCol, '+'); continue; }
    if (ch === '-') { const startOffset = offset, startLine = line, startCol = col; advance(); push('minus', startOffset, startLine, startCol, '-'); continue; }
    if (ch === '*') { const startOffset = offset, startLine = line, startCol = col; advance(); push('star', startOffset, startLine, startCol, '*'); continue; }
    if (ch === '/') { const startOffset = offset, startLine = line, startCol = col; advance(); push('slash', startOffset, startLine, startCol, '/'); continue; }

    if (ch === '#') {
      // 指令：#incloud <模块名>；其它 # 开头的字符一律不认识
      const rest = text.slice(offset);
      if (rest.startsWith('#incloud')) {
        const startOffset = offset, startLine = line, startCol = col;
        for (let k = 0; k < '#incloud'.length; k += 1) advance();
        push('incloud', startOffset, startLine, startCol, '#incloud');
        continue;
      }
      throw new ModError(
        ModErrorCode.UnexpectedCharacter,
        '不认识这个字符：`#`（lemonmod 目前只支持 #incloud 指令）',
        spanFrom(line, col),
      );
    }

    const symbols: Record<string, Token['kind']> = {
      '{': 'lbrace',
      '}': 'rbrace',
      '(': 'lparen',
      ')': 'rparen',
      ',': 'comma',
      ';': 'semicolon',
    };
    const symbol = symbols[ch];
    if (symbol !== undefined) {
      const startOffset = offset;
      const startLine = line;
      const startCol = col;
      advance();
      push(symbol, startOffset, startLine, startCol, ch);
      continue;
    }

    if (ch === '"') {
      const startOffset = offset;
      const startLine = line;
      const startCol = col;
      advance();
      let value = '';
      let closed = false;
      while (offset < text.length) {
        const current = text[offset];
        if (current === '\n') break;
        if (current === '\\') {
          const next = text[offset + 1];
          if (next === undefined || next === '\n') break;
          const decoded = ESCAPES[next];
          if (decoded === undefined) {
            throw new ModError(
              ModErrorCode.UnexpectedCharacter,
              `字符串里的转义 \\${next} 不认识（支持 \\n \\t \\r \\" \\' \\\\）`,
              spanFrom(line, col),
            );
          }
          value += decoded;
          advance();
          advance();
          continue;
        }
        if (current === '"') {
          advance();
          closed = true;
          break;
        }
        value += current;
        advance();
      }
      if (!closed) {
        throw new ModError(
          ModErrorCode.UnterminatedString,
          '字符串没有闭合，缺少收尾的 `"`',
          spanFrom(startLine, startCol),
        );
      }
      push('string', startOffset, startLine, startCol, value);
      continue;
    }

    if (WORD_START.test(ch)) {
      const startOffset = offset;
      const startLine = line;
      const startCol = col;
      while (offset < text.length && WORD_PART.test(text[offset])) advance();
      const raw = text.slice(startOffset, offset);
      // true / false 是布尔字面量（不是变量）
      if (raw === 'true' || raw === 'false') {
        push('bool', startOffset, startLine, startCol, raw);
        continue;
      }
      // 纯数字（可含一个小数点）当作数字字面量；含汉字 / 字母或字母数字混合的仍是裸词
      if (/^\d+(\.\d+)?$/.test(raw)) {
        push('number', startOffset, startLine, startCol, raw);
      } else {
        push('word', startOffset, startLine, startCol, raw);
      }
      continue;
    }

    throw new ModError(
      ModErrorCode.UnexpectedCharacter,
      `不认识这个字符：\`${ch}\``,
      spanFrom(line, col),
    );
  }

  tokens.push({
    kind: 'eof',
    text: '',
    value: '',
    line,
    col,
    endLine: line,
    endCol: col,
  });
  return tokens;
}
