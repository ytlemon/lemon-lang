/**
 * 把 websets() / game() 生成的自包含 HTML 打包成独立 .exe。
 *
 * 由 CLI 在 `buildexe = 文件名` 声明下自动调用：
 *   node scripts/bundle-html-exe.mjs <html文件> <输出exe> [窗口标题]
 *
 * 流程与 scripts/make-exe.mjs 一致（esbuild → Node SEA blob → postject 注入），
 * 区别是被打包的不是 Lemon 解释器，而是一个内嵌该 HTML 的启动器：
 * 双击 exe → 把 HTML 释放到临时目录 → 用系统默认浏览器打开界面。
 *
 * 注意：SEA 产物与 Node 主版本绑定；升级 Node 后需要重新打包。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [htmlArg, exeArg, titleArg] = process.argv.slice(2);

function fail(message, hint) {
  console.error(`[buildexe] 打包失败：${message}`);
  if (hint) console.error(`[buildexe] 提示：${hint}`);
  process.exit(1);
}

if (!htmlArg || !exeArg) {
  fail('缺少参数', '用法：node scripts/bundle-html-exe.mjs <html文件> <输出exe> [标题]');
}

const htmlPath = resolve(htmlArg);
const exePath = resolve(exeArg);
const title = titleArg || 'Lemon 应用';
const postjectCli = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

if (!existsSync(htmlPath)) fail(`找不到 HTML：${htmlPath}`);
if (!existsSync(postjectCli)) fail('找不到 postject', '请先在项目根目录执行 npm install');

const html = readFileSync(htmlPath, 'utf8');
const workDir = join(root, 'dist', 'exe-build');
const safeName = title.replace(/[^\w\u4e00-\u9fff-]/g, '_') || 'lemon-app';
const bundle = join(workDir, `${safeName}.bundle.cjs`);
const blob = join(workDir, `${safeName}.blob`);
const configPath = join(workDir, `${safeName}.sea-config.json`);
mkdirSync(workDir, { recursive: true });

/* ------------------------- 1. 生成内嵌 HTML 的启动器 ------------------------- */

const launcher = `'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exec } = require('node:child_process');

const HTML = ${JSON.stringify(html)};
const TITLE = ${JSON.stringify(title)};

if (process.argv.includes('--version')) {
  process.stdout.write('lemon-webapp 1.0\\n');
} else {
  const safe = TITLE.replace(/[^\\w\\u4e00-\\u9fff-]/g, '_') || 'lemon-app';
  const tmp = path.join(os.tmpdir(), 'lemon-' + process.pid + '-' + safe + '.html');
  fs.writeFileSync(tmp, HTML, 'utf8');
  const quoted = '"' + tmp + '"';
  const cmd = process.platform === 'win32'
    ? 'start "" ' + quoted
    : (process.platform === 'darwin' ? 'open ' + quoted : 'xdg-open ' + quoted);
  exec(cmd, function () {});
  process.stdout.write('已启动 ' + TITLE + '\\n');
}
`;

await build({
  stdin: { contents: launcher, resolveDir: root, sourcefile: 'lemon-webapp-launcher.cjs', loader: 'js' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  charset: 'utf8',
  outfile: bundle,
});

/* ------------------------------ 2. SEA blob ------------------------------ */

writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const sea = spawnSync(process.execPath, ['--experimental-sea-config', configPath], { cwd: root, encoding: 'utf8' });
if (sea.status !== 0) {
  fail(`生成 SEA blob 失败（退出码 ${sea.status}）\n${sea.stderr ?? ''}`);
}
if (!existsSync(blob)) fail('SEA blob 未生成');

/* --------------------------- 3. 复制宿主 + 注入 --------------------------- */

if (existsSync(exePath)) {
  try {
    rmSync(exePath, { force: true });
  } catch {
    fail(`无法覆盖 ${exePath}`, '请先关闭正在运行的同名 exe 后重试');
  }
}
mkdirSync(dirname(exePath), { recursive: true });
copyFileSync(process.execPath, exePath);

const inject = spawnSync(
  process.execPath,
  [postjectCli, exePath, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SENTINEL_FUSE],
  { cwd: root, encoding: 'utf8' },
);
if (inject.status !== 0) {
  fail(`注入 SEA blob 失败（退出码 ${inject.status}）\n${inject.stderr ?? ''}`);
}

/* ------------------------------- 4. 冒烟 ------------------------------- */

const smoke = spawnSync(exePath, ['--version'], { cwd: root, encoding: 'utf8' });
if (smoke.status !== 0 || !String(smoke.stdout ?? '').includes('lemon-webapp')) {
  fail(`冒烟测试失败（退出码 ${smoke.status}）\n${smoke.stdout ?? ''}${smoke.stderr ?? ''}`);
}

console.log(`[buildexe] 已生成 ${exePath}（${(statSync(exePath).size / 1024 / 1024).toFixed(1)} MB）`);
