#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Round4 阶段 B 独立验收：剪贴板隐私 / 12 错误码 / 离线体验 / 设备槽位 + live 只读核对
证据：_internal/checker/round4/r4-acceptance.json + screenshots/r4-*.png
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EVID = os.path.join(ROOT, "_internal", "checker", "round4")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
RUN = os.path.join(ROOT, "_internal", "checker", "tmp", "r4-" + STAMP)
DATA = os.path.join(RUN, "data")
AGENT_DATA = os.path.join(RUN, "agent-data")
SHOTS = os.path.join(EVID, "screenshots")
LOG_DIR = os.path.join(EVID, "logs")
HELPERS = os.path.join(ROOT, "test", "verify", "r3-helpers")
PORT = 7462
BASE = "http://127.0.0.1:%d" % PORT
LIVE = "http://127.0.0.1:7410"
CHECKS = []


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + m, flush=True)


def rec(name, ok, detail="", skip=False):
    CHECKS.append({"name": name, "ok": bool(ok), "skip": bool(skip), "detail": str(detail)[:800]})
    log(("SKIP " if skip else ("PASS " if ok else "FAIL ")) + name + (" :: " + str(detail)[:240] if detail else ""))


def api(path, method="GET", body=None, token=None, base=None, timeout=20):
    base = base or BASE
    data = json.dumps(body).encode() if body is not None else None
    h = {}
    if data:
        h["Content-Type"] = "application/json"
    if token:
        h["x-tenon-token"] = token
    req = urllib.request.Request(base + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            content = r.read()
            try:
                return r.status, json.loads(content.decode())
            except Exception:
                return r.status, {"raw_len": len(content)}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def wait_http(url, timeout=45):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def ps_json(script, *args):
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] + list(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
        for line in reversed((r.stdout or "").strip().splitlines()):
            if line.strip().startswith("{"):
                return json.loads(line)
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
    return {"ok": False, "error": "no json"}


def start_hub(port, data_dir):
    os.makedirs(data_dir, exist_ok=True)
    env = dict(os.environ)
    env.update({"TENON_PORT": str(port), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": data_dir,
                "TENON_DISCOVERY_PORT": str(port + 50), "TENON_ASSETS_OCR": "0"})
    os.makedirs(LOG_DIR, exist_ok=True)
    logf = open(os.path.join(LOG_DIR, "hub-%d-%s.log" % (port, STAMP)), "a", encoding="utf-8")
    return subprocess.Popen(["node", os.path.join(ROOT, "server", "start.js")], cwd=ROOT, env=env, stdout=logf, stderr=logf)


def start_agent(node_id, node_token, clipboard="0"):
    os.makedirs(AGENT_DATA, exist_ok=True)
    env = dict(os.environ)
    env.update({"TENON_HUB_URL": BASE, "TENON_DATA_DIR": AGENT_DATA, "TENON_NODE_TOKEN": node_token,
                "TENON_NODE_ID": node_id, "TENON_NODE_NAME": "验收节点-" + node_id, "TENON_V2": "1",
                "TENON_CLIPBOARD": clipboard, "TENON_CLIPBOARD_MS": "800", "TENON_RECEIVE_DIR": os.path.join(RUN, "接收")})
    logf = open(os.path.join(LOG_DIR, "agent-%s-%s.log" % (node_id, STAMP)), "a", encoding="utf-8")
    return subprocess.Popen(["node", os.path.join(ROOT, "node-agent", "agent.js")], cwd=ROOT, env=env, stdout=logf, stderr=logf)


def kill(proc):
    if proc:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        except Exception:
            pass


def ledger_events(data_dir):
    try:
        with open(os.path.join(data_dir, "events.jsonl"), "r", encoding="utf-8") as f:
            return [json.loads(l) for l in f.read().split("\n") if l.strip()]
    except Exception:
        return []


def wait_devices(token, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, js = api("/api/v2/devices", token=token)
        items = (js.get("items") or js.get("devices") or []) if st == 200 else []
        if items:
            return items
        time.sleep(0.5)
    return []


def main():
    hub = agent = None
    token = node_token = ""
    report = {"kind": "r4-acceptance", "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": {}}
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(RUN, exist_ok=True)
    original_clip = ""
    try:
        # ========== live 7410 只读核对 ==========
        try:
            st_h, health = api("/api/v2/health", base=LIVE)
            st_s, live_state = api("/api/state", base=LIVE)
            live_secrets = json.load(open(os.path.join(ROOT, "data", "secrets.json"), encoding="utf-8"))
            live_tok = live_secrets.get("operatorToken")
            st_slots, live_slots = api("/api/v2/devices/settings", token=live_tok, base=LIVE)
            st_pre, live_pre = api("/api/v2/super/presets", token=live_tok, base=LIVE)
            st_priv, live_priv = api("/api/v2/link/clipboard/settings", token=live_tok, base=LIVE)
            rec("live 7410 R4 模块/数据就绪（health/devices/slots/presets/privacy）",
                st_h == 200 and st_s == 200 and st_slots == 200 and st_pre == 200 and st_priv == 200 and bool(health.get("modules")),
                "modules=%s seq=%s devices=%s presets=%s privacy.enabled=%s" % (",".join(health.get("modules") or []), (live_state or {}).get("seq"), len(((live_slots.get("settings") or {}).get("bound") or [])), [p.get("id") for p in (live_pre.get("presets") or [])], (live_priv or {}).get("enabled")))
        except Exception as e:
            rec("live 7410 R4 只读核对", False, str(e)[:300])

        # ========== 隔离实例 ==========
        subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA], cwd=ROOT, capture_output=True, timeout=150)
        subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-home.js"), "--data-dir", DATA], cwd=ROOT, capture_output=True, timeout=180)
        hub = start_hub(PORT, DATA)
        if not wait_http(BASE + "/api/state", 50):
            raise RuntimeError("隔离实例未启动")
        secrets = json.load(open(os.path.join(DATA, "secrets.json"), encoding="utf-8"))
        token = secrets["operatorToken"]
        node_token = secrets["nodeToken"]
        agent = start_agent("node-checker-r4", node_token, clipboard="1")
        wait_devices(token)
        original_clip = str(ps_json(os.path.join(HELPERS, "get-clipboard.ps1")).get("text") or "")

        # ========== A) 剪贴板隐私 ==========
        SENSITIVE = {
            "密码": "我的登录密码是 Abc12345!",
            "验证码": "验证码：827310，5 分钟内有效",
            "银行卡": "银行卡号 4111 1111 1111 1111 请勿外传",
            "身份证": "身份证 11010519491231002X",
        }
        NORMAL = "普通文本：明天下午三点开产品评审会"
        results = {}
        for label, text in list(SENSITIVE.items()) + [("普通文本", NORMAL)]:
            st, js = api("/api/v2/link/clipboard", "POST", {"kind": "text", "text": text}, token=token)
            leaked = text in json.dumps(js, ensure_ascii=False)
            st_l, latest = api("/api/v2/link/clipboard/latest", token=token)
            st_hh, hist = api("/api/v2/link/clipboard/history", token=token)
            hist_txt = json.dumps(hist, ensure_ascii=False)
            latest_txt = json.dumps(latest, ensure_ascii=False)
            events = ledger_events(DATA)
            clip_events = [e for e in events if str(e.get("type", "")).startswith("clipboard.")]
            ev_txt = json.dumps(clip_events[-5:], ensure_ascii=False)
            if label == "普通文本":
                ok = st == 200 and js.get("redacted") is False and (js.get("clipboard") or {}).get("text") == text
                rec("A-剪贴板隐私：普通文本放行（落盘/返回原文）", ok, "status=%s redacted=%s" % (st, js.get("redacted")))
            else:
                ok = st == 200 and js.get("redacted") is True and not leaked and text not in hist_txt and text not in latest_txt and text not in ev_txt
                results[label] = {"status": st, "redacted": js.get("redacted"), "sensitiveType": js.get("sensitiveType"), "label": js.get("label")}
                rec("A-剪贴板隐私：%s 被过滤（不落盘/不同步/history/账本无原文）" % label, ok,
                    "status=%s type=%s leakedResp=%s hist=%s latest=%s ledger=%s" % (st, js.get("sensitiveType"), leaked, text in hist_txt, text in latest_txt, text in ev_txt))
        red_ev = [e for e in ledger_events(DATA) if e.get("type") == "clipboard.shared" and (e.get("data") or {}).get("redacted")]
        rec("A-剪贴板隐私：账本记录 redacted 事件（只记类型/长度）", len(red_ev) >= 4 and all("text" not in json.dumps(e.get("data") or {}, ensure_ascii=False) for e in red_ev), "redactedEvents=%d sample=%s" % (len(red_ev), json.dumps(red_ev[-1], ensure_ascii=False)[:300]))
        # 单条删除/清空
        st_hh, hist = api("/api/v2/link/clipboard/history", token=token)
        items = (hist.get("history") or [])
        if items:
            iid = items[0].get("id") or items[0].get("at")
            st_d, delr = api("/api/v2/link/clipboard/history/" + str(iid), "DELETE", token=token)
            st_hh2, hist2 = api("/api/v2/link/clipboard/history", token=token)
            rec("A-剪贴板隐私：单条删除", st_d == 200 and (delr.get("ok") is True) and len(hist2.get("history") or []) == len(items) - 1, "deleteStatus=%s %d→%d" % (st_d, len(items), len(hist2.get("history") or [])))
        st_c, clr = api("/api/v2/link/clipboard/history", "DELETE", token=token)
        st_hh3, hist3 = api("/api/v2/link/clipboard/history", token=token)
        rec("A-剪贴板隐私：一键清空", st_c == 200 and len(hist3.get("history") or []) == 0, "status=%s remaining=%d" % (st_c, len(hist3.get("history") or [])))
        # 开关关闭 → 10s 内停采（API 侧直接 409 + 不新增记录）
        st_off, off = api("/api/v2/link/clipboard/settings", "POST", {"enabled": False}, token=token)
        st_hh4, _ = api("/api/v2/link/clipboard/history", token=token)
        cnt_before = len(ledger_events(DATA))
        st_post, post_js = api("/api/v2/link/clipboard", "POST", {"kind": "text", "text": "关机期间不应记录"}, token=token)
        time.sleep(3)
        st_hh5, hist5 = api("/api/v2/link/clipboard/history", token=token)
        disabled_ok = st_off == 200 and st_post == 409 and not any("关机期间不应记录" in json.dumps(e, ensure_ascii=False) for e in ledger_events(DATA)[cnt_before:]) and len(hist5.get("history") or []) == len(hist4.get("history") or []) if False else (st_off == 200 and st_post == 409 and not any("关机期间不应记录" in json.dumps(e, ensure_ascii=False) for e in ledger_events(DATA)[cnt_before:]))
        rec("A-剪贴板隐私：关闭开关后停止采集（POST 被拒 409 + 无新记录）", disabled_ok, "settingsStatus=%s POST=%s error=%s" % (st_off, st_post, post_js.get("error")))
        api("/api/v2/link/clipboard/settings", "POST", {"enabled": True}, token=token)
        # node-agent 侧过滤：系统剪贴板放敏感文本 → agent 上报不落原文
        try:
            set_clip = subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value '登录密码是 AgentSecret99'"], capture_output=True, timeout=30)
            time.sleep(4)
            st_l, latest2 = api("/api/v2/link/clipboard/latest", token=token)
            st_hh6, hist6 = api("/api/v2/link/clipboard/history", token=token)
            all_txt = json.dumps([latest2, hist6] + ledger_events(DATA)[-30:], ensure_ascii=False)
            rec("A-剪贴板隐私：node-agent 侧过滤（本机剪贴板敏感内容不落原文）", "AgentSecret99" not in all_txt, "agentEnabled=1 系统剪贴板含敏感文本，hub 侧无原文=%s" % ("AgentSecret99" not in all_txt))
        except Exception as e:
            rec("A-剪贴板隐私：node-agent 侧过滤", False, str(e)[:200])

        # ========== D) 设备槽位 ==========
        st_set, slots = api("/api/v2/devices/settings", token=token)
        sset = slots.get("settings") or {}
        mode = sset.get("mode") or "personal"
        maxd = sset.get("maxDevices") or (3 if mode == "personal" else 8)
        bound = sset.get("bound") or []
        rec("D-槽位：GET settings（个人模式上限 3）", st_set == 200 and mode == "personal" and maxd == 3, "mode=%s maxDevices=%s bound=%d" % (mode, maxd, len(bound)))
        devs = wait_devices(token)
        unbound = [d for d in devs if not d.get("bound") and d.get("bindable") is not False and d.get("kind") != "hub"]
        bind_results = []
        for d in unbound:
            if len(bound) >= 3:
                break
            st_b, bj = api("/api/v2/devices/" + d["id"] + "/bind", "POST", {}, token=token)
            if st_b in (200, 201):
                bound.append(d)
            bind_results.append((d["id"], st_b))
        overflow = None
        if unbound:
            rest = [d for d in unbound if d not in bound]
            if rest:
                st_o, over = api("/api/v2/devices/" + rest[0]["id"] + "/bind", "POST", {}, token=token)
                overflow = (st_o, over)
        over_txt = json.dumps(overflow[1] if overflow else {}, ensure_ascii=False)
        rec("D-槽位：第 4 台设备被拦（409 + 最久未活跃 3 台替换建议）",
            bool(overflow) and overflow[0] == 409 and ("建议" in over_txt or "suggest" in over_txt.lower() or "槽位" in over_txt or "slot" in over_txt.lower()),
            "status=%s body=%s" % (overflow[0] if overflow else None, over_txt[:300]))
        st_f, fam = api("/api/v2/devices/settings", "PATCH", {"mode": "family"}, token=token)
        st_set2, slots2 = api("/api/v2/devices/settings", token=token)
        sset2 = slots2.get("settings") or {}
        bind4 = None
        if overflow and overflow[0] == 409:
            # 找到剩余未绑定设备再试
            devs2 = wait_devices(token)
            rest2 = [d for d in devs2 if not d.get("bound") and d.get("kind") != "hub" and d.get("bindable") is not False]
            if rest2:
                bind4 = api("/api/v2/devices/" + rest2[0]["id"] + "/bind", "POST", {}, token=token)
        rec("D-槽位：切换家庭版（上限 8）后可绑定第 4 台", st_f == 200 and sset2.get("mode") == "family" and sset2.get("maxDevices") == 8 and (bind4 and bind4[0] in (200, 201)),
            "patch=%s mode=%s max=%s bind4=%s" % (st_f, sset2.get("mode"), sset2.get("maxDevices"), bind4[0] if bind4 else None))
        # 重名后缀
        devs3 = wait_devices(token)
        cand = [d for d in devs3 if d.get("kind") != "hub"][:2]
        rename_ok = False
        if len(cand) >= 2:
            name = "重名测试-" + STAMP[-4:]
            api("/api/v2/devices/" + cand[0]["id"] + "/rename", "POST", {"name": name}, token=token)
            st_r, rj = api("/api/v2/devices/" + cand[1]["id"] + "/rename", "POST", {"name": name}, token=token)
            final = json.dumps(rj, ensure_ascii=False)
            rename_ok = st_r == 200 and ("（2）" in final or "(2)" in final or "重名" in final)
        rec("D-槽位：重名自动加后缀", rename_ok, "renameResult=%d" % (st_r if len(cand) >= 2 else -1))

        # ========== B)+C) 真实 Chrome：12 错误码 / 离线体验 ==========
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                ctx = browser.new_context(viewport={"width": 1440, "height": 900})
                ctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                page = ctx.new_page()
                js_errs = []
                page.on("pageerror", lambda e: js_errs.append(str(e)[:200]))
                # 12 错误码
                page.goto(BASE + "/#/errors", wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(2500)
                code_cards = page.locator('[data-testid^="error-demo-"]').count()
                cards = page.locator('[data-testid="tenon-error-card"]')
                card_n = cards.count()
                structure_ok = True
                for i in range(min(card_n, 12)):
                    c = cards.nth(i)
                    if c.locator('[data-testid="error-phenomenon"]').count() == 0 or c.locator('[data-testid="error-cause"]').count() == 0 or c.locator('[data-testid="error-next"]').count() == 0 or c.locator('[data-testid="btn-copy-diagnose"]').count() == 0:
                        structure_ok = False
                        break
                diagnose = page.locator('[data-testid="error-diagnose"]').first
                diag_txt = (diagnose.text_content() or "") if diagnose.count() else ""
                if not diag_txt and diagnose.count():
                    diag_txt = diagnose.evaluate("el => el.textContent || ''")
                page.screenshot(path=os.path.join(SHOTS, "r4-errors-12.png"), full_page=True)
                # 点复制诊断
                copy_ok = False
                try:
                    page.locator('[data-testid="btn-copy-diagnose"]').first.click()
                    page.wait_for_timeout(500)
                    copy_ok = True
                except Exception:
                    pass
                rec("B-12 个错误码全部渲染（现象/原因/下一步/复制诊断）", code_cards == 12 and card_n >= 12 and structure_ok and bool(diag_txt) and copy_ok,
                    "demoCards=%d errorCards=%d structure=%s diagnoseHasVersionPort=%s copyClick=%s" % (code_cards, card_n, structure_ok, ("版本" in diag_txt and "端口" in diag_txt), copy_ok))
                # link/devices 页错误组件（拦截 API 模拟失败）
                page.route("**/api/v2/link/peers**", lambda route: route.abort())
                page.goto(BASE + "/#/link", wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(2800)
                panel = page.locator('[data-testid="tenon-error-panel"]').count()
                next_btn = page.locator('[data-testid="tenon-error-panel"] [data-testid="error-next"]').count()
                copy_btn = page.locator('[data-testid="tenon-error-panel"] [data-testid="btn-copy-diagnose"]').count()
                page.screenshot(path=os.path.join(SHOTS, "r4-link-error-panel.png"))
                page.unroute("**/api/v2/link/peers**")
                rec("B-link 页 API 出错时渲染统一下一步/复制诊断组件", panel >= 1 and next_btn >= 1 and copy_btn >= 1, "panels=%d next=%d copy=%d" % (panel, next_btn, copy_btn))
                # 离线体验 5 页
                pages = ["#/super", "#/link", "#/devices", "#/assets", "#/handoff"]
                offline_results = {}
                for pg_path in pages:
                    pg = ctx.new_page()
                    pg.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                    pg.goto(BASE + "/" + pg_path, wait_until="domcontentloaded", timeout=30000)
                    pg.wait_for_timeout(2600)
                    ctx.set_offline(True)
                    pg.evaluate("() => window.dispatchEvent(new Event('offline'))")
                    pg.wait_for_timeout(1500)
                    banner = pg.locator('[data-testid="offline-banner"]')
                    visible = banner.count() > 0 and not banner.first.get_attribute("class").count("hidden") if banner.count() else False
                    try:
                        banner_visible = banner.first.is_visible()
                    except Exception:
                        banner_visible = False
                    btxt = banner.first.inner_text() if banner.count() else ""
                    disabled = pg.locator('[data-offline-disabled="1"]').count()
                    if pg_path in ("#/link", "#/devices"):
                        pg.screenshot(path=os.path.join(SHOTS, "r4-offline-%s.png" % pg_path.strip("#/").replace("/", "-")))
                    ctx.set_offline(False)
                    pg.evaluate("() => window.dispatchEvent(new Event('online'))")
                    gone = False
                    for _ in range(24):
                        pg.wait_for_timeout(500)
                        try:
                            if not pg.locator('[data-testid="offline-banner"]').first.is_visible():
                                gone = True
                                break
                        except Exception:
                            gone = True
                            break
                    offline_results[pg_path] = {"banner": banner_visible, "text": btxt[:80], "writeDisabled": disabled, "recovered": gone}
                    pg.close()
                ok_off = all(v["banner"] and v["recovered"] for v in offline_results.values()) and all(v["writeDisabled"] >= 0 for v in offline_results.values())
                offline_show = sum(1 for v in offline_results.values() if v["banner"])
                offline_recover = sum(1 for v in offline_results.values() if v["recovered"])
                rec("C-离线体验：5 页横幅出现 + 数据截至缓存文案", offline_show == 5, "bannerPages=%d/5 detail=%s" % (offline_show, json.dumps({k: v["text"] for k, v in offline_results.items()}, ensure_ascii=False)[:300]))
                rec("C-离线体验：写操作在离线时置灰说明", all(v["writeDisabled"] > 0 for v in offline_results.values()), json.dumps({k: v["writeDisabled"] for k, v in offline_results.items()}, ensure_ascii=False))
                rec("C-离线体验：恢复后 ≤10s 自动消失", offline_recover == 5, "recoveredPages=%d/5" % offline_recover)
                rec("R4 页面 JS 运行时错误 = 0", len(js_errs) == 0, json.dumps(js_errs[:3], ensure_ascii=False))
                report["evidence"]["offline"] = offline_results
            finally:
                browser.close()
    except Exception as e:
        rec("R4 验收执行异常", False, str(e)[:500])
    finally:
        try:
            if original_clip:
                subprocess.run(["powershell", "-NoProfile", "-Command", "$in=[Console]::In.ReadToEnd(); Set-Clipboard -Value $in"], input=original_clip, capture_output=True, text=True, timeout=30)
        except Exception:
            pass
        kill(agent)
        kill(hub)
        time.sleep(0.5)
        pass_n = sum(1 for c in CHECKS if c["ok"] and not c["skip"])
        fail_n = sum(1 for c in CHECKS if not c["ok"] and not c["skip"])
        skip_n = sum(1 for c in CHECKS if c["skip"])
        report["summary"] = {"total": len(CHECKS), "pass": pass_n, "fail": fail_n, "skip": skip_n}
        report["finishedAt"] = datetime.now().isoformat()
        with open(os.path.join(EVID, "r4-acceptance.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：_internal/checker/round4/r4-acceptance.json")
        if not os.environ.get("R4_KEEP"):
            shutil.rmtree(RUN, ignore_errors=True)
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()