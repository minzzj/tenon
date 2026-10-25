// 榫卯 Tenon 节点 · 极简 PNG 编解码（纯 Node 内置模块，零外部依赖）
// 支持：8bit RGB / RGBA 真彩色、非隔行扫描。
// 损坏文件抛 PngError(code='CORRUPT')；不支持的格式抛 PngError(code='UNSUPPORTED')。
// 对外主要 API：
//   decodePng(buffer) -> { width, height, channels:4, data:Uint8Array(RGBA) }
//   encodePng({width,height,data,channels?}) -> Buffer
//   cropCenter(imageOrBuffer, size) -> { width:size, height:size, channels:4, data }
//   cropPng(buffer, size) -> Buffer
// 居中裁剪规则：目标比原图小时取中心区域；目标比原图大时按居中位置补边（边缘像素复制），
// 因此输出始终是合法的 size×size PNG，不会因为样品图尺寸小而失败。
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 64 * 1024 * 1024;

export class PngError extends Error {
  constructor(message, code = 'CORRUPT') {
    super(message);
    this.name = 'PngError';
    this.code = code;
  }
}

const corrupt = (message) => new PngError(message, 'CORRUPT');
const unsupported = (message) => new PngError(message, 'UNSUPPORTED');

// ---------- CRC32（PNG 规范多项式 0xEDB88320） ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf, start = 0, end) {
  const stop = end === undefined ? buf.length : end;
  let c = 0xffffffff;
  for (let i = start; i < stop; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const chunk = Buffer.alloc(8 + body.length + 4);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk, 4, 8 + body.length), 8 + body.length);
  return chunk;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function toRgba(image) {
  const width = Number(image.width);
  const height = Number(image.height);
  let data = image.data;
  if (!(data instanceof Uint8Array)) data = Uint8Array.from(data || []);
  const channels = Number(image.channels) || (data.length === width * height * 3 ? 3 : 4);
  if (data.length !== width * height * channels) throw corrupt('图像像素数据长度与尺寸不符');
  if (channels === 4) return data;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * 3;
    const d = i * 4;
    out[d] = data[s];
    out[d + 1] = data[s + 1];
    out[d + 2] = data[s + 2];
    out[d + 3] = 255;
  }
  return out;
}

// ---------- 解码 ----------
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buf.length) throw corrupt('PNG 文件为空（0 字节）');
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw corrupt('不是有效的 PNG 文件（签名不符）');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  let ended = false;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw corrupt(`PNG 数据被截断（${type || '未知'} 块不完整）`);
    const expectedCrc = buf.readUInt32BE(dataEnd);
    if (expectedCrc !== crc32(buf, pos + 4, dataEnd)) throw corrupt(`PNG 校验失败（${type || '未知'} 块 CRC 不符）`);
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (length !== 13) throw corrupt('PNG 头信息（IHDR）长度异常');
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
      pos = dataEnd + 4;
      break;
    }
    pos = dataEnd + 4;
  }
  if (!ihdr) throw corrupt('PNG 缺少 IHDR 头信息');
  if (!idat.length) throw corrupt('PNG 缺少图像数据（IDAT）');
  if (!ended) throw corrupt('PNG 缺少结束标记（IEND），文件可能不完整');
  const { width, height, bitDepth, colorType, compression, filter, interlace } = ihdr;
  if (!width || !height) throw corrupt('PNG 尺寸非法（宽或高为 0）');
  if (width * height > MAX_PIXELS) throw unsupported('PNG 尺寸过大（超过 64M 像素）');
  if (bitDepth !== 8) throw unsupported(`不支持 ${bitDepth} 位深的 PNG（仅支持 8bit RGB/RGBA）`);
  if (colorType !== 2 && colorType !== 6) throw unsupported(`不支持颜色类型 ${colorType} 的 PNG（仅支持 RGB/RGBA 真彩色）`);
  if (compression !== 0 || filter !== 0) throw unsupported('不支持的 PNG 压缩或过滤方法');
  if (interlace !== 0) throw unsupported('不支持隔行扫描（interlace=1）的 PNG');
  const channels = colorType === 6 ? 4 : 3;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  } catch {
    throw corrupt('PNG 图像数据无法解压（文件损坏）');
  }
  const stride = width * channels;
  const needed = (stride + 1) * height;
  if (raw.length < needed) throw corrupt('PNG 像素数据不完整（文件损坏）');
  const data = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    const filterType = raw[base];
    if (filterType > 4) throw corrupt(`PNG 行过滤类型异常（${filterType}）`);
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[base + 1 + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = y > 0 ? prev[x] : 0;
      const upLeft = y > 0 && x >= channels ? prev[x - channels] : 0;
      let value;
      if (filterType === 0) value = rawByte;
      else if (filterType === 1) value = rawByte + left;
      else if (filterType === 2) value = rawByte + up;
      else if (filterType === 3) value = rawByte + ((left + up) >> 1);
      else value = rawByte + paeth(left, up, upLeft);
      row[x] = value & 0xff;
    }
    const outBase = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const o = outBase + x * 4;
      data[o] = row[s];
      data[o + 1] = row[s + 1];
      data[o + 2] = row[s + 2];
      data[o + 3] = channels === 4 ? row[s + 3] : 255;
    }
    prev = row.slice();
  }
  return { width, height, channels: 4, sourceChannels: channels, colorType, bitDepth, data };
}

