/**
 * 终端键盘输入。
 *
 * 为什么需要 Worker + SharedArrayBuffer：
 *  求值器是**同步**的，`cycle()` 这种紧循环不会让出事件循环，因此异步的 stdin
 *  'data' 事件永远不会被处理——用事件回调实现的"非阻塞查询"在紧循环里会永远
 *  拿到 false。这里让一个 Worker 线程用阻塞式 readSync 读 fd 0，把字节写进
 *  SAB，主线程则用 Atomics 轮询（不等）或 Atomics.wait 小睡（等待按键）。
 *
 * 终端限制：拿不到 keyup，所以模型是"按过就算"，读取后清零。
 * raw 模式下 Ctrl+C 不会产生 SIGINT，而是送来 \x03——解成 INTERRUPT_KEY，
 * 由上层转成中断退出，因此用户仍然可以用 Ctrl+C 停下无限循环。
 */
import { Worker } from 'node:worker_threads';

import { INTERRUPT_KEY, decodeKeys } from '../lang/keys';
import { ErrorCodes, LemonError, wholeFileSpan } from '../lang/errors';
import type { Span } from './source';

/* SAB 布局（Int32） */
const TAIL = 0; // 主线程的读取位置
const HEAD = 1; // Worker 的写入位置
const EOF_CELL = 2; // Worker 读到文件尾时置 1
const SLEEP_CELL = 3; // 永不写入，仅用于 Atomics.wait 小睡
const SLOTS = 4; // 环形缓冲起点
const RING_CAPACITY = 4096;
const SLEEP_MS = 8;

/** Ctrl+C 中断（不是语言错误，由 CLI 转成 130 退出码） */
export class KeyboardInterrupt extends Error {
  constructor() {
    super('用户中断（Ctrl+C）');
    this.name = 'KeyboardInterrupt';
  }
}

export interface KeyboardSource {
  /** 这个键自上次读取之后是否被按过；读取后清零 */
  take(name: string, span: Span): boolean;
  /** 阻塞等待这个键被按下 */
  wait(name: string, span: Span): void;
  /** 只检查有没有收到 Ctrl+C（不读按键）；sleep 用它让长睡眠也能被中断 */
  checkInterrupt(): void;
  /** 恢复终端状态并结束读取线程 */
  close(): void;
}

export interface KeyboardOptions {
  /**
   * 是否要求 stdin 是真实终端。
   * CLI 用 true（管道里拒绝启动）；测试用 false，好让管道也能驱动键盘。
   */
  requireTty?: boolean;
  /** 创建失败（如不是终端）时诊断指向的位置——由调用点传入，指向真正的那行代码 */
  span?: Span;
}

/**
 * Worker 源码（内联字符串：单文件 exe 里没有可供 require 的脚本文件）。
 * 只做一件事：把 fd 0 的字节搬进环形缓冲。
 */
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const i32 = new Int32Array(workerData.sab);
const CAP = workerData.capacity;
const HEAD = workerData.head;
const TAIL = workerData.tail;
const EOF = workerData.eof;
const SLOTS = workerData.slots;
const buf = Buffer.allocUnsafe(1024);

