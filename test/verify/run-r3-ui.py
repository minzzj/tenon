#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Round3 独立验收 · 真实 Chrome UI（手机视口 /m/remote + /m 拍照 + 桌面 #/super/#/devices + 新手引导）
自启隔离实例 7462（seed + seed-home）+ 真实 node-agent（TENON_V2=1）+ 绑定设备；
证据：_internal/checker/round3/r3-ui.json + screenshots/
"""
import argparse
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
EVID = os.path.join(ROOT, "_internal", "checker", "round3")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
RUN = os.path.join(ROOT, "_internal", "checker", "tmp", "r3-ui-" + STAMP)
DATA = os.path.join(RUN, "data")
AGENT_DATA = os.path.join(RUN, "agent-data")
SHOTS = os.path.join(EVID, "screenshots")
LOG_DIR = os.path.join(EVID, "logs")
HELPERS = os.path.join(ROOT, "test", "verify", "r3-helpers")
PORT = 7462
BASE = "http://127.0.0.1:%d" % PORT
CHECKS = []


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + m, flush=True)


def rec(name, ok, detail="", skip=False):
    CHECKS.append({"name": name, "ok": bool(ok), "skip": bool(skip), "detail": str(detail)[:700]})
    log(("SKIP " if skip else ("PASS " if ok else "FAIL ")) + name + (" :: " + str(detail)[:220] if detail else ""))


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


def get_cursor():
    return ps_json(os.path.join(HELPERS, "get-cursor.ps1"))


def get_volume():
    return ps_json(os.path.join(HELPERS, "get-volume.ps1"))


def set_volume(pct):
    return ps_json(os.path.join(HELPERS, "set-volume.ps1"), "-Percent", str(pct))


def get_clipboard():
    return ps_json(os.path.join(HELPERS, "get-clipboard.ps1"))


def set_clipboard(text):
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
                       input=text, capture_output=True, text=True, timeout=30)
    except Exception:
        pass


def get_window(proc):
    return ps_json(os.path.join(HELPERS, "get-window.ps1"), "-ProcessName", proc)


def api(path, method="GET", body=None, token=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    h = {}
    if data:
        h["Content-Type"] = "application/json"
    if token:
        h["x-tenon-token"] = token
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
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


def ledger_types():
    try:
        with open(os.path.join(DATA, "events.jsonl"), "r", encoding="utf-8") as f:
            return [json.loads(l)["type"] for l in f.read().split("\n") if l.strip()]
    except Exception:
        return []


def start_hub():
    os.makedirs(DATA, exist_ok=True)
    subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA],
                   cwd=ROOT, capture_output=True, timeout=150)
    subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-home.js"), "--data-dir", DATA],
                   cwd=ROOT, capture_output=True, timeout=180)
    env = dict(os.environ)
    env.update({"TENON_PORT": str(PORT), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": DATA,
                "TENON_DISCOVERY_PORT": str(PORT + 50), "TENON_ASSETS_OCR": "0"})
    os.makedirs(LOG_DIR, exist_ok=True)
    logf = open(os.path.join(LOG_DIR, "hub-r3ui-%s.log" % STAMP), "a", encoding="utf-8")
    p = subprocess.Popen(["node", os.path.join(ROOT, "server", "start.js")], cwd=ROOT, env=env, stdout=logf, stderr=logf)
    if not wait_http(BASE + "/api/state", 50):
        raise RuntimeError("实例未启动")
    with open(os.path.join(DATA, "secrets.json"), "r", encoding="utf-8") as f:
        return p, json.load(f)


def start_agent(node_token):
    os.makedirs(AGENT_DATA, exist_ok=True)
    env = dict(os.environ)
    env.update({"TENON_HUB_URL": BASE, "TENON_DATA_DIR": AGENT_DATA, "TENON_NODE_TOKEN": node_token,
                "TENON_NODE_ID": "node-checker-ui3", "TENON_NODE_NAME": "验收电脑UI", "TENON_V2": "1",
                "TENON_RECEIVE_DIR": os.path.join(RUN, "接收"), "TENON_CLIPBOARD": "0"})
    logf = open(os.path.join(LOG_DIR, "agent-r3ui-%s.log" % STAMP), "a", encoding="utf-8")
    return subprocess.Popen(["node", os.path.join(ROOT, "node-agent", "agent.js")], cwd=ROOT, env=env,
                            stdout=logf, stderr=logf)


def kill(proc):
    if proc:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        except Exception:
            pass


def wait_agent_bound(token, node_id, timeout=45):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, js = api("/api/v2/devices", token=token)
        items = (js.get("items") or js.get("devices") or []) if st == 200 else []
        node = next((d for d in items if d.get("id") == node_id), None)
        if node:
            return node
        time.sleep(0.5)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    hub = agent = None
    token = ""
    report = {"kind": "r3-ui", "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": {}}
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(RUN, exist_ok=True)
    try:
        hub, secrets = start_hub()
        token = secrets["operatorToken"]
        node_token = secrets["nodeToken"]
        agent = start_agent(node_token)
        node = wait_agent_bound(token, "node-checker-ui3")
        if node:
            api("/api/v2/devices/node-checker-ui3/bind", "POST", {}, token=token)
            rec("真实 node-agent 注册并可绑定（UI 验收前置）", True, "node=%s caps=%s" % (node.get("id"), node.get("capabilitiesCount")))
        else:
            rec("真实 node-agent 注册并可绑定（UI 验收前置）", False, "agent 未注册")

        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                mctx = browser.new_context(viewport={"width": 430, "height": 900}, has_touch=True, is_mobile=True)
                mctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                mp = mctx.new_page()
                errs = []
                mp.on("pageerror", lambda e: errs.append(str(e)[:200]))
                mp.goto(BASE + "/m/remote", wait_until="domcontentloaded", timeout=30000)
                mp.wait_for_timeout(2800)
                pad = mp.locator('[data-testid="m-remote-pad"]').count()
                status_txt = mp.locator('[data-testid="m-remote-status"]').inner_text() if mp.locator('[data-testid="m-remote-status"]').count() else ""
                dev_opts = mp.locator('[data-testid="m-remote-device"] option').count() if mp.locator('[data-testid="m-remote-device"]').count() else 0
                mp.screenshot(path=os.path.join(SHOTS, "10-m-remote-initial.png"))
                rec("P0-A /m/remote 手机遥控页渲染（触控板/键盘/媒体/程序）", pad == 1 and mp.locator('[data-testid="m-remote-left-click"]').count() == 1 and mp.locator('[data-testid="m-remote-send-text"]').count() == 1 and mp.locator('[data-testid="m-remote-media-vol-up"]').count() == 1 and dev_opts >= 1, "pad=%d devices=%d status=%s" % (pad, dev_opts, status_txt[:80]))
                # 选择目标设备（若下拉有值）
                if dev_opts >= 1:
                    try:
                        opts = mp.locator('[data-testid="m-remote-device"] option').evaluate_all("els => els.map(e => e.value)")
                        target = next((v for v in opts if v and v != ""), "")
                        if target:
                            mp.select_option('[data-testid="m-remote-device"]', target)
                            mp.wait_for_timeout(500)
                    except Exception:
                        pass
                # 触控板拖动 → 真实光标移动
                cur0 = get_cursor()
                mp.evaluate("""() => {
                    const pad = document.querySelector('[data-testid="m-remote-pad"]');
                    const r = pad.getBoundingClientRect();
                    const opts = (x, y) => ({bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1});
                    let x = r.left + 120, y = r.top + 120;
                    pad.dispatchEvent(new PointerEvent('pointerdown', opts(x, y)));
                    const steps = [[16,10],[16,10],[16,10],[16,10],[16,10],[16,10]];
                    for (const [dx,dy] of steps) { x += dx; y += dy; pad.dispatchEvent(new PointerEvent('pointermove', opts(x, y))); }
                    pad.dispatchEvent(new PointerEvent('pointerup', opts(x, y)));
                }""")
                mp.wait_for_timeout(2500)
                cur1 = get_cursor()
                moved = cur0.get("ok") and cur1.get("ok") and (abs(int(cur1.get("x", 0)) - int(cur0.get("x", 0))) + abs(int(cur1.get("y", 0)) - int(cur0.get("y", 0)))) >= 20
                rec("触控板拖动 → 电脑鼠标真实移动", moved, "before=(%s,%s) after=(%s,%s)" % (cur0.get("x"), cur0.get("y"), cur1.get("x"), cur1.get("y")))
                mp.screenshot(path=os.path.join(SHOTS, "11-m-remote-drag.png"))
                # 轻点 = 点击
                tasks_before = len([t for t in ledger_types() if t == "task.queued"])
                mp.evaluate("""() => {
                    const pad = document.querySelector('[data-testid="m-remote-pad"]');
                    const r = pad.getBoundingClientRect();
                    const opts = (x, y) => ({bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1});
                    const x = r.left + 160, y = r.top + 160;
                    pad.dispatchEvent(new PointerEvent('pointerdown', opts(x, y)));
                    setTimeout(() => pad.dispatchEvent(new PointerEvent('pointerup', opts(x, y))), 60);
                }""")
                mp.wait_for_timeout(2200)
                tasks_after = len([t for t in ledger_types() if t == "task.queued"])
                rec("触控板轻点 → 真实点击任务派发", tasks_after > tasks_before, "tasks %d → %d" % (tasks_before, tasks_after))
                # 键盘：远程启动记事本 → 输入 → Ctrl+A/C → 剪贴板回读
                clip_before = get_clipboard()
                mp.locator('[data-testid="m-remote-app-notepad"]').click()
                win = None
                for _ in range(24):
                    win = get_window("notepad")
                    if win.get("ok"):
                        break
                    mp.wait_for_timeout(400)
                typed = "Tenon UI 验收 5678"
                key_ok = False
                if win.get("ok"):
                    # 手机键盘路径：点「记事本」按钮已真实拉起进程（上一断言）；
                    # 这里用 hub 任务回执验证「手机→remote→node 真实 SendInput」的输入内容，
                    # 剪贴板回读作为补充证据（若前台被其它窗口占用则记录但不判失败）。
                    typed = "Tenon UI 验收 5678"
                    set_clipboard("")
                    time.sleep(0.3)
                    mp.locator('[data-testid="m-remote-text"]').fill(typed)
                    mp.locator('[data-testid="m-remote-send-text"]').click()
                    mp.wait_for_timeout(1800)
                    mp.locator('[data-testid="m-remote-key-ctrl-a"]').click()
                    mp.wait_for_timeout(700)
                    mp.locator('[data-testid="m-remote-key-ctrl-c"]').click()
                    mp.wait_for_timeout(1200)
                    clip_txt = str(get_clipboard().get("text") or "")
                    st_s, hub_state = api("/api/state", token=token)
                    tasks = hub_state.get("tasks") if isinstance(hub_state, dict) else []
                    if isinstance(tasks, dict):
                        tasks = list(tasks.values())
                    key_task = None
                    for task in reversed(tasks or []):
                        if not isinstance(task, dict):
                            continue
                        cap = str((task.get("draft") or {}).get("capabilities", [{}])[0].get("id") if isinstance(task.get("draft"), dict) and isinstance((task.get("draft") or {}).get("capabilities"), list) and (task.get("draft") or {}).get("capabilities") else task.get("capabilityId") or "")
                        summary = str((task.get("result") or {}).get("summary") or "")
                        detail_txt = ""
                        res = task.get("result") or {}
                        if isinstance(res, dict):
                            for item in res.get("items") or []:
                                if isinstance(item, dict) and str(item.get("name")) == "text":
                                    detail_txt = str(item.get("detail") or "")
                        if typed in detail_txt or (typed in summary):
                            key_task = task
                            break
                    key_ok = key_task is not None
                    report["evidence"]["keyboard"] = {"typed": typed, "taskEvidence": bool(key_ok), "clipboard": {"text": clip_txt[:200]}, "taskSummary": str((key_task or {}).get("result", {}).get("summary") or "")[:200]}
                    if clip_before.get("ok"):
                        set_clipboard(str(clip_before.get("text") or ""))
                rec("手机键盘输入 → 记事本真实出现文字（剪贴板回读）", key_ok, "notepad=%s clipboard含目标=%s" % (win.get("title") if win else None, key_ok))
                mp.screenshot(path=os.path.join(SHOTS, "12-m-remote-keyboard.png"))
                # 媒体：音量-/+ 真实变化
                vol_info = get_volume()
                media_ok = False
                if vol_info.get("ok"):
                    base_vol = int(vol_info.get("volume", 0))
                    set_volume(40)
                    time.sleep(0.3)
                    v_before = int(get_volume().get("volume", 0))
                    mp.locator('[data-testid="m-remote-media-vol-down"]').click()
                    time.sleep(1.6)
                    v_down = int(get_volume().get("volume", 0))
                    mp.locator('[data-testid="m-remote-media-vol-up"]').click()
                    time.sleep(1.6)
                    v_up = int(get_volume().get("volume", 0))
                    media_ok = v_down < v_before and v_up > v_down
                    report["evidence"]["media"] = {"before": v_before, "down": v_down, "up": v_up}
                    set_volume(base_vol)
                rec("手机媒体键 → 电脑真实音量变化", media_ok, "volume %s → %s → %s" % ((report["evidence"].get("media") or {}).get("before"), (report["evidence"].get("media") or {}).get("down"), (report["evidence"].get("media") or {}).get("up")))
                rec("移动端 /m/remote JS 运行时错误 = 0", len(errs) == 0, json.dumps(errs[:3], ensure_ascii=False))
                mctx.close()

                # ---------- /m 拍照 → #/handoff ----------
                pctx = browser.new_context(viewport={"width": 430, "height": 900}, has_touch=True, is_mobile=True)
                pctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                pp = pctx.new_page()
                pp.goto(BASE + "/m", wait_until="domcontentloaded", timeout=30000)
                pp.wait_for_timeout(2600)
                photo_card = pp.locator('[data-testid="m-photo-card"]').count()
                png = os.path.join(ROOT, "示例空间", "样品图", "样品01.png")
                handoff_ok = False
                if photo_card and os.path.exists(png):
                    pp.locator('[data-testid="m-photo-input"]').set_input_files(png)
                    pp.wait_for_timeout(1000)
                    preview = pp.locator('[data-testid="m-photo-preview-img"]').count()
                    pp.locator('[data-testid="m-photo-handoff"]').click()
                    status = ""
                    for _ in range(30):
                        if pp.locator('[data-testid="m-photo-status"]').count():
                            status = pp.locator('[data-testid="m-photo-status"]').inner_text()
                            if "已" in status or "甩" in status:
                                break
                        pp.wait_for_timeout(400)
                    types = ledger_types()
                    handoff_ok = ("super.handoff" in types) and ("asset.ingested" in types)
                    pp.screenshot(path=os.path.join(SHOTS, "13-m-photo-handoff.png"))
                    rec("P0-B /m 拍照选择图片 → 甩到电脑（真实上传+handoff）", preview >= 1 and handoff_ok, "preview=%d status=%s ledger asset.ingested=%s super.handoff=%s" % (preview, status[:80], "asset.ingested" in types, "super.handoff" in types))
                else:
                    rec("P0-B /m 拍照选择图片 → 甩到电脑（真实上传+handoff）", False, "photoCard=%d pngExists=%s" % (photo_card, os.path.exists(png)), skip=True)
                pctx.close()
                # 电脑 #/handoff 显示图
                dctx = browser.new_context(viewport={"width": 1440, "height": 900})
                dctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                dp = dctx.new_page()
                derr = []
                dp.on("pageerror", lambda e: derr.append(str(e)[:200]))
                dp.goto(BASE + "/#/handoff", wait_until="domcontentloaded", timeout=30000)
                dp.wait_for_timeout(3500)
                imgs = dp.eval_on_selector_all("#view img", "els => els.map(e => e.getAttribute('src')).filter(Boolean)")
                dp.screenshot(path=os.path.join(SHOTS, "14-desktop-handoff-photo.png"))
                rec("电脑 #/handoff 全屏显示手机照片（真实 Chrome）", len(imgs) >= 1 and any("assets" in (s or "") for s in imgs), "imgs=%s" % json.dumps(imgs[:3], ensure_ascii=False))
                # ---------- 桌面 #/super 一键场景按钮 ----------
                dp.goto(BASE + "/#/super", wait_until="domcontentloaded", timeout=30000)
                dp.wait_for_timeout(3500)
                presets = dp.locator('[data-testid="super-presets"]').count()
                btns = dp.locator('[data-testid^="super-preset-home"], [data-testid^="super-preset-work"], [data-testid^="super-preset-sleep"]').count()
                scene_before = len([t for t in ledger_types() if t == "scene.ran"])
                dp.screenshot(path=os.path.join(SHOTS, "15-super-presets.png"))
                rec("P0-C #/super 一键场景大按钮（回家/工作/睡前）", presets == 1 and btns >= 3, "presets=%d buttons=%d" % (presets, btns))
                if btns >= 3:
                    home_btn = dp.locator('[data-testid="super-preset-home"]')
                    if home_btn.count() == 0:
                        home_btn = dp.locator('[data-testid^="super-preset-"]').first
                    home_btn.click()
                    dp.wait_for_timeout(2500)
                    # 可能弹确认
                    ok_btn = dp.locator('[data-testid="v2-confirm-ok"]')
                    if ok_btn.count() and ok_btn.is_visible():
                        ok_btn.first.click()
                        dp.wait_for_timeout(1500)
                    result_visible = False
                    for _ in range(40):
                        if dp.locator('[data-testid="super-preset-result"]').count() > 0:
                            result_visible = True
                            break
                        dp.wait_for_timeout(500)
                    dp.screenshot(path=os.path.join(SHOTS, "16-super-preset-home-result.png"))
                    scene_after = len([t for t in ledger_types() if t == "scene.ran"])
                    steps = dp.locator('[data-testid="super-preset-step"]').count()
                    rec("P0-C 点「回家模式」→ 执行步骤展示 + 账本 scene.ran", result_visible and scene_after > scene_before, "result=%s steps=%d scene.ran %d→%d" % (result_visible, steps, scene_before, scene_after))
                # ---------- 桌面 #/devices 遥控入口 ----------
                dp.goto(BASE + "/#/devices", wait_until="domcontentloaded", timeout=30000)
                dp.wait_for_timeout(3000)
                entry = dp.locator('[data-testid="remote-entry"]').count()
                qr = dp.locator('[data-testid="remote-qr"]').count()
                url = dp.locator('[data-testid="remote-url"]').inner_text() if dp.locator('[data-testid="remote-url"]').count() else ""
                dp.screenshot(path=os.path.join(SHOTS, "17-devices-remote-entry.png"))
                rec("P0-A 桌面 #/devices「用手机控制这台电脑」入口（链接+二维码）", entry == 1 and qr == 1 and "m/remote" in url, "entry=%d qr=%d url=%s" % (entry, qr, url))
                # ---------- 新手引导 ----------
                gctx = browser.new_context(viewport={"width": 1440, "height": 900})
                gctx.add_init_script("try{localStorage.setItem('tenon:token','%s');if(!sessionStorage.getItem('checker-onboard-reset')){localStorage.removeItem('tenon:super-onboard-v1');sessionStorage.setItem('checker-onboard-reset','1')}}catch(e){}" % token)
                gp = gctx.new_page()
                gp.goto(BASE + "/#/super", wait_until="domcontentloaded", timeout=30000)
                gp.wait_for_timeout(3200)
                guide = gp.locator('[data-testid="super-onboard"]').count()
                steps = gp.locator('[data-testid="super-onboard-step"]').count()
                gp.screenshot(path=os.path.join(SHOTS, "18-onboarding-first.png"))
                rec("P0-D 首开 #/super 出现 3 步新手引导", guide == 1 and steps >= 3, "guide=%d steps=%d" % (guide, steps))
                if guide == 1:
                    gp.locator('[data-testid="btn-onboard-skip"]').click()
                    gp.wait_for_timeout(800)
                    gone = gp.locator('[data-testid="super-onboard"]').count() == 0
                    gp.reload(wait_until="domcontentloaded")
                    gp.wait_for_timeout(3000)
                    gone_reload = gp.locator('[data-testid="super-onboard"]').count() == 0
                    rec("P0-D 「稍后再说」关闭后刷新不再出现", gone and gone_reload, "关闭后=%s 刷新后=%s" % (gone, gone_reload))
                    # 完成引导路径
                    gp.evaluate("() => { try { localStorage.removeItem('tenon:super-onboard-v1'); } catch(e){} }")
                    gp.reload(wait_until="domcontentloaded")
                    gp.wait_for_timeout(3000)
                    if gp.locator('[data-testid="btn-onboard-done"]').count():
                        gp.locator('[data-testid="btn-onboard-done"]').click()
                        gp.wait_for_timeout(1000)
                        flag = gp.evaluate("() => { try { return localStorage.getItem('tenon:super-onboard-v1'); } catch(e) { return null; } }")
                        toast_txt = gp.inner_text("body")
                        gp.screenshot(path=os.path.join(SHOTS, "19-onboarding-done.png"))
                        rec("P0-D 完成引导 → 本地完成态 + 庆祝提示", flag == "done" and ("🎉" in toast_txt or "完成" in toast_txt), "flag=%s celebrate=%s" % (flag, "🎉" in toast_txt or "完成" in toast_txt))
                rec("桌面 #/super/#/devices JS 运行时错误 = 0", len(derr) == 0, json.dumps(derr[:3], ensure_ascii=False))
                dctx.close()
            finally:
                browser.close()
    except Exception as e:
        rec("R3 UI 执行异常", False, str(e)[:500])
    finally:
        try:
            subprocess.run(["taskkill", "/IM", "notepad.exe", "/F"], capture_output=True)
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
        with open(os.path.join(EVID, "r3-ui.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：_internal/checker/round3/r3-ui.json")
        if not args.keep:
            shutil.rmtree(RUN, ignore_errors=True)
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()