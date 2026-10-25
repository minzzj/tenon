/* 榫卯 Tenon v3 · 手机页增强（/m）：拍照/选图 → 甩到电脑大屏 + 手机遥控入口
 * 真实链路：multipart POST /api/v2/assets/ingest → assetId → POST /api/v2/super/handoff {kind:'photo'}。
 * 需要一次操作令牌（与 /m 页其它写操作一致，存在 localStorage）；失败就地给下一步。 */
(function () {
  'use strict';
  var TOKEN_KEY = 'tenon:token';
  var state = { file: null, previewUrl: '', busy: false };
  function $(sel) { return document.querySelector(sel); }
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {} }
  function toast(msg, kind) {
    var root = $('#m-toast');
    if (!root) { root = document.createElement('div'); root.id = 'm-toast'; root.className = 'm-toast-root'; document.body.appendChild(root); }
    var el = document.createElement('div');
    el.className = 'toast ' + (kind === 'ok' ? 'toast-ok' : kind === 'warn' ? 'toast-warn' : 'toast-bad');
    el.innerHTML = '<span class="toast-icon">' + (kind === 'ok' ? '✓' : '!') + '</span><span>' + esc(msg) + '</span>';
    root.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3600);
  }
  function setStatus(html, kind) {
    var el = $('#m-photo-status');
    if (!el) return;
    el.className = 'tiny ' + (kind === 'ok' ? 'm-ok' : kind === 'warn' ? 'm-warn' : kind === 'bad' ? 'm-bad' : 'dim');
    el.innerHTML = html;
  }
  function showTokenRow(show) {
    var row = $('#m-photo-token-row');
    if (row) row.classList.toggle('hidden', !show);
  }
  function requireToken() {
    var tok = getToken();
    if (!tok) { showTokenRow(true); setStatus('需要一次操作令牌：电脑启动日志里打印的 operatorToken（与手机页其它写操作共用）。', 'warn'); }
    return tok;
  }
  function renderPreview(file) {
    state.file = file;
    var box = $('#m-photo-preview');
    if (!box) return;
    if (state.previewUrl) { try { URL.revokeObjectURL(state.previewUrl); } catch (_) {} }
    state.previewUrl = URL.createObjectURL(file);
    box.innerHTML = '<img data-testid="m-photo-preview-img" alt="待甩到电脑的照片" src="' + attrUrl(state.previewUrl) + '"><div class="tiny dim" style="margin-top:4px">' + esc(file.name) + ' · ' + Math.round(file.size / 1024) + 'KB</div>';
    box.classList.remove('hidden');
  }
  function attrUrl(u) { return String(u).replace(/"/g, '%22'); }
  function uploadAndHandoff() {
    if (state.busy) return;
    var tok = requireToken();
    if (!tok) return;
    if (!state.file) { toast('先拍照或选一张图片', 'warn'); return; }
    state.busy = true;
    var btn = $('#m-photo-handoff');
    if (btn) btn.disabled = true;
    setStatus('上传到素材库…', '');
    var form = new FormData();
    form.append('deviceId', 'phone');
    form.append('file', state.file, state.file.name || 'photo.jpg');
    fetch('/api/v2/assets/ingest', { method: 'POST', headers: { 'x-tenon-token': tok }, body: form, credentials: 'same-origin' })
      .then(function (res) { return res.json().catch(function () { return null; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; }); })
      .then(function (r) {
        if (r.status === 401) { setToken(''); showTokenRow(true); throw new Error('令牌无效：请重新输入操作令牌'); }
        if (!r.ok || !r.data || r.data.ok === false) throw new Error((r.data && r.data.error) || ('上传失败 HTTP ' + r.status));
        var item = (r.data.items && r.data.items[0]) || null;
        var asset = item && (item.asset || item);
        if (!asset || !asset.id) throw new Error('素材入库没有返回 assetId');
        setStatus('照片已入库（' + esc(asset.name || asset.id) + '），正在甩到电脑…', '');
        return fetch('/api/v2/super/handoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenon-token': tok },
          body: JSON.stringify({ kind: 'photo', assetId: asset.id, text: '手机照片', fromDevice: 'phone' }),
          credentials: 'same-origin'
        }).then(function (hres) { return hres.json().catch(function () { return null; }).then(function (h) { return { ok: hres.ok, status: hres.status, data: h }; }); }).then(function (h) {
          if (!h.ok || !h.data || h.data.ok === false) throw new Error((h.data && h.data.error) || ('流转失败 HTTP ' + h.status));
          return { asset: asset, handoff: h.data };
        });
      })
      .then(function (out) {
        setStatus('✅ 照片已甩到电脑大屏！<br><a href="/#/handoff?kind=photo&assetId=' + encodeURIComponent(out.asset.id) + '" target="_blank" rel="noopener">在电脑端查看</a> · 素材 ID：<code>' + esc(out.asset.id) + '</code>', 'ok');
        toast('照片已甩到电脑大屏', 'ok');
        var box = $('#m-photo-preview');
        if (box) box.classList.add('hidden');
        state.file = null;
      })
      .catch(function (err) {
        setStatus('失败：' + esc(String((err && err.message) || err)) + '<br>下一步：确认电脑端中枢在线、令牌正确，再点一次；照片已保留在本机相册。', 'bad');
        toast('甩照片失败：' + String((err && err.message) || err), 'bad');
      })
      .then(function () {
        state.busy = false;
        if (btn) btn.disabled = false;
      });
  }
  function initPhoto() {
    var input = $('#m-photo-input');
    if (input) input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (!/^image\//.test(file.type || '') && !/\.(jpg|jpeg|png|webp|gif|heic)$/i.test(file.name || '')) { toast('请选择图片文件', 'warn'); return; }
      renderPreview(file);
      setStatus('已选择照片，点下面按钮即可甩到电脑大屏。', '');
    });
    var btn = $('#m-photo-handoff');
    if (btn) btn.addEventListener('click', uploadAndHandoff);
    var save = $('#m-photo-token-save');
    if (save) save.addEventListener('click', function () {
      var inp = $('#m-photo-token-input');
      var tok = inp ? String(inp.value || '').trim() : '';
      if (!tok) { toast('请输入操作令牌', 'warn'); return; }
      setToken(tok); showTokenRow(false); toast('令牌已保存，可以甩照片了', 'ok'); setStatus('令牌已保存，点「拍照/选图 → 甩到电脑」上传。', 'ok');
    });
    if (getToken()) showTokenRow(false);
  }
  function initRemoteEntry() {
    var btn = $('#m-remote-entry-btn');
    if (btn) btn.addEventListener('click', function () { location.href = '/m/remote'; });
  }
  function init() { initPhoto(); initRemoteEntry(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();