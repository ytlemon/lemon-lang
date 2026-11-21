/**
 * 黄金用例驱动器。
 *
 * 约定（位于 tests/fixtures/）：
 *   xxx-name.lemon1    输入
 *   xxx-name.out  期望 stdout（存在则比对）
 *   xxx-name.err  期望的错误码列表，每行一个（存在则要求执行失败且错误码完全一致）
 *
 * 至少要存在 .out 或 .err 之一，否则用例本身视为不合格。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { SOURCE_EXTENSION } from '../src/index';
import { errorCodes, runText } from './support';

const fixturesDir = path.join(__dirname, '..', '..', 'tests', 'fixtures');

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function readExpected(file: string): string {
  return normalize(fs.readFileSync(file, 'utf8'));
}

const sources = fs
  .readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.lemon1'))
  .sort();

describe('黄金用例', () => {
  it('每个 .lemon1 都有配套的 .out 或 .err', () => {
    for (const name of sources) {
      const base = path.join(fixturesDir, name.slice(0, -SOURCE_EXTENSION.length));
      const hasOut = fs.existsSync(`${base}.out`);
      const hasErr = fs.existsSync(`${base}.err`);
      assert.ok(hasOut || hasErr, `${name} 缺少 .out 或 .err`);
    }
  });

  for (const name of sources) {
    it(name, () => {
      const full = path.join(fixturesDir, name);
      const base = full.slice(0, -SOURCE_EXTENSION.length);
      const outcome = runText(fs.readFileSync(full, 'utf8'), { path: name });

      if (fs.existsSync(`${base}.err`)) {
        assert.equal(outcome.ok, false, `${name} 期望执行失败，但成功了`);
        const expected = readExpected(`${base}.err`)
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        assert.deepEqual(
          errorCodes(outcome.diagnostics),
          expected,
          `${name} 错误码不一致：${JSON.stringify(outcome.diagnostics, null, 2)}`,
        );
      } else {
        assert.equal(
          outcome.ok,
          true,
          `${name} 期望成功，实际诊断：${JSON.stringify(outcome.diagnostics, null, 2)}`,
        );
        assert.deepEqual(errorCodes(outcome.diagnostics), [], `${name} 不应有错误`);
      }

      const outFile = `${base}.out`;
      if (fs.existsSync(outFile)) {
        assert.equal(outcome.stdout, readExpected(outFile), `${name} 输出不一致`);
      }
    });
  }
});
