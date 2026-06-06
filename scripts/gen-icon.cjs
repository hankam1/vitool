// Генерация исходной иконки app-icon.png (1024×1024) без внешних зависимостей.
// Тёмный скруглённый квадрат + акцентный «ромб» (бренд ◆). 2× суперсэмплинг для гладких краёв.
// Затем: npm run tauri icon app-icon.png  → создаст весь набор (png/ico/icns).

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const OUT = 1024;
const SS = 2;
const HI = OUT * SS;

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// SDF скруглённого прямоугольника (нормализованные координаты, центр 0.5)
function sdfRoundRect(fx, fy, half, r) {
  const qx = Math.abs(fx - 0.5) - (half - r);
  const qy = Math.abs(fy - 0.5) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const BG_TOP = [22, 22, 26];
const BG_BOT = [11, 11, 13];
const AC_TOP = [42, 147, 255];
const AC_BOT = [10, 111, 224];

function sample(fx, fy) {
  // за пределами скруглённого квадрата — прозрачно
  const sdf = sdfRoundRect(fx, fy, 0.5, 0.22);
  if (sdf > 0) return [0, 0, 0, 0];

  let col = mix(BG_TOP, BG_BOT, fy);

  // лёгкий верхний блик
  const hl = Math.max(0, 1 - fy * 2.2) * 10;
  col = [col[0] + hl, col[1] + hl, col[2] + hl];

  // ромб (бренд)
  const d = Math.abs(fx - 0.5) + Math.abs(fy - 0.5);
  if (d <= 0.30) {
    const t = (fy - 0.2) / 0.6; // вертикальный градиент акцента
    col = mix(AC_TOP, AC_BOT, Math.min(1, Math.max(0, t)));
    // внутренняя «вырезка» — тонкая тёмная грань для глубины
    if (d > 0.27) col = mix(col, [0, 0, 0], 0.15);
  }

  return [col[0], col[1], col[2], 255];
}

// Рендер hi-res
const hi = Buffer.alloc(HI * HI * 4);
for (let y = 0; y < HI; y++) {
  for (let x = 0; x < HI; x++) {
    const [r, g, b, a] = sample((x + 0.5) / HI, (y + 0.5) / HI);
    const i = (y * HI + x) * 4;
    hi[i] = Math.round(r); hi[i + 1] = Math.round(g); hi[i + 2] = Math.round(b); hi[i + 3] = a;
  }
}

// Даунсэмпл 2×2 box-filter → OUT×OUT
const rgba = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * HI + (x * SS + dx)) * 4;
        const af = hi[i + 3] / 255;
        r += hi[i] * af; g += hi[i + 1] * af; b += hi[i + 2] * af; a += hi[i + 3];
      }
    }
    const n = SS * SS;
    const af = a / 255;
    const o = (y * OUT + x) * 4;
    rgba[o] = af ? Math.round(r / af) : 0;
    rgba[o + 1] = af ? Math.round(g / af) : 0;
    rgba[o + 2] = af ? Math.round(b / af) : 0;
    rgba[o + 3] = Math.round(a / n);
  }
}

// Кодирование PNG (RGBA, 8 бит)
function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, data) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const outPath = path.resolve(__dirname, "..", "app-icon.png");
fs.writeFileSync(outPath, encodePng(OUT, OUT, rgba));
console.log("Создан", outPath, `(${OUT}×${OUT})`);
