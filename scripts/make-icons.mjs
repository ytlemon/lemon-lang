/**
 * 生成扩展的图标（PNG，无第三方依赖）。
 *
 * 产出三个文件：
 *   vscode-lemon/icons/lemon-light.png  浅色主题下的 .lemon1 文件图标
 *   vscode-lemon/icons/lemon-dark.png   深色主题下的 .lemon1 文件图标
 *   vscode-lemon/icons/extension.png    扩展自身的图标（扩展面板 / Marketplace）
 *
 * 画的是柠檬果实本身（黄果子 + 绿叶），刻意**不用字母**：
 * 无图标扩展在扩展面板里会被自动生成一个"字母头像"，做成字母 L 的话
 * 跟那个兜底长得一样，用户根本分不清图标到底加载了没有。
 *
 * 用代码画而不是塞位图：手写光栅化 + 4 倍超采样就能得到锐利的边，
 * 改配色只是改两个常量。依赖 Node 自带的 zlib 直接编码 PNG。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'vscode-lemon', 'icons');

/* ------------------------------------------------------------------ */
/* PNG 编码                                                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/** rgba: Uint8Array，长度 = width * height * 4 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩
  ihdr[11] = 0; // 滤波
  ihdr[12] = 0; // 逐行

  // 每行前面加一个滤波字节 0
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* 形状：归一化坐标 0..1，返回该点是否在形状内                          */
/* ------------------------------------------------------------------ */

/** 可旋转的椭圆；rot 为弧度，顺时针为正 */
function insideEllipse(x, y, cx, cy, rx, ry, rot = 0) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  return (u / rx) ** 2 + (v / ry) ** 2 <= 1;
}

/*
 * 柠檬的构图（横向摆放）：
 *   - 果身：一个压扁的椭圆
 *   - 两端各一个小凸起：去掉它就像个鸡蛋，加上才像柠檬
 *   - 左上一道浅色高光：大尺寸下有体积感，缩到 16px 自然消失也不碍事
 *   - 右上一片斜着的绿叶：16px 下的主要识别特征
 */
const BODY = { cx: 0.5, cy: 0.62, rx: 0.38, ry: 0.3 };
// 凸起压扁一点、往果身里收一点：太大就成了"长耳朵"，太小又变回鸡蛋
const NUB_LEFT = { cx: 0.105, cy: 0.62, rx: 0.075, ry: 0.042 };
const NUB_RIGHT = { cx: 0.895, cy: 0.62, rx: 0.075, ry: 0.042 };
const SHEEN = { cx: 0.37, cy: 0.5, rx: 0.16, ry: 0.075 };
const LEAF = { cx: 0.635, cy: 0.25, rx: 0.175, ry: 0.072, rot: -0.6 };

function insideBody(x, y) {
  return (
    insideEllipse(x, y, BODY.cx, BODY.cy, BODY.rx, BODY.ry) ||
    insideEllipse(x, y, NUB_LEFT.cx, NUB_LEFT.cy, NUB_LEFT.rx, NUB_LEFT.ry) ||
    insideEllipse(x, y, NUB_RIGHT.cx, NUB_RIGHT.cy, NUB_RIGHT.rx, NUB_RIGHT.ry)
  );
}

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

/** 把调色板编成一个"给点返回颜色"的函数，供渲染器采样 */
function makeShade({ body, sheen, leaf }) {
  const cBody = hex(body);
  const cSheen = hex(sheen);
  const cLeaf = hex(leaf);
  return (x, y) => {
    // 叶子压在果身之上；高光必须夹在果身内，否则会飘在轮廓外面
    if (insideEllipse(x, y, LEAF.cx, LEAF.cy, LEAF.rx, LEAF.ry, LEAF.rot)) return cLeaf;
    if (!insideBody(x, y)) return null;
    if (insideEllipse(x, y, SHEEN.cx, SHEEN.cy, SHEEN.rx, SHEEN.ry)) return cSheen;
    return cBody;
  };
}

/** 4 倍超采样：每个输出像素取 16 个子样本，按覆盖率混合出平滑边缘 */
function render(size, shade) {
  const scale = 4;
  const rgba = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const px = (x + (sx + 0.5) / scale) / size;
          const py = (y + (sy + 0.5) / scale) / size;
          const c = shade(px, py);
          if (c === null) continue; // 透明
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }

      const covered = a / 255;
      if (covered === 0) continue;
      const at = (y * size + x) * 4;
      rgba[at] = Math.round(r / covered);
      rgba[at + 1] = Math.round(g / covered);
      rgba[at + 2] = Math.round(b / covered);
      rgba[at + 3] = Math.round(a / (scale * scale));
    }
  }

  return encodePng(size, size, rgba);
}

/* ------------------------------------------------------------------ */

mkdirSync(outDir, { recursive: true });

// 浅色背景要给果身加深（纯柠檬黄压在白底上几乎看不见），深色背景则用亮黄
const LIGHT = { body: '#EDB200', sheen: '#FFD75E', leaf: '#2E9E4A' };
const DARK = { body: '#FFD22E', sheen: '#FFEC9B', leaf: '#57C46A' };

const files = [
  ['lemon-light.png', 128, LIGHT],
  ['lemon-dark.png', 128, DARK],
  ['extension.png', 256, DARK],
];

for (const [name, size, palette] of files) {
  const png = render(size, makeShade(palette));
  writeFileSync(join(outDir, name), png);
  console.log(`${name}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log(`\n已写入 ${outDir}`);
