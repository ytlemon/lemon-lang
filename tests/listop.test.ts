/**
 * 列表操作测试：编号槽 + 四个操作（add / del / file / clear）。
 *
 * 两套东西共用同一个词 `list(X)`：
 *   - `list(1)` 是**编号槽**（全局容器，用到就存在）
 *   - `list(分数)` 是**命名列表变量**（作用域与 int a = 1 相同）
 * 四个操作对两者写法完全一致，下面两边都覆盖。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Session, SourceFile, parseProgram } from '../src/index';
import { captureError, checkText, errorCodes, runText } from './support';

function program(body: string): string {
  return `__init__ {\n${body}\n}\n`;
}

/** 直接写在 main 里，省掉缩进噪音 */
function inMain(body: string): string {
  return program(`    main() {\n${body}\n    }`);
}

describe('列表操作：编号槽', () => {
  it('add list(1) 建槽，add[X] to list(1) 追加，say 能看到全部', () => {
    const out = runText(
      inMain('        add list(1)\n        add[90] to list(1)\n        add[85] to list(1)\n        say(list(1))'),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[90, 85]\n');
  });

  it('file list(1) 一行一个元素', () => {
    const out = runText(inMain('        list(1) { 90\n 85\n 78 }\n        file list(1)'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '90\n85\n78\n');
  });

  it('块式初始化编号槽，连最早的 list(name = 1) 写法也认', () => {
    const withName = runText(inMain('        list(name = 1) {\n            1\n            2\n            3\n        }\n        say(list(1))'));
    const plain = runText(inMain('        list(1) { 1\n 2\n 3 }\n        say(list(1))'));
    assert.equal(withName.ok, true, JSON.stringify(withName.diagnostics));
    assert.equal(withName.stdout, '[1, 2, 3]\n');
    assert.equal(plain.stdout, withName.stdout);
  });

  it('编号槽可以当值用：len / 下标 / 参与运算 / 链式下标', () => {
    const out = runText(
      inMain(
        '        list(1) { 10\n 20\n 30 }\n        say(len(list(1)))\n        say(list(1)[1])\n        say(list(1)[0] + 1)\n        say(list(1)[2] - list(1)[0])',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '3\n20\n11\n20\n');
  });

  it('编号槽是全局的：在函数里写，函数外照样读得到', () => {
    const out = runText(
      program('    def f() {\n        add[7] to list(5)\n    }\n\n    main() {\n        f()\n        file list(5)\n    }'),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '7\n');
  });

  it('同一个槽在两处指向同一个列表（引用语义）', () => {
    const out = runText(
      inMain('        add list(1)\n        add[1] to list(1)\n        add[2] to list(1)\n        list(1) { 9 }\n        say(len(list(1)))\n        add[8] to list(1)\n        say(list(1))'),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    // 第二次声明是**初始化**：内容被换成 [9]，而不是追加
    assert.equal(out.stdout, '1\n[9, 8]\n');
  });

  it('del[1] to list(1) 删掉第一个相等的元素', () => {
    const out = runText(inMain('        list(1) { 5\n 5\n 7 }\n        del[5] to list(1)\n        say(list(1))'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[5, 7]\n');
  });

  it('del 的相等判定与 == 一致：1 与 1.0 算相等', () => {
    const out = runText(inMain('        list(1) { 5\n 7 }\n        del[5.0] to list(1)\n        say(list(1))'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[7]\n');
  });

  it('clear list(1) 清空后还能继续加', () => {
    const out = runText(inMain('        list(1) { 1\n 2 }\n        clear list(1)\n        say(len(list(1)))\n        add[9] to list(1)\n        say(list(1))'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '0\n[9]\n');
  });

  it('空槽 file 不报错，也不输出任何东西', () => {
    const out = runText(inMain('        file list(9)\n        say("后面照常")'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '后面照常\n');
  });

  it('add[1] to list(1) 里两个 1 含义不同：一个是值，一个是槽号', () => {
    const out = runText(inMain('        add[1] to list(1)\n        add[1] to list(2)\n        say(list(1))\n        say(list(2))'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[1]\n[1]\n');
  });
});

describe('列表操作：del list(X) 删掉整个列表', () => {
  it('删掉编号槽，再引用是一个新的空槽', () => {
    const out = runText(
      inMain('        list(1) { 1\n 2 }\n        say(list(1))\n        del list(1)\n        say(len(list(1)))\n        add[9] to list(1)\n        say(list(1))'),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[1, 2]\n0\n[9]\n');
  });

  it('删一个本来就不存在的槽不报错（编号槽没有"未声明"状态）', () => {
    const out = runText(inMain('        del list(9)\n        say(len(list(9)))'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '0\n');
  });

  it('别处已经持有的那个列表不会被删掉（引用语义）', () => {
    const out = runText(
      inMain('        list(1) { 1\n 2 }\n        list(别名) { list(1) }\n        del list(1)\n        say(别名)\n        say(len(list(1)))'),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[[1, 2]]\n0\n');
  });

  it('命名列表不能整体删除，报 E0330 并指向 clear', () => {
    const result = checkText(inMain('        list(名单) { 小明 }\n        del list(名单)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0330']);
    assert.match(result.diagnostics[0].hint ?? '', /clear/);
  });

  it('编号槽在函数里删、函数外一样生效', () => {
    const out = runText(
      program(
        '    def 清掉() {\n        del list(1)\n    }\n\n    main() {\n        list(1) { 1\n 2 }\n        清掉()\n        say(len(list(1)))\n    }',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '0\n');
  });
});

describe('列表操作：命名列表', () => {
  it('四个操作作用在命名列表上，写法与编号槽一致', () => {
    const out = runText(
      inMain(
        '        list(名单) {\n            小明\n        }\n        add[小红] to list(名单)\n        file list(名单)\n        del[小明] to list(名单)\n        say(名单)\n        clear list(名单)\n        say(len(名单))',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '小明\n小红\n[小红]\n0\n');
  });

  it('list(名字) 与直接写 名字 是同一个东西', () => {
    const out = runText(inMain('        list(值) { 1\n 2 }\n        add[3] to list(值)\n        say(值)\n        say(len(list(值)))\n        say(list(值)[0])'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '[1, 2, 3]\n3\n1\n');
  });
});

describe('列表操作：错误场景', () => {
  it('del 找不到元素报 E0416，不静默跳过', () => {
    const out = runText(inMain('        list(1) { 90 }\n        del[99] to list(1)'));
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'E0416');
    assert.match(out.error?.message ?? '', /99/);
  });

  it('引用未声明的名字报 E0329', () => {
    const result = checkText(inMain('        say(list(未声明))'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0329']);
  });

  it('引用不是列表的变量报 E0329', () => {
    const result = checkText(inMain('        text 名字 = 你好\n        add[1] to list(名字)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0329']);
    assert.match(result.diagnostics[0].message, /不是列表/);
  });

  it('编号位置写 bool 字面量或小数报 E0205', () => {
    const boolErr = captureError(() =>
      parseProgram(new SourceFile('<test>', inMain('        say(list(true))'))),
    );
    assert.equal(boolErr.code, 'E0205');

    const doubleErr = captureError(() =>
      parseProgram(new SourceFile('<test>', inMain('        say(list(1.5))'))),
    );
    assert.equal(doubleErr.code, 'E0205');
  });

  it('add 少了 to 报 E0202 并给出正确写法', () => {
    const error = captureError(() =>
      parseProgram(new SourceFile('<test>', inMain('        add[1] list(1)'))),
    );
    assert.equal(error.code, 'E0202');
    assert.match(error.hint ?? '', /to list\(1\)/);
  });

  it('add 后面不是 list( 时报 E0202', () => {
    const error = captureError(() =>
      parseProgram(new SourceFile('<test>', inMain('        add[1] to 1'))),
    );
    assert.equal(error.code, 'E0202');
  });

  it('光秃秃的 list(1) 作语句报 E0304（它是个引用，不是调用）', () => {
    const result = checkText(inMain('        list(1)'));
    assert.deepEqual(errorCodes(result.diagnostics), ['E0304']);
  });
});

describe('列表操作：上下文关键字不误伤既有写法', () => {
  it('add / del / file / clear 仍可作普通变量名', () => {
    const out = runText(
      inMain(
        '        int add = 1\n        int del = 2\n        int file = 3\n        int clear = 4\n        say(add + del + file + clear)',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '10\n');
  });

  it('say 里写 file（文本）要加引号', () => {
    const out = runText(inMain('        say("file")'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, 'file\n');
  });

  it('list(x) 里的 x 是普通名字时不影响 list 作变量名', () => {
    const out = runText(inMain('        text list = 你好\n        say(list)'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '你好\n');
  });
});

describe('列表操作：REPL 里裸引用会回显', () => {
  it('敲 list(1) 直接回显内容', () => {
    let stdout = '';
    const session = new Session({ write: (text) => { stdout += text; } });
    session.execute(new SourceFile('<repl>', 'add list(1)'));
    session.execute(new SourceFile('<repl>', 'add[42] to list(1)'));
    session.execute(new SourceFile('<repl>', 'list(1)'));
    assert.equal(stdout, '[42]\n');
  });

  it('编号槽跨片段保持', () => {
    let stdout = '';
    const session = new Session({ write: (text) => { stdout += text; } });
    session.execute(new SourceFile('<repl>', 'add list(7)'));
    session.execute(new SourceFile('<repl>', 'add[1] to list(7)'));
    // 注意 len(...) 是函数调用，REPL 不会回显它的值——要看得用 say
    session.execute(new SourceFile('<repl>', 'say(len(list(7)))'));
    assert.equal(stdout, '1\n');
  });

  it('命名列表的声明也会进 REPL 符号表（否则下一片段会退化成裸文本）', () => {
    let stdout = '';
    const session = new Session({ write: (text) => { stdout += text; } });
    const declared = session.execute(new SourceFile('<repl>', 'list(值) { 1; 2 }'));
    assert.equal(declared.ok, true, JSON.stringify(declared.diagnostics));
    session.execute(new SourceFile('<repl>', 'say(值)'));
    assert.equal(stdout, '[1, 2]\n');
  });
});

describe('列表操作：语法树', () => {
  it('四种形态解析成不同的 ListOp', () => {
    const parsed = parseProgram(
      new SourceFile(
        '<test>',
        inMain('        add[1] to list(1)\n        del[2] to list(1)\n        del list(1)\n        file list(1)\n        clear list(1)'),
      ),
    );
    const main = parsed.main;
    assert.ok(main);
    const ops = main.body.map((s) => (s.kind === 'ListOp' ? s.op : s.kind));
    assert.deepEqual(ops, ['addElement', 'delElement', 'deleteList', 'file', 'clear']);
  });

  it('del list(X) 与 del[元素] to list(X) 是两种东西', () => {
    const out = runText(
      inMain(
        '        list(1) { 甲\n 乙 }\n        del[甲] to list(1)\n        say(list(1))\n\n        list(2) { 丙\n 丁 }\n        del list(2)\n        say(len(list(2)))',
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    // 前者只删一个元素（列表还在），后者删掉整个槽（再引用是个新的空槽）
    assert.equal(out.stdout, '[乙]\n0\n');
  });

  it('编号与名字解析成同一个 ListRef，靠 slot / name 区分', () => {
    const parsed = parseProgram(
      new SourceFile('<test>', inMain('        say(list(1))\n        say(list(分数))')),
    );
    const main = parsed.main;
    assert.ok(main);
    const refs = main.body
      .flatMap((s) => (s.kind === 'ExprStmt' && s.expr.kind === 'Call' ? s.expr.args : []))
      .filter((a) => a.kind === 'ListRef');
    assert.equal(refs.length, 2);
    const [slot, named] = refs;
    assert.equal(slot.kind === 'ListRef' ? slot.slot : null, 1);
    assert.equal(slot.kind === 'ListRef' ? slot.name : 'x', '');
    assert.equal(named.kind === 'ListRef' ? named.slot : 1, null);
    assert.equal(named.kind === 'ListRef' ? named.name : '', '分数');
  });
});
