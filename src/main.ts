/**
 * 可执行文件入口。
 *
 * 使用 process.exitCode 而非 process.exit()，确保大段 stdout 在管道中被完整写出。
 */
import { defaultIo, main } from './cli';

main(process.argv.slice(2), defaultIo())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`内部错误：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
