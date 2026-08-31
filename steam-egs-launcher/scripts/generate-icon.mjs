// Generates the app icon (resources/icon.ico + resources/icon.png) with zero
// dependencies: shapes are rasterized in JS (signed-distance functions with
// 4x supersampling), PNGs are written via the built-in zlib, and the .ico is
// a plain PNG-entry container (supported since Windows Vista).
//
// The mark: two fanned "game cards" (a light Epic-ish one behind, a Steam-blue
// one in front with a play triangle) on a dark rounded square — the merged
// library in one picture. Regenerate any time with `npm run gen:icon`.

import { deflateSync } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const MASTER = 1024; // rendered once, then area-downsampled to every ico size
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];

// ---------- tiny SDF rasterizer ----------

/** Rounded-rectangle SDF for a point in the shape's local space. */
function sdRoundRect(x, y, halfW, halfH, radius) {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Signed distance to a convex CCW polygon (negative inside). */
function sdConvexPoly(x, y, pts) {
  let inside = true;
  let minEdge = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const ex = x2 - x1;
    const ey = y2 - y1;
    const px = x - x1;
    const py = y - y1;
    const cross = ex * py - ey * px; // >0 = left of edge (CCW polygon → inside)
    if (cross < 0) inside = false;
    // Distance to the edge segment.
    const t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
    minEdge = Math.min(minEdge, Math.hypot(px - t * ex, py - t * ey));
  }
  return inside ? -minEdge : minEdge;
}

const coverage = (dist, aa) => Math.max(0, Math.min(1, 0.5 - dist / aa));

function rotate(x, y, deg) {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a)];
}

/** Renders the master RGBA bitmap. All geometry in 0..1 unit space. */
function renderMaster(size) {
  const img = new Uint8Array(size * size * 4);
  const aa = 1.5 / size; // anti-aliasing width in unit space

  // Card geometry (unit space, centered coords).
  const backTilt = -14;
  const frontTilt = 8;
  const cardW = 0.26;
  const cardH = 0.36;
  const cardR = 0.055;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const v = (py + 0.5) / size;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // Background: dark rounded square with a subtle vertical gradient.
      const bgD = sdRoundRect(u - 0.5, v - 0.5, 0.5, 0.5, 0.22);
      const bgC = coverage(bgD, aa);
      if (bgC > 0) {
        const t = v; // 0 top → 1 bottom
        r = 30 + (16 - 30) * t;
        g = 41 + (23 - 41) * t;
        b = 61 + (36 - 61) * t;
        a = 255 * bgC;

        // Back card (light, Epic-ish), fanned left, slightly up-left.
        {
          const [lx, ly] = rotate(u - 0.42, v - 0.47, backTilt);
          const d = sdRoundRect(lx, ly, cardW, cardH, cardR);
          const c = coverage(d, aa);
          if (c > 0) {
            const shade = 232 - 26 * ((ly + cardH) / (2 * cardH)); // soft top light
            r = r + (shade - r) * c;
            g = g + (shade + 4 - g) * c;
            b = b + (shade + 12 - b) * c;
          }
        }

        // Front card (Steam blue), fanned right, slightly down-right.
        {
          const [lx, ly] = rotate(u - 0.56, v - 0.55, frontTilt);
          const d = sdRoundRect(lx, ly, cardW, cardH, cardR);
          const c = coverage(d, aa);
          if (c > 0) {
            const t2 = (ly + cardH) / (2 * cardH);
            const cr = 77 + (43 - 77) * t2; // #4d9df0 → #2b6fd0
            const cg = 157 + (111 - 157) * t2;
            const cb = 240 + (208 - 240) * t2;
            r = r + (cr - r) * c;
            g = g + (cg - g) * c;
            b = b + (cb - b) * c;

            // Play triangle, white, in the front card's local space (CCW).
            const tri = sdConvexPoly(lx, ly, [
              [-0.077, -0.13],
              [0.154, 0],
              [-0.077, 0.13],
            ]);
            const tc = coverage(tri, aa);
            if (tc > 0) {
              r = r + (250 - r) * tc;
              g = g + (252 - g) * tc;
              b = b + (255 - b) * tc;
            }
          }
        }
      }

      const o = (py * size + px) * 4;
      img[o] = Math.round(r);
      img[o + 1] = Math.round(g);
      img[o + 2] = Math.round(b);
      img[o + 3] = Math.round(a);
    }
  }
  return img;
}

/** Area-average downsample (master size must be a multiple of target). */
function downsample(src, srcSize, dst) {
  const k = srcSize / dst;
  const out = new Uint8Array(dst * dst * 4);
  for (let y = 0; y < dst; y++) {
    for (let x = 0; x < dst; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < k; sy++) {
        for (let sx = 0; sx < k; sx++) {
          const o = ((y * k + sy) * srcSize + (x * k + sx)) * 4;
          r += src[o];
          g += src[o + 1];
          b += src[o + 2];
          a += src[o + 3];
        }
      }
      const n = k * k;
      const o = (y * dst + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------- PNG writer (RGBA8, no filtering) ----------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // Scanlines with filter byte 0.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO container ----------
//
// Windows only guarantees PNG-compressed entries for the 256px slot; the
// window frame and taskbar load the small sizes through the classic icon API,
// which chokes on PNG entries. So: 256 = PNG, everything smaller = classic
// uncompressed 32-bit BMP (bottom-up BGRA + an empty AND mask — alpha rules).

function encodeBmpEntry(rgba, size) {
  const header = Buffer.alloc(40); // BITMAPINFOHEADER
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND mask heights combined
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp

  const xor = Buffer.alloc(size * size * 4); // bottom-up BGRA
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = rgba[src + 2]; // B
      xor[dst + 1] = rgba[src + 1]; // G
      xor[dst + 2] = rgba[src]; // R
      xor[dst + 3] = rgba[src + 3]; // A
    }
  }
  // 1bpp AND mask, rows padded to 32 bits; all zero — transparency comes from alpha.
  const andMask = Buffer.alloc(size * (((size + 31) >> 5) * 4));
  return Buffer.concat([header, xor, andMask]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((p) => p.data)]);
}

// ---------- main ----------

console.log('Rendering master bitmap…');
const master = renderMaster(MASTER);

const images = ICO_SIZES.map((size) => {
  const rgba = downsample(master, MASTER, size);
  return { size, data: size >= 256 ? encodePng(rgba, size) : encodeBmpEntry(rgba, size) };
});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco(images));
writeFileSync(join(OUT_DIR, 'icon.png'), encodePng(downsample(master, MASTER, 256), 256));
console.log(`Wrote resources/icon.ico (${ICO_SIZES.join('/')}) and resources/icon.png`);
