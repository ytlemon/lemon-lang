/**
 * 构建脚本：用 esbuild 把解释器打包成单文件 CJS。
 *
 * 产物：dist/lemon.cjs —— bin/lemon.js 与 Node SEA 打包（lemon.exe）共用。
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

mkdirSync(resolve(root, 'dist'), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(root, 'dist/lemon.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // 保持中文可读：默认 charset=ascii 会把中文错误文案转义成 \uXXXX
  charset: 'utf8',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    js: '/* Lemon 编程语言 —— 单文件构建产物，请勿直接编辑；源码见 src/ */',
  },
});

if (result.warnings.length > 0) {
  console.warn(`esbuild 警告 ${result.warnings.length} 条`);
}