for (;;) {
  let n = 0;
  try {
    n = fs.readSync(0, buf, 0, buf.length, null);
  } catch (error) {
    n = 0;
  }
  if (n <= 0) {
    Atomics.store(i32, EOF, 1);
    break;
  }
  for (let k = 0; k < n; k += 1) {
    const head = Atomics.load(i32, HEAD);
    const tail = Atomics.load(i32, TAIL);
    if (head - tail >= CAP) break; // 环满：丢弃多余的按键
    Atomics.store(i32, SLOTS + (head % CAP), buf[k]);
    Atomics.store(i32, HEAD, head + 1);
  }
}
`;

/** 惰性创建：程序不使用 keyboard 就完全不碰终端 */
export function createLazyKeyboard(options: KeyboardOptions = {}): KeyboardSource {
  let source: KeyboardSource | null = null;
  const get = (span: Span): KeyboardSource => {
    if (source === null) source = createTerminalKeyboard({ ...options, span });
    return source;
  };
  return {
    take: (name, span) => get(span).take(name, span),
    wait: (name, span) => get(span).wait(name, span),
    // 刻意不惰性创建：只是睡个觉不该让终端进入 raw 模式
    checkInterrupt: () => {
      if (source !== null) source.checkInterrupt();
    },
    close: () => {
      if (source !== null) source.close();
    },
  };
}

export function createTerminalKeyboard(options: KeyboardOptions = {}): KeyboardSource {
  const requireTty = options.requireTty !== false;
  const stdin = process.stdin;

  if (requireTty && stdin.isTTY !== true) {
    throw new LemonError({
      code: ErrorCodes.KEYBOARD_UNAVAILABLE,
      phase: 'runtime',
      message: 'keyboard / waitKey 需要真实终端键盘，当前标准输入不是终端',
      span: options.span ?? wholeFileSpan(),
      hint: '管道输入、重定向、编辑器里运行都无法判定键盘；请在终端里执行 lemon run 文件.lemon1',
    });
  }

  const sab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (SLOTS + RING_CAPACITY));
  const i32 = new Int32Array(sab);

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { sab, capacity: RING_CAPACITY, head: HEAD, tail: TAIL, eof: EOF_CELL, slots: SLOTS },
  });
  worker.unref(); // 不让读取线程阻止进程退出

  const restore = (): void => {
    try {
      if (stdin.isTTY === true) stdin.setRawMode(false);
    } catch {
      /* 终端已关闭时忽略 */
    }
  };

  if (stdin.isTTY === true) stdin.setRawMode(true);
  process.once('exit', restore);

  const pending = new Set<string>();
  let buffer = '';
  let interrupted = false;
  let closed = false;

  /** 把环形缓冲里的字节搬过来，解成键名放进 pending */
  const drain = (): void => {
    for (;;) {
      const tail = Atomics.load(i32, TAIL);
      const head = Atomics.load(i32, HEAD);
      if (tail >= head) break;
      const byte = Atomics.load(i32, SLOTS + (tail % RING_CAPACITY));
      Atomics.store(i32, TAIL, tail + 1);
      buffer += String.fromCharCode(byte);
    }

    if (buffer.length === 0) return;
    const decoded = decodeKeys(buffer);
    buffer = decoded.rest;
    for (const key of decoded.keys) {
      if (key === INTERRUPT_KEY) {
        interrupted = true;
        continue;
      }
      pending.add(key);
    }
  };

  const checkInterrupt = (): void => {
    if (interrupted) {
      restore();
      throw new KeyboardInterrupt();
    }
  };

  const eofReached = (): boolean => Atomics.load(i32, EOF_CELL) === 1;

  const source: KeyboardSource = {
    take(name: string, span: Span): boolean {
      drain();
      checkInterrupt();
      if (!pending.has(name)) return false;
      pending.delete(name);
      return true;
    },

    wait(name: string, span: Span): void {
      for (;;) {
        drain();
        checkInterrupt();
        if (pending.has(name)) {
          pending.delete(name);
          return;
        }
        if (eofReached()) {
          restore();
          throw new LemonError({
            code: ErrorCodes.INPUT_ENDED,
            phase: 'runtime',
            message: `标准输入已结束，等不到按键 ${name}`,
            span,
            hint: '输入被关闭（Ctrl+D 或管道结束）后无法继续等待；请检查输入来源',
          });
        }
        // 小睡一会儿再查：主线程同步阻塞，Worker 在另一个线程继续收字节
        Atomics.wait(i32, SLEEP_CELL, 0, SLEEP_MS);
      }
    },

    checkInterrupt(): void {
      drain();
      checkInterrupt();
    },

    close(): void {
      if (closed) return;
      closed = true;
      restore();
      void worker.terminate();
    },
  };

  return source;
}
