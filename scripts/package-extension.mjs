/**
 * 打包 VS Code 扩展为 .vsix。
 *
 * 使用根目录的 @vscode/vsce，并以 `--no-dependencies` 跳过扩展目录下的 node_modules
 * （扩展的运行时依赖为零，vscode 模块由编辑器注入）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'vscode-lemon');
const vsceCli = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');

if (!existsSync(join(extDir, 'out', 'extension.js'))) {
  console.error('找不到 vscode-lemon/out/extension.js，请先执行 npm run ext:build');
  process.exit(1);
}

console.log('正在打包 .vsix …');
const result = spawnSync(
  process.execPath,
  [vsceCli, 'package', '--no-dependencies', '--allow-missing-repository', '--out', 'lemon-language.vsix'],
  { cwd: extDir, stdio: 'inherit' },
);

if (result.status !== 0) {
  console.error(`\n打包失败（退出码 ${result.status}）`);
  process.exit(1);
}

const vsix = join(extDir, 'lemon-language.vsix');
if (!existsSync(vsix)) {
  console.error('打包命令结束，但未找到 .vsix 产物');
  process.exit(1);
}

console.log(`\n打包完成：${vsix}`);
console.log(`大小：${(statSync(vsix).size / 1024).toFixed(1)} KB`);
console.log('\n安装方式：VS Code 中执行「扩展: 从 VSIX 安装…」，或运行：');
console.log(`  code --install-extension "${vsix}"`);
console.log('\n扩展目录内容：');
for (const name of readdirSync(extDir)) {
  if (name === 'node_modules') continue;
  console.log(`  - ${name}`);
}
