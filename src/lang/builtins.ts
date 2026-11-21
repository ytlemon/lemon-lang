/**
 * 内置函数表。
 *
 *   say(x)      输出一个值并换行
 *   ask(提示词)  读取用户输入的一行，返回文本
 *   keyboard(k) 非阻塞判定：这个键自上次读取后是否被按过（读取后清零）
 *   waitKey(k)  阻塞等待：停在这一行直到该键被按下
 *
 * 新增内置只需在此注册，静态检查与求值器都会自动识别。
 * `checkLiteralArg` 是可选钩子：参数写成字面量时做额外校验（键名拼写）。
 */
import type { Span } from '../utils/source';
import type { LemonType } from './ast';
import { ErrorCodes, LemonError } from './errors';
import { KEY_NAME_HINT, normalizeKeyName } from './keys';
import { displayValue, typeNameOf, UNIT, type Value } from './value';

export interface BuiltinContext {
  /** 向 stdout 写入（不含换行） */
  write(text: string): void;
  /** 键盘输入源；未接入时为 undefined（REPL、库调用） */
  keyboard?: KeyboardInput;
  /**
   * 读一行输入：先打印 prompt，再等用户回车，返回这一行；拿不到输入（非终端）返回 null。
   * 未接入时为 undefined。`ask(...)` 与 `read in answer` 共用它。
   */
  readLine?: (prompt: string) => string | null;
}

/** 键盘输入源接口（实现见 utils/keyboard.ts，此处只依赖接口以便解耦与测试） */
export interface KeyboardInput {
  take(name: string, span: Span): boolean;
  wait(name: string, span: Span): void;
  /** 只检查有没有收到 Ctrl+C；sleep 用它让长睡眠也能被中断 */
  checkInterrupt?(): void;
}

export interface BuiltinFn {
  name: string;
  /** 位置参数类型，'any' 表示不限 */
  paramTypes: LemonType[];
  minArgs: number;
  maxArgs: number;
  returns: LemonType;
  /** 参数个数不符时的提示 */
  arityHint?: string;
  /** 各位置参数类型不符时的补充提示（按下标，可缺省） */
  paramHints?: ReadonlyArray<string | undefined>;
  invoke(args: Value[], ctx: BuiltinContext, nameSpan: Span): Value;
  /**
   * 可选：某个参数写成字面量时的额外校验（返回 null 表示合法）。
   * 只在实参确实是字面量时调用——传变量时不检查，因为值要到运行期才知道。
   */
  checkLiteralArg?: (index: number, literal: string) => { message: string; hint?: string } | null;
}

function builtinSay(args: Value[], ctx: BuiltinContext, nameSpan: Span): Value {
  if (args.length !== 1) {
    throw new LemonError({
      code: ErrorCodes.SAY_ARITY,
      phase: 'runtime',
      message: `say 需要恰好 1 个参数，实际给了 ${args.length} 个`,
      span: nameSpan,
      hint: '需要输出多个值时，请分多次调用 say',
    });
  }
  ctx.write(`${displayValue(args[0])}\n`);
  return UNIT;
}

function requireKeyboard(ctx: BuiltinContext, name: string, span: Span): KeyboardInput {
  if (ctx.keyboard === undefined) {
    throw new LemonError({
      code: ErrorCodes.KEYBOARD_UNAVAILABLE,
      phase: 'runtime',
      message: `${name} 在当前环境里拿不到键盘`,
      span,
      hint: 'keyboard / waitKey 需要真实终端：请把程序写成 .lemon1 文件后用 lemon 运行（REPL 与库调用里 stdin 不可用）',
    });
  }
  return ctx.keyboard;
}

