// 榫卯 v2 · 素材中心 · 元数据 / 缩略图 / EXIF
// sharp 为可选依赖（懒加载）：未安装时图片仅记录基础元数据，不影响非图片入库。
import fs from 'node:fs';
import path from 'node:path';

export const THUMB_SIZES = [320, 640];
export const THUMB_QUALITY = 82;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', svg: 'image/svg+xml',
  avif: 'image/avif', ico: 'image/x-icon',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', gz: 'application/gzip',
  exe: 'application/octet-stream', apk: 'application/vnd.android.package-archive',
};

const KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image',
  tif: 'image', tiff: 'image', heic: 'image', svg: 'image', avif: 'image', ico: 'image',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio',
  pdf: 'pdf',
  doc: 'doc', docx: 'doc',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet',
  ppt: 'slide', pptx: 'slide',
  txt: 'text', md: 'text', json: 'text', log: 'text',
  zip: 'archive', '7z': 'archive', rar: 'archive', gz: 'archive',
};

/** 由文件名推断 { kind, ext, mime }。 */
export function kindOf(name) {
  const ext = (path.extname(String(name || '')).slice(1) || '').toLowerCase();
  return { kind: KIND[ext] || 'other', ext, mime: MIME[ext] || 'application/octet-stream' };
}

export function isImageName(name) {
  return kindOf(name).kind === 'image';
}

// ---------- sharp 懒加载 ----------
let sharpPromise = null;

export function getSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((mod) => mod.default || mod)
      .catch((err) => {
        sharpPromise = null;
        throw err;
      });
  }
  return sharpPromise;
}

export async function depsStatus() {
  const out = { sharp: false, sharpVersion: null, error: null };
  try {
    const sharp = await getSharp();
    out.sharp = true;
    out.sharpVersion = (sharp.versions && sharp.versions.sharp) || null;
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  return out;
}

// ---------- EXIF（最小 TIFF/EXIF 解析，基础字段） ----------
const EXIF_TAGS = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISO',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x920a: 'FocalLength',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0x0100: 'ImageWidth',
  0x0101: 'ImageLength',
  0x011c: 'PlanarConfiguration',
  0x9209: 'Flash',
  0xa433: 'LensMake',
  0xa434: 'LensModel',
};

const EXIF_EXIF_IFD = 0x8769;
const EXIF_GPS_IFD = 0x8825;

function readExifValue(tiff, le, type, count, valueOffset, entryOffset) {
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const unit = TYPE_SIZE[type];
  if (!unit) return null;
  const total = unit * count;
  const base = total <= 4 ? entryOffset + 8 : valueOffset; // 超过 4 字节的值存在 offset 处
  if (base < 0 || base + total > tiff.length) return null;
  const rd16 = (p) => (le ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p));
  const rd32 = (p) => (le ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p));
  try {
    if (type === 2) return tiff.toString('utf8', base, base + count).replace(/\u0000+$/, '').trim();
    if (type === 3) {
      const arr = [];
      for (let i = 0; i < count; i += 1) arr.push(rd16(base + i * 2));
      return count === 1 ? arr[0] : arr;
    }
    if (type === 4) {
      const arr = [];
      for (let i = 0; i < count; i += 1) arr.push(rd32(base + i * 4));
      return count === 1 ? arr[0] : arr;
    }
    if (type === 5) {
      const arr = [];
      for (let i = 0; i < count; i += 1) {
        const num = rd32(base + i * 8);
        const den = rd32(base + i * 8 + 4);
        arr.push(den ? Number((num / den).toFixed(4)) : 0);
      }
      return count === 1 ? arr[0] : arr;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 解析 sharp metadata().exif（Buffer，可能带 "Exif\0\0" 头）为基础 EXIF 字段。
 * 失败返回 {}，不抛异常（不影响入库）。
 */
export function parseExifBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 8) return {};
  try {
    let start = 0;
    if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'Exif') start = 6;
    const tiff = buf.subarray(start);
    if (tiff.length < 8) return {};
    const order = tiff.toString('ascii', 0, 2);
    if (order !== 'II' && order !== 'MM') return {};
    const le = order === 'II';
    const rd16 = (p) => (le ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p));
    const rd32 = (p) => (le ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p));
    const out = {};
    const exifIfds = [];
    const readIfd = (offset, depth = 0) => {
      if (depth > 3 || !offset || offset + 2 > tiff.length) return;
      const entries = rd16(offset);
      for (let i = 0; i < entries; i += 1) {
        const e = offset + 2 + i * 12;
        if (e + 12 > tiff.length) break;
        const tag = rd16(e);
        const type = rd16(e + 2);
        const count = rd32(e + 4);
        const valueOffset = rd32(e + 8);
        if (tag === EXIF_EXIF_IFD) {
          exifIfds.push(valueOffset);
          continue;
        }
        if (tag === EXIF_GPS_IFD) continue; // P0 不解析 GPS
        const name = EXIF_TAGS[tag];
        if (!name) continue;
        const value = readExifValue(tiff, le, type, count, valueOffset, e);
        if (value !== null && value !== undefined && value !== '') out[name] = value;
      }
    };
    const ifd0 = rd32(4);
    readIfd(ifd0);
    for (const p of exifIfds) readIfd(p, 1);
    return out;
  } catch {
    return {};
  }
}

// ---------- 探测与缩略图 ----------
export async function probeFile(filePath, name) {
  const info = kindOf(name || filePath);
  const out = { ...info, image: null, exif: null, imageError: null };
  if (info.kind !== 'image') return out;
  try {
    const sharp = await getSharp();
    const m = await sharp(filePath).metadata();
    out.image = {
      width: m.width || null,
      height: m.height || null,
      format: m.format || null,
      space: m.space || null,
      hasAlpha: !!m.hasAlpha,
      orientation: typeof m.orientation === 'number' ? m.orientation : null,
    };
    out.exif = parseExifBuffer(m.exif);
  } catch (err) {
    out.imageError = String((err && err.message) || err);
  }
  return out;
}

/** 生成 webp 缩略图（默认 320/640，等比内缩、自动转正）。返回 { 320: absPath, 640: absPath }。 */
export async function makeThumbnails(filePath, { outDir, key, sizes = THUMB_SIZES, quality = THUMB_QUALITY } = {}) {
  if (!outDir || !key) throw new Error('makeThumbnails 需要 outDir 与 key');
  const sharp = await getSharp();
  fs.mkdirSync(outDir, { recursive: true });
  const out = {};
  for (const size of sizes) {
    const dest = path.join(outDir, key + '-' + size + '.webp');
    const tmp = dest + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 6);
    await sharp(filePath)
      .rotate()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toFile(tmp);
    let ok = false;
    for (let i = 0; i < 3 && !ok; i += 1) {
      try {
        fs.renameSync(tmp, dest);
        ok = true;
      } catch { /* retry */ }
    }
    if (!ok) {
      fs.copyFileSync(tmp, dest);
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
    out[size] = dest;
  }
  return out;
}

/** 对已有 webp 缩略图按需缩放（用于 ?w= 非 320/640 的请求）。 */
export async function resizeWebp(buffer, width, quality = THUMB_QUALITY) {
  const sharp = await getSharp();
  return sharp(buffer)
    .resize(width, width, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
}