// ---------- 编码 ----------
export function encodePng(image) {
  if (!image || typeof image !== 'object') throw new PngError('encodePng 需要 { width, height, data }');
  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new PngError('PNG 尺寸非法');
  if (width * height > MAX_PIXELS) throw unsupported('PNG 尺寸过大（超过 64M 像素）');
  let data = image.data;
  if (!(data instanceof Uint8Array)) data = Uint8Array.from(data || []);
  const channels = Number(image.channels) || (data.length === width * height * 3 ? 3 : 4);
  if (channels !== 3 && channels !== 4) throw new PngError('PNG 通道数只支持 3(RGB) / 4(RGBA)');
  if (data.length !== width * height * channels) throw new PngError('PNG 像素数据长度与尺寸不符');
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    raw[base] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), base + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([SIGNATURE, makeChunk('IHDR', ihdr), makeChunk('IDAT', idat), makeChunk('IEND', Buffer.alloc(0))]);
}

// ---------- 居中裁剪 ----------
export function cropCenter(input, size) {
  const target = Number(size);
  if (!Number.isInteger(target) || target < 1) throw new PngError(`裁剪尺寸非法：${size}`);
  if (target > 8192) throw unsupported('裁剪尺寸过大（上限 8192）');
  const isBuffer = Buffer.isBuffer(input) || input instanceof Uint8Array;
  const image = isBuffer ? decodePng(Buffer.from(input)) : input;
  if (!image || typeof image !== 'object') throw new PngError('cropCenter 需要解码后的图像对象或 PNG Buffer');
  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new PngError('图像尺寸非法');
  const src = toRgba(image);
  const offX = Math.floor((width - target) / 2);
  const offY = Math.floor((height - target) / 2);
  const out = new Uint8Array(target * target * 4);
  for (let y = 0; y < target; y += 1) {
    const sy = clamp(offY + y, 0, height - 1);
    for (let x = 0; x < target; x += 1) {
      const sx = clamp(offX + x, 0, width - 1);
      const si = (sy * width + sx) * 4;
      const di = (y * target + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return { width: target, height: target, channels: 4, data: out };
}

export function cropPng(input, size) {
  return encodePng(cropCenter(decodePng(input), size));
}

// 兼容两种调用：crop(pngBuffer, 256) -> Buffer；crop(decodedImage, 256) -> 图像对象
export function crop(input, size) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) return cropPng(input, size);
  return cropCenter(input, size);
}

// 只读 IHDR，不解码像素（用于快速校验输出）
export function pngSize(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) throw corrupt('不是有效的 PNG 文件');
  const length = buf.readUInt32BE(8);
  const type = buf.toString('ascii', 12, 16);
  if (type !== 'IHDR' || length !== 13) throw corrupt('PNG 缺少 IHDR 头信息');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) throw corrupt('PNG 尺寸非法');
  return { width, height };
}

export function isPng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  return buf.length >= 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

export { decodePng as decode, encodePng as encode, cropPng as cropPngCenter };
export default { PngError, crc32, decodePng, encodePng, cropCenter, cropPng, crop, pngSize, isPng };
