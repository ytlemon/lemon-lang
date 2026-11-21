import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { main, type CliIo } from '../src/cli';

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-cli-'));
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let counter = 0;
function writeTemp(content: string, extension = '.lemon1'): string {
  counter += 1;
  const file = path.join(tmpDir, `case-${counter}${extension}`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

async function runCli(argv: string[], lines?: string[], stdin?: string): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  let index = 0;
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    color: false,
  };
  if (lines !== undefined) {
    io.readLine = async () => (index < lines.length ? lines[index++] : null);
  }
  if (stdin !== undefined) {
    io.readStdin = () => stdin;
  }
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

describe('命令行 / run', () => {
  it('运行脚本成功，输出走 stdout，退出码 0', async () => {
    const file = writeTemp('__init__ {\n    main() { say("你好") }\n}\n');
    const result = await runCli(['run', file]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '你好\n');
    assert.equal(result.stderr, '');
  });

  it('省略 run 直接给文件路径也等价', async () => {
    const file = writeTemp('__init__ {\n    main() { say("ok") }\n}\n');
    const result = await runCli([file]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'ok\n');
  });

  it('静态检查失败：退出码 1，诊断走 stderr', async () => {
    const file = writeTemp('__init__ {\n    main() { int a = 你好 }\n}\n');
    const result = await runCli([file]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /E0307/);
    assert.match(result.stderr, /类型不匹配/);
  });

  it('运行期错误：退出码 1，并打印调用栈', async () => {
    const file = writeTemp('__init__ {\n    def loop() { loop() }\n    main() { loop() }\n}\n');
    const result = await runCli([file]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /E0403/);
    assert.match(result.stderr, /调用栈/);
  });

  it('源码带 UTF-8 BOM 也能正常运行（Windows 记事本常见）', async () => {
    const file = writeTemp('\uFEFF__init__ {\n    main() { say("你好") }\n}\n');
    const result = await runCli([file]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '你好\n');
  });

  it('CRLF 换行的文件照常运行', async () => {
    const file = writeTemp('__init__ {\r\n    main() { say("换行") }\r\n}\r\n');
    const result = await runCli([file]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '换行\n');
  });

  it('文件不存在：退出码 2 且提示用法', async () => {
    const result = await runCli(['run', path.join(tmpDir, 'nope.lemon1')]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /找不到文件/);
    assert.match(result.stderr, /lemon --help/);
  });

  it('一次给多个文件属于用法错误', async () => {
    const a = writeTemp('__init__ { main() { say(1) } }');
    const b = writeTemp('__init__ { main() { say(2) } }');
    const result = await runCli([a, b]);
    assert.equal(result.code, 2);
  });
});

describe('命令行 / check', () => {
  it('检查通过：退出码 0', async () => {
    const file = writeTemp('__init__ {\n    main() { say("你好") }\n}\n');
    const result = await runCli(['check', file]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /检查通过/);
  });

  it('--json 成功时 stdout 只有一份合法 JSON', async () => {
    const file = writeTemp('__init__ {\n    main() { say("你好") }\n}\n');
    const result = await runCli(['check', '--json', file]);
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report, { ok: true, diagnostics: [] });
  });

  it('--json 失败时携带 code/行列/hint', async () => {
    const file = writeTemp('__init__ {\n    main() {\n        int a = 你好\n    }\n}\n');
    const result = await runCli(['check', '--json', file]);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.diagnostics.length, 1);
    const diag = report.diagnostics[0];
    assert.equal(diag.code, 'E0307');
    assert.equal(diag.severity, 'error');
    assert.equal(diag.line, 3);
    assert.equal(diag.col, 17);
    assert.ok(typeof diag.hint === 'string');
    assert.ok(diag.endCol > diag.col);
  });

  it('--json 遇到缺失文件也返回合法 JSON（供插件解析）', async () => {
    const result = await runCli(['check', '--json', path.join(tmpDir, 'missing.lemon1')]);
    assert.equal(result.code, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.diagnostics[0].code, 'E0902');
  });

  it('--stdin 直接检查缓冲区内容（编辑器插件路径）', async () => {
    const good = await runCli(
      ['check', '--json', '--stdin', 'demo.lemon1'],
      undefined,
      '__init__ {\n    main() { say("你好") }\n}\n',
    );
    assert.equal(good.code, 0);
    assert.deepEqual(JSON.parse(good.stdout), { ok: true, diagnostics: [] });

    const bad = await runCli(
      ['check', '--json', '--stdin', 'demo.lemon1'],
      undefined,
      '__init__ {\n    main() {\n        int a = 你好\n    }\n}\n',
    );
    assert.equal(bad.code, 1);
    const report = JSON.parse(bad.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.diagnostics[0].code, 'E0307');
    assert.equal(report.diagnostics[0].line, 3);
  });

  it('--warn-unused 会额外输出警告但不影响退出码', async () => {
    const file = writeTemp('__init__ {\n    int unused = 1\n    main() { say("你好") }\n}\n');
    const result = await runCli(['check', '--warn-unused', file]);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /警告/);
    assert.match(result.stdout, /检查通过/);
  });
});

