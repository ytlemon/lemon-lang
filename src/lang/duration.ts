/**
 * 时间单位后缀（`500ms`、`2s`、`1min`、`1h`）。
 *
 * 设计取舍：带单位的字面量**一律求值为 double**，表示"多少秒"。
 * 于是 `1min` 就是 `60.0`，`500ms` 就是 `0.5`；`sleep(1)` 里的裸数字同样按秒算。
 * 规则只有一条：**Lemon 里的时间以秒为单位**。
 */

/** 单位后缀 → 秒数换算系数（按长度倒序匹配，保证 min 不会被 m 截断） */
export const DURATION_UNITS: ReadonlyArray<{ suffix: string; seconds: number }> = [
  { suffix: 'min', seconds: 60 },
  { suffix: 'ms', seconds: 0.001 },
  { suffix: 's', seconds: 1 },
  { suffix: 'h', seconds: 3600 },
];

/** 可用单位说明，出现在报错提示里 */
export const DURATION_UNIT_HINT =
  '时间单位：ms（毫秒）、s（秒）、min（分）、h（小时），例如 500ms、2s、1min、1.5h';

/** 单位后面还能跟字符时，说明这不是一个完整的单位（如 1min2） */
const IDENT_LIKE = /[\p{L}\p{N}_]/u;

/**
 * 从 text 的 from 位置起是否紧跟一个时间单位。
 * 大小写都认（`1S` / `1Min`）；单位后面不能再跟字母数字，否则不算命中。
 */
export function matchDurationUnit(
  text: string,
  from: number,
): { seconds: number; unit: string; length: number } | null {
  for (const { suffix, seconds } of DURATION_UNITS) {
    if (text.slice(from, from + suffix.length).toLowerCase() !== suffix) continue;
    const after = text[from + suffix.length];
    if (after !== undefined && IDENT_LIKE.test(after)) continue;
    return { seconds, unit: suffix, length: suffix.length };
  }
  return null;
}
