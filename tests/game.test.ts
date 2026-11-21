/**
 * game() 测试。
 *
 * 全程走内存文件系统 + 内存窗口数据：不落盘、不开浏览器。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_GAME_TITLE, renderGameHtml } from '../src/index';
import { errorCodes, runFiles } from './support';

/** 把一段 game 声明拼进完整的 __init__ 里 */
function program(body: string, header = '#incloud game\n'): string {
  return `${header}\n__init__ {\n    main() { say("跑完了") }\n\n${body}\n}\n`;
}

const ONE_GAME = `    game() {
        game.init() {
            display.win(1000, 800)
            display.head("lemon")
        }
    }`;

describe('game：产出窗口', () => {
  it('main() 照常跑，同时产出一份窗口数据', () => {
    const out = runFiles('app.lemon1', { 'app.lemon1': program(ONE_GAME) });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '跑完了\n');
    assert.deepEqual(out.game, { width: 1000, height: 800, title: 'lemon' });
  });

  it('没有 game() 时 game 是 null', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '#incloud game\n\n__init__ {\n    main() { say("纯终端") }\n}\n',
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '纯终端\n');
    assert.equal(out.game, null);
  });

  it('没写 display.head 时用缺省标题', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program('    game() {\n        game.init() {\n            display.win(320, 240)\n        }\n    }'),
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.deepEqual(out.game, { width: 320, height: 240, title: DEFAULT_GAME_TITLE });
  });

  it('display.win / display.head 可以引用 __init__ 顶层变量', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': `#incloud game

__init__ {
    int 宽 = 640
    text 名字 = "小搓"

    main() { say("开始") }

    game() {
        game.init() {
            display.win(宽, 480)
            display.head(名字)
        }
    }
}
`,
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '开始\n');
    assert.deepEqual(out.game, { width: 640, height: 480, title: '小搓' });
  });

  it('game() 与 websets() 可以并存', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': `#incloud web
#incloud game

__init__ {
    main() { say("两个都产") }

    websets() {
        web.init() {
            button { to "localhost:9000" }
        }
    }

    game() {
        game.init() {
            display.win(100, 200)
            display.head("g")
        }
    }
}
`,
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.deepEqual(out.game, { width: 100, height: 200, title: 'g' });
    assert.deepEqual(out.page?.nodes, [
      { kind: 'button', target: 'localhost:9000', href: 'http://localhost:9000' },
    ]);
  });
});

describe('game：运行状态 game.running / game.quit', () => {
  it('game.running = true 能赋值，if game.quit == true 条件为假时不进分支', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': `#incloud game

__init__ {
    game() {
        game.init() {
            display.win(320, 240)
        }
    }

    main() {
        game.running = true
        say(game.running)
        if game.quit == true {
            game.running = false
        }
        say(game.running)
    }
}
`,
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, 'true\ntrue\n');
  });

  it('条件为真时进入分支并改写 game.running', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': `#incloud game

__init__ {
    main() {
        game.running = true
        game.quit = true
        if game.quit == true {
            game.running = false
        }
        say(game.running)
    }
}
`,
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, 'false\n');
  });

  it('game 是上下文关键字，say(game) 仍是裸文本', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '#incloud game\n\n__init__ {\n    main() { say(game) }\n}\n',
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, 'game\n');
  });
});

describe('game：需要 #incloud game', () => {
  it('没启用模块时报 E0335 并点名要补哪一行', () => {
    const out = runFiles('app.lemon1', { 'app.lemon1': program(ONE_GAME, '') });
    assert.equal(out.ok, false);
    assert.deepEqual(errorCodes(out.diagnostics), ['E0335']);
    assert.match(out.diagnostics[0].message, /game\(\) 需要 game 能力模块/);
    assert.match(out.diagnostics[0].hint ?? '', /#incloud game/);
    assert.equal(out.game, null);
  });
});

describe('game：结构校验', () => {
  it('缺 game.init()：E0336', () => {
    const out = runFiles('app.lemon1', { 'app.lemon1': program('    game() {\n    }') });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0336']);
    assert.match(out.diagnostics[0].message, /缺少 game\.init\(\)/);
  });

  it('未知元素：E0337', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program('    game() {\n        game.init() {\n            thing.win(1, 2)\n        }\n    }'),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0337']);
    assert.match(out.diagnostics[0].message, /不认识元素 thing/);
  });

  it('display.win 的宽高必须是 int：E0307', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program('    game() {\n        game.init() {\n            display.win(1.5, 800)\n        }\n    }'),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0307']);
    assert.match(out.diagnostics[0].message, /宽高必须是 int/);
  });

  it('display.head 的标题必须是 text：E0307', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program('    game() {\n        game.init() {\n            display.head(123)\n        }\n    }'),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0307']);
    assert.match(out.diagnostics[0].message, /标题必须是 text/);
  });

  it('game() 只能声明一次：E0306', () => {
    const out = runFiles('app.lemon1', { 'app.lemon1': program(`${ONE_GAME}\n\n${ONE_GAME}`) });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0306']);
    assert.match(out.diagnostics[0].message, /只能声明一次/);
  });

  it('game() 不能带参数：E0202', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program('    game(1) {\n        game.init() {\n        }\n    }'),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0202']);
    assert.match(out.diagnostics[0].message, /不能带参数/);
  });

  it('game() 不能写在函数体里：E0201', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': `#incloud game

__init__ {
    main() {
        game() {
            game.init() {
            }
        }
    }
}
`,
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0201']);
    assert.match(out.diagnostics[0].message, /只能写在 __init__ 顶层/);
  });
});

describe('game：赋值语句的限制', () => {
  it('给普通对象赋值：E0338（普通变量仍不可重新赋值）', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '#incloud game\n\n__init__ {\n    main() {\n        foo.bar = 1\n    }\n}\n',
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0338']);
    assert.match(out.diagnostics[0].message, /不能给 foo\.bar 赋值/);
  });

  it('game 的未知字段：E0338', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '#incloud game\n\n__init__ {\n    main() {\n        game.started = true\n    }\n}\n',
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0338']);
    assert.match(out.diagnostics[0].message, /没有可赋值的字段 'started'/);
  });

  it('值必须是 bool：E0307', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '#incloud game\n\n__init__ {\n    main() {\n        game.running = 1\n    }\n}\n',
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0307']);
    assert.match(out.diagnostics[0].message, /只能赋 bool/);
  });

  it('普通变量重新赋值仍照旧报错（不可变性未被破坏）', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': '__init__ {\n    main() {\n        int a = 1\n        a = 2\n    }\n}\n',
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0201']);
  });
});

describe('game：HTML 渲染', () => {
  it('画布尺寸与标题写进页面，标题会转义', () => {
    const html = renderGameHtml({ width: 1000, height: 800, title: 'le<mon>' });
    assert.match(html, /<canvas id="game" width="1000" height="800">/);
    assert.match(html, /<title>le&lt;mon&gt;<\/title>/);
    assert.doesNotMatch(html, /<mon>/);
  });
});
