/**
 * lemonmod 命令行：lemonmod <文件.lemon2>
 *
 * 输出走 stdout，诊断走 stderr；有错时退出码为 1。
 */
import * as fs from 'node:fs';
import { MOD_EXTENSION, formatDiagnostic, runModSource } from './index';

const USAGE = `lemonmod —— lemonmod 语言（${MOD_EXTENSION}）解释器

用法：
  lemonmod <文件${MOD_EXTENSION}>
  lemonmod --help
`;

export function main(argv: readonly string[]): number {
  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h') {
    process.stdout.write(USAGE);
    return first === undefined ? 1 : 0;
  }

  let text: string;
  try {
    text = fs.readFileSync(first, 'utf8');
  } catch {
    process.stderr.write(`读不到文件：${first}\n`);
    return 1;
  }

  const result = runModSource(text, { write: (chunk) => process.stdout.write(chunk) });
  if (result.ok) return 0;

  for (const diagnostic of result.diagnostics) {
    process.stderr.write(`${formatDiagnostic(diagnostic, first, text)}\n`);
  }
  return 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