/** 取出并校验键名；不认识的键名直接报错，而不是永远返回 false */
function keyNameOf(args: Value[], name: string, span: Span): string {
  const value = args[0];
  if (value === undefined || value.kind !== 'text') {
    throw new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: `${name} 需要一个文本键名`,
      span,
      hint: KEY_NAME_HINT,
    });
  }
  const key = normalizeKeyName(value.value);
  if (key === null) {
    throw new LemonError({
      code: ErrorCodes.INVALID_ARGUMENT,
      phase: 'runtime',
      message: `${name} 不认识键名「${value.value}」`,
      span,
      hint: KEY_NAME_HINT,
    });
  }
  return key;
}

function builtinKeyboard(args: Value[], ctx: BuiltinContext, nameSpan: Span): Value {
  const keyboard = requireKeyboard(ctx, 'keyboard', nameSpan);
  const key = keyNameOf(args, 'keyboard', nameSpan);
  return { kind: 'bool', value: keyboard.take(key, nameSpan) };
}

function builtinWaitKey(args: Value[], ctx: BuiltinContext, nameSpan: Span): Value {
  const keyboard = requireKeyboard(ctx, 'waitKey', nameSpan);
  const key = keyNameOf(args, 'waitKey', nameSpan);
  keyboard.wait(key, nameSpan);
  return UNIT;
}

/**
 * 睡眠单元：Atomics.wait 是同步阻塞，正好用来实现 sleep——
 * 不需要事件循环，也不会让紧循环把时间片吃掉。
 * 单元格永远保持 0，所以每次调用都会乖乖等到超时。
 */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** 睡眠切片长度：切小片是为了让 Ctrl+C 在长睡眠中也能被接住 */
const SLEEP_SLICE_MS = 50;

function builtinSleep(args: Value[], ctx: BuiltinContext, nameSpan: Span): Value {
  const value = args[0];
  const seconds = value !== undefined && (value.kind === 'int' || value.kind === 'double') ? value.value : null;

  if (seconds === null || !Number.isFinite(seconds)) {
    throw new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: 'sleep 需要一个数字（秒）',
      span: nameSpan,
      hint: '写法：sleep(1) 停 1 秒、sleep(0.5) 停半秒、sleep(1min) 停 1 分钟',
    });
  }

  if (seconds < 0) {
    throw new LemonError({
      code: ErrorCodes.NEGATIVE_DURATION,
      phase: 'runtime',
      message: `sleep 的时间不能为负（这里是 ${seconds} 秒）`,
      span: nameSpan,
      hint: 'sleep(0) 合法（不等待）；负数没有意义，请检查时间的计算方式',
    });
  }

  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return UNIT;
    // 主线程在这里真的睡过去；Worker（如果有）仍在后台收键盘
    Atomics.wait(SLEEP_CELL, 0, 0, Math.min(remaining, SLEEP_SLICE_MS));
    // 睡到一半按 Ctrl+C 也能立刻停下——但只在程序确实用过键盘时才检查
    ctx.keyboard?.checkInterrupt?.();
  }
}

/**
 * ask(提示词)：向用户提问并读取一行输入，返回文本。
 * 提示词可省略（ask() 直接读）。需要真实终端；否则报 E0410。
 */
function builtinAsk(args: Value[], ctx: BuiltinContext, nameSpan: Span): Value {
  const prompt = args.length === 0 || args[0].kind !== 'text' ? '' : args[0].value;

  if (ctx.readLine === undefined) {
    throw new LemonError({
      code: ErrorCodes.KEYBOARD_UNAVAILABLE,
      phase: 'runtime',
      message: 'ask 需要真实终端来读取输入，当前环境拿不到键盘',
      span: nameSpan,
      hint: '请把程序写成 .lemon1 文件后用 lemon 运行（REPL 与库调用里 stdin 不可用）',
    });
  }

  const line = ctx.readLine(prompt);
  if (line === null) {
    throw new LemonError({
      code: ErrorCodes.KEYBOARD_UNAVAILABLE,
      phase: 'runtime',
      message: 'ask 读不到用户输入（非终端环境，或输入已结束）',
      span: nameSpan,
      hint: 'ask 只能在真实终端里等待输入',
    });
  }
  return { kind: 'text', value: line };
}

