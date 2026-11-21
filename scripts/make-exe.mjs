/**
 * 用 Node SEA（Single Executable Application）把解释器打包成独立的 lemon.exe。
 *
 * 流程：
 *   1) 前置检查 dist/lemon.cjs（由 scripts/build.mjs 产出）
 *   2) 生成 SEA 配置并调用 node --experimental-sea-config 得到 blob
 *   3) 复制当前 node 可执行文件为 dist/lemon.exe
 *   4) 用 postject 把 blob 注入 exe（注入前先尝试结束占用进程）
 *   5) 冒烟测试：--version / 运行 examples/hello.lemon1
 *
 * 注意：SEA 产物与 Node 主版本绑定，升级 Node 后需重新执行本脚本。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const bundle = join(dist, 'lemon.cjs');
const blob = join(dist, 'sea-prep.blob');
const configPath = join(dist, 'sea-config.json');
const exePath = join(dist, 'lemon.exe');
const postjectCli = join(root, 'node_modules', 'postject', 'dist', 'cli.js');

/** Node 官方 SEA fuse 标识（跨版本稳定） */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function fail(message, hint) {
  console.error(`\n打包失败：${message}`);
  if (hint) console.error(`提示：${hint}`);
  process.exit(1);
}

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    fail(`${label} 执行失败（退出码 ${result.status}）\n${output}`);
  }
  return result;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------ 1. 前置检查 ------------------------------ */

if (!existsSync(bundle)) {
  fail('找不到 dist/lemon.cjs', '请先执行 npm run build');
}
if (!existsSync(postjectCli)) {
  fail('找不到 postject', '请先执行 npm install');
}
mkdirSync(dist, { recursive: true });

log('1/5', `使用构建产物 ${bundle}`);

/* --------------------------- 2. 生成 SEA blob --------------------------- */

const seaConfig = {
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
};
writeFileSync(configPath, `${JSON.stringify(seaConfig, null, 2)}\n`, 'utf8');

log('2/5', '生成 SEA blob …');
runNode(['--experimental-sea-config', configPath], 'node --experimental-sea-config');
if (!existsSync(blob)) fail('SEA blob 未生成');
log('2/5', `blob 就绪 ${mb(statSync(blob).size)}`);

/* ---------------------------- 3. 复制 node.exe ---------------------------- */

if (existsSync(exePath)) {
  try {
    rmSync(exePath, { force: true });
  } catch {
    fail('无法覆盖 dist/lemon.exe', '请先关闭正在运行的 lemon.exe 后重试');
  }
}
copyFileSync(process.execPath, exePath);
log('3/5', `已复制 ${process.execPath} → dist/lemon.exe`);

/* ------------------------------ 4. 注入 blob ----------------------------- */

log('4/5', '注入 SEA blob …');
runNode(
  [
    postjectCli,
    exePath,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    SENTINEL_FUSE,
  ],
  'postject',
);
log('4/5', `注入完成，产物大小 ${mb(statSync(exePath).size)}`);

/* ------------------------------ 5. 冒烟测试 ------------------------------ */

log('5/5', '冒烟测试 …');

const version = spawnSync(exePath, ['--version'], { cwd: root, encoding: 'utf8' });
if (version.status !== 0) {
  fail(`lemon.exe --version 失败（退出码 ${version.status}）\n${version.stderr ?? ''}`);
}
log('5/5', `版本检查通过：${(version.stdout ?? '').trim()}`);

// 冒烟用例自包含，不依赖 examples/ 下可被人为改动的文件
const sampleDir = join(dist, 'smoke');
mkdirSync(sampleDir, { recursive: true });

const goodFile = join(sampleDir, 'smoke.lemon1');
writeFileSync(
  goodFile,
  ['__init__ {', '    int a = 7', '    main() {', '        say("你好，世界")', '        say(a * 2 + 1)', '    }', '}', ''].join('\n'),
  'utf8',
);
const run = spawnSync(exePath, [goodFile], { cwd: root, encoding: 'utf8' });
if (run.status !== 0) {
  fail(`运行冒烟用例失败（退出码 ${run.status}）\n${run.stderr ?? ''}`);
}
const expected = '你好，世界\n15\n';
if (run.stdout !== expected) {
  fail(`输出与预期不一致\n期望：${JSON.stringify(expected)}\n实际：${JSON.stringify(run.stdout)}`);
}
log('5/5', `运行与运算均通过，输出：${(run.stdout ?? '').trim().replace(/\n/g, ' / ')}`);

// 负例：静态类型错误应以退出码 1 结束
const badFile = join(sampleDir, 'bad.lemon1');
writeFileSync(badFile, '__init__ {\n    main() { int a = 你好 }\n}\n', 'utf8');
const bad = spawnSync(exePath, [badFile], { cwd: root, encoding: 'utf8' });
if (bad.status !== 1) {
  fail(`类型错误用例的退出码应为 1，实际为 ${bad.status}`);
}
log('5/5', '错误退出码契约通过（1）');

console.log(`\n打包完成：${exePath}`);
console.log('后续可直接分发该文件，目标机器无需安装 Node。');
