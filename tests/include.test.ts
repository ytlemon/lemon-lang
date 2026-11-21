/**
 * `#incloud` 加载器测试。
 *
 * 全程走内存文件系统（memoryIncludeIo），不碰磁盘：
 * 每个用例自己就是一棵目录树，哪几个文件参与、谁引了谁一眼可见。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderDiagnostic } from '../src/lang/diagnostics';
import { captureIncludeFailure, checkFiles, errorCodes, resolveFiles, runFiles } from './support';

/** 一个最普通的"零件"文件：只有 def 与变量，没有 __init__ */
const LIB = `def 打招呼(名字) {
    say(你好：+ 名字)
}

int 版本 = 3
`;

/** 入口文件 + 同目录的 工具.lemon1 */
function withLib(body: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'main.lemon1': body, '工具.lemon1': LIB, ...extra };
}

/** 只跑静态检查，返回 (行号 → 真实文件) 的映射结果 */
function staticCheck(files: Record<string, string>) {
  const resolved = resolveFiles('main.lemon1', files);
  const analysis = checkFiles('main.lemon1', files);
  return { resolved, analysis };
}

describe('#incloud：引入源文件', () => {
  it('写在 __init__ 之前：被引入的 def 与变量都能用', () => {
    const out = runFiles(
      'main.lemon1',
      withLib(`#incloud 工具

__init__ {
    main() {
        打招呼(小明)
        say(版本)
    }
}
`),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '你好：小明\n3\n');
  });

  it('写在 __init__ 之中：就地展开', () => {
    const out = runFiles(
      'main.lemon1',
      withLib(`__init__ {
    #incloud 工具

    main() {
        打招呼(乙)
    }
}
`),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '你好：乙\n');
  });

  it('带不带 .lemon1、带不带引号、行尾注释，都认', () => {
    for (const directive of ['#incloud 工具', '#incloud 工具.lemon1', '#incloud "工具.lemon1"', '#incloud 工具 // 引入工具']) {
      const out = runFiles('main.lemon1', withLib(`${directive}\n\n__init__ {\n    main() { say(版本) }\n}\n`));
      assert.equal(out.ok, true, `${directive} → ${JSON.stringify(out.diagnostics)}`);
      assert.equal(out.stdout, '3\n', directive);
    }
  });

  it('路径里的 // 不会被当成注释（注释必须前面有空白）', () => {
    const out = runFiles('main.lemon1', {
      'main.lemon1': '#incloud lib//工具\n\n__init__ {\n    main() { say(版本) }\n}\n',
      'lib/工具.lemon1': LIB,
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '3\n');
  });

  it('可以用相对路径引子目录里的文件', () => {
    const out = runFiles('main.lemon1', {
      'main.lemon1': '#incloud lib/工具.lemon1\n\n__init__ {\n    main() { say(版本) }\n}\n',
      'lib/工具.lemon1': LIB,
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '3\n');
  });

  it('同一个文件只并入一次（菱形依赖不是错误）', () => {
    const files: Record<string, string> = {
      'main.lemon1': '#incloud 甲\n#incloud 乙\n#incloud 工具\n#incloud 工具.lemon1\n\n__init__ {\n    main() { say(版本) }\n}\n',
      '甲.lemon1': '#incloud 工具\ndef 甲函数() { say("甲") }\n',
      '乙.lemon1': '#incloud 工具\ndef 乙函数() { say("乙") }\n',
      '工具.lemon1': LIB,
    };
    const out = runFiles('main.lemon1', files);
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '3\n');
  });

  it('互相引入不会绕不出来', () => {
    const files: Record<string, string> = {
      'main.lemon1': '#incloud 甲\n\n__init__ {\n    main() { say(甲值) }\n}\n',
      '甲.lemon1': '#incloud 乙\nint 甲值 = 1\n',
      '乙.lemon1': '#incloud 甲\nint 乙值 = 2\n',
    };
    const out = runFiles('main.lemon1', files);
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '1\n');
  });

  it('注释与字符串里的 #incloud 都只是普通文本', () => {
    const commented = runFiles(
      'main.lemon1',
      withLib(`/*
#incloud 工具
*/
__init__ {
    main() {
        text v = 版本
        say(v)
    }
}
`),
    );
    // 注释里的指令没生效：版本 是未声明的名字，按裸文本处理
    assert.equal(commented.ok, true, JSON.stringify(commented.diagnostics));
    assert.equal(commented.stdout, '版本\n');

    const quoted = runFiles('main.lemon1', {
      'main.lemon1': '__init__ {\n    main() { say("#incloud 工具") }\n}\n',
    });
    assert.equal(quoted.ok, true, JSON.stringify(quoted.diagnostics));
    assert.equal(quoted.stdout, '#incloud 工具\n');
  });

  it('被引入文件里的错误，报错指向那个文件而不是入口文件', () => {
    const files: Record<string, string> = {
      'main.lemon1': '#incloud 坏文件\n\n__init__ {\n    main() { say(1) }\n}\n',
      '坏文件.lemon1': 'def 加法(a, b) {\n    int 结果 = a + b\n    say(结果 + 不是数字)\n}\n',
    };
    const { resolved, analysis } = staticCheck(files);
    assert.deepEqual(errorCodes(analysis.diagnostics), ['E0307']);

    const diag = analysis.diagnostics[0];
    const at = resolved.source.locate(diag.line);
    assert.equal(at.source.path, '坏文件.lemon1');
    assert.equal(at.line, 3);

    const rendered = renderDiagnostic(diag, resolved.source, 'main.lemon1');
    assert.match(rendered, /--> 坏文件\.lemon1:3:/);
    assert.match(rendered, /say\(结果 \+ 不是数字\)/);
  });

  it('入口文件自己的错误，仍然指向入口文件', () => {
    const { resolved, analysis } = staticCheck(
      withLib('#incloud 工具\n\n__init__ {\n    main() {\n        int a = 你好\n    }\n}\n'),
    );
    assert.deepEqual(errorCodes(analysis.diagnostics), ['E0307']);
    const at = resolved.source.locate(analysis.diagnostics[0].line);
    assert.equal(at.source.path, 'main.lemon1');
    // 被并入的 工具.lemon1 有 5 行 + 一个空行，因此这里应该是原文件第 5 行
    assert.equal(at.line, 5);
  });
});