describe('命令行 / eval', () => {
  it('求值代码片段', async () => {
    const result = await runCli(['eval', 'say("你好")']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '你好\n');
  });

  it('片段报错时行号与用户输入一致', async () => {
    const result = await runCli(['eval', 'int a = 你好']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /<eval>:1:/);
  });

  it('多行片段的行号同样对齐', async () => {
    const result = await runCli(['eval', 'say("第一行")\nint a = 你好']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /<eval>:2:/);
    // 静态检查先于执行，因此不会产生任何输出
    assert.equal(result.stdout, '');
  });

  it('多行片段可以正常执行', async () => {
    const result = await runCli(['eval', 'say("第一行")\nsay("第二行")']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '第一行\n第二行\n');
  });

  it('eval 支持 if / elif / else 与比较运算', async () => {
    const result = await runCli([
      'eval',
      'int a = 2\nif a > 1 { say("大") } elif a == 1 { say("一") } else { say("小") }',
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '大\n');
  });

  it('eval 里 if 的条件类型错误行号与输入对齐', async () => {
    const result = await runCli(['eval', 'say("第一行")\nif 1 { say(x) }']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /E0318/);
    assert.match(result.stderr, /<eval>:2:/);
    assert.equal(result.stdout, '');
  });

  it('缺少代码属于用法错误', async () => {
    const result = await runCli(['eval']);
    assert.equal(result.code, 2);
  });
});

describe('命令行 / 调试与信息', () => {
  it('ast 打印语法树', async () => {
    const file = writeTemp('__init__ {\n    text x = 你好\n    main() { say("ok") }\n}\n');
    const result = await runCli(['ast', file]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Program/);
    assert.match(result.stdout, /FuncDecl main\(\)/);
    // 静态检查已把 你好 解析为裸文本，AST 打印中会标注出来
    assert.match(result.stdout, /Ident 你好\s+\(裸文本\)/);
    assert.match(result.stdout, /Call → say/);
  });

  it('tokens 打印词法单元', async () => {
    const file = writeTemp('__init__ {\n    text x = 你好\n    main() { say("ok") }\n}\n');
    const result = await runCli(['tokens', file]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /__init__\s+__init__/);
    // 词法层面 你好 是标识符，是否为裸文本由静态检查决定
    assert.match(result.stdout, /ident\s+你好/);
    assert.match(result.stdout, /eof\s+<EOF>/);
  });

  it('--version 与 --help', async () => {
    const version = await runCli(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^lemon \d+\.\d+\.\d+/);

    const help = await runCli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /用法/);
    assert.match(help.stdout, /退出码/);
  });

  it('未知选项属于用法错误', async () => {
    const result = await runCli(['--nope']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /未知选项 --nope/);
  });
});

describe('命令行 / REPL', () => {
  it('跨行保留绑定、支持多行 def，:quit 正常退出', async () => {
    const result = await runCli([], [
      'int a = 7',
      'say("你好")',
      'say(a)',
      'def greet(name) {',
      '    say(name)',
      '}',
      'greet(小明)',
      ':symbols',
      ':quit',
    ]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Lemon v\d+\.\d+\.\d+ 交互式解释器/);
    assert.match(result.stdout, /你好/);
    assert.match(result.stdout, /\b7\b/);
    assert.match(result.stdout, /小明/);
    assert.match(result.stdout, /a\s+greet/);
    assert.equal(result.stderr, '');
  });

  it('REPL 中的报错走 stderr 且不中断会话', async () => {
    const result = await runCli([], ['hello(你好)', 'say("继续")', ':quit']);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /E0308/);
    assert.match(result.stdout, /继续/);
  });

  it('EOF 直接退出（支持管道输入）', async () => {
    const result = await runCli([], ['say("管道")']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /管道/);
  });

  it(':help 与 :reset 可用', async () => {
    const result = await runCli([], ['int a = 1', ':reset', 'say("a")', ':help', ':quit']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /已清空所有绑定/);
    // reset 之后 a 不再是变量；say 里写文本要加引号
    assert.match(result.stdout, /lemon> a\n/);
    assert.match(result.stdout, /:symbols/);
  });

  it('花括号未闭合时自动续行，不会误报语法错误', async () => {
    const result = await runCli([], ['def f() {', '    say("多行")', '}', 'f()', ':quit']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /多行/);
    assert.equal(result.stderr, '');
  });

  it(':ast 打印片段语法树', async () => {
    const result = await runCli([], [':ast int a = 1', ':quit']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /VarDecl int a/);
  });
});

