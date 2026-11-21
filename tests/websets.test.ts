/**
 * websets() 测试。
 *
 * 全程走内存文件系统 + 内存收录页面：不落盘、不开浏览器。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buttonNode, makePage, renderHtml, resolveHref } from '../src/index';
import { checkFiles, errorCodes, runFiles } from './support';

/** 把一段 websets 声明拼进完整的 __init__ 里 */
function program(websets: string, header = '#incloud web\n'): string {
  return `${header}\n__init__ {\n    main() { say("逻辑跑完了") }\n\n${websets}\n}\n`;
}

const ONE_BUTTON = `    websets() {
        web.init() {
            button {
                to "localhost:9000"
            }
        }
    }`;

function main(websets: string, header = '#incloud web\n'): Record<string, string> {
  return { 'app.lemon1': program(websets, header) };
}

describe('websets：产出页面', () => {
  it('main() 照常跑，同时产出一份页面数据', () => {
    const out = runFiles('app.lemon1', main(ONE_BUTTON));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '逻辑跑完了\n');
    assert.deepEqual(out.page, {
      nodes: [{ kind: 'button', target: 'localhost:9000', href: 'http://localhost:9000' }],
    });
  });

  it('没有 websets() 时 page 是 null（纯终端程序）', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '__init__ {\n    main() { say("纯终端") }\n}\n',
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '纯终端\n');
    assert.equal(out.page, null);
  });

  it('多个 button 按书写顺序排列', () => {
    const out = runFiles(
      'app.lemon1',
      main(`    websets() {
        web.init() {
            button { to "a.example.com" }
            button { to "https://b.example.com" }
            button { to "localhost:9000/x" }
        }
    }`),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.deepEqual(
      out.page?.nodes.map((n) => (n.kind === 'button' ? n.href : n.kind)),
      ['http://a.example.com', 'https://b.example.com', 'http://localhost:9000/x'],
    );
  });

  it('to 可以引用 __init__ 顶层的变量与函数调用（页面在最后求值）', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': `#incloud web

__init__ {
    text 端口 = "9000"
    text 主机 = "localhost"

    def 地址() {
        say("算地址")
    }

    main() { say("开始") }

    websets() {
        web.init() {
            button {
                to 主机 + ":" + 端口
            }
        }
    }
}
`,
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '开始\n');
    assert.deepEqual(out.page?.nodes, [
      { kind: 'button', target: 'localhost:9000', href: 'http://localhost:9000' },
    ]);
  });

  it('web.init() 里一个 button 都没有时是空页面', () => {
    const out = runFiles('app.lemon1', main('    websets() {\n        web.init() {\n        }\n    }'));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.deepEqual(out.page, { nodes: [] });
    assert.match(renderHtml(out.page!, '空'), /这个页面还是空的/);
  });
});

describe('websets：需要 #incloud web', () => {
  it('没启用模块时报 E0323 并点名要补哪一行', () => {
    const out = runFiles('app.lemon1', main(ONE_BUTTON, ''));
    assert.equal(out.ok, false);
    assert.deepEqual(errorCodes(out.diagnostics), ['E0323']);
    assert.match(out.diagnostics[0].message, /websets\(\) 需要 web 能力模块/);
    assert.match(out.diagnostics[0].hint ?? '', /#incloud web/);
    assert.equal(out.page, null);
  });

  it('模块没启用时不再往下列报错（避免淹没病因）', () => {
    // button 里毛病一堆，但只应报"缺模块"这一条
    const out = runFiles(
      'app.lemon1',
      main('    websets() {\n        web.init() {\n            button {\n            }\n        }\n    }', ''),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0323']);
  });

  it('启用了模块但写成别的模块名也不行', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(ONE_BUTTON).replace('#incloud web', '#incloud 工具'),
      '工具.lemon1': 'def 占位() { say("x") }\n',
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0323']);
  });
});

describe('websets：结构校验', () => {
  it('缺 web.init()：E0324', () => {
    const out = runFiles('app.lemon1', main('    websets() {\n    }'));
    assert.deepEqual(errorCodes(out.diagnostics), ['E0324']);
    assert.match(out.diagnostics[0].message, /缺少 web\.init\(\)/);
  });

  it('button 缺 to：E0324', () => {
    const out = runFiles('app.lemon1', main('    websets() {\n        web.init() {\n            button {\n            }\n        }\n    }'));
    assert.deepEqual(errorCodes(out.diagnostics), ['E0324']);
    assert.match(out.diagnostics[0].hint ?? '', /点了去哪/);
  });

  it('未知元素：E0325', () => {
    const out = runFiles(
      'app.lemon1',
      main('    websets() {\n        web.init() {\n            buton { to "x" }\n        }\n    }'),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0325']);
    assert.match(out.diagnostics[0].message, /不认识元素 buton/);
  });

  it('button 里写了 to 之外的东西：E0325', () => {
    const out = runFiles(
      'app.lemon1',
      main('    websets() {\n        web.init() {\n            button {\n                say(hi)\n            }\n        }\n    }'),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0325']);
    assert.match(out.diagnostics[0].message, /只能写 to <地址>/);
  });

  it('websets 块里写了别的语句：E0325', () => {
    const out = runFiles('app.lemon1', main('    websets() {\n        int a = 1\n    }'));
    assert.deepEqual(errorCodes(out.diagnostics), ['E0325']);
    assert.match(out.diagnostics[0].message, /只能写 web\.init\(\)/);
  });

  it('把 web 打错：直接说"模块名写错了"，而不是"遇到标识符 wed"', () => {
    const out = runFiles(
      'app.lemon1',
      main('    websets() {\n        wed.init()\n        button { to "x" }\n    }'),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0325']);
    assert.match(out.diagnostics[0].message, /模块名写错了：这里是 'wed\.init\(\)'/);
    assert.match(out.diagnostics[0].hint ?? '', /固定写 web\.init\(\)/);
  });

  it('web.init 漏了括号：不能报成"遇到标识符 web"', () => {
    const out = runFiles(
      'app.lemon1',
      main('    websets() {\n        web.init{\n            button { to "x" }\n        }\n    }'),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0202']);
    assert.match(out.diagnostics[0].message, /要跟一对括号/);
    assert.doesNotMatch(out.diagnostics[0].message, /遇到/);
  });

  it('web.init() 漏了花括号：直接指出 button 该放哪', () => {
    const out = runFiles(
      'app.lemon1',
      main('    websets() {\n        web.init()\n        button { to "x" }\n    }'),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0325']);
    assert.match(out.diagnostics[0].message, /button 要写在 web\.init\(\) 的花括号里/);
    assert.match(out.diagnostics[0].hint ?? '', /web\.init\(\) \{ button \{ to "localhost:9000" \} \}/);
  });

  it('漏掉 web.init 直接写 button：提示里给出完整结构', () => {
    const out = runFiles(
      'app.lemon1',
      main('    websets() {\n        button { to "localhost:9000" }\n    }'),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0325']);
    assert.match(out.diagnostics[0].hint ?? '', /button 要写在 web\.init\(\) 里面/);
  });

  it('to 的地址必须是 text：E0307', () => {
    const out = runFiles('app.lemon1', main('    websets() {\n        web.init() {\n            button { to 9000 }\n        }\n    }'));
    assert.deepEqual(errorCodes(out.diagnostics), ['E0307']);
    assert.match(out.diagnostics[0].message, /to 的地址必须是 text/);
  });

  it('websets 只能有一个：E0306', () => {
    const out = runFiles('app.lemon1', main(`${ONE_BUTTON}\n\n${ONE_BUTTON}`));
    assert.deepEqual(errorCodes(out.diagnostics), ['E0306']);
    assert.match(out.diagnostics[0].message, /只能声明一次/);
  });

  it('websets 不能带参数：E0202', () => {
    const out = runFiles('app.lemon1', main('    websets(1) {\n        web.init() {\n        }\n    }'));
    assert.deepEqual(errorCodes(out.diagnostics), ['E0202']);
    assert.match(out.diagnostics[0].message, /不能带参数/);
  });

  it('web.init() 只能写一次：E0202', () => {
    const out = runFiles(
      'app.lemon1',
      main('    websets() {\n        web.init() {\n        }\n\n        web.init() {\n        }\n    }'),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0202']);
    assert.match(out.diagnostics[0].message, /只能写一次/);
  });

  it('websets 不能写在函数体里：E0201', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': `#incloud web

__init__ {
    main() {
        websets() {
            web.init() {
            }
        }
    }
}
`,
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0201']);
    assert.match(out.diagnostics[0].message, /只能写在 __init__ 顶层/);
    assert.match(out.diagnostics[0].hint ?? '', /与 main\(\) 同级/);
  });
});

describe('websets：不影响现有写法（上下文关键字）', () => {
  it('say 里写文本要加引号（button / to / websets 同理）', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '__init__ {\n    main() {\n        say("button")\n        say("to")\n        say("websets")\n    }\n}\n',
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, 'button\nto\nwebsets\n');
    assert.equal(out.page, null);
  });

  it('websets / button / to 仍可作变量名', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '__init__ {\n    int button = 1\n    int to = 2\n    int websets = 3\n\n    main() { say(button + to + websets) }\n}\n',
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '6\n');
  });

  it('普通函数调用名里带 web 或 init 不受影响', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '__init__ {\n    def web() { say("叫 web 的函数") }\n\n    main() { web() }\n}\n',
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '叫 web 的函数\n');
  });
});

describe('websets：地址规范化与转义', () => {
  it('host:port 必须补 http://（否则浏览器把它当协议，点了没反应）', () => {
    assert.equal(resolveHref('localhost:9000'), 'http://localhost:9000');
    assert.equal(resolveHref('127.0.0.1:8080/x?a=1'), 'http://127.0.0.1:8080/x?a=1');
    assert.equal(resolveHref('example.com:443'), 'http://example.com:443');
  });

  it('没写协议的普通域名补 http://，写了协议的原样保留', () => {
    assert.equal(resolveHref('example.com'), 'http://example.com');
    assert.equal(resolveHref('www.example.com/a/b'), 'http://www.example.com/a/b');
    assert.equal(resolveHref('https://example.com'), 'https://example.com');
    assert.equal(resolveHref('http://example.com'), 'http://example.com');
    assert.equal(resolveHref('mailto:a@b.com'), 'mailto:a@b.com');
  });

  it('地址两端空白会被去掉', () => {
    assert.deepEqual(makePage([buttonNode('  localhost:9000  ')]).nodes, [
      { kind: 'button', target: 'localhost:9000', href: 'http://localhost:9000' },
    ]);
  });

  it('标题与地址都会转义，不会注入标签或破坏属性', () => {
    const page = makePage([buttonNode('a"b<c')]);
    const html = renderHtml(page, '标<题>');
    assert.match(html, /<title>标&lt;题&gt;<\/title>/);
    assert.match(html, /href="http:\/\/a&quot;b&lt;c"/);
    assert.doesNotMatch(html, /<c>/);
  });
});

describe('websets：div 元素与颜色字面量', () => {
  it('div 的位置盒子与颜色被求值成页面数据', () => {
    const out = runFiles(
      'app.lemon1',
      main(`    websets() {
        web.init() {
            div (in (0,0;256,256); color=#ffffff) {
                你好
            }
        }
    }`),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.deepEqual(out.page, {
      nodes: [
        {
          kind: 'div',
          box: { left: 0, top: 0, width: 256, height: 256 },
          color: '#ffffff',
          children: [{ kind: 'text', text: '你好' }],
        },
      ],
    });
  });

  it('括号可以整个省略；div 里能放 button 与嵌套 div', () => {
    const out = runFiles(
      'app.lemon1',
      main(`    websets() {
        web.init() {
            div {
                button { to "a.example.com" }
                div (in (0,0;10,10)) { 内层 }
            }
        }
    }`),
    );
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    const node = out.page?.nodes[0];
    assert.equal(node?.kind, 'div');
    if (node?.kind !== 'div') return;
    assert.equal(node.box, null);
    assert.equal(node.color, null);
    assert.deepEqual(node.children.map((c) => c.kind), ['button', 'div']);
  });

  it('in 的坐标可以引用变量', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': `#incloud web

__init__ {
    int 宽 = 100
    int 高 = 50

    main() { say("ok") }

    websets() {
        web.init() {
            div (in (1,2;宽,高)) { 空白 }
        }
    }
}
`,
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.deepEqual(out.page?.nodes[0], {
      kind: 'div',
      box: { left: 1, top: 2, width: 99, height: 48 },
      color: null,
      children: [{ kind: 'text', text: '空白' }],
    });
  });

  it('渲染 div 时盒子写成行内样式、颜色写成背景色，文本会转义', () => {
    const html = renderHtml(
      makePage([
        {
          kind: 'div',
          box: { left: 0, top: 0, width: 10, height: 20 },
          color: '#ffffff',
          children: [{ kind: 'text', text: '<b>x</b>' }],
        },
      ]),
      '标题',
    );
    assert.match(html, /left:0px;top:0px;width:10px;height:20px;background:#ffffff/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<b>x<\/b>/);
  });

  it('#rrggbb / #rgb 是文本字面量，say 与 text 变量都能用', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1':
        '__init__ {\n    main() {\n        say(#abc)\n        say(#aabbcc)\n        text c = #FFFFFF\n        say(c)\n    }\n}\n',
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '#abc\n#aabbcc\n#FFFFFF\n');
  });

  it('#incloud 仍是指令，不会被颜色判定吃掉', () => {
    const out = runFiles('app.lemon1', main(ONE_BUTTON));
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.modules.includes('web'), true);
  });

  it('div 属性的名字不认识：E0348', () => {
    const out = runFiles(
      'app.lemon1',
      main(`    websets() {
        web.init() {
            div (top (0,0;1,1)) { x }
        }
    }`),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0348']);
    assert.match(out.diagnostics[0].message, /只能是 in\(\.\.\.\) 或 color=\.\.\./);
  });

  it('属性之间漏了分号：E0348', () => {
    const out = runFiles(
      'app.lemon1',
      main(`    websets() {
        web.init() {
            div (in (0,0;1,1) color=#ffffff) { x }
        }
    }`),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0348']);
    assert.match(out.diagnostics[0].message, /要用 ; 分隔/);
  });

  it('in 的坐标不是数字：E0307', () => {
    const out = runFiles(
      'app.lemon1',
      main(`    websets() {
        web.init() {
            div (in ("a",0;1,1)) { x }
        }
    }`),
    );
    assert.deepEqual(errorCodes(out.diagnostics), ['E0307']);
    assert.match(out.diagnostics[0].message, /坐标必须是数字/);
  });
});
