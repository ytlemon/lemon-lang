/**
 * websets() 的产出：页面数据 + HTML 渲染。
 *
 * 求值器只负责把描述跑成一份**纯数据**（WebPage 节点树），渲染成 HTML 是这里的事。
 * 这样分开的好处：求值器不碰文件与字符串模板，渲染器不需要环境与作用域，
 * 两边都能单独测。
 *
 * 生成的是**自包含**页面：样式内联、不引用任何外部资源，双击 .html 就能看。
 */

/** 一枚按钮：求值后的最终形态（地址已经是 text 值） */
export interface WebButtonNode {
  kind: 'button';
  /** 用户在 `to` 里写的原样地址 */
  target: string;
  /** 写进 href 的地址（自动补 http:// 前缀，见 resolveHref） */
  href: string;
}

/** div 的位置与尺寸（来自 `in (x1,y1;x2,y2)`，单位 px） */
export interface WebRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 一个 div：可选的位置盒子与颜色，里面可以再放按钮 / div / 文本 */
export interface WebDivNode {
  kind: 'div';
  /** 没写 `in(...)` 时为 null —— 按普通块级容器排布 */
  box: WebRect | null;
  /** 没写 `color=...` 时为 null */
  color: string | null;
  children: WebNode[];
}

/** 一段文本内容 */
export interface WebTextNode {
  kind: 'text';
  text: string;
}

export type WebNode = WebButtonNode | WebDivNode | WebTextNode;

export interface WebPage {
  nodes: WebNode[];
}