describe('命令行 / #incloud', () => {
  const LIB = 'def 打招呼(名字) {\n    say(你好：+ 名字)\n}\n\nint 版本 = 1\n';

  /** 在独立子目录里放一对「入口 + 工具.lemon1」，返回入口路径 */
  function writePair(entry: string, lib = LIB, subdir = ''): string {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'inc-'));
    if (subdir !== '') fs.mkdirSync(path.join(dir, subdir), { recursive: true });
    fs.writeFileSync(path.join(dir, subdir, '工具.lemon1'), lib, 'utf8');
    const file = path.join(dir, 'main.lemon1');
    fs.writeFileSync(file, entry, 'utf8');
    return file;
  }

  it('真实文件系统上引入同目录的 .lemon1 并运行', async () => {
    const file = writePair('#incloud 工具\n\n__init__ {\n    main() {\n        打招呼(小明)\n        say(版本)\n    }\n}\n');
    const result = await runCli(['run', file]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '你好：小明\n1\n');
    assert.equal(result.stderr, '');
  });

  it('可以引子目录里的文件', async () => {
    const file = writePair(
      '#incloud lib/工具.lemon1\n\n__init__ {\n    main() { say(版本) }\n}\n',
      LIB,
      'lib',
    );
    const result = await runCli(['run', file]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '1\n');
  });

  it('check 认可 #incloud，并报告"检查通过"', async () => {
    const file = writePair('#incloud 工具\n\n__init__ {\n    main() { say(版本) }\n}\n');
    const result = await runCli(['check', file]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /检查通过/);
  });

  it('被引入文件里的错误：报错指向那个文件，退出码 1', async () => {
    const file = writePair(
      '#incloud 工具\n\n__init__ {\n    main() { say(1) }\n}\n',
      'def 坏函数() {\n    int a = 你好\n}\n',
    );
    const result = await runCli(['run', file]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /E0307/);
    assert.match(result.stderr, /工具\.lemon1:2:/);
    // 入口文件里没有错，不该被点名
    assert.doesNotMatch(result.stderr, /main\.lemon1:2:/);
  });

  it('引入数据文件：E0502，退出码 1', async () => {
    const file = writePair('#incloud package.json\n\n__init__ {\n    main() { say(1) }\n}\n');
    const result = await runCli(['run', file]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /E0502/);
    assert.match(result.stderr, /只支持 \.lemon1 源文件/);
  });

  it('找不到目标：E0501，提示里列出同目录候选', async () => {
    const file = writePair('#incloud 工具库\n\n__init__ {\n    main() { say(1) }\n}\n');
    const result = await runCli(['run', file]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /E0501/);
    assert.match(result.stderr, /工具\.lemon1/);
  });

  it('check --json 在引入失败时仍只输出一份合法 JSON', async () => {
    const file = writePair('#incloud package.json\n\n__init__ {\n    main() { say(1) }\n}\n');
    const result = await runCli(['check', '--json', file]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout) as { ok: boolean; diagnostics: Array<{ code: string }> };
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.diagnostics.map((d) => d.code),
      ['E0502'],
    );
  });

  it('eval 里用 #incloud：E0207 并引导改用文件运行', async () => {
    const result = await runCli(['eval', '#incloud web']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /E0207/);
    assert.match(result.stderr, /只在从文件运行时生效/);
    assert.equal(result.stdout, '');
  });

  it('REPL 里用 #incloud 同样报 E0207', async () => {
    const result = await runCli([], ['#incloud web', ':quit']);
    // REPL 的诊断走 stderr（与其它错误一致），提示里引导改用文件运行
    assert.equal(result.code, 0);
    assert.match(result.stderr, /E0207/);
    assert.match(result.stderr, /只在从文件运行时生效/);
  });
});

describe('命令行 / websets', () => {
  const PAGE = `#incloud web

__init__ {
    main() { say("逻辑跑完了") }

    websets() {
        web.init() {
            button {
                to "localhost:9000"
            }
            button {
                to "https://example.com"
            }
        }
    }
}
`;

  /** 与入口同名的 .html 路径 */
  function htmlOf(file: string): string {
    return file.replace(/\.lemon1$/, '.html');
  }

  it('--no-open：main() 照常输出，同时生成同名 .html', async () => {
    const file = writeTemp(PAGE);
    const result = await runCli(['run', '--no-open', file]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /逻辑跑完了/);
    assert.match(result.stdout, /已生成页面 .*\.html（2 个按钮）/);

    const html = fs.readFileSync(htmlOf(file), 'utf8');
    assert.match(html, /href="http:\/\/localhost:9000"/);
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /<title>case-\d+<\/title>/);
  });

  it('check 只检查、不生成页面', async () => {
    const file = writeTemp(PAGE);
    const result = await runCli(['check', file]);
    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(htmlOf(file)), false);
  });

  it('没有 websets() 的程序不会产出 .html', async () => {
    const file = writeTemp('__init__ {\n    main() { say("纯终端") }\n}\n');
    const result = await runCli(['run', '--no-open', file]);
    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(htmlOf(file)), false);
  });

  it('少了 #incloud web：退出码 1 + E0323，不产出文件', async () => {
    const file = writeTemp(PAGE.replace('#incloud web\n', ''));
    const result = await runCli(['run', '--no-open', file]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /E0323/);
    assert.match(result.stderr, /#incloud web/);
    assert.equal(fs.existsSync(htmlOf(file)), false);
  });

  it('--no-open 是合法选项（不会当成用法错误）', async () => {
    const file = writeTemp('__init__ {\n    main() { say("ok") }\n}\n');
    const result = await runCli(['run', '--no-open', file]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
  });
});
