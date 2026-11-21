/**
 * 轻量 argv 解析：子命令 + 布尔 flag + 位置参数。
 *
 * 不使用第三方依赖；非法选项返回可读的中文错误，由 CLI 层转成用法错误（退出码 2）。
 */

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Set<string>;
  error: string | null;
}

export interface ParseArgsOptions {
  commands: readonly string[];
  flags: readonly string[];
}

export function parseArgs(argv: string[], options: ParseArgsOptions): ParsedArgs {
  const commands = new Set(options.commands);
  const knownFlags = new Set(options.flags);
  const result: ParsedArgs = { command: null, positionals: [], flags: new Set(), error: null };

  for (const raw of argv) {
    if (raw.startsWith('-') && raw !== '-') {
      const name = raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw;
      if (!knownFlags.has(name)) {
        result.error = `未知选项 ${name}`;
        return result;
      }
      result.flags.add(name);
      continue;
    }
    if (result.command === null && commands.has(raw)) {
      result.command = raw;
      continue;
    }
    result.positionals.push(raw);
  }

  return result;
}
