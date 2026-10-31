// 榫卯 V6 · 版本更新服务：手机/桌面 App 一键更新（从本机中枢下载最新 APK）
// 路由（挂载在 /api/v2 下，GET 不需要 token，方便手机直接更新）：
//   GET /update/info?platform=android&versionCode=N → {ok, platform, currentVersionCode, latest{versionName,versionCode,size,sha256,downloadUrl,notes,builtAt}, updateAvailable}
//   GET /update/android.apk → 最新 APK 二进制（支持 Range）
//   GET /update/manifest → 更新清单 JSON
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UPDATE_VERSION = '1.0.0';
const DEFAULT_MANIFEST = { platform: 'android', versionName: '0.0.0', versionCode: 0, apk: '', notes: '', builtAt: null };

function sha256File(file) {
  try {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
    fs.closeSync(fd);
    return hash.digest('hex');
  } catch (err) { return ''; }
}

export async function createUpdateService({ root, readOnly = false } = {}) {
  const downloadDir = path.join(root, 'public', 'download');
  const manifestPath = path.join(downloadDir, 'update-android.json');
  let cache = { file: '', mtime: 0, manifest: null, sha: '' };

  function loadManifest() {
    try {
      const st = fs.statSync(manifestPath);
      if (cache.mtime === st.mtimeMs && cache.manifest) return cache.manifest;
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const manifest = { ...DEFAULT_MANIFEST, ...raw, platform: raw.platform || 'android' };
      if (!manifest.apk) manifest.apk = '';
      if (manifest.apk) {
        const apkPath = path.join(downloadDir, manifest.apk);
        if (fs.existsSync(apkPath)) {
          const apkStat = fs.statSync(apkPath);
          cache = { file: apkPath, mtime: st.mtimeMs, manifest, sha: manifest.sha256 || sha256File(apkPath), size: apkStat.size, mtimeApk: apkStat.mtimeMs };
          manifest.size = apkStat.size;
          manifest.sha256 = cache.sha;
        }
      }
      cache.manifest = manifest;
      return manifest;
    } catch (err) {
      // 回退：自动找最新的 tenon-android-*.apk
      try {
        const files = fs.readdirSync(downloadDir).filter((f) => /^tenon-android-.*\.apk$/i.test(f));
        if (!files.length) return { ...DEFAULT_MANIFEST };
        const latest = files.map((f) => ({ f, t: fs.statSync(path.join(downloadDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
        const p = path.join(downloadDir, latest.f);
        const st = fs.statSync(p);
        const m = String(latest.f).match(/tenon-android-([0-9.]+)-debug\.apk/);
        const versionName = m ? m[1] : '0.0.0';
        cache.file = p; cache.sha = sha256File(p);
        return { platform: 'android', versionName, versionCode: 0, apk: latest.f, size: st.size, sha256: cache.sha, notes: '', builtAt: new Date(st.mtimeMs).toISOString() };
      } catch (e2) { return { ...DEFAULT_MANIFEST }; }
    }
  }

  function manifestPublic() {
    const m = loadManifest();
    return {
      platform: 'android',
      versionName: m.versionName || '0.0.0',
      versionCode: Number(m.versionCode) || 0,
      size: Number(m.size) || 0,
      sha256: m.sha256 || '',
      notes: m.notes || '',
      builtAt: m.builtAt || null,
      downloadUrl: m.apk ? '/api/v2/update/android.apk' : '',
      fileName: m.apk || '',
    };
  }

  const routes = [
    { method: 'GET', path: '/update/manifest', handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, latest: manifestPublic() }));
    } },
    { method: 'GET', path: '/update/info', handler: async (req, res, ctx) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const platform = String(url.searchParams.get('platform') || 'android');
      const current = Number(url.searchParams.get('versionCode') || 0) || 0;
      const latest = manifestPublic();
      const updateAvailable = platform === 'android' && latest.versionCode > current;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, platform, currentVersionCode: current, updateAvailable, latest }));
    } },
    { method: 'GET', path: '/update/android.apk', handler: async (req, res) => {
      const m = loadManifest();
      let file = cache.file;
      if (!file || !fs.existsSync(file)) {
        const apkPath = m && m.apk ? path.join(downloadDir, m.apk) : '';
        if (!apkPath || !fs.existsSync(apkPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '暂无 APK' })); return; }
        file = apkPath;
      }
      const st = fs.statSync(file);
      const headers = {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="' + (m.apk || path.basename(file)) + '"',
        'Content-Length': String(st.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      };
      const range = req.headers.range;
      if (range) {
        const m2 = /bytes=(\d+)-(\d*)/.exec(range);
        if (m2) {
          const start = Number(m2[1]);
          const end = m2[2] ? Number(m2[2]) : st.size - 1;
          headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
          headers['Content-Length'] = String(end - start + 1);
          res.writeHead(206, headers);
          fs.createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    } },
  ];

  return {
    name: 'update',
    version: UPDATE_VERSION,
    routes,
    getStatus: () => ({ ok: true, version: UPDATE_VERSION, latest: manifestPublic() }),
  };
}

export default { createUpdateService };
