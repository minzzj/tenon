/* 榫卯 Tenon · 纯 JS 二维码（无依赖 / 无 CDN / 无外链字体）
 * 字节模式（UTF-8）、纠错等级 M、自动版本 1–10（约 100 字节内）、自动掩码。
 * 用法：
 *   window.TenonQR.render(canvas, 'tenon://pair?host=192.168.1.8:7410&code=123456', { size: 176, margin: 4 });
 *   window.TenonQR.matrix(text) -> { version, size, mask, modules: [[0|1]] }
 * 仅用于配对二维码等短内容；内容过长会抛错并由调用方降级为纯文本。
 */
(function (global) {
  'use strict';

  /* 纠错等级 M：每个版本 [ecPerBlock, blocksG1, dataG1, blocksG2, dataG2] */
  var VERSIONS_M = {
    1: [10, 1, 16, 0, 0],
    2: [16, 1, 28, 0, 0],
    3: [26, 1, 44, 0, 0],
    4: [18, 2, 32, 0, 0],
    5: [24, 2, 43, 0, 0],
    6: [16, 4, 27, 0, 0],
    7: [18, 4, 31, 0, 0],
    8: [22, 2, 38, 2, 39],
    9: [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44]
  };
  var ECL_M = 0; /* 格式信息里的纠错等级位：M = 0b00 */

  /* ---------- GF(256) ---------- */
  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
  })();
  function gfMul(a, b) { if (a === 0 || b === 0) return 0; return GF_EXP[GF_LOG[a] + GF_LOG[b]]; }
  function generatorPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(g.length + 1);
      for (var k = 0; k < next.length; k++) next[k] = 0;
      for (var j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
      }
      g = next;
    }
    return g;
  }
  function rsEncode(data, ecLen) {
    var gen = generatorPoly(ecLen);
    var res = new Array(ecLen);
    for (var i = 0; i < ecLen; i++) res[i] = 0;
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ res[0];
      for (var s = 0; s < ecLen - 1; s++) res[s] = res[s + 1];
      res[ecLen - 1] = 0;
      if (factor !== 0) {
        for (var j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return res;
  }

  /* ---------- UTF-8 ---------- */
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(str));
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  function totalDataCodewords(version) {
    var t = VERSIONS_M[version];
    return t[1] * t[2] + t[3] * t[4];
  }
  function chooseVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var need = 4 + (v <= 9 ? 8 : 16) + byteLen * 8;
      if (need <= totalDataCodewords(v) * 8) return v;
    }
    return null;
  }
  function pushBits(bits, value, len) {
    for (var i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  }
  function makeDataCodewords(bytes, version) {
    var totalData = totalDataCodewords(version);
    var cap = totalData * 8;
    var bits = [];
    pushBits(bits, 4, 4); /* byte mode = 0100 */
    pushBits(bits, bytes.length, version <= 9 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) pushBits(bits, bytes[i], 8);
    var term = Math.min(4, cap - bits.length);
    for (var t = 0; t < term; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    var codewords = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[b + j];
      codewords.push(v);
    }
    var pads = [0xec, 0x11];
    var pi = 0;
    while (codewords.length < totalData) codewords.push(pads[pi++ % 2]);
    return codewords;
  }
  function makeFinalCodewords(dataCw, version) {
    var t = VERSIONS_M[version];
    var ecLen = t[0];
    var blocks = [];
    var offset = 0;
    for (var i = 0; i < t[1]; i++) { blocks.push({ data: dataCw.slice(offset, offset + t[2]), ec: null }); offset += t[2]; }
    for (var k = 0; k < t[3]; k++) { blocks.push({ data: dataCw.slice(offset, offset + t[4]), ec: null }); offset += t[4]; }
    for (var bi = 0; bi < blocks.length; bi++) blocks[bi].ec = rsEncode(blocks[bi].data, ecLen);
    var out = [];
    var maxData = Math.max(t[2], t[4]);
    for (var col = 0; col < maxData; col++) {
      for (var b2 = 0; b2 < blocks.length; b2++) {
        if (col < blocks[b2].data.length) out.push(blocks[b2].data[col]);
      }
    }
    for (var e = 0; e < ecLen; e++) {
      for (var b3 = 0; b3 < blocks.length; b3++) out.push(blocks[b3].ec[e]);
    }
    return out;
  }
  function alignmentPositions(version) {
    if (version === 1) return [];
    var size = version * 4 + 17;
    var numAlign = Math.floor(version / 7) + 2;
    var step = Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
    var result = [];
    for (var i = 0, pos = size - 7; i < numAlign - 1; i++, pos -= step) result.unshift(pos);
    result.unshift(6);
    return result;
  }
  function maskFn(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return false;
    }
  }
  function getBit(value, i) { return ((value >>> i) & 1) !== 0; }

  function buildMatrix(version, codewords, mask) {
    var size = version * 4 + 17;
    var mod = [];
    var fun = [];
    for (var y = 0; y < size; y++) {
      var rowM = new Array(size);
      var rowF = new Array(size);
      for (var x = 0; x < size; x++) { rowM[x] = false; rowF[x] = false; }
      mod.push(rowM);
      fun.push(rowF);
    }
    function set(x, y, v) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      mod[y][x] = !!v;
      fun[y][x] = true;
    }
    function finder(cx, cy) {
      for (var dy = -1; dy <= 7; dy++) {
        for (var dx = -1; dx <= 7; dx++) {
          var xx = cx + dx;
          var yy = cy + dy;
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
          var inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
          var on = inside && ((dx === 0 || dx === 6 || dy === 0 || dy === 6) || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
          set(xx, yy, on);
        }
      }
    }
    finder(0, 0);
    finder(size - 7, 0);
    finder(0, size - 7);
    /* 定时图案 */
    for (var i = 8; i < size - 8; i++) {
      set(i, 6, i % 2 === 0);
      set(6, i, i % 2 === 0);
    }
    /* 对齐图案 */
    var pos = alignmentPositions(version);
    var last = pos.length - 1;
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
        var px = pos[a];
        var py = pos[b];
        for (var dy2 = -2; dy2 <= 2; dy2++) {
          for (var dx2 = -2; dx2 <= 2; dx2++) set(px + dx2, py + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
        }
      }
    }
    /* 版本信息区域（v7+ 先预留） */
    if (version >= 7) {
      for (var v = 0; v < 18; v++) {
        var ax = size - 11 + (v % 3);
        var ay = Math.floor(v / 3);
        set(ax, ay, false);
        set(ay, ax, false);
      }
    }
    /* 固定黑模块 + 格式信息区域预留 */
    set(8, size - 8, true);
    var fmt = [];
    for (var f1 = 0; f1 <= 5; f1++) fmt.push([8, f1]);
    fmt.push([8, 7], [8, 8], [7, 8]);
    for (var f2 = 9; f2 < 15; f2++) fmt.push([14 - f2, 8]);
    for (var f3 = 0; f3 < 8; f3++) fmt.push([size - 1 - f3, 8]);
    for (var f4 = 8; f4 < 15; f4++) fmt.push([8, size - 15 + f4]);
    for (var f = 0; f < fmt.length; f++) set(fmt[f][0], fmt[f][1], false);

    /* 数据位（之字形填充） */
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var xCol = right - j;
          var upward = ((right + 1) & 2) === 0;
          var yRow = upward ? size - 1 - vert : vert;
          if (fun[yRow][xCol]) continue;
          var dark = false;
          if (bitIndex < totalBits) {
            dark = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
            bitIndex++;
          }
          mod[yRow][xCol] = dark;
        }
      }
    }
    /* 掩码（只作用于数据模块） */
    for (var my = 0; my < size; my++) {
      for (var mx = 0; mx < size; mx++) {
        if (!fun[my][mx] && maskFn(mask, mx, my)) mod[my][mx] = !mod[my][mx];
      }
    }
    return { mod: mod, fun: fun, size: size };
  }

  function drawFormat(built, version, mask) {
    var size = built.size;
    var mod = built.mod;
    var data = (ECL_M << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    function setFmt(x, y, v) { mod[y][x] = v; }
    for (var a = 0; a <= 5; a++) setFmt(8, a, getBit(bits, a));
    setFmt(8, 7, getBit(bits, 6));
    setFmt(8, 8, getBit(bits, 7));
    setFmt(7, 8, getBit(bits, 8));
    for (var b = 9; b < 15; b++) setFmt(14 - b, 8, getBit(bits, b));
    for (var c = 0; c < 8; c++) setFmt(size - 1 - c, 8, getBit(bits, c));
    for (var d = 8; d < 15; d++) setFmt(8, size - 15 + d, getBit(bits, d));
    mod[size - 8][8] = true; /* 固定黑模块 */
    if (version >= 7) {
      var vrem = version;
      for (var k = 0; k < 12; k++) vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1f25);
      var vbits = (version << 12) | vrem;
      for (var v = 0; v < 18; v++) {
        var bit = getBit(vbits, v);
        var ax = size - 11 + (v % 3);
        var ay = Math.floor(v / 3);
        mod[ay][ax] = bit;
        mod[ax][ay] = bit;
      }
    }
  }

  function penalty(mod, size) {
    var score = 0;
    var x, y;
    for (y = 0; y < size; y++) {
      var run = 1;
      for (x = 1; x < size; x++) {
        if (mod[y][x] === mod[y][x - 1]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (x = 0; x < size; x++) {
      var runV = 1;
      for (y = 1; y < size; y++) {
        if (mod[y][x] === mod[y - 1][x]) runV++;
        else { if (runV >= 5) score += 3 + (runV - 5); runV = 1; }
      }
      if (runV >= 5) score += 3 + (runV - 5);
    }
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
      }
    }
    var pat = [true, false, true, true, true, false, true, false, false, false, false];
    var patInv = pat.slice().reverse();
    function matches(arr, start, p) {
      for (var i = 0; i < p.length; i++) if (arr[start + i] !== p[i]) return false;
      return true;
    }
    for (y = 0; y < size; y++) {
      for (x = 0; x <= size - 11; x++) {
        var rowArr = mod[y];
        if (matches(rowArr, x, pat) || matches(rowArr, x, patInv)) score += 40;
      }
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y <= size - 11; y++) {
        var colArr = [];
        for (var k = 0; k < 11; k++) colArr.push(mod[y + k][x]);
        if (matches(colArr, 0, pat) || matches(colArr, 0, patInv)) score += 40;
      }
    }
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mod[y][x]) dark++;
    var total = size * size;
    var ratio = Math.abs(dark * 100 / total - 50);
    score += Math.floor(ratio / 5) * 10;
    return score;
  }

  function matrix(text, opts) {
    opts = opts || {};
    var bytes = utf8Bytes(String(text === null || text === undefined ? '' : text));
    if (!bytes.length) bytes = [32];
    var version = opts.version || chooseVersion(bytes.length);
    if (!version) throw new Error('二维码内容过长：前端仅支持约 100 字节以内（版本 1–10 / 纠错 M）');
    var dataCw = makeDataCodewords(bytes, version);
    var finalCw = makeFinalCodewords(dataCw, version);
    var forced = (opts.mask === null || opts.mask === undefined) ? null : (opts.mask | 0);
    var best = null;
    var masks = forced === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forced];
    for (var i = 0; i < masks.length; i++) {
      var built = buildMatrix(version, finalCw, masks[i]);
      var p = penalty(built.mod, built.size);
      if (!best || p < best.penalty) best = { built: built, mask: masks[i], penalty: p };
    }
    drawFormat(best.built, version, best.mask);
    var out = [];
    for (var y = 0; y < best.built.size; y++) {
      var row = new Array(best.built.size);
      for (var x = 0; x < best.built.size; x++) row[x] = best.built.mod[y][x] ? 1 : 0;
      out.push(row);
    }
    return { version: version, size: best.built.size, mask: best.mask, penalty: best.penalty, modules: out };
  }

  function render(canvas, text, opts) {
    if (!canvas || !canvas.getContext) return null;
    opts = opts || {};
    var m = opts.matrix || matrix(text);
    var margin = opts.margin === undefined ? 4 : opts.margin;
    var sizePx = opts.size || 176;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var modules = m.size + margin * 2;
    var scale = Math.max(1, Math.floor((sizePx * dpr) / modules));
    var px = modules * scale;
    canvas.width = px;
    canvas.height = px;
    canvas.style.width = Math.round(px / dpr) + 'px';
    canvas.style.height = Math.round(px / dpr) + 'px';
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.background || '#e9f1fa';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = opts.color || '#070b14';
    for (var y = 0; y < m.size; y++) {
      for (var x = 0; x < m.size; x++) {
        if (m.modules[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
      }
    }
    return m;
  }

  global.TenonQR = { matrix: matrix, render: render, version: '1.0' };
})(typeof window !== 'undefined' ? window : this);
