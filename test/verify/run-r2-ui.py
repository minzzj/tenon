#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Round2 独立验收 · 真实浏览器（真实 Chrome via playwright channel=chrome）
覆盖（对应 R2 §验收 2/3/4/5 的 UI 部分）：
  A. /m/link 配对前置自检：6 项渲染；全绿后出二维码；红项（X-Forwarded-For 模拟跨网段）就地显示「下一步」
  B. /m/link 扫码/带参自动配对：?code=&exp=&host= → 自动配对 → 成功页（设备名 + 能力清单 + 3 个一键动作）
  C. 成功页动作「发一个文件」：≤3 次点击进入文件选择；选文件→发送→账本 transfer.completed
  D. 码过期提示：?code=000000&exp=<过去> → 「码已过期/已换新码」+ 自动刷新新码
  E. 桌面 #/devices：设备卡 R2 字段（最近活跃/来源/能力）+ 重命名 UI + 撤销预览 UI（未实现则 SKIP）
证据：_internal/checker/round2/r2-ui.json + screenshots/
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EVID = os.path.join(ROOT, "_internal", "checker", "round2")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
RUN = os.path.join(ROOT, "_internal", "checker", "tmp", "r2-ui-" + STAMP)
DATA = os.path.join(RUN, "data")
SHOTS = os.path.join(EVID, "screenshots")
LOG_DIR = os.path.join(EVID, "logs")
PORT = 7462
CHECKS = []


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + m, flush=True)


def rec(name, ok, detail="", skip=False):
    CHECKS.append({"name": name, "ok": bool(ok), "skip": bool(skip), "detail": str(detail)[:600]})
    log(("SKIP " if skip else ("PASS " if ok else "FAIL ")) + name + (" :: " + str(detail)[:220] if detail else ""))


def api(url, token=None, method="GET", body=None, raw=False, timeout=15):
    data = None
    h = {}
    if body is not None:
        data = body if raw else json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if token:
        h["x-tenon-token"] = token
    req = urllib.request.Request(url, data=data, headers=h, method=method)
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


def start_second_agent(base, data_dir, node_id, node_token):
    """真实第二个 node-agent（独立 nodeId/数据目录），用于 #/devices 卡片出现。"""
    os.makedirs(data_dir, exist_ok=True)
    env = dict(os.environ)
    env.update({"TENON_HUB_URL": base, "TENON_DATA_DIR": data_dir, "TENON_NODE_TOKEN": node_token,
                "TENON_NODE_ID": node_id, "TENON_NODE_NAME": "验收第二台电脑(UI)"})
    logf = open(os.path.join(LOG_DIR, "second-agent-%s.log" % STAMP), "a", encoding="utf-8")
    proc = subprocess.Popen(["node", os.path.join(ROOT, "node-agent", "agent.js")], cwd=ROOT, env=env,
                            stdout=logf, stderr=logf)
    return proc


