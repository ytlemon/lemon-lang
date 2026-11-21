/**
 * 打一个可以直接拷到别的电脑上双击安装的发布包。
 *
 * 产物：
 *   dist/lemon-<版本>/          解包目录（可以直接整个文件夹拖过去）
 *   dist/lemon-<版本>-安装包.zip 同样的内容压成一个文件（远程传输更方便）
 *
 * 只负责"组装"，不负责"编译"：解释器与扩展必须先生成好。
 * 但会检查它们是不是比源码旧 —— 这正是最容易踩的坑：
 * 源码改了、忘了重新打包，拷过去的还是旧行为。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const installerDir = join(root, 'tools', 'installer');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const bundleDir = join(dist, `lemon-${version}`);
const zipPath = join(dist, `lemon-${version}-安装包.zip`);

const exe = join(dist, 'lemon.exe');
const vsix = join(root, 'vscode-lemon', 'lemon-language.vsix');

function fail(message, hint) {
  console.error(`\n打包失败：${message}`);
  if (hint) console.error(`提示：${hint}`);
  process.exit(1);
}

/** 递归取目录下最新的修改时间 */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const time = entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs;
    if (time > newest) newest = time;
  }
  return newest;
}

/* ------------------------------ 前置检查 ------------------------------ */

for (const [path, label, how] of [
  [exe, 'dist/lemon.exe', 'npm run exe'],
  [vsix, 'vscode-lemon/lemon-language.vsix', 'npm run ext:package'],
]) {
  if (!existsSync(path)) fail(`找不到 ${label}`, `请先执行 ${how}`);
}

// 源码比产物新 = 大概率忘了重新打包
const srcTime = newestMtime(join(root, 'src'));
if (statSync(exe).mtimeMs < srcTime) {
  fail(
    'dist/lemon.exe 比 src/ 旧，打进去的会是旧行为',
    '请重新执行 npm run exe（Node SEA 打包，约需半分钟）',
  );
}
// 扩展打包时会把根 README.md 一并塞进 vsix，所以它也参与陈旧判断
const extTime = Math.max(
  newestMtime(join(root, 'vscode-lemon', 'src')),
  statSync(join(root, 'README.md')).mtimeMs,
);
if (statSync(vsix).mtimeMs < extTime) {
  fail('lemon-language.vsix 比扩展源码或 README 旧', '请重新执行 npm run ext:package');
}

/* ------------------------------- 组装 --------------------------------- */

rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });

copyFileSync(exe, join(bundleDir, 'lemon.exe'));
copyFileSync(vsix, join(bundleDir, 'lemon-language.vsix'));
copyFileSync(join(installerDir, '安装.bat'), join(bundleDir, '安装.bat'));

// install.ps1 与安装说明必须带 UTF-8 BOM 再送出去：
// 目标机器上 PowerShell 5.1 是按 ANSI 读 .ps1 的，没有 BOM 的话
// 脚本里的中文会变成乱码（本仓库里不存 BOM，只在打包这一步加上）。
const BOM = '\uFEFF';
for (const name of ['install.ps1', '安装说明.txt']) {
  const text = readFileSync(join(installerDir, name), 'utf8').replace(/^\uFEFF/, '');
  writeFileSync(join(bundleDir, name), BOM + text, 'utf8');
}

/* -------------------------------- 压缩 -------------------------------- */

if (existsSync(zipPath)) rmSync(zipPath, { force: true });
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${join(bundleDir, '*')}' -DestinationPath '${zipPath}' -Force`,
  ],
  { stdio: 'inherit' },
);

/* -------------------------------- 汇报 -------------------------------- */

const mb = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`\n目录：${bundleDir}`);
console.log(`压缩包：${zipPath}  ${mb(zipPath)}`);
console.log(`\n里面：`);
for (const name of readdirSync(bundleDir)) {
  console.log(`  ${name.padEnd(24)} ${mb(join(bundleDir, name))}`);
}
console.log('\n把压缩包（或整个目录）拷到目标电脑，双击「安装.bat」即可。');
