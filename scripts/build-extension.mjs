/**
 * 构建 VS Code 扩展：把 vscode-lemon/src/extension.ts 打包成单文件 out/extension.js。
 *
 * `vscode` 模块由编辑器运行时注入，必须保持 external。
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'vscode-lemon/out');

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'vscode-lemon/src/extension.ts')],
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