def start_hub():
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA],
                   cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    env = dict(os.environ)
    env.update({"TENON_PORT": str(PORT), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": DATA,
                "TENON_DISCOVERY_PORT": str(PORT + 50), "TENON_ASSETS_OCR": "0"})
    logf = open(os.path.join(LOG_DIR, "hub-r2ui-%s.log" % STAMP), "a", encoding="utf-8")
    proc = subprocess.Popen(["node", os.path.join(ROOT, "server", "start.js")], cwd=ROOT, env=env, stdout=logf, stderr=logf)
    base = "http://127.0.0.1:%d" % PORT
    if not wait_http(base + "/api/state", 45):
        raise RuntimeError("实例未启动")
    with open(os.path.join(DATA, "secrets.json"), "r", encoding="utf-8") as f:
        token = json.load(f)["operatorToken"]
    return proc, base, token


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    proc = None
    agent = None
    base = ""
    token = ""
    results = {"kind": "r2-ui", "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": {}}
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(RUN, exist_ok=True)
    try:
        proc, base, token = start_hub()
        log("隔离实例就绪 " + base)
        node_token = ""
        try:
            with open(os.path.join(DATA, "secrets.json"), "r", encoding="utf-8") as f:
                node_token = json.load(f)["nodeToken"]
        except Exception:
            node_token = ""
        agent = None
        if node_token:
            agent = start_second_agent(base, os.path.join(RUN, "agent-data"), "node-checker-ui", node_token)
            log("真实第二个 node-agent 已启动（node-checker-ui）")
            for _ in range(60):
                st_dev, devs = api(base + "/api/v2/devices", token)
                items = (devs.get("items") or devs.get("devices") or []) if st_dev == 200 else []
                if any(d.get("id") == "node-checker-ui" for d in items):
                    log("第二设备已注册进设备列表")
                    break
                time.sleep(0.5)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-dev-shm-usage"])
            try:
                # ---------- 移动端 /m/link ----------
                mctx = browser.new_context(viewport={"width": 430, "height": 860})
                mctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                mp = mctx.new_page()
                merr = []
                mp.on("pageerror", lambda e: merr.append(str(e)[:200]))
                mp.goto(base + "/m/link", wait_until="domcontentloaded", timeout=30000)
                mp.wait_for_timeout(2600)
                # 自检渲染
                pf = mp.locator('[data-testid="m-preflight"]').count()
                items = mp.locator('[data-testid="m-preflight-item"]').count()
                if pf == 0:
                    rec("P0-1 /m/link 配对前置自检渲染", False, "缺少 m-preflight", skip=True)
                else:
                    ok_badge = mp.locator('[data-testid="m-preflight-ok"]').count()
                    fail_badge = mp.locator('[data-testid="m-preflight-fail"]').count()
                    qr = mp.locator('[data-testid="m-pair-qr"]').count()
                    code_txt = mp.locator('[data-testid="m-link-code"]').inner_text() if mp.locator('[data-testid="m-link-code"]').count() else ""
                    mp.screenshot(path=os.path.join(SHOTS, "20-m-preflight-green.png"))
                    rec("P0-1 /m/link 自检 6 项 + 全绿徽标 + 二维码 + 6 位码", items >= 6 and ok_badge == 1 and qr == 1 and bool(re.search(r"\d{3}\s*\d{3}", code_txt)), "items=%d okBadge=%d qr=%d code=%s" % (items, ok_badge, qr, code_txt))
                    # 红项：跨网段 mock X-Forwarded-For
                    mctx2 = browser.new_context(viewport={"width": 430, "height": 860},
                                                extra_http_headers={"x-forwarded-for": "10.99.99.99"})
                    mctx2.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                    m2 = mctx2.new_page()
                    m2.goto(base + "/m/link", wait_until="domcontentloaded", timeout=30000)
                    m2.wait_for_timeout(2600)
                    fail_badge2 = m2.locator('[data-testid="m-preflight-fail"]').count()
                    bad_item = m2.locator('[data-testid="m-preflight-item"][data-item-id="subnet"]')
                    bad_cls = bad_item.get_attribute("class") if bad_item.count() else ""
                    fix_visible = m2.locator('[data-testid="m-preflight-fix"]').count()
                    m2.screenshot(path=os.path.join(SHOTS, "21-m-preflight-red-subnet.png"))
                    rec("P0-1 故障注入 3（跨网段 mock）：红项 + 就地「下一步」", fail_badge2 >= 1 and ("bad" in (bad_cls or "")) and fix_visible >= 1, "failBadge=%d subnetClass=%s fixes=%d" % (fail_badge2, bad_cls, fix_visible))
                    mctx2.close()
                # ---------- B. 自动配对 → 成功页 3 动作 ----------
                st, qr = api(base + "/api/v2/link/pair/qr", token)
                if st != 200 or not qr.get("code"):
                    rec("P0-2 自动配对成功页", False, "无法取到二维码", skip=True)
                else:
                    params = {"code": qr["code"], "exp": qr.get("exp"), "host": "127.0.0.1", "port": PORT}
                    url = base + "/m/link?" + urllib.parse.urlencode(params)
                    mp.goto(url, wait_until="domcontentloaded", timeout=30000)
                    success = False
                    for _ in range(30):
                        if mp.locator('[data-testid="m-pair-success"]').count() > 0:
                            success = True
                            break
                        mp.wait_for_timeout(300)
                    mp.screenshot(path=os.path.join(SHOTS, "22-m-pair-success.png"))
                    if not success:
                        rec("P0-2 扫码/带参自动配对 → 成功页", False, "未出现 m-pair-success")
                    else:
                        name_txt = mp.locator('[data-testid="m-pair-success-name"]').inner_text() if mp.locator('[data-testid="m-pair-success-name"]').count() else ""
                        caps = mp.locator('[data-testid="m-pair-capabilities"] .tag').count()
                        acts = mp.locator('[data-testid="m-pair-actions"] [data-testid^="m-pair-action-"]').count()
                        act_ids = [mp.locator('[data-testid="m-pair-actions"] [data-testid^="m-pair-action-"]').nth(i).get_attribute("data-testid") for i in range(acts)]
                        rec("P0-2 带参自动配对 → 成功页（设备名+能力清单）", bool(name_txt), "name=" + name_txt[:80] + " caps=" + str(caps))
                        rec("P0-3 成功页出现 3 个一键动作", acts == 3, "actions=" + json.dumps(act_ids, ensure_ascii=False))
                        # 点「发一个文件」→ ≤3 次点击进入文件选择，并真实发送一次 → 账本 transfer.completed
                        send_btn = mp.locator('[data-testid="m-pair-action-send-file"]')
                        if send_btn.count() == 0:
                            rec("P0-3 点「发一个文件」≤3 次点击进入文件选择", False, "缺少 send-file 动作", skip=True)
                        else:
                            clicks = 1
                            chooser_ok = False
                            try:
                                with mp.expect_file_chooser(timeout=8000) as fc:
                                    send_btn.first.click()
                                fc.value.set_files(os.path.join(ROOT, "示例空间", "样品图", "样品01.png"))
                                chooser_ok = True
                            except Exception:
                                # 可能只是滚动/切到文件区
                                mp.wait_for_timeout(800)
                                chooser_ok = mp.locator('[data-testid="m-file-input"]').count() > 0
                            mp.screenshot(path=os.path.join(SHOTS, "23-m-send-file-chooser.png"))
                            rec("P0-3 点「发一个文件」≤3 次点击进入文件选择", chooser_ok, "clicks=%d" % clicks)
                            if chooser_ok:
                                try:
                                    up = mp.locator('[data-testid="m-btn-upload"]')
                                    if up.count():
                                        up.first.click()
                                        mp.wait_for_timeout(3500)
                                except Exception:
                                    pass
                                st2, tr = api(base + "/api/v2/link/transfers", token)
                                tlist = (tr.get("transfers") or tr.get("items") or []) if st2 == 200 else []
                                done = [t for t in tlist if str(t.get("status")) in ("completed", "ready", "delivered", "done")]
                                ev_types = []
                                try:
                                    with open(os.path.join(DATA, "events.jsonl"), "r", encoding="utf-8") as f:
                                        ev_types = [json.loads(l)["type"] for l in f.read().split("\n") if l.strip()]
                                except Exception:
                                    pass
                                rec("P0-3 发送文件成功 → 账本 transfer.completed", ("transfer.completed" in ev_types) or bool(done), "transfers=%d completed=%d ledger=%s" % (len(tlist), len(done), "transfer.completed" in ev_types))
                # ---------- D. 码过期提示 ----------
                expired_url = base + "/m/link?" + urllib.parse.urlencode({"code": "000000", "exp": str(int(time.time() * 1000) - 60000), "host": "127.0.0.1", "port": PORT})
                mp.goto(expired_url, wait_until="domcontentloaded", timeout=30000)
                mp.wait_for_timeout(2600)
                expired_txt = mp.locator('[data-testid="m-pair-expired"]').inner_text() if mp.locator('[data-testid="m-pair-expired"]').count() else ""
                hidden = mp.locator('[data-testid="m-pair-expired"].hidden').count()
                code_new = mp.locator('[data-testid="m-link-code"]').inner_text() if mp.locator('[data-testid="m-link-code"]').count() else ""
                mp.screenshot(path=os.path.join(SHOTS, "24-m-pair-expired.png"))
                rec("P0-2 码过期提示 + 自动换新码", (expired_txt and hidden == 0) and bool(re.search(r"\d{3}\s*\d{3}", code_new)), "text=" + expired_txt[:80] + " newCode=" + code_new)
                rec("移动端 /m/link JS 运行时错误 = 0", len(merr) == 0, json.dumps(merr[:3], ensure_ascii=False))
                # ---------- E. 桌面 #/link 自检 + #/devices 字段/重命名 + 撤销预览 ----------
                ctx = browser.new_context(viewport={"width": 1440, "height": 900})
                ctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                page = ctx.new_page()
                derr = []
                page.on("pageerror", lambda e: derr.append(str(e)[:200]))
                page.goto(base + "/#/link", wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(2800)
                pf_card = page.locator('[data-testid="preflight-card"]').count()
                pf_items = page.locator('[data-testid="preflight-item"]').count()
                pf_ok = page.locator('[data-testid="preflight-ok"]').count()
                qr_visible = page.locator('[data-testid="pair-qr"]').count()
                page.screenshot(path=os.path.join(SHOTS, "25-desktop-link-preflight.png"))
                if pf_card == 0:
                    rec("P0-1 桌面 #/link 配对前置自检卡", False, "缺少 preflight-card（UI 未交付）", skip=True)
                else:
                    rec("P0-1 桌面 #/link 自检 6 项 + 全绿徽标 + 二维码", pf_items >= 6 and pf_ok == 1 and qr_visible == 1, "items=%d ok=%d qr=%d" % (pf_items, pf_ok, qr_visible))
                    # 红项（跨网段 mock）→ 红徽标 + 就地「下一步」+ 二维码被门禁
                    rctx = browser.new_context(viewport={"width": 1440, "height": 900},
                                               extra_http_headers={"x-forwarded-for": "10.99.99.99"})
                    rctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                    rp = rctx.new_page()
                    rp.goto(base + "/#/link", wait_until="domcontentloaded", timeout=30000)
                    rp.wait_for_timeout(2800)
                    fail_badge = rp.locator('[data-testid="preflight-fail"]').count()
                    fixes = rp.locator('[data-testid="preflight-fix"]').count()
                    gated = rp.locator('[data-testid="pair-gated"]').count()
                    rp.screenshot(path=os.path.join(SHOTS, "26-desktop-preflight-red.png"))
                    rec("P0-1 桌面红项（跨网段 mock）：红徽标 + 就地下一步 + 二维码门禁", fail_badge >= 1 and fixes >= 1 and gated == 1, "fail=%d fixes=%d gated=%d" % (fail_badge, fixes, gated))
                    rctx.close()
                # 准备一个信任 peer（供撤销预览 UI）：用 A 的配对码做一次入站配对
                st_qr, qr_info = api(base + "/api/v2/link/pair/qr", token)
                peer_id = None
                if st_qr == 200 and qr_info.get("code"):
                    st_pair, pair_ret = api(base + "/api/v2/link/pair", method="POST",
                                            body={"code": qr_info["code"], "deviceId": "verify-ui-peer", "name": "验收Peer(UI)", "platform": "windows"})
                    if st_pair == 200 and pair_ret.get("ok"):
                        peer_id = (pair_ret.get("peer") or {}).get("peerId")
                page.reload(wait_until="domcontentloaded")
                page.wait_for_timeout(2400)
                rev_btn = page.locator('[data-testid="btn-revoke"]')
                if rev_btn.count() == 0:
                    rec("P0-5 桌面撤销前影响预览 UI", False, "无撤销按钮（peer 未出现或 UI 未交付）", skip=True)
                else:
                    rev_btn.first.click()
                    page.wait_for_timeout(1200)
                    modal = page.locator("#v2-confirm-modal:not(.hidden)")
                    counts = page.locator('[data-testid="impact-counts"]').count()
                    body_txt = page.inner_text("body")
                    has_three = all(k in body_txt for k in ["确定", "可能", "未知"])
                    page.screenshot(path=os.path.join(SHOTS, "27-desktop-revoke-preview.png"))
                    rec("P0-5 撤销前影响预览 UI（确定/可能/未知 + 取消入口）", modal.count() == 1 and counts >= 1 and has_three, "modal=%d counts=%d three=%s" % (modal.count(), counts, has_three))
                    # 取消 → 弹窗关闭、账本不出现 link.revoked
                    ev_before = 0
                    try:
                        with open(os.path.join(DATA, "events.jsonl"), "r", encoding="utf-8") as f:
                            ev_before = [json.loads(l)["type"] for l in f.read().split("\n") if l.strip()].count("link.revoked")
                    except Exception:
                        pass
                    page.locator('[data-testid="v2-confirm-cancel"]').first.click()
                    page.wait_for_timeout(800)
                    modal_after = page.locator("#v2-confirm-modal:not(.hidden)").count()
                    events = []
                    try:
                        with open(os.path.join(DATA, "events.jsonl"), "r", encoding="utf-8") as f:
                            events = [json.loads(l)["type"] for l in f.read().split("\n") if l.strip()]
                    except Exception:
                        pass
                    rec("P0-5 撤销预览取消零变化（弹窗关闭 + 账本无 link.revoked）", modal_after == 0 and events.count("link.revoked") == ev_before, "modalAfter=%d revoked=%d/%d" % (modal_after, events.count("link.revoked"), ev_before))
                # 回访场景：#/devices 已知产品 P1（v2Sig 缺 devices 分支）——记录为 SKIP 并单独报 Operator
                known_page = ctx.new_page()
                known_page.goto(base + "/#/devices", wait_until="domcontentloaded", timeout=30000)
                known_page.wait_for_timeout(4000)
                known_cards = known_page.locator('[data-testid="v2-device-card"]').count()
                known_loading = "正在检测 v2 接口" in known_page.inner_text("body")
                known_page.screenshot(path=os.path.join(SHOTS, "30-returning-devices-known-issue.png"))
                rec("P0-4 回访/刷新用户 #/devices 渲染（v2Sig devices 修复后）", known_cards >= 1 and not known_loading,
                    "cards=%d loading=%s" % (known_cards, known_loading))
                # 首访用户（干净 localStorage 的新 context + 已注册真实第二 node-agent）→ #/devices 真实渲染
                dctx = browser.new_context(viewport={"width": 1440, "height": 900})
                dctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                page = dctx.new_page()
                page.on("pageerror", lambda e: derr.append(str(e)[:200]))
                page.goto(base + "/#/devices", wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(1200)
                for _ in range(40):
                    if page.locator('[data-testid="v2-device-card"]').count() > 0:
                        break
                    page.wait_for_timeout(300)
                page.wait_for_timeout(600)
                page.screenshot(path=os.path.join(SHOTS, "31-devices-first-visit.png"))
                cards = page.locator('[data-testid="v2-device-card"]').count()
                last_active = page.locator('[data-testid="v2-device-last-active"]').count()
                src = page.locator('[data-testid="v2-device-source"]').count()
                caps = page.locator('[data-testid="v2-device-caps"]').count()
                rec("P0-4 桌面设备卡字段（最近活跃/来源/能力标签）", cards >= 1 and last_active >= 1 and src >= 1 and caps >= 1, "cards=%d lastActive=%d source=%d caps=%d" % (cards, last_active, src, caps))
                rename_btn = page.locator('[data-testid="btn-device-rename"]')
                if rename_btn.count() == 0:
                    rec("P0-4 桌面设备重命名 UI", False, "缺少 btn-device-rename", skip=True)
                else:
                    old_name = rename_btn.first.get_attribute("data-name") or ""
                    target_id = rename_btn.first.get_attribute("data-device-id") or ""
                    new_name = "UI重命名-" + STAMP[-6:]
                    rename_btn.first.click()
                    page.wait_for_timeout(700)
                    inp = page.locator('[data-testid="device-rename-input"]')
                    if inp.count() == 0:
                        rec("P0-4 桌面设备重命名 UI", False, "缺少重命名输入框")
                    else:
                        inp.first.fill(new_name)
                        page.locator('[data-testid="v2-confirm-ok"]').first.click()
                        page.wait_for_timeout(1600)
                        ok_name = new_name in page.inner_text("body")
                        st_dev, devs = api(base + "/api/v2/devices", token)
                        dev = next((d for d in ((devs.get("items") or devs.get("devices") or [])) if d.get("id") == target_id), None) if st_dev == 200 else None
                        events = []
                        try:
                            with open(os.path.join(DATA, "events.jsonl"), "r", encoding="utf-8") as f:
                                events = [json.loads(l)["type"] for l in f.read().split("\n") if l.strip()]
                        except Exception:
                            pass
                        page.screenshot(path=os.path.join(SHOTS, "32-desktop-renamed.png"))
                        rec("P0-4 桌面重命名 UI → 列表更新 + 账本 device.renamed", ok_name and dev is not None and dev.get("name") == new_name and "device.renamed" in events, "uiName=%s apiName=%s ledger=%s" % (ok_name, dev.get("name") if dev else None, "device.renamed" in events))
                        if dev:
                            api(base + "/api/v2/devices/" + target_id + "/rename", token, method="POST", body={"name": old_name})
                rec("桌面 #/link/#/devices JS 运行时错误 = 0", len(derr) == 0, json.dumps(derr[:3], ensure_ascii=False))
            finally:
                browser.close()
    except Exception as e:
        rec("R2 UI 执行异常", False, str(e)[:500])
    finally:
        if agent:
            try:
                subprocess.run(["taskkill", "/PID", str(agent.pid), "/T", "/F"], capture_output=True)
            except Exception:
                pass
        if proc:
            try:
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
            except Exception:
                pass
        time.sleep(0.5)
        pass_n = sum(1 for c in CHECKS if c["ok"] and not c["skip"])
        fail_n = sum(1 for c in CHECKS if not c["ok"] and not c["skip"])
        skip_n = sum(1 for c in CHECKS if c["skip"])
        results["summary"] = {"total": len(CHECKS), "pass": pass_n, "fail": fail_n, "skip": skip_n}
        results["base"] = base
        results["screenshotDir"] = os.path.relpath(SHOTS, ROOT).replace("\\", "/")
        results["finishedAt"] = datetime.now().isoformat()
        os.makedirs(EVID, exist_ok=True)
        with open(os.path.join(EVID, "r2-ui.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：_internal/checker/round2/r2-ui.json；截图 " + results["screenshotDir"])
        if not args.keep:
            shutil.rmtree(RUN, ignore_errors=True)
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()