/** `localhost:9000`、`127.0.0.1:8080/x` 这类 host:port（冒号后直接是端口号） */
const HOST_PORT_RE = /^[^/\s:]+:\d+(?:[/?#].*)?$/;
/** 形如 scheme: 的前缀，如 `https:`、`mailto:`、`file:` */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 把 `to` 里的地址补成浏览器认得的写法。
 *
 * 坑在这里：`localhost:9000` 语法上是个合法的 URI（scheme 叫 `localhost`），
 * 所以 `href="localhost:9000"` 浏览器认为"这是个协议"，点了毫无反应。
 * 因此 host:port 必须显式补 `http://`，不能只看"有没有 scheme"。
 *
 *   localhost:9000        → http://localhost:9000
 *   example.com           → http://example.com
 *   https://example.com   → 原样
 *   mailto:a@b            → 原样
 */
export function resolveHref(target: string): string {
  const url = target.trim();
  if (HOST_PORT_RE.test(url)) return `http://${url}`;
  return SCHEME_RE.test(url) ? url : `http://${url}`;
}

/** 造一枚按钮节点（地址两端空白会被去掉，href 由 resolveHref 规范化） */
export function buttonNode(target: string): WebButtonNode {
  const trimmed = target.trim();
  return { kind: 'button', target: trimmed, href: resolveHref(trimmed) };
}

export function makePage(nodes: WebNode[]): WebPage {
  return { nodes };
}

/** 给页面写一句人话摘要（"2 个按钮 · 1 个 div" / "空页面"），页面副标题与 CLI 提示共用 */
export function describePage(page: WebPage): string {
  if (page.nodes.length === 0) return '空页面';
  const { buttons, divs } = countNodes(page.nodes);
  return summarize(buttons, divs);
}

/** 渲染成一份自包含的 HTML */
export function renderHtml(page: WebPage, title: string): string {
  const safeTitle = escapeText(title);
  const empty = page.nodes.length === 0;

  const stage = boundingBox(page.nodes);
  const stageStyle = stage === null ? '' : ` style="width:${px(stage.width)}px;height:${px(stage.height)}px"`;

  const body = empty
    ? '        <p class="empty">这个页面还是空的。在 websets() 里加一点内容：<br>button { to "localhost:9000" }、div (in (0,0;256,256); color=#ffffff) { 你好 }</p>'
    : renderNodes(page.nodes, 4);

  const subtitle = describePage(page);

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
    margin: 0; min-height: 100vh; padding: 40px 16px;
    display: grid; place-items: center;
    background: radial-gradient(120% 120% at 50% 0%, #1e293b 0%, #0b1120 55%, #05070f 100%);
    color: #e2e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  main { width: 100%; max-width: 640px; text-align: center; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; letter-spacing: .02em; }
  p.sub { margin: 0 0 24px; color: #7c8aa3; font-size: 13px; }
  nav { display: grid; gap: 12px; }
  .stage {
    position: relative; margin: 0 auto;
    border: 1px dashed rgba(148,163,184,.24); border-radius: 12px;
    overflow: hidden;
  }
  a.button {
    display: block; padding: 16px 20px; border-radius: 14px;
    text-decoration: none; color: #f8fafc; font-size: 15px; font-weight: 500;
    word-break: break-all;
    background: linear-gradient(180deg, rgba(148,163,184,.16), rgba(148,163,184,.06));
    border: 1px solid rgba(148,163,184,.28);
    box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, 0 8px 24px -12px rgba(0,0,0,.8);
    transition: transform .15s ease, border-color .15s ease, background .15s ease;
  }
  a.button:hover {
    transform: translateY(-2px);
    border-color: rgba(96,165,250,.65);
    background: linear-gradient(180deg, rgba(96,165,250,.22), rgba(96,165,250,.08));
  }
  a.button:active { transform: translateY(0); }
  div.box {
    position: absolute; border-radius: 10px;
    border: 1px solid rgba(148,163,184,.28);
    display: grid; align-content: center; justify-items: center; gap: 6px;
    padding: 6px; overflow: auto; text-align: center;
  }
  div.panel {
    border-radius: 10px; border: 1px solid rgba(148,163,184,.22);
    padding: 12px; display: grid; gap: 8px;
  }
  span.text { display: block; }
  p.empty { color: #7c8aa3; font-size: 14px; line-height: 1.7; }
  footer { margin-top: 24px; color: #55637a; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>${safeTitle}</h1>
  <p class="sub">${subtitle}</p>
  <nav>
    <div class="stage"${stageStyle}>
${body}
    </div>
  </nav>
  <footer>由 Lemon 生成 · websets()</footer>
</main>
</body>
</html>
`;
}

/** 把节点树渲染成 HTML；depth 是缩进层数（每层 2 空格） */
function renderNodes(nodes: WebNode[], depth: number): string {
  return nodes.map((node) => renderNode(node, depth)).join('\n');
}

function renderNode(node: WebNode, depth: number): string {
  const pad = '  '.repeat(depth);
  switch (node.kind) {
    case 'button':
      return `${pad}<a class="button" href="${escapeAttr(node.href)}">${escapeText(node.target)}</a>`;
    case 'text':
      return `${pad}<span class="text">${escapeText(node.text)}</span>`;
    case 'div': {
      const cls = node.box === null ? 'panel' : 'box';
      const style = node.box === null ? '' : ` style="${rectStyle(node.box, node.color)}"`;
      if (node.children.length === 0) {
        return `${pad}<div class="${cls}"${style}></div>`;
      }
      const inner = node.children.map((child) => renderNode(child, depth + 1)).join('\n');
      return `${pad}<div class="${cls}"${style}>\n${inner}\n${pad}</div>`;
    }
  }
}

/** 把位置盒子与颜色拼成行内样式 */
function rectStyle(rect: WebRect, color: string | null): string {
  const parts = [
    `left:${px(rect.left)}px`,
    `top:${px(rect.top)}px`,
    `width:${px(rect.width)}px`,
    `height:${px(rect.height)}px`,
  ];
  if (color !== null && color.trim() !== '') parts.push(`background:${color.trim()}`);
  return `${parts.join(';')}`;
}

/**
 * 顶层位置盒子围出来的画布尺寸：取所有带盒子 div 的最右 / 最下。
 * 一个带盒子的 div 都没有时返回 null（此时 stage 自适应高度）。
 *
 * 只统计**顶层**节点——嵌套 div 的坐标是相对父容器的，不该参与画布尺寸。
 */
function boundingBox(nodes: WebNode[]): { width: number; height: number } | null {
  let width = 0;
  let height = 0;
  let found = false;
  for (const node of nodes) {
    if (node.kind !== 'div' || node.box === null) continue;
    found = true;
    width = Math.max(width, node.box.left + node.box.width);
    height = Math.max(height, node.box.top + node.box.height);
  }
  return found ? { width: Math.max(0, width), height: Math.max(0, height) } : null;
}

function countNodes(nodes: WebNode[]): { buttons: number; divs: number } {
  let buttons = 0;
  let divs = 0;
  for (const node of nodes) {
    if (node.kind === 'button') buttons += 1;
    else if (node.kind === 'div') {
      divs += 1;
      const inner = countNodes(node.children);
      buttons += inner.buttons;
      divs += inner.divs;
    }
  }
  return { buttons, divs };
}

function summarize(buttons: number, divs: number): string {
  const parts: string[] = [];
  if (buttons > 0) parts.push(`${buttons} 个按钮`);
  if (divs > 0) parts.push(`${divs} 个 div`);
  return parts.length === 0 ? '没有可显示的内容' : parts.join(' · ');
}

/** px 长度：整数原样，小数最多保留 3 位，避免浮点尾巴 */
function px(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

/** 文本节点转义 */
function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 属性值转义（比文本多一层引号） */
function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}