describe('#incloud：报错', () => {
  it('找不到目标时报 E0501，并列出同目录的 .lemon1 候选', () => {
    const failure = captureIncludeFailure(() =>
      resolveFiles('main.lemon1', withLib('#incloud 工具库\n\n__init__ { main() { say(1) } }\n')),
    );
    assert.equal(failure.lemon.code, 'E0501');
    assert.match(failure.lemon.message, /找不到 工具库/);
    assert.match(failure.lemon.hint ?? '', /工具\.lemon1/);
    assert.match(failure.lemon.hint ?? '', /可用模块：web/);
    assert.equal(failure.source.path, 'main.lemon1');
  });

  it('候选里相近的名字排在前面', () => {
    const files: Record<string, string> = {
      'main.lemon1': '#incloud 工具库\n\n__init__ { main() { say(1) } }\n',
      '工具.lemon1': LIB,
      'aaa.lemon1': LIB,
      'bbb.lemon1': LIB,
    };
    const failure = captureIncludeFailure(() => resolveFiles('main.lemon1', files));
    const hint = failure.lemon.hint ?? '';
    assert.ok(hint.indexOf('工具.lemon1') < hint.indexOf('aaa.lemon1'), hint);
  });

  it('引入 package.json 这类数据文件：E0502', () => {
    const failure = captureIncludeFailure(() =>
      resolveFiles('main.lemon1', withLib('#incloud package.json\n\n__init__ { main() { say(1) } }\n')),
    );
    assert.equal(failure.lemon.code, 'E0502');
    assert.match(failure.lemon.message, /只支持 \.lemon1 源文件/);
    assert.match(failure.lemon.hint ?? '', /数据文件暂不支持/);
  });

  it('写成旧的 .l 后缀：专门提示后缀已改', () => {
    const failure = captureIncludeFailure(() =>
      resolveFiles('main.lemon1', withLib('#incloud 工具.l\n\n__init__ { main() { say(1) } }\n')),
    );
    assert.equal(failure.lemon.code, 'E0502');
    assert.match(failure.lemon.message, /后缀已从 \.l 改为 \.lemon1/);
    // 提示里要给出改成什么：把 工具.l 改成 工具.lemon1
    assert.match(failure.lemon.hint ?? '', /工具\.lemon1/);
  });

  it('被引入的文件里写了 __init__：E0504', () => {
    const failure = captureIncludeFailure(() =>
      resolveFiles('main.lemon1', {
        'main.lemon1': '#incloud 完整程序\n\n__init__ { main() { say(1) } }\n',
        '完整程序.lemon1': '__init__ {\n    main() { say("我是主程序") }\n}\n',
      }),
    );
    assert.equal(failure.lemon.code, 'E0504');
    assert.match(failure.lemon.hint ?? '', /只写 def 与变量/);
  });

  it('深层文件里出错时，failure 带着那个文件而不是入口文件', () => {
    const failure = captureIncludeFailure(() =>
      resolveFiles('main.lemon1', {
        'main.lemon1': '#incloud 甲\n\n__init__ { main() { say(1) } }\n',
        '甲.lemon1': '#incloud 乙\n',
        '乙.lemon1': '#incloud 丙\n',
        '丙.lemon1': '__init__ { main() { say("深") } }\n',
      }),
    );
    assert.equal(failure.lemon.code, 'E0504');
    assert.equal(failure.source.path, '乙.lemon1');
  });

  it('写错成 #include：#E0107 并点名正确写法', () => {
    const failure = captureIncludeFailure(() =>
      resolveFiles('main.lemon1', withLib('#include web\n\n__init__ { main() { say(1) } }\n')),
    );
    assert.equal(failure.lemon.code, 'E0107');
    assert.match(failure.lemon.message, /不认识 '#include'/);
    assert.match(failure.lemon.hint ?? '', /#incloud（不是 #include）/);
  });

  it('不独占一行：#E0107', () => {
    const failure = captureIncludeFailure(() =>
      resolveFiles('main.lemon1', withLib('__init__ {\n    main() { say(1) #incloud web }\n}\n')),
    );
    assert.equal(failure.lemon.code, 'E0107');
    assert.match(failure.lemon.message, /必须独占一行/);
  });

  it('后面什么都不写：#E0107', () => {
    for (const line of ['#incloud', '#incloud   ', '#incloud // 先留着']) {
      const failure = captureIncludeFailure(() =>
        resolveFiles('main.lemon1', withLib(`${line}\n\n__init__ { main() { say(1) } }\n`)),
      );
      assert.equal(failure.lemon.code, 'E0107', line);
      assert.match(failure.lemon.message, /要写引入的目标/);
    }
  });

  it('不认识的 # 指令：#E0107', () => {
    const failure = captureIncludeFailure(() =>
      resolveFiles('main.lemon1', withLib('#define X\n\n__init__ { main() { say(1) } }\n')),
    );
    assert.equal(failure.lemon.code, 'E0107');
    assert.match(failure.lemon.message, /不认识 '#define'/);
  });
});

describe('#incloud：能力模块', () => {
  it('启用 web 之后，它提供的函数就能用', () => {
    const analysis = checkFiles(
      'main.lemon1',
      withLib(`#incloud web

__init__ {
    main() {
        text 正文 = fetchText("https://example.com")
        say("正文")
        openUrl("https://example.com")
    }
}
`),
    );
    assert.deepEqual(errorCodes(analysis.diagnostics), []);
  });

  it('没启用时用模块函数：报 E0308 并告诉你补哪一行', () => {
    const out = runFiles('main.lemon1', {
      'main.lemon1': '__init__ {\n    main() { say(fetchText("https://example.com")) }\n}\n',
    });
    assert.equal(out.ok, false);
    assert.deepEqual(errorCodes(out.diagnostics), ['E0308']);
    const hint = out.diagnostics[0].hint ?? '';
    assert.match(hint, /fetchText 来自 web 模块/);
    assert.match(hint, /#incloud web/);
  });

  it('没启用时用 openUrl，同样给模块提示', () => {
    const out = runFiles('main.lemon1', {
      'main.lemon1': '__init__ {\n    main() { openUrl("https://example.com") }\n}\n',
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0308']);
    assert.match(out.diagnostics[0].hint ?? '', /#incloud web/);
  });

  it('形近名优先于通用说明（findSimilar 仍生效）', () => {
    const out = runFiles('main.lemon1', {
      'main.lemon1': '#incloud web\n\n__init__ {\n    main() { fetchTxt("https://example.com") }\n}\n',
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0308']);
    assert.match(out.diagnostics[0].hint ?? '', /是否想调用 fetchText/);
  });

  it('启用模块不产生任何源码，也不占用 __init__ 的位置', () => {
    const files: Record<string, string> = {
      'main.lemon1': '#incloud web\n\n__init__ {\n    main() { say(1) }\n}\n',
    };
    const resolved = resolveFiles('main.lemon1', files);
    assert.equal(resolved.source.text, '\n__init__ {\n    main() { say(1) }\n}\n');
    assert.deepEqual(resolved.modules.map((m) => m.name), ['web']);
  });

  it('模块优先于同名文件：要引文件得写 web.lemon1', () => {
    const files: Record<string, string> = {
      'main.lemon1': '#incloud web\n\n__init__ {\n    main() { say("文件里的") }\n}\n',
      'web.lemon1': 'int 文件里的 = 42\n',
    };
    // 走模块：web.lemon1 没有被并入，文件里的 只是裸文本
    const out = runFiles('main.lemon1', files);
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '文件里的\n');

    // 写全 web.lemon1 才引文件
    const explicit = runFiles('main.lemon1', {
      ...files,
      'main.lemon1': '#incloud web.lemon1\n\n__init__ {\n    main() { say(文件里的) }\n}\n',
    });
    assert.equal(explicit.stdout, '42\n');
  });

  it('模块启用是幂等的', () => {
    const resolved = resolveFiles('main.lemon1', {
      'main.lemon1': '#incloud web\n#incloud web\n#incloud web\n\n__init__ { main() { say(1) } }\n',
    });
    assert.deepEqual(resolved.modules.map((m) => m.name), ['web']);
  });
});

describe('#incloud：参数校验（运行期）', () => {
  it('openUrl / fetchText 只接受 http(s) 网址', () => {
    const out = runFiles('main.lemon1', {
      'main.lemon1': `#incloud web

__init__ {
    main() {
        try {
            openUrl(这不是网址)
        } catch (e) {
            say(e.code)
        }
        try {
            fetchText(也不是)
        } catch (e) {
            say(e.message)
        }
    }
}
`,
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.match(out.stdout, /^E0321\n/);
    assert.match(out.stdout, /只接受 http:\/\/ 或 https:\/\//);
  });
});
