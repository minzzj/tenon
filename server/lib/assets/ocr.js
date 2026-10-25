// 榫卯 v2 · 素材中心 · OCR 异步队列（tesseract.js chi_sim+eng）
// 关键设计：
//   1) 语言包在主线程预下载并解压到 cachePath（worker 线程内 fetch 在部分受限网络环境下会失败）；
//   2) 串行队列（tesseract worker 单实例），失败只标记、不阻塞入库；
//   3) 传 errorHandler，避免 worker 错误冒泡成进程级未捕获异常。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const DEFAULT_OCR_LANGS = 'chi_sim+eng';
export const DEFAULT_TESSDATA_URL = 'https://tessdata.projectnaptha.com/4.0.0';
export const DEFAULT_TESSDATA_TEMPLATE = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/{lang}/4.0.0_best_int/{lang}.traineddata.gz';
const MIN_TRAINEDDATA_BYTES = 1024 * 1024;

let tesseractPromise = null;

function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import('tesseract.js').catch((err) => {
      tesseractPromise = null;
      throw err;
    });
  }
  return tesseractPromise;
}

function pickCreateWorker(mod) {
  if (mod && typeof mod.createWorker === 'function') return mod.createWorker;
  if (mod && mod.default && typeof mod.default.createWorker === 'function') return mod.default.createWorker;
  throw new Error('tesseract.js 未导出 createWorker');
}

function traineddataCandidates(lang, template, allowFallback = true) {
  const out = [];
  const tpl = String(template || DEFAULT_TESSDATA_TEMPLATE);
  if (tpl.includes('{lang}')) out.push(tpl.split('{lang}').join(lang));
  else out.push(tpl.replace(/\/+$/, '') + '/' + lang + '.traineddata.gz');
  if (allowFallback) {
    const fallback = DEFAULT_TESSDATA_URL.replace(/\/+$/, '') + '/' + lang + '.traineddata.gz';
    if (!out.includes(fallback)) out.push(fallback);
  }
  return out;
}

async function ensureTraineddataFile(lang, { cacheDir, template = DEFAULT_TESSDATA_TEMPLATE, allowFallback = true, onProgress = null } = {}) {
  const dest = path.join(cacheDir, lang + '.traineddata');
  let size = 0;
  try {
    size = fs.statSync(dest).size;
  } catch {
    size = 0;
  }
  if (size > MIN_TRAINEDDATA_BYTES) return { lang, cached: true, bytes: size };
  fs.mkdirSync(cacheDir, { recursive: true });
  let lastErr = null;
  for (const url of traineddataCandidates(lang, template, allowFallback)) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status + '：' + url);
      const total = Number(res.headers.get('content-length')) || 0;
      const chunks = [];
      let received = 0;
      for await (const chunk of res.body) {
        chunks.push(chunk);
        received += chunk.length;
        if (onProgress) onProgress({ lang, received, total, progress: total ? Math.min(1, received / total) : 0 });
      }
      const plain = zlib.gunzipSync(Buffer.concat(chunks));
      if (plain.length < MIN_TRAINEDDATA_BYTES) throw new Error('语言包解压后过小（' + plain.length + 'B）：' + url);
      const tmp = dest + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, plain);
      fs.renameSync(tmp, dest);
      return { lang, cached: false, bytes: plain.length, url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error('语言包下载失败（已尝试全部镜像）：' + String((lastErr && lastErr.message) || lastErr));
}

export class OcrQueue {
  constructor({ langs = DEFAULT_OCR_LANGS, cacheDir = null, logger = null, timeoutMs = 240000, maxText = 8000, enabled = true, langPathTemplate = null, onDownloadProgress = null } = {}) {
    this.langs = langs;
    this.cacheDir = cacheDir;
    this.logger = logger;
    this.langPathTemplate = langPathTemplate || process.env.TENON_TESSDATA_TEMPLATE || DEFAULT_TESSDATA_TEMPLATE;
    this.allowTessdataFallback = !(langPathTemplate || process.env.TENON_TESSDATA_TEMPLATE);
    this.onDownloadProgress = onDownloadProgress;
    this.timeoutMs = Number(timeoutMs) || 240000;
    this.maxText = Number(maxText) || 8000;
    this.enabled = enabled !== false;
    this.worker = null;
    this.creating = null;
    this.chain = Promise.resolve();
    this.pending = 0;
    this.processed = 0;
    this.failed = 0;
    this.lastError = null;
    this.lastMs = null;
    this.startedAt = null;
    this.engine = null;
    this.langsReady = false;
    this.downloading = null;
    if (this.cacheDir) fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async prepareLanguages() {
    if (!this.cacheDir) return [];
    const langs = String(this.langs).split('+').map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const lang of langs) {
      try {
        out.push(await ensureTraineddataFile(lang, {
          cacheDir: this.cacheDir,
          template: this.langPathTemplate,
          allowFallback: this.allowTessdataFallback,
          onProgress: (p) => {
            this.downloading = { lang: p.lang, received: p.received, total: p.total, progress: p.progress };
            if (this.onDownloadProgress) this.onDownloadProgress(this.downloading);
            if (this.logger) this.logger({ status: 'downloading traineddata', lang: p.lang, progress: p.progress });
          },
        }));
      } catch (err) {
        this.lastError = String((err && err.message) || err);
        throw err;
      }
    }
    this.downloading = null;
    this.langsReady = true;
    return out;
  }