/**
 * len(列表)：元素个数。
 * 参数不是列表就直接报错，而不是悄悄返回 0 或长度算成别的意思。
 */
function builtinLen(args: Value[], _ctx: BuiltinContext, nameSpan: Span): Value {
  const target = args[0];
  if (target.kind !== 'list') {
    throw new LemonError({
      code: ErrorCodes.RUNTIME_TYPE,
      phase: 'runtime',
      message: `len 需要一个列表，实际给了 ${typeNameOf(target)}`,
      span: nameSpan,
      hint: '写法：len(名字)，其中名字是 list(名字) { 元素 换行 元素 } 声明出来的列表',
    });
  }
  return { kind: 'int', value: target.items.length };
}

/** 键名字面量的静态校验：拼错在运行前就报出来 */
function checkKeyLiteral(name: string) {
  return (_index: number, literal: string): { message: string; hint: string } | null => {
    if (normalizeKeyName(literal) !== null) return null;
    return { message: `${name} 不认识键名「${literal}」`, hint: KEY_NAME_HINT };
  };
}

export const BUILTINS: ReadonlyMap<string, BuiltinFn> = new Map<string, BuiltinFn>([
  [
    'say',
    {
      name: 'say',
      paramTypes: ['any'],
      minArgs: 1,
      maxArgs: 1,
      returns: 'unit',
      arityHint: '需要输出多个值时，请分多次调用 say',
      invoke: builtinSay,
    },
  ],
  [
    'ask',
    {
      name: 'ask',
      paramTypes: ['text'],
      minArgs: 0,
      maxArgs: 1,
      returns: 'text',
      arityHint: '写法：ask(提示词) 或 ask()，返回用户输入的一行文本',
      paramHints: ['提示词是文本，例如 ask("你叫什么名字？")'],
      invoke: builtinAsk,
    },
  ],
  [
    'keyboard',
    {
      name: 'keyboard',
      paramTypes: ['text'],
      minArgs: 1,
      maxArgs: 1,
      returns: 'bool',
      arityHint: '写法：keyboard(键名)，例如 keyboard(w)',
      paramHints: [KEY_NAME_HINT],
      invoke: builtinKeyboard,
      checkLiteralArg: checkKeyLiteral('keyboard'),
    },
  ],
  [
    'waitKey',
    {
      name: 'waitKey',
      paramTypes: ['text'],
      minArgs: 1,
      maxArgs: 1,
      returns: 'unit',
      arityHint: '写法：waitKey(键名)，例如 waitKey(space)',
      paramHints: [KEY_NAME_HINT],
      invoke: builtinWaitKey,
      checkLiteralArg: checkKeyLiteral('waitKey'),
    },
  ],
  [
    'sleep',
    {
      name: 'sleep',
      paramTypes: ['double'],
      minArgs: 1,
      maxArgs: 1,
      returns: 'unit',
      arityHint: '写法：sleep(秒数)，例如 sleep(1)、sleep(0.5)、sleep(1min)',
      paramHints: [
        'sleep 的时间按秒算：sleep(1) 停 1 秒、sleep(0.5) 停半秒；也可以写带单位的字面量（500ms、2s、1min）',
      ],
      invoke: builtinSleep,
    },
  ],
  [
    'len',
    {
      name: 'len',
      paramTypes: ['list'],
      minArgs: 1,
      maxArgs: 1,
      returns: 'int',
      arityHint: '写法：len(列表)，返回列表里元素的个数',
      paramHints: ['len 只接受列表：先用 list(名字) { 元素 换行 元素 } 声明一个列表'],
      invoke: builtinLen,
    },
  ],
]);

export function getBuiltin(name: string): BuiltinFn | undefined {
  return BUILTINS.get(name);
}
