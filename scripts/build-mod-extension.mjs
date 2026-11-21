/**
 * 构建 lemonmod 的 VS Code 扩展：
 * 把 mod/vscode-lemonmod/src/extension.ts（连同它引用的 mod/src 编译器）打成
 * 单文件 mod/vscode-lemonmod/out/extension.js。
 *
 * `vscode` 模块由编辑器运行时注入，必须保持 external。
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = resolve(root, 'mod/vscode-lemonmod');
const outDir = resolve(extensionDir, 'out');

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(extensionDir, 'src/extension.ts')],
  outfile: resolve(outDir, 'extension.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  // 保持中文可读：默认 charset=ascii 会把中文转义成 \uXXXX，调试时几乎没法看
  charset: 'utf8',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});
