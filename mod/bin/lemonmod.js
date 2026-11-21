#!/usr/bin/env node
'use strict';

/**
 * lemonmod 的 bin 入口：转发到 tsc 产物 mod/build/src/cli.js。
 * 与语言本身无关，只负责给出「忘了编译」的友好提示。
 */
const path = require('node:path');

const cli = path.join(__dirname, '..', 'build', 'src', 'cli.js');

try {
  require(cli);
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('cli.js')) {
    process.stderr.write('未找到构建产物 mod/build，请先执行：npm run mod:build\n');
    process.exitCode = 1;
  } else {
    throw error;
  }
}
