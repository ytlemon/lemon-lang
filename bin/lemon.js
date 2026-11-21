#!/usr/bin/env node
'use strict';

/**
 * npm bin 入口：转发到 esbuild 打包产物（与 lemon.exe 共用同一份代码）。
 * 若尚未构建，给出明确提示。
 */
const path = require('node:path');

const bundle = path.join(__dirname, '..', 'dist', 'lemon.cjs');

try {
  require(bundle);
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('lemon.cjs')) {
    process.stderr.write('未找到构建产物 dist/lemon.cjs，请先执行：npm run build\n');
    process.exitCode = 1;
  } else {
    throw error;
  }
}