  async ensureWorker() {
    if (this.worker) return this.worker;
    if (!this.creating) {
      this.creating = (async () => {
        if (this.cacheDir && !this.langsReady) await this.prepareLanguages();
        const mod = await loadTesseract();
        const createWorker = pickCreateWorker(mod);
        const options = {
          logger: this.logger || (() => {}),
          errorHandler: (data) => {
            this.lastError = typeof data === 'string' ? data : JSON.stringify(data);
          },
        };
        if (this.cacheDir) options.cachePath = this.cacheDir;
        this.startedAt = Date.now();
        const worker = await createWorker(this.langs, 1, options);
        this.worker = worker;
        this.engine = 'tesseract.js';
        return worker;
      })().catch((err) => {
        this.lastError = String((err && err.message) || err);
        throw err;
      }).finally(() => {
        this.creating = null;
      });
    }
    return this.creating;
  }

  async resetWorker() {
    if (this.creating) {
      try { await this.creating; } catch { /* ignore */ }
    }
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      try { await worker.terminate(); } catch { /* ignore */ }
    }
  }

  /**
   * 入队一次 OCR。永不 reject：成功/失败都 resolve 结果对象，并通过 onResult 回调通知。
   * @returns {Promise<{assetId:string,status:'done'|'failed',text:string,confidence:number|null,error:string|null,ms:number,lang:string}>}
   */
  run({ assetId, filePath, onResult = null } = {}) {
    this.pending += 1;
    const job = this.chain.then(async () => {
      const started = Date.now();
      let timer = null;
      try {
        const worker = await this.ensureWorker();
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('OCR 超时：' + this.timeoutMs + 'ms')), this.timeoutMs);
          if (timer.unref) timer.unref();
        });
        let rec;
        try {
          rec = await Promise.race([worker.recognize(filePath), timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        const data = (rec && rec.data) || {};
        const text = String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, this.maxText);
        const result = {
          assetId,
          status: 'done',
          text,
          confidence: typeof data.confidence === 'number' ? Number(data.confidence.toFixed(2)) : null,
          error: null,
          ms: Date.now() - started,
          lang: this.langs,
          at: new Date().toISOString(),
        };
        this.processed += 1;
        this.lastMs = result.ms;
        if (onResult) {
          try { await onResult(result); } catch (err) { this.lastError = String((err && err.message) || err); }
        }
        return result;
      } catch (err) {
        this.failed += 1;
        this.lastError = String((err && err.message) || err);
        const result = {
          assetId,
          status: 'failed',
          text: '',
          confidence: null,
          error: this.lastError,
          ms: Date.now() - started,
          lang: this.langs,
          at: new Date().toISOString(),
        };
        if (onResult) {
          try { await onResult(result); } catch (e) { /* ignore */ }
        }
        // 超时/worker 崩溃：重建 worker，避免后续队列卡死
        if (/超时|terminate|Worker|worker/i.test(this.lastError)) {
          try { await this.resetWorker(); } catch { /* ignore */ }
        }
        return result;
      } finally {
        if (timer) clearTimeout(timer);
        this.pending -= 1;
      }
    });
    this.chain = job.catch(() => null);
    return job;
  }

  async drain() {
    await this.chain;
    return this.status();
  }

  status() {
    return {
      enabled: this.enabled,
      engine: this.engine,
      langs: this.langs,
      langsReady: this.langsReady,
      downloading: this.downloading,
      cacheDir: this.cacheDir,
      pending: this.pending,
      processed: this.processed,
      failed: this.failed,
      lastError: this.lastError,
      lastMs: this.lastMs,
      workerReady: !!this.worker,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
    };
  }

  async close() {
    if (this.creating) {
      try { await this.creating; } catch { /* ignore */ }
    }
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      try { await worker.terminate(); } catch { /* ignore */ }
    }
  }
}

export async function ocrAvailable() {
  try {
    const mod = await loadTesseract();
    return { available: typeof pickCreateWorker(mod) === 'function', error: null };
  } catch (err) {
    return { available: false, error: String((err && err.message) || err) };
  }
}