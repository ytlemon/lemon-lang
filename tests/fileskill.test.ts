/**
 * fileskill 测试：cd / running / delete。
 *
 * 这三条语句会**真的碰磁盘**（删文件、跑程序），所以涉及执行的用例都在临时目录里跑，
 * 并且顺带验证"逃不出 cd 目录"的保护。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { checkFiles, checkText, errorCodes, runFiles, wrap } from './support';

const HEADER = '#incloud fileskill\n';

/** 带 fileskill 模块的最小程序 */
function program(body: string): string {
  return `${HEADER}\n__init__ {\n    main() {\n${body}\n    }\n}\n`;
}

/** 把一个绝对路径翻成 Lemon 字符串里能直接用的形式（反斜杠在字符串里是转义符） */
function lemonPath(path: string): string {
  return path.replace(/\\/g, '/');
}

let root = '';
const isWindows = process.platform === 'win32';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'lemon-fileskill-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fileskill：需要 #incloud 与 cd 作用域', () => {
  it('没启用模块：E0345', () => {
    const out = checkText(wrap('cd "./" { delete "a.txt" }'));
    assert.deepEqual(errorCodes(out.diagnostics), ['E0345']);
    assert.match(out.diagnostics[0].hint ?? '', /#incloud fileskill/);
  });

  it('running 不在 cd 里：E0346', () => {
    const out = checkFiles('app.lemon1', { 'app.lemon1': program('        running "a.bat"') });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0346']);
    assert.match(out.diagnostics[0].message, /running 只能写在 cd 块里/);
  });

  it('delete 不在 cd 里：E0346', () => {
    const out = checkFiles('app.lemon1', { 'app.lemon1': program('        delete "a.txt"') });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0346']);
  });

  it('cd 的目录不是文本：E0347', () => {
    const out = checkFiles('app.lemon1', { 'app.lemon1': program('        cd 123 { }') });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0347']);
    assert.match(out.diagnostics[0].message, /cd 的目录必须是文本/);
  });

  it('delete 的文件名不是文本：E0347', () => {
    const out = checkFiles('app.lemon1', { 'app.lemon1': program('        cd "x" { delete 123 }') });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0347']);
  });
});

describe('fileskill：delete', () => {
  it('删掉 cd 目录里的文件', () => {
    const dir = mkdtempSync(join(root, 'del-'));
    const victim = join(dir, 'to-delete.txt');
    writeFileSync(victim, '内容', 'utf8');

    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`        cd "${lemonPath(dir)}" {\n            delete "to-delete.txt"\n        }`),
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(existsSync(victim), false);
  });

  it('文件不存在：E0419', () => {
    const dir = mkdtempSync(join(root, 'del-missing-'));
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`        cd "${lemonPath(dir)}" {\n            delete "nope.txt"\n        }`),
    });
    assert.equal(out.ok, false);
    assert.deepEqual(errorCodes(out.diagnostics), ['E0419']);
  });

  it('目标是文件夹：E0419（防误删）', () => {
    const dir = mkdtempSync(join(root, 'del-dir-'));
    mkdirSync(join(dir, '子目录'));
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`        cd "${lemonPath(dir)}" {\n            delete "子目录"\n        }`),
    });
    assert.equal(out.ok, false);
    assert.deepEqual(errorCodes(out.diagnostics), ['E0419']);
    assert.match(out.diagnostics[0].message, /不能删文件夹/);
  });

  it('不能用 .. 逃出 cd 目录：E0420，且目标仍在', () => {
    const dir = mkdtempSync(join(root, 'escape-'));
    const outside = join(root, `outside-${Date.now()}.txt`);
    writeFileSync(outside, '别删我', 'utf8');

    const out = runFiles('app.lemon1', {
      'app.lemon1': program(
        `        cd "${lemonPath(dir)}" {\n            delete "${lemonPath(outside)}"\n        }`,
      ),
    });
    assert.equal(out.ok, false);
    assert.deepEqual(errorCodes(out.diagnostics), ['E0420']);
    assert.equal(existsSync(outside), true);
    rmSync(outside, { force: true });
  });
});

describe('fileskill：cd', () => {
  it('目录不存在：E0417', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`        cd "${lemonPath(join(root, '根本没有这个目录'))}" {\n            delete "x.txt"\n        }`),
    });
    assert.equal(out.ok, false);
    assert.deepEqual(errorCodes(out.diagnostics), ['E0417']);
  });

  it('退出 cd 块后目录不再生效：块外 delete 报 E0346（静态拦下）', () => {
    const dir = mkdtempSync(join(root, 'scope-'));
    const out = checkFiles('app.lemon1', {
      'app.lemon1': program(
        `        cd "${lemonPath(dir)}" {\n            delete "a.txt"\n        }\n        delete "b.txt"`,
      ),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0346']);
  });
});

describe('fileskill：running', () => {
  it('文件不存在：E0418', () => {
    const dir = mkdtempSync(join(root, 'run-missing-'));
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`        cd "${lemonPath(dir)}" {\n            running "nope.bat"\n        }`),
    });
    assert.equal(out.ok, false);
    assert.deepEqual(errorCodes(out.diagnostics), ['E0418']);
  });

  it('能运行 cd 目录里的 .bat 并转发它的输出', { skip: !isWindows }, () => {
    const dir = mkdtempSync(join(root, 'run-'));
    writeFileSync(join(dir, 'hello.bat'), '@echo off\r\necho hello-from-bat\r\n', 'utf8');

    const out = runFiles('app.lemon1', {
      'app.lemon1': program(
        `        cd "${lemonPath(dir)}" {\n            running "hello.bat"\n        }\n        say("跑完了")`,
      ),
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.match(out.stdout, /hello-from-bat/);
    assert.match(out.stdout, /跑完了/);
  });

  it('能运行 cd 目录里的 .lemon2（由内置 lemonmod 解释器执行）', () => {
    const dir = mkdtempSync(join(root, 'run2-'));
    writeFileSync(
      join(dir, 'mod.lemon2'),
      'set mod public{\n    class public{\n        printf("hi-from-lemon2")\n    }\n}\n',
      'utf8',
    );

    const out = runFiles('app.lemon1', {
      'app.lemon1': program(
        `        cd "${lemonPath(dir)}" {\n            running "mod.lemon2"\n        }\n        say("跑完了")`,
      ),
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.match(out.stdout, /hi-from-lemon2/);
    assert.match(out.stdout, /跑完了/);
  });
});
