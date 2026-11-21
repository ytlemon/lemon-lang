/**
 * 分发产物端到端测试：以真实进程驱动构建产物，覆盖编辑器插件所依赖的
 * `check --json --stdin` 通道、程序输出与退出码契约。
 *
 * 产物不存在或比源码旧时自动跳过（执行 `npm run exe` 即可刷新并启用）。
 * 刻意不使用 examples/ 下的文件——那是给人改动的地方，测试必须自包含。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const root = path.join(__dirname, '..', '..');
const exePath = path.join(root, 'dist', 'lemon.exe');
const cjsPath = path.join(root, 'dist', 'lemon.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-dist-'));
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SAMPLE = [
  '__init__ {',
  '    int a = 7',
  '    int zero = 1 - 1',
  '',
  '    main() {',
  '        say("你好，世界")',
  '        say(a * 2)',
  '        say(1 + 2 * 3)',
  '        say(-a)',
  '        try {',
  '            say(a / zero)',
  '        } catch (错误) {',
  '            say(错误.code)',
  '        }',
  '    }',
  '}',
  '',
].join('\n');
const SAMPLE_OUTPUT = '你好，世界\n14\n7\n-7\nE0405\n';

const sampleFile = path.join(tmpDir, 'sample.lemon1');
fs.writeFileSync(sampleFile, SAMPLE, 'utf8');

interface Target {
  label: string;
  command: string;
  args: string[];
  artifact: string;
  available: boolean;
}

/** 产物比 src/ 下的任何文件都旧，说明需要重新打包 */
function isStale(artifact: string): boolean {
  if (!fs.existsSync(artifact)) return true;
  const artifactTime = fs.statSync(artifact).mtimeMs;

  let newest = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  if (fs.existsSync(path.join(root, 'src'))) walk(path.join(root, 'src'));

  return artifactTime < newest;
}

const targets: Target[] = [
  { label: 'lemon.exe', command: exePath, args: [], artifact: exePath, available: false },
  { label: 'dist/lemon.cjs', command: process.execPath, args: [cjsPath], artifact: cjsPath, available: false },
].map((target) => ({
  ...target,
  available: fs.existsSync(target.artifact) && !isStale(target.artifact),
}));

describe('分发产物前置检查', () => {
  it('产物缺失或过期时给出可操作的提示', () => {
    const unavailable = targets.filter((t) => !t.available).map((t) => t.label);
    if (unavailable.length > 0) {
      console.log(`[跳过] ${unavailable.join('、')} 缺失或比源码旧，请执行 npm run exe 后重跑测试。`);
    }
    assert.ok(true);
  });
});

for (const target of targets) {
  const describeTarget = target.available ? describe : describe.skip;

  describeTarget(`分发产物 / ${target.label}`, () => {
    const invoke = (args: string[], input?: string) =>
      spawnSync(target.command, [...target.args, ...args], { input, encoding: 'utf8' });

    it('check --json --stdin 返回可解析的诊断（编辑器插件链路）', () => {
      const source = '__init__ {\n    main() {\n        int a = 你好\n    }\n}\n';
      const result = invoke(['check', '--json', '--stdin', 'demo.lemon1'], source);
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout) as {
        ok: boolean;
        diagnostics: Array<{ code: string; line: number; col: number; hint?: string }>;
      };
      assert.equal(report.ok, false);
      assert.equal(report.diagnostics.length, 1);
      assert.equal(report.diagnostics[0].code, 'E0307');
      assert.equal(report.diagnostics[0].line, 3);
      assert.ok(typeof report.diagnostics[0].hint === 'string');
    });

    it('check --json --stdin 对合法源码返回 ok:true', () => {
      const result = invoke(['check', '--json', '--stdin', 'demo.lemon1'], SAMPLE);
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, diagnostics: [] });
    });

    it('运行脚本：中文、裸文本与基础运算都正确', () => {
      const result = invoke([sampleFile]);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, SAMPLE_OUTPUT);
    });

    it('退出码契约：语言错误 1、用法错误 2、成功 0', () => {
      assert.equal(invoke(['--bogus']).status, 2);
      assert.equal(invoke(['--version']).status, 0);
      assert.equal(invoke([path.join(tmpDir, 'missing.lemon1')]).status, 2);

      const badFile = path.join(tmpDir, 'bad.lemon1');
      fs.writeFileSync(badFile, '__init__ {\n    main() { int a = 你好 }\n}\n', 'utf8');
      assert.equal(invoke([badFile]).status, 1);
    });
  });
}
