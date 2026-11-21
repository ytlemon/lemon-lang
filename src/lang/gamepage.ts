/**
 * game() 的产出：窗口数据 + HTML 渲染。
 *
 * 求值器只负责把描述跑成一份**纯数据**（GameWindow），渲染成 HTML 是这里的事。
 * 与 websets() 的 webpage.ts 同一套分工：求值器不碰字符串模板，渲染器不需要环境。
 *
 * 生成的是**自包含**页面：样式内联、不引用任何外部资源，双击 .html 就能看。
 * 窗口用一块 <canvas> 表示，尺寸就是 display.win(宽, 高) 里写的值。
 */

/** game.init() 求值后的最终形态 */
export interface GameWindow {
  width: number;
  height: number;
  /** 窗口标题，来自 display.head(...)；缺省为 Lemon Game */
  title: string;
}

/** 缺省标题（没写 display.head 时用） */
export const DEFAULT_GAME_TITLE = 'Lemon Game';

/** 渲染成一份自包含的 HTML —— 一块指定尺寸的画布，外面套一层"窗口"边框 */
export function renderGameHtml(window: GameWindow): string {
  const safeTitle = escapeText(window.title);
  const width = window.width;
  const height = window.height;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 24px 16px;
    display: grid; place-items: center;
    background: radial-gradient(120% 120% at 50% 0%, #1e293b 0%, #0b1120 55%, #05070f 100%);
    color: #e2e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .window {
    border-radius: 12px; overflow: hidden;
    border: 1px solid rgba(148,163,184,.28);
    box-shadow: 0 24px 60px -24px rgba(0,0,0,.9);
    background: #0b1120;
  }
  .titlebar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    background: linear-gradient(180deg, rgba(148,163,184,.16), rgba(148,163,184,.06));
    border-bottom: 1px solid rgba(148,163,184,.28);
    font-size: 13px; font-weight: 600; letter-spacing: .02em;
  }
  .dots { display: flex; gap: 6px; }
  .dots i { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
  .dots i:nth-child(1) { background: #ff5f57; }
  .dots i:nth-child(2) { background: #febc2e; }
  .dots i:nth-child(3) { background: #28c840; }
  canvas { display: block; background: #05070f; }
  footer { margin-top: 16px; color: #55637a; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div>
  <div class="window" style="width:${width}px">
    <div class="titlebar"><span class="dots"><i></i><i></i><i></i></span>${safeTitle}</div>
    <canvas id="game" width="${width}" height="${height}"></canvas>
  </div>
  <footer>由 Lemon 生成 · game() · ${width}×${height}</footer>
</div>
<script>
  // 一块空的画布起点：真正的游戏逻辑可以在这里继续往上写
  (function () {
    var canvas = document.getElementById('game');
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#7c8aa3';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('${safeTitle}', canvas.width / 2, canvas.height / 2);
  })();
</script>
</body>
</html>
`;
}

/** 文本节点转义 */
function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
