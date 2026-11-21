/**
 * 键名规范化与终端按键解码。
 *
 * 为什么判定是"按过就算"而不是"当前是否按住"：终端只告诉我们**按下了什么**，
 * 拿不到"松开了"（没有 keyup 事件，键盘自动重复也只是重复的按下）。
 * 所以 Lemon 的 keyboard 语义是：按一次 → 报一次 true → 被读取后清零。
 */

/** 单个字符之外还支持的命名键 */
export const NAMED_KEYS: ReadonlySet<string> = new Set([
  'space',
  'enter',
  'esc',
  'up',
  'down',
  'left',
  'right',
  'tab',
  'backspace',
]);

/** 中断键：在 raw 模式下 Ctrl+C 不会产生 SIGINT，而是送来这个字节 */
export const INTERRUPT_KEY = 'ctrl+c';

/** 可用键名说明，出现在错误提示里 */
export const KEY_NAME_HINT =
  '可用键名：单个字符（w、a、1、-）或 space / enter / esc / up / down / left / right / tab / backspace';

/**
 * 把源码里写的键名规范化成内部键名；返回 null 表示不认识。
 *
 * 规则：单个字符按小写处理（`W` 与 `w` 是同一个键）；其余必须命中命名键表。
 * 中文名也接受最常见的几个（空格 / 回车 / 上 / 下 / 左 / 右）。
 */
export function normalizeKeyName(raw: string): string | null {
  if (raw === ' ' || raw === '空格') return 'space';
  if (raw === '回车') return 'enter';
  if (raw === '上') return 'up';
  if (raw === '下') return 'down';
  if (raw === '左') return 'left';
  if (raw === '右') return 'right';
  if (raw === '制表' || raw === '制表符') return 'tab';
  if (raw === '退格') return 'backspace';

  if (raw.length === 0) return null;
  if (raw.length === 1) {
    const code = raw.charCodeAt(0);
    // 控制字符不能作为键名（含 \n、\t 等）
    if (code < 0x20 || code === 0x7f) return null;
    return raw.toLowerCase();
  }

  const lower = raw.toLowerCase();
  return NAMED_KEYS.has(lower) ? lower : null;
}

/** 解码结果：完整的按键 + 留到下一批继续的半个转义序列 */
export interface KeyDecodeResult {
  keys: string[];
  /** 尚未凑齐的转义序列（如只收到 \x1b），下一批字节拼上后继续解 */
  rest: string;
}

/**
 * 把终端字节流解成键名序列。
 *
 * 方向键之类会送来 CSI 转义序列（`\x1b[A` 等），可能被拆成两批到达，
 * 因此不完整的部分通过 `rest` 返回，由调用方拼到下一批前面。
 */
export function decodeKeys(input: string): KeyDecodeResult {
  const keys: string[] = [];
  let i = 0;
  let rest = '';

  while (i < input.length) {
    const ch = input[i];

    if (ch === '\x1b') {
      const seq = matchEscape(input, i);
      if (seq === null) {
        rest = input.slice(i); // 不完整，等下一批
        break;
      }
      if (seq.key !== null) keys.push(seq.key);
      i += seq.length;
      continue;
    }

    i += 1;
    const mapped = mapSingleByte(ch);
    if (mapped !== null) keys.push(mapped);
  }

  return { keys, rest };
}

/** 单个字符 → 键名；null 表示这个字节不产生按键（如控制字符） */
function mapSingleByte(ch: string): string | null {
  switch (ch) {
    case '\r':
    case '\n':
      return 'enter';
    case '\t':
      return 'tab';
    case '\x7f':
    case '\b':
      return 'backspace';
    case '\x03':
      return INTERRUPT_KEY;
    case ' ':
      return 'space';
    default: {
      const code = ch.charCodeAt(0);
      if (code < 0x20) return null; // 其余控制字符忽略
      return ch.toLowerCase();
    }
  }
}

/** CSI 终止字节 / 参数组合 → 键名 */
const CSI_KEYS = new Map<string, string>([
  ['A', 'up'],
  ['B', 'down'],
  ['C', 'right'],
  ['D', 'left'],
  ['1~', 'home'],
  ['3~', 'delete'],
  ['4~', 'end'],
  ['5~', 'pageup'],
  ['6~', 'pagedown'],
]);

/**
 * 尝试从 start 处解析一个转义序列。
 * 返回 null 表示"还不完整"；key 为 null 表示"序列完整但不产生按键"。
 */
function matchEscape(input: string, start: number): { key: string | null; length: number } | null {
  const second = input[start + 1];
  if (second === undefined) return null; // 只收到一个 ESC，可能是序列的开头

  // 裸 ESC（后面不是 [ 或 O）：Esc 键本身
  if (second !== '[' && second !== 'O') return { key: 'esc', length: 1 };

  // CSI：参数部分在 0x30–0x3F，中间在 0x20–0x2F，终止字节在 0x40–0x7E
  let j = start + 2;
  while (j < input.length) {
    const code = input.charCodeAt(j);
    if (code >= 0x40 && code <= 0x7e) break;
    j += 1;
  }
  if (j >= input.length) return null; // 序列还没收完

  const params = input.slice(start + 2, j);
  const final = input[j];
  const key = CSI_KEYS.get(`${params}${final}`) ?? CSI_KEYS.get(final) ?? null;
  return { key, length: j - start + 1 };
}
