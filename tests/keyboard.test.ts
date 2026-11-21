/**
 * 键盘输入：键名规范化、终端解码、语言层集成与真实读取线程。
 *
 * 真实终端无法在自动化里模拟，因此这里分两层测：
 *  1) 纯函数层（normalizeKeyName / decodeKeys）直接单测；
 *  2) 语言层用**假键盘**注入，验证 keyboard / waitKey 的语义；
 *  3) 读取线程用子进程 + 管道驱动——它不要求 TTY，正好能在 CI 里跑通
 *     Worker + SharedArrayBuffer + Atomics 这条链路。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { KeyboardInterrupt, analyze, runSource } from '../src/index';
import { runText } from './support';
import { INTERRUPT_KEY, KEY_NAME_HINT, decodeKeys, normalizeKeyName } from '../src/lang/keys';
import { checkText, errorCodes, wrap } from './support';
import type { KeyboardInput } from '../src/lang/builtins';

/* ------------------------------------------------------------------ */
/* 键名规范化                                                          */
/* ------------------------------------------------------------------ */

describe('键名规范化', () => {
  it('单个字符按小写处理，w 与 W 是同一个键', () => {
    assert.equal(normalizeKeyName('w'), 'w');
    assert.equal(normalizeKeyName('W'), 'w');
    assert.equal(normalizeKeyName('1'), '1');
    assert.equal(normalizeKeyName('-'), '-');
  });

  it('空格与常用命名键', () => {
    assert.equal(normalizeKeyName(' '), 'space');
    assert.equal(normalizeKeyName('space'), 'space');
    assert.equal(normalizeKeyName('Space'), 'space');
    assert.equal(normalizeKeyName('ENTER'), 'enter');
    assert.equal(normalizeKeyName('esc'), 'esc');
    assert.equal(normalizeKeyName('up'), 'up');
    assert.equal(normalizeKeyName('backspace'), 'backspace');
  });

  it('接受几个中文键名', () => {
    assert.equal(normalizeKeyName('空格'), 'space');
    assert.equal(normalizeKeyName('回车'), 'enter');
    assert.equal(normalizeKeyName('上'), 'up');
    assert.equal(normalizeKeyName('左'), 'left');
  });

  it('不认识的键名返回 null', () => {
    assert.equal(normalizeKeyName('ww'), null);
    assert.equal(normalizeKeyName(''), null);
    assert.equal(normalizeKeyName('\n'), null);
    assert.equal(normalizeKeyName('控制'), null);
  });
});

/* ------------------------------------------------------------------ */
/* 终端字节解码                                                        */
/* ------------------------------------------------------------------ */

describe('终端按键解码', () => {
  it('普通字符、回车、退格、空格', () => {
    assert.deepEqual(decodeKeys('wab').keys, ['w', 'a', 'b']);
    assert.deepEqual(decodeKeys('\r').keys, ['enter']);
    assert.deepEqual(decodeKeys('\n').keys, ['enter']);
    assert.deepEqual(decodeKeys('\x7f').keys, ['backspace']);
    assert.deepEqual(decodeKeys('\t').keys, ['tab']);
    assert.deepEqual(decodeKeys(' ').keys, ['space']);
  });

  it('大写字母归一成小写，Ctrl+C 单独成键', () => {
    assert.deepEqual(decodeKeys('W').keys, ['w']);
    assert.deepEqual(decodeKeys('\x03').keys, [INTERRUPT_KEY]);
  });

  it('方向键等 CSI 序列', () => {
    assert.deepEqual(decodeKeys('\x1b[A').keys, ['up']);
    assert.deepEqual(decodeKeys('\x1b[B').keys, ['down']);
    assert.deepEqual(decodeKeys('\x1b[C').keys, ['right']);
    assert.deepEqual(decodeKeys('\x1b[D').keys, ['left']);
    // 应用模式下的 \x1bO 前缀同样认识
    assert.deepEqual(decodeKeys('\x1bOA').keys, ['up']);
  });

  it('裸 ESC 是 esc 键', () => {
    assert.deepEqual(decodeKeys('\x1bx').keys, ['esc', 'x']);
  });

  it('不完整的序列留到下一批（方向键可能被拆开到达）', () => {
    const first = decodeKeys('\x1b');
    assert.deepEqual(first.keys, []);
    assert.equal(first.rest, '\x1b');

    const second = decodeKeys(`${first.rest}[A`);
    assert.deepEqual(second.keys, ['up']);
    assert.equal(second.rest, '');
  });

  it('不产生按键的序列会被完整吃掉，不会漏成普通字符', () => {
    // Home 键（\x1b[H）不在支持列表里，但它后面的 A 不能当成字母 a
    const result = decodeKeys('\x1b[HA');
    assert.deepEqual(result.keys, ['a']);
  });

  it('其余控制字符忽略', () => {
    assert.deepEqual(decodeKeys('\x01\x02').keys, []);
  });
});

