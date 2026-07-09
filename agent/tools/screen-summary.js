#!/usr/bin/env node
import { execFileSync } from "child_process";
import { readFileSync, rmSync } from "fs";

const out = process.argv[2] || "/tmp/mim-screen-summary.xwd";
const display = process.env.DISPLAY || ":99";

execFileSync("xwd", ["-root", "-silent", "-out", out], {
  env: { ...process.env, DISPLAY: display },
  stdio: ["ignore", "ignore", "pipe"],
});

const buf = readFileSync(out);

function headerEndian() {
  const beSize = buf.readUInt32BE(0);
  const leSize = buf.readUInt32LE(0);
  const beVersion = buf.readUInt32BE(4);
  const leVersion = buf.readUInt32LE(4);
  if (leVersion === 7 && leSize >= 100 && leSize < 10000) return "LE";
  if (beVersion === 7 && beSize >= 100 && beSize < 10000) return "BE";
  throw new Error("Could not parse XWD header");
}

const endian = headerEndian();
const u32 = (offset) =>
  endian === "LE" ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);

const headerSize = u32(0);
const width = u32(16);
const height = u32(20);
const byteOrder = u32(28);
const bitsPerPixel = u32(44);
const bytesPerLine = u32(48);
const redMask = u32(56);
const greenMask = u32(60);
const blueMask = u32(64);
const ncolors = u32(76);
const dataOffset = headerSize + ncolors * 12;

if (bitsPerPixel !== 32 && bitsPerPixel !== 24) {
  throw new Error(`Unsupported XWD bits_per_pixel=${bitsPerPixel}`);
}

function maskShift(mask) {
  let shift = 0;
  while (((mask >>> shift) & 1) === 0 && shift < 32) shift++;
  return shift;
}

function maskBits(mask) {
  let bits = 0;
  for (let m = mask >>> 0; m; m >>>= 1) bits += m & 1;
  return bits;
}

const shifts = {
  r: maskShift(redMask),
  g: maskShift(greenMask),
  b: maskShift(blueMask),
};
const bits = {
  r: maskBits(redMask),
  g: maskBits(greenMask),
  b: maskBits(blueMask),
};

function scale(value, count) {
  const max = (1 << count) - 1;
  return Math.round((value * 255) / max);
}

function pixelAt(offset) {
  let p;
  if (bitsPerPixel === 32) {
    p = byteOrder === 0 ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
  } else {
    const b0 = buf[offset], b1 = buf[offset + 1], b2 = buf[offset + 2];
    p = byteOrder === 0 ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
  }
  return {
    r: scale((p & redMask) >>> shifts.r, bits.r),
    g: scale((p & greenMask) >>> shifts.g, bits.g),
    b: scale((p & blueMask) >>> shifts.b, bits.b),
  };
}

const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 12000)));
const colors = new Map();
let saturated = 0;
let bright = 0;

for (let y = 0; y < height; y += step) {
  for (let x = 0; x < width; x += step) {
    const offset = dataOffset + y * bytesPerLine + x * (bitsPerPixel / 8);
    if (offset + bitsPerPixel / 8 > buf.length) continue;
    const { r, g, b } = pixelAt(offset);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min > 80) saturated++;
    if (max > 180) bright++;
    const key = [r, g, b].map((v) => Math.round(v / 32) * 32).join(",");
    colors.set(key, (colors.get(key) || 0) + 1);
  }
}

const top = [...colors.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([rgb, count]) => {
    const hex =
      "#" +
      rgb
        .split(",")
        .map((v) => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, "0"))
        .join("");
    return `${hex} ${count}`;
  });

console.log(`display=${display}`);
console.log(`size=${width}x${height} bpp=${bitsPerPixel} sample_step=${step}`);
console.log(`bright_samples=${bright} saturated_samples=${saturated}`);
console.log("top_colors:");
for (const line of top) console.log(`  ${line}`);

try {
  rmSync(out);
} catch {
  // leave capture for inspection if deletion fails
}