/* ------------------------------------------------------------------ */
/* 语言层：静态检查                                                    */
/* ------------------------------------------------------------------ */

describe('键盘 / 静态检查', () => {
  it('keyboard 返回 bool，可以当条件用', () => {
    assert.deepEqual(errorCodes(checkText(wrap('if keyboard(w) { say("按下") }')).diagnostics), []);
    assert.deepEqual(errorCodes(checkText(wrap('bool 按下 = keyboard(up)\nsay(按下)')).diagnostics), []);
  });

  it('键名字面量拼错时报错（E0321）', () => {
    const result = checkText(wrap('say(keyboard(ww))'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0321']);
    assert.match(result.diagnostics[0].message, /ww/);
    assert.match(result.diagnostics[0].hint ?? '', /可用键名/);
  });

  it('键名是变量或参数时不静态校验（值要到运行期才知道）', () => {
    assert.deepEqual(
      errorCodes(checkText(`__init__ {
    text 键 = w
    def f(键名) { say(keyboard(键名)) }
    main() { say(keyboard(键)) }
}`).diagnostics),
      [],
    );
  });

  it('waitKey 返回 unit：不能当条件，也不能存进变量', () => {
    assert.deepEqual(errorCodes(checkText(wrap('waitKey(space)')).diagnostics), []);
    assert.deepEqual(errorCodes(checkText(wrap('bool b = waitKey(space)')).diagnostics), ['E0307']);
    const asCondition = checkText(wrap('if waitKey(space) { say(1) }'));
    assert.deepEqual(errorCodes(asCondition.diagnostics), ['E0318']);
  });

  it('参数个数与类型都有检查', () => {
    assert.deepEqual(errorCodes(checkText(wrap('keyboard()')).diagnostics), ['E0310']);
    assert.deepEqual(errorCodes(checkText(wrap('keyboard(w, a)')).diagnostics), ['E0310']);
    assert.deepEqual(errorCodes(checkText(wrap('int n = 1\nkeyboard(n)')).diagnostics), ['E0307']);
  });

  it('keyboard 是内置名，不能被占用', () => {
    assert.deepEqual(errorCodes(checkText(wrap('int keyboard = 1')).diagnostics), ['E0306']);
    assert.deepEqual(
      errorCodes(checkText('__init__ {\n    def keyboard(k) { say(k) }\n    main() { say(1) }\n}').diagnostics),
      ['E0306'],
    );
  });

  it('写成 True / False 时提示小写写法（E0322）', () => {
    const result = checkText(wrap('say(keyboard(w) == True)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0322']);
    assert.match(result.diagnostics[0].hint ?? '', /全小写/);

    // 只报一条：不再补 "bool 与 text 不能比较"
    assert.equal(result.diagnostics.length, 1);
  });

  it('自己声明了 True 就不算错（只是不推荐）', () => {
    assert.deepEqual(errorCodes(checkText(wrap('bool True = true\nif keyboard(w) == True { say(1) }')).diagnostics), []);
  });
});

/* ------------------------------------------------------------------ */
/* 语言层：求值（用假键盘注入）                                        */
/* ------------------------------------------------------------------ */

/** 记录调用参数的假键盘：想什么时候按下就什么时候按下 */
function fakeKeyboard(): KeyboardInput & {
  press(key: string): void;
  hold(key: string): void;
  taken: string[];
  waited: string[];
} {
  const pending = new Set<string>();
  const taken: string[] = [];
  const waited: string[] = [];
  return {
    taken,
    waited,
    press(key: string): void {
      pending.add(key);
    },
    /** 预留：让 wait 立刻返回 */
    hold(key: string): void {
      pending.add(key);
    },
    take(name: string): boolean {
      taken.push(name);
      if (!pending.has(name)) return false;
      pending.delete(name);
      return true;
    },
    wait(name: string): void {
      waited.push(name);
      pending.delete(name);
    },
  };
}

function runWith(
  text: string,
  keyboard?: KeyboardInput,
): { stdout: string; ok: boolean; codes: string[] } {
  let stdout = '';
  const result = runSource('<test>', text, { write: (chunk) => (stdout += chunk), keyboard });
  return {
    stdout,
    ok: result.ok,
    codes: result.diagnostics.map((d) => d.code),
  };
}

describe('键盘 / 求值', () => {
  it('keyboard(键) 把规范化的键名交给键盘层，并把结果当 bool 用', () => {
    const keyboard = fakeKeyboard();
    keyboard.press('w');

    const first = runWith('__init__ {\n    main() {\n        if keyboard(W) { say("按下") } else { say("没按") }\n    }\n}', keyboard);
    assert.equal(first.ok, true);
    assert.equal(first.stdout, '按下\n');
    // 大写 W 与 w 是同一个键
    assert.deepEqual(keyboard.taken, ['w']);

    const second = runWith('__init__ {\n    main() {\n        if keyboard(w) { say("按下") } else { say("没按") }\n    }\n}', keyboard);
    assert.equal(second.stdout, '没按\n');
  });

  it('一次按下只算一次：读取后清零', () => {
    const keyboard = fakeKeyboard();
    keyboard.press('space');
    const out = runWith(
      `__init__ {
    main() {
        say(keyboard(space))
        say(keyboard(space))
    }
}`,
      keyboard,
    );
    assert.equal(out.stdout, 'true\nfalse\n');
  });

  it('waitKey 阻塞等待并返回 unit', () => {
    const keyboard = fakeKeyboard();
    keyboard.hold('enter');
    const out = runWith('__init__ {\n    main() {\n        waitKey(enter)\n        say("继续")\n    }\n}', keyboard);
    assert.equal(out.ok, true);
    assert.equal(out.stdout, '继续\n');
    assert.deepEqual(keyboard.waited, ['enter']);
  });

  it('锁存语义：读取之前重复按同一个键只算一次', () => {
    const keyboard = fakeKeyboard();
    keyboard.press('w');
    keyboard.press('w');
    keyboard.press('w');
    const out = runWith(
      `__init__ {
    main() {
        cycle(3) {
            say(keyboard(w))
        }
    }
}`,
      keyboard,
    );
    // 这是"按过就算"的锁存，不是计数：连续三次按下在第一次读取时合成一个 true
    assert.equal(out.stdout, 'true\nfalse\nfalse\n');
  });

  it('不同键各自独立：读 w 不影响 a 的待读状态', () => {
    const keyboard = fakeKeyboard();
    keyboard.press('w');
    keyboard.press('a');
    const out = runWith(
      `__init__ {
    main() {
        say(keyboard(w))
        say(keyboard(a))
        say(keyboard(w))
    }
}`,
      keyboard,
    );
    assert.equal(out.stdout, 'true\ntrue\nfalse\n');
  });

  it('没有接入键盘时给出明确错误（E0410），不是静默返回 false', () => {
    const out = runWith('__init__ {\n    main() {\n        say(keyboard(w))\n    }\n}');
    assert.equal(out.ok, false);
    assert.deepEqual(out.codes, ['E0410']);
    assert.equal(out.stdout, '');
  });

  it('键名不认识时在运行期报错（传变量绕过了静态检查）', () => {
    const keyboard = fakeKeyboard();
    const out = runWith(`__init__ {
    text 键 = ww
    main() { say(keyboard(键)) }
}`, keyboard);
    assert.equal(out.ok, false);
    assert.deepEqual(out.codes, ['E0321']);
  });
});

/* ------------------------------------------------------------------ */
/* sleep 与 Ctrl+C                                                     */
/* ------------------------------------------------------------------ */

describe('sleep / 中断', () => {
  it('sleep 期间收到 Ctrl+C 会立刻停下，不会傻等', () => {
    const interrupt = new KeyboardInterrupt();
    let checks = 0;
    const keyboard: KeyboardInput = {
      take: () => false,
      wait: () => undefined,
      checkInterrupt: () => {
        checks += 1;
        throw interrupt;
      },
    };

    let caught: unknown = null;
    const started = Date.now();
    try {
      runSource('<test>', '__init__ {\n    main() {\n        sleep(1)\n    }\n}', {
        write: () => undefined,
        keyboard,
      });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;

    assert.equal(caught, interrupt, '中断信号必须原样抛出，不能被当成语言错误吞掉');
    assert.ok(checks >= 1);
    assert.ok(elapsed < 500, `没有及时中断：${elapsed}ms`);
  });

  it('没有接入键盘时 sleep 照常工作（不会去碰终端）', () => {
    const started = Date.now();
    const out = runText('__init__ {\n    main() {\n        sleep(0.03)\n        say("好")\n    }\n}');
    assert.equal(out.stdout, '好\n');
    assert.ok(Date.now() - started >= 20);
  });
});

/* ------------------------------------------------------------------ */
/* 真实读取线程（子进程 + 管道驱动）                                    */
/* ------------------------------------------------------------------ */

const PROBE = `
const { createTerminalKeyboard, KeyboardInterrupt } = require(${JSON.stringify(
  path.join(__dirname, '..', 'src', 'utils', 'keyboard.js'),
)});
const span = { line: 1, col: 1, endLine: 1, endCol: 1, start: 0, end: 0 };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const kb = createTerminalKeyboard({ requireTty: false });
const mode = process.argv[2];

if (mode === 'poll') {
  let seen = false;
  for (let i = 0; i < 200 && !seen; i += 1) {
    seen = kb.take('w', span);
    if (!seen) sleep(5);
  }
  console.log('take(w)=' + seen);
  console.log('take(w)2=' + kb.take('w', span));
  console.log('take(a)=' + kb.take('a', span));
  const started = Date.now();
  kb.wait('q', span);
  console.log('wait(q)=' + (Date.now() - started < 2000));
  console.log('take(up)=' + kb.take('up', span));
} else if (mode === 'eof') {
  try {
    kb.wait('q', span);
    console.log('no-error');
  } catch (error) {
    console.log('error=' + error.code);
  }
} else if (mode === 'interrupt') {
  let caught = false;
  for (let i = 0; i < 200 && !caught; i += 1) {
    try {
      kb.take('w', span);
    } catch (error) {
      caught = error instanceof KeyboardInterrupt;
      break;
    }
    sleep(5);
  }
  console.log('interrupt=' + caught);
}

kb.close();
`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-keyboard-'));
const probeFile = path.join(tmpDir, 'probe.cjs');
fs.writeFileSync(probeFile, PROBE, 'utf8');

function runProbe(mode: string, input: string): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [probeFile, mode], {
    input,
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: result.status, stdout: result.stdout };
}

describe('终端键盘读取线程', () => {
  it('管道输入能驱动 take / wait，方向键序列也能解出来', () => {
    // w 之后紧跟方向键序列，最后是 q
    const { status, stdout } = runProbe('poll', 'w\x1b[Aq');
    assert.equal(status, 0, stdout);
    assert.match(stdout, /take\(w\)=true/);
    assert.match(stdout, /take\(w\)2=false/);
    assert.match(stdout, /take\(a\)=false/);
    assert.match(stdout, /wait\(q\)=true/);
    assert.match(stdout, /take\(up\)=true/);
  });

  it('输入被关闭后再等待会报 E0411，而不是永久卡住', () => {
    const { status, stdout } = runProbe('eof', '');
    assert.equal(status, 0, stdout);
    assert.match(stdout, /error=E0411/);
  });

  it('Ctrl+C 字节会转成中断信号', () => {
    const { status, stdout } = runProbe('interrupt', '\x03');
    assert.equal(status, 0, stdout);
    assert.match(stdout, /interrupt=true/);
  });
});

/* ------------------------------------------------------------------ */
/* 提示文本                                                            */
/* ------------------------------------------------------------------ */

describe('键盘 / 提示文本', () => {
  it('可用键名提示里列出了命名键', () => {
    assert.match(KEY_NAME_HINT, /space/);
    assert.match(KEY_NAME_HINT, /backspace/);
  });

  it('lemon check 能独立发现键名拼写错误（不执行也能查出来）', () => {
    const analysis = analyze('<test>', '__init__ {\n    main() {\n        say(keyboard(ww))\n    }\n}');
    assert.deepEqual(
      analysis.diagnostics.map((d) => d.code),
      ['E0321'],
    );
  });
});
