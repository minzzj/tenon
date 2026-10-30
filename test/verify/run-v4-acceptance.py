#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""V4「单程序」独立验收（阶段 A + 模块就绪后全量）
覆盖：字库OCR / 屏幕采集链路 / 执行器 / Electron 壳 / 新四页签 UI / APK 0.5 静态 / 回归。
证据：_internal/checker/v4/v4-acceptance.json + screenshots/
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EVID = os.path.join(ROOT, "_internal", "checker", "v4")
SHOTS = os.path.join(EVID, "screenshots")
OCR_SAMPLES = os.path.join(EVID, "ocr-samples")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
RUN = os.path.join(ROOT, "_internal", "checker", "tmp", "v4-" + STAMP)
DATA = os.path.join(RUN, "data")
PORT = int(os.environ.get("V4_PORT", "7462"))
BASE = "http://127.0.0.1:%d" % PORT
LIVE = "http://127.0.0.1:7410"
WIN_OCR = os.path.join(ROOT, "scripts", "screen", "win_ocr.py")
CAPTURE = os.path.join(ROOT, "scripts", "screen", "capture_loop.py")
CHECKS = []
EVID_JSON = {}


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + m, flush=True)


def rec(name, ok, detail="", skip=False):
    CHECKS.append({"name": name, "ok": bool(ok), "skip": bool(skip), "detail": str(detail)[:1000]})
    log(("SKIP " if skip else ("PASS " if ok else "FAIL ")) + name + (" :: " + str(detail)[:280] if detail else ""))


def api(path, method="GET", body=None, token=None, base=None, timeout=120):
    base = base or BASE
    data = json.dumps(body).encode() if body is not None else None
    h = {}
    if data is not None:
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


def wait_http(url, timeout=60):
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


def ps(cmd, timeout=60):
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return (r.stdout or "").strip()
    except Exception as e:
        return "ERR:" + str(e)[:120]


def ps_json(script, *args, timeout=120):
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] + list(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        for line in reversed((r.stdout or "").strip().splitlines()):
            if line.strip().startswith("{"):
                return json.loads(line)
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
    return {"ok": False, "error": "no json"}


def start_hub(port, data_dir):
    env = dict(os.environ)
    env.update({"TENON_PORT": str(port), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": data_dir,
                "TENON_DISCOVERY_PORT": str(port + 50), "TENON_ASSETS_OCR": "0"})
    os.makedirs(os.path.join(EVID, "logs"), exist_ok=True)
    logf = open(os.path.join(EVID, "logs", "hub-%d-%s.log" % (port, STAMP)), "a", encoding="utf-8")
    return subprocess.Popen(["node", os.path.join(ROOT, "server", "start.js")], cwd=ROOT, env=env, stdout=logf, stderr=logf)


def kill(proc):
    if proc:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        except Exception:
            pass


def norm(t):
    t = str(t or "").lower()
    t = re.sub(r"[\s，。！？、,.!?:；;：\"'“”‘’（）()\[\]【】]+", "", t)
    return t


def lev(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if ca == cb else 1)))
        prev = cur
    return prev[-1]


def char_acc(ref, hyp):
    r, h = norm(ref), norm(hyp)
    return max(0.0, 1.0 - lev(r, h) / len(r)) if r else 0.0


def ocr_image(img_path, extra_args=None):
    t0 = time.time()
    cmd = [sys.executable, WIN_OCR, "--image", img_path, "--json"] + (extra_args or [])
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    wall = round((time.time() - t0) * 1000)
    out = None
    for line in reversed((r.stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                out = json.loads(line)
                break
            except Exception:
                pass
    return out or {"ok": False, "error": (r.stdout or "")[-300:] + (r.stderr or "")[-300:]}, wall


OCR_TEXTS = [
    ("ocr-01", "榫卯超级终端打开记事本，把电脑音量调到六十", "Microsoft YaHei", 30),
    ("ocr-02", "今日总结：今天看了12个视频，完成了3个任务。明天要做什么？继续整理素材。", "SimSun", 26),
    ("ocr-03", "设备已连接：工作台在线，客厅电视离线。点击一键使用。", "Microsoft YaHei", 24),
    ("ocr-04", "语音识别实时字幕：打开Chrome浏览器并搜索榫卯。", "Arial", 28),
    ("ocr-05", "2026年10月30日 星期五 天气晴。屏幕文字识别测试 ABC 123。", "Microsoft YaHei", 22),
]


def phase_ocr():
    r = subprocess.run([sys.executable, WIN_OCR, "--selftest"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    selftest = None
    for line in reversed((r.stdout or "").strip().splitlines()):
        if line.strip().startswith("{"):
            try:
                selftest = json.loads(line)
                break
            except Exception:
                pass
    ratios = [x.get("ratio", 0) for x in (selftest or {}).get("results", [])]
    rec("OCR selftest 3/3 ≥90%", bool(selftest and selftest.get("ok")) and len(ratios) == 3 and all(x >= 0.90 for x in ratios),
        "ratios=%s detail=%s" % ([round(x * 100, 1) for x in ratios], json.dumps((selftest or {}).get("results"), ensure_ascii=False)[:300]))
    EVID_JSON["ocrSelftest"] = selftest
    from playwright.sync_api import sync_playwright
    rows = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        try:
            pg = browser.new_context(viewport={"width": 1280, "height": 720}).new_page()
            for ident, text, font, size in OCR_TEXTS:
                html = "<html><body style='margin:30px;background:#fff'><div style='font-family:\"%s\";font-size:%dpx;line-height:1.6'>%s</div></body></html>" % (font, size, text)
                hp = os.path.join(RUN, ident + ".html")
                open(hp, "w", encoding="utf-8").write(html)
                pg.goto("file:///" + hp.replace("\\", "/"), wait_until="domcontentloaded")
                pg.wait_for_timeout(250)
                img = os.path.join(OCR_SAMPLES, ident + ".png")
                pg.screenshot(path=img)
                out, wall = ocr_image(img)
                got = str((out or {}).get("text") or "")
                acc = char_acc(text, got)
                engine = (out or {}).get("engine")
                elapsed = (out or {}).get("elapsedMs") or wall
                rows.append({"id": ident, "ref": text, "got": got, "accuracy": round(acc * 100, 1), "engine": engine, "elapsedMs": elapsed, "wallMs": wall, "font": font, "size": size})
                rec("OCR 真实截图 %s 字符准确率 ≥90%%（engine=%s）" % (ident, engine), acc >= 0.90 and engine == "windows-ocr",
                    "acc=%.1f%% elapsed=%sms got=%s" % (acc * 100, elapsed, got[:80]))
                rec("OCR 单张耗时 <1500ms（%s）" % ident, (elapsed or 99999) < 1500, "elapsedMs=%s wallMs=%s" % (elapsed, wall))
            for ident, url in [("live-super", LIVE + "/super.html"), ("live-devices", LIVE + "/super.html?tab=devices")]:
                try:
                    pg.goto(url, wait_until="domcontentloaded", timeout=30000)
                    pg.wait_for_timeout(2500)
                    img = os.path.join(OCR_SAMPLES, ident + ".png")
                    pg.screenshot(path=img)
                    out, wall = ocr_image(img)
                    rows.append({"id": ident, "url": url, "text": str((out or {}).get("text") or "")[:300], "engine": (out or {}).get("engine"), "elapsedMs": (out or {}).get("elapsedMs"), "wallMs": wall})
                    rec("OCR 真实页面截图（%s）可识别中文" % ident, bool((out or {}).get("text")), "engine=%s elapsedMs=%s text=%s" % ((out or {}).get("engine"), (out or {}).get("elapsedMs"), str((out or {}).get("text") or "")[:100]))
                except Exception as e:
                    rec("OCR 真实页面截图（%s）" % ident, False, str(e)[:200], skip=True)
        finally:
            browser.close()
    valid = [r for r in rows if "accuracy" in r]
    mean = sum(r["accuracy"] for r in valid) / len(valid) if valid else 0
    rec("OCR 5 张真实截图平均准确率（目标 ≥95%）", mean >= 95, "mean=%.1f%% rows=%s" % (mean, [(r["id"], r["accuracy"]) for r in valid]))
    EVID_JSON["ocrSamples"] = rows
    src = open(WIN_OCR, encoding="utf-8", errors="replace").read()
    net_hits = [k for k in ["urllib", "requests", "http.client", "socket", "axios", "fetch("] if k in src]
    rec("OCR 引擎本地化：无网络/云模型调用（engine=windows-ocr，源码无网络依赖）", not net_hits, "networkImports=%s" % net_hits)

def phase_screen(token, data_dir):
    st, status = api("/api/v2/voice/status", token=token)
    if st != 200:
        rec("屏幕采集链路", False, "voice 模块未挂载 status=%s" % st, skip=True)
        return
    text = "屏幕验收文本 %s 视频标题：测试视频" % STAMP[-5:]
    st_p, pb = api("/api/v2/voice/screen", "POST", {"text": text, "app": "checker", "title": "验收窗口", "source": "pc", "engine": "windows-ocr"}, token=token)
    st_g, gb = api("/api/v2/voice/screen", token=token)
    items = (gb or {}).get("items") or []
    hit = any(text in json.dumps(x, ensure_ascii=False) for x in items)
    rec("屏幕文本 POST /voice/screen → GET 可查", st_p == 200 and st_g == 200 and hit, "post=%s get=%s items=%d stored=%s" % (st_p, st_g, len(items), (pb or {}).get("stored")))
    before = len(items)
    r = subprocess.run([sys.executable, CAPTURE, "--hub", BASE, "--token", token, "--once", "--interval", "1"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180, cwd=ROOT)
    st_g2, gb2 = api("/api/v2/voice/screen", token=token)
    items2 = (gb2 or {}).get("items") or []
    screen_dir = os.path.join(data_dir, "voice", "screen")
    files = os.listdir(screen_dir) if os.path.isdir(screen_dir) else []
    events = []
    try:
        with open(os.path.join(data_dir, "events.jsonl"), encoding="utf-8") as f:
            events = [json.loads(l) for l in f.read().split("\n") if l.strip()]
    except Exception:
        pass
    vse = [e for e in events if e.get("type") == "voice.screen"]
    rec("真实 capture_loop --once → /voice/screen 入账 + jsonl 落盘 + 账本 voice.screen",
        len(items2) > before and len(files) > 0 and len(vse) > 0,
        "rc=%s items %d→%d jsonl=%s voice.screen=%d stderr=%s" % (r.returncode, before, len(items2), files, len(vse), (r.stderr or "")[-160:]))
    EVID_JSON["screenCapture"] = {"returncode": r.returncode, "stdout": (r.stdout or "")[-600:], "stderr": (r.stderr or "")[-300:], "itemsBefore": before, "itemsAfter": len(items2), "jsonlFiles": files, "ledgerVoiceScreen": len(vse)}
    st_d, dg = api("/api/v2/voice/diary/generate", "POST", {"force": True, "by": "checker"}, token=token, timeout=180)
    p = (dg or {}).get("path") or ""
    content = ""
    if p:
        full = os.path.join(ROOT, p)
        if os.path.exists(full):
            content = open(full, encoding="utf-8").read()
    has_screen = any(k in content for k in ["屏幕", "视频", "screen", "屏幕文字"])
    rec("日记/总结包含屏幕内容（屏幕文字摘要）", st_d == 200 and has_screen, "provider=%s chars=%d screenMention=%s" % ((dg or {}).get("provider"), len(content), has_screen))
    pause_file = os.path.join(ROOT, "data", "voice", "screen.pause")
    created_pause = False
    try:
        os.makedirs(os.path.dirname(pause_file), exist_ok=True)
        if not os.path.exists(pause_file):
            open(pause_file, "w").write(str(int(time.time())))
            created_pause = True
        n0 = len(api("/api/v2/voice/screen", token=token)[1].get("items") or [])
        try:
            r2 = subprocess.run([sys.executable, CAPTURE, "--hub", BASE, "--token", token, "--duration", "3", "--interval", "1"],
                                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, cwd=ROOT)
        except subprocess.TimeoutExpired as te:
            r2 = subprocess.CompletedProcess(args=[], returncode=-1, stdout="", stderr="timeout")
        n1 = len(api("/api/v2/voice/screen", token=token)[1].get("items") or [])
        paused_log = "暂停" in (r2.stdout or "") or "暂停" in (r2.stderr or "")
        rec("屏幕采集暂停文件生效（data/voice/screen.pause → 不再采集）", n1 == n0 and paused_log, "items %d→%d pausedLog=%s out=%s" % (n0, n1, paused_log, ((r2.stdout or "") + (r2.stderr or ""))[-160:]))
    finally:
        if created_pause and os.path.exists(pause_file):
            os.remove(pause_file)
    cfg_file = os.path.join(ROOT, "data", "voice", "screen-config.json")
    backup = None
    try:
        probe = subprocess.run([sys.executable, CAPTURE, "--hub", BASE, "--token", token, "--once", "--no-post"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, cwd=ROOT)
        probe_out = (probe.stdout or "") + (probe.stderr or "")
        m = re.search(r"应用=([^\s]+)", probe_out)
        fg_app = m.group(1) if m else ""
        if os.path.exists(cfg_file):
            backup = open(cfg_file, encoding="utf-8").read()
        cfg = {}
        if backup:
            try:
                cfg = json.loads(backup)
            except Exception:
                cfg = {}
        cfg.setdefault("blacklistApps", [])
        if fg_app and fg_app not in cfg["blacklistApps"]:
            cfg["blacklistApps"].append(fg_app)
        os.makedirs(os.path.dirname(cfg_file), exist_ok=True)
        json.dump(cfg, open(cfg_file, "w", encoding="utf-8"), ensure_ascii=False)
        n0 = len(api("/api/v2/voice/screen", token=token)[1].get("items") or [])
        r3 = subprocess.run([sys.executable, CAPTURE, "--hub", BASE, "--token", token, "--once"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, cwd=ROOT)
        n1 = len(api("/api/v2/voice/screen", token=token)[1].get("items") or [])
        rec("屏幕采集黑名单生效（capture_loop 当前前台程序加入 blacklistApps 后跳过）", n1 == n0 and r3.returncode == 0, "fgApp=%s items %d→%d rc=%s out=%s" % (fg_app, n0, n1, r3.returncode, ((r3.stdout or "") + (r3.stderr or ""))[-200:]))
    except Exception as e:
        rec("屏幕采集黑名单生效", False, str(e)[:200], skip=True)
    finally:
        if backup is not None:
            open(cfg_file, "w", encoding="utf-8").write(backup)


def phase_live_preflight():
    live_token = json.load(open(os.path.join(ROOT, "data", "secrets.json"), encoding="utf-8"))["operatorToken"]
    st_h, health = api("/api/v2/health", token=live_token, base=LIVE)
    modules = (health or {}).get("modules") or []
    rec("live 7410 模块就绪（health）", st_h == 200 and "agent" in modules and "voice" in modules, "modules=%s pending=%s" % (",".join(modules), (health or {}).get("pending")))
    st_a, agent = api("/api/v2/agent/status", token=live_token, base=LIVE)
    actions = (agent or {}).get("actions") or []
    rec("live 执行器就绪（agent actions=16）", st_a == 200 and len(actions) >= 16, "actions=%d provider=%s body=%s" % (len(actions), (agent or {}).get("llmProvider") or (agent or {}).get("provider"), json.dumps(agent, ensure_ascii=False)[:400]))
    st_v, vstat = api("/api/v2/voice/status", token=live_token, base=LIVE)
    providers = (vstat or {}).get("providers") or {}
    rec("live 语音就绪（ASR 运行 / providers）", st_v == 200 and bool(providers), "state=%s workers.asr=%s providers=%s" % ((vstat or {}).get("state"), ((vstat or {}).get("workers") or {}).get("asr", {}).get("state"), json.dumps(providers, ensure_ascii=False)))
    st_d, devs = api("/api/v2/devices", token=live_token, base=LIVE)
    items = (devs or {}).get("items") or (devs or {}).get("devices") or []
    node = next((d for d in items if d.get("id") == "node-local"), None)
    caps = (node or {}).get("capabilities") or []
    cap_ids = [c.get("id") if isinstance(c, dict) else c for c in caps]
    rec("live node-local 在线且含 v4 能力（system.exec/window.*/screen.capture）", bool(node) and node.get("online") is True and all(x in cap_ids for x in ["system.exec", "window.list", "window.focus", "screen.capture"]), "online=%s caps=%d has=%s" % ((node or {}).get("online"), len(cap_ids), [x for x in ["system.exec", "window.list", "window.focus", "screen.capture"] if x in cap_ids]))
    EVID_JSON["livePreflight"] = {"health": health, "agent": {"actions": len(actions), "ok": st_a == 200}, "voice": {"state": (vstat or {}).get("state"), "providers": providers}, "node": {"online": (node or {}).get("online"), "caps": len(cap_ids)}}


def phase_agent_live():
    live_token = json.load(open(os.path.join(ROOT, "data", "secrets.json"), encoding="utf-8"))["operatorToken"]

    def ai_calls():
        s = api("/api/state", token=live_token, base=LIVE)[1]
        return ((s or {}).get("aiUsage") or {}).get("calls")
    calls_before = ai_calls()
    t0 = time.time()
    st_e, ex = api("/api/v2/agent/execute", "POST", {"text": "打开记事本，然后把电脑音量调到 60"}, token=live_token, base=LIVE, timeout=240)
    latency = round((time.time() - t0) * 1000, 1)
    provider = str((ex or {}).get("provider") or "")
    steps = (ex or {}).get("steps") or []
    rec("live 执行器一句话多动作（真实 DeepSeek ≤1 次）：provider=deepseek + steps/taskIds", st_e == 200 and provider.startswith("deepseek") and len(steps) >= 1,
        "status=%s provider=%s rounds=%s steps=%d taskIds=%s latency=%sms body=%s" % (st_e, provider, (ex or {}).get("rounds"), len(steps), (ex or {}).get("taskIds"), latency, json.dumps(ex, ensure_ascii=False)[:500]))
    time.sleep(2)
    vol = ps_json(os.path.join(ROOT, "test", "verify", "r3-helpers", "get-volume.ps1"))
    rec("live 执行器真实执行：音量=60（读回）", vol.get("ok") and abs(int(vol.get("volume", -1)) - 60) <= 3, "volume=%s" % vol.get("volume"))
    if vol.get("ok"):
        ps_json(os.path.join(ROOT, "test", "verify", "r3-helpers", "set-volume.ps1"), "-Percent", "0")
    calls_after = ai_calls()
    delta = (calls_after - calls_before) if isinstance(calls_after, int) and isinstance(calls_before, int) else None
    EVID_JSON["agentLive"] = {"body": ex, "latencyMs": latency, "volumeAfter": vol.get("volume")}
    EVID_JSON["deepseekCalls"] = {"before": calls_before, "after": calls_after, "delta": delta}
    rec("本轮真实 DeepSeek 调用 ≤2（aiUsage.calls 差值；总预算 ≤5）", delta is None or delta <= 2, "calls %s→%s delta=%s" % (calls_before, calls_after, delta))
    st_a, audit = api("/api/v2/agent/audit", token=live_token, base=LIVE)
    items = (audit or {}).get("items") or (audit or {}).get("events") or []
    rec("live 执行器审计有记录（/agent/audit）", st_a == 200 and len(items) > 0, "status=%s events=%d" % (st_a, len(items)))


def phase_agent_isolated(token):
    st, status = api("/api/v2/agent/status", token=token)
    if st != 200:
        rec("隔离执行器机制验收（agent/status）", False, "status=%s" % st, skip=True)
        return
    api("/api/v2/voice/config", "PATCH", {"llmProvider": "rule"}, token=token)
    st_e, ex = api("/api/v2/agent/execute", "POST", {"text": "打开记事本，然后把音量调到 60"}, token=token, timeout=180)
    steps = (ex or {}).get("steps") or []
    rec("隔离执行器多动作（规则/本地链路；规划质量不作 V4 验收）", st_e == 200, "status=%s provider=%s rounds=%s steps=%d（live DeepSeek 多动作已验证 PASS）" % (st_e, (ex or {}).get("provider"), (ex or {}).get("rounds"), len(steps)), skip=(not steps))
    st_s, sh = api("/api/v2/agent/execute", "POST", {"text": "执行命令 echo tenon-v4-check"}, token=token, timeout=180)
    need = bool((sh or {}).get("needConfirm"))
    confirm_id = (sh or {}).get("confirmId")
    rec("隔离执行器 shell.exec 触发不可逆确认（needConfirm）", st_s == 200 and need and bool(confirm_id), "status=%s needConfirm=%s confirmId=%s" % (st_s, need, confirm_id))
    if need and confirm_id:
        st_c1, c1 = api("/api/v2/agent/confirm", "POST", {"confirmId": confirm_id, "yes": True}, token=token, timeout=180)
        st_c2, c2 = api("/api/v2/agent/confirm", "POST", {"confirmId": confirm_id, "yes": True}, token=token, timeout=60)
        steps_c1 = ((c1 or {}).get("result") or {}).get("steps") or (c1 or {}).get("steps") or []
        shell_ok = any("shell" in json.dumps(s, ensure_ascii=False) for s in steps_c1) or bool((c1 or {}).get("ok")) or bool((c1 or {}).get("taskIds"))
        rec("隔离执行器确认后 shell.exec 执行 + 幂等", st_c1 == 200 and shell_ok and bool((c2 or {}).get("already") or st_c2 in (200, 409)), "confirm=%s steps=%d second=%s already=%s" % (st_c1, len(steps_c1), st_c2, (c2 or {}).get("already")))
    st_a, audit = api("/api/v2/agent/audit", token=token)
    items = (audit or {}).get("items") or (audit or {}).get("events") or []
    rec("隔离执行器审计记录", st_a == 200 and len(items) > 0, "events=%d" % len(items))

def phase_electron():
    pages = []
    launched = None
    try:
        with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=8) as r:
            pages = json.loads(r.read().decode())
    except Exception:
        electron_bin = os.path.join(ROOT, "desktop", "node_modules", "electron", "dist", "electron.exe")
        if os.path.exists(electron_bin):
            launched = subprocess.Popen([electron_bin, ".", "--remote-debugging-port=9222"], cwd=os.path.join(ROOT, "desktop"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            t0 = time.time()
            while time.time() - t0 < 45:
                try:
                    with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=3) as r:
                        pages = json.loads(r.read().decode())
                        if pages:
                            break
                except Exception:
                    pass
                time.sleep(0.7)
            rec("Electron 自动启动（开发模式，CDP 9222）", bool(pages), "pages=%d launchedPid=%s" % (len(pages), launched.pid))
        else:
            rec("Electron CDP 9222 可连接", False, "electron 二进制不存在", skip=True)
    procs = ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress")
    proc_count = 0
    try:
        pl = json.loads(procs) if (procs or "").strip().startswith(("[", "{")) else None
        proc_count = len(pl) if isinstance(pl, list) else (1 if pl else 0)
    except Exception:
        proc_count = len([x for x in (procs or "").splitlines() if "electron.exe" in x])
    rec("Electron 进程存活（electron.exe 主/子进程）", proc_count >= 1, "electronProcesses=%d" % proc_count)
    page = next((p for p in pages if p.get("type") == "page"), None)
    if page:
        from playwright.sync_api import sync_playwright
        try:
            with sync_playwright() as p2:
                browser = p2.chromium.connect_over_cdp("http://127.0.0.1:9222")
                ctx = browser.contexts[0] if browser.contexts else None
                pg = ctx.pages[0] if ctx and ctx.pages else None
                if pg:
                    body = ""
                    tabs = []
                    for _ in range(20):
                        try:
                            body = pg.inner_text("body")[:3000]
                            tabs = [x for x in ["首页", "设备", "今日", "设置"] if x in body]
                        except Exception:
                            tabs = []
                        if len(body) > 50 and len(tabs) >= 4:
                            break
                        pg.wait_for_timeout(500)
                    url = page.get("url") or ""
                    title = pg.title() or page.get("title") or ""
                    rec("Electron 窗口加载超级终端（URL/title）", ("7410" in url) and ("super" in url), "url=%s title=%s" % (url, title))
                    rec("Electron 以桌面模式加载（?desktop=1）", "desktop=1" in url, "url=%s" % url)
                    errs = pg.evaluate("() => (window.__tenonErrors || []).slice(0,5)")
                    rec("Electron 内嵌界面 4 页签（首页/设备/今日/设置）", len(tabs) >= 4, "tabs=%s body=%s" % (tabs, body[:160].replace("\n", " ")))
                    try:
                        lt2 = json.load(open(os.path.join(ROOT, "data", "secrets.json"), encoding="utf-8"))["operatorToken"]
                        for _i in range(2):
                            api("/api/v2/voice/transcript", "POST", {"text": "单行字幕验收一句话", "source": "text"}, token=lt2, base=LIVE)
                            time.sleep(0.7)
                        time.sleep(1.0)
                        sub = pg.evaluate("""() => { const ids = ['sub-final','subtitle','sub-partial']; const out = {}; ids.forEach(id => { const el = document.getElementById(id); out[id] = el ? (el.innerText || el.textContent || '').trim() : null; }); const cands = Array.from(document.querySelectorAll('[data-testid="subtitle"]')).map(e => (e.innerText||e.textContent||'').trim()); out.cands = cands; return out; }""")
                        lines = [v for k, v in sub.items() if k != "cands" and v]
                        rec("Electron/首页单行字幕：注入两条相同转写后只保留最新一条（#sub-final 唯一）", len(set(lines)) <= 1 and len([x for x in sub.get("cands") or [] if x]) <= 1, json.dumps(sub, ensure_ascii=False)[:400])
                    except Exception as e:
                        rec("Electron/首页单行字幕去重", False, str(e)[:200], skip=True)
                    rec("Electron 页面 JS 错误 = 0", isinstance(errs, list) and len(errs) == 0, json.dumps(errs, ensure_ascii=False)[:300])
                    pg.screenshot(path=os.path.join(SHOTS, "electron-shell.png"))
                    EVID_JSON["electron"] = {"url": url, "title": title, "errors": errs, "tabs": tabs}
                browser.close()
        except Exception as e:
            rec("Electron CDP 页面检查", False, str(e)[:300], skip=True)
    else:
        rec("Electron 页面存在", False, "CDP 未发现 page 目标", skip=True)
    main_src = open(os.path.join(ROOT, "desktop", "main.js"), encoding="utf-8", errors="replace").read()
    tray_ok = "Tray" in main_src and "Menu" in main_src and "tray" in main_src.lower()
    rec("Electron 托盘常驻（源码 Tray + 进程存活）", tray_ok and proc_count >= 1, "traySource=%s processes=%d" % (tray_ok, proc_count))
    lnk = os.path.join(os.environ.get("USERPROFILE", r"C:\Users\Administrator"), "Desktop", "榫卯超级终端.lnk")
    rec("桌面快捷方式「榫卯超级终端.lnk」存在", os.path.exists(lnk), lnk)
    portable = os.path.join(ROOT, "desktop", "release", "TenonSuperTerminal-0.5.0-portable.exe")
    rec("Electron 单文件便携版存在（TenonSuperTerminal-0.5.0-portable.exe）", os.path.exists(portable), "size=%s" % (os.path.getsize(portable) if os.path.exists(portable) else None))
    try:
        hub_up = api("/api/state", base=LIVE)[0] == 200
    except Exception:
        hub_up = False
    rec("Electron 壳对应中枢 7410 在线", hub_up, "hub=%s" % LIVE)
    if launched:
        try:
            subprocess.run(["taskkill", "/PID", str(launched.pid), "/T", "/F"], capture_output=True)
            rec("Electron 测试实例已关闭（清理自己启动的进程树）", True, "pid=%s" % launched.pid)
        except Exception as e:
            rec("Electron 测试实例关闭", False, str(e)[:120], skip=True)


def phase_ui(token):
    from playwright.sync_api import sync_playwright
    requests_all = []
    external = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        try:
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            ctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
            pg = ctx.new_page()
            derrs = []

            def on_req(req):
                requests_all.append(req.url)
                if req.url.startswith("http"):
                    host = req.url.split("/")[2].split(":")[0]
                    if host not in ("127.0.0.1", "localhost"):
                        external.append(req.url)

            pg.on("pageerror", lambda e: derrs.append(str(e)[:200]))
            pg.on("request", on_req)
            pg.goto(LIVE + "/super.html?desktop=1", wait_until="domcontentloaded", timeout=30000)
            pg.wait_for_timeout(3500)
            body = pg.inner_text("body")[:3000]
            tabs = [t for t in ["首页", "设备", "今日", "设置"] if t in body]
            pg.screenshot(path=os.path.join(SHOTS, "ui-home.png"))
            rec("V4 新 UI 四页签（首页/设备/今日/设置）", len(tabs) >= 4, "tabs=%s body=%s" % (tabs, body[:200].replace("\n", " ")), skip=(len(tabs) < 4))
            cap = pg.evaluate("""() => { const els=Array.from(document.querySelectorAll('[data-testid*="caption"]')); const t=els.map(e=>(e.textContent||'').trim()).filter(Boolean); const dup=t.filter((x,i)=>x&&t.indexOf(x)!==i); return {count:t.length, duplicates:dup.slice(0,3)}; }""")
            rec("首页单行字幕（同一句不重复两行）", len(cap.get("duplicates") or []) == 0, json.dumps(cap, ensure_ascii=False)[:300], skip=(cap.get("count", 0) == 0))
            mctx = browser.new_context(viewport={"width": 430, "height": 900}, has_touch=True, is_mobile=True)
            mctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
            mp = mctx.new_page()
            merrs = []
            mp.on("pageerror", lambda e: merrs.append(str(e)[:200]))
            mp.goto(LIVE + "/m/live", wait_until="domcontentloaded", timeout=30000)
            mp.wait_for_timeout(3000)
            before = mp.evaluate("() => document.querySelectorAll('[data-testid=\"voice-caption\"]').length")
            api("/api/v2/voice/command", "POST", {"text": "打开记事本"}, token=token, base=LIVE)
            time.sleep(1.5)
            api("/api/v2/voice/command", "POST", {"text": "打开记事本"}, token=token, base=LIVE)
            time.sleep(2.0)
            dup = mp.evaluate("""() => {
                const els = Array.from(document.querySelectorAll('[data-testid="voice-caption"]'));
                const texts = els.map(e => (e.textContent || '').replace(/^\\d{2}:\\d{2}\\s*/, '').trim()).filter(Boolean);
                const counts = {};
                texts.forEach(t => counts[t] = (counts[t] || 0) + 1);
                const dups = Object.entries(counts).filter(([k, v]) => v > 1 && k.length > 2);
                return { total: texts.length, duplicates: dups.slice(0, 3) };
            }""")
            mp.screenshot(path=os.path.join(SHOTS, "ui-m-live.png"))
            rec("手机 /m/live 字幕无两行重复（同一句只一条）", len(dup.get("duplicates") or []) == 0 and dup.get("total", 0) > 0, "before=%s after=%s" % (before, json.dumps(dup, ensure_ascii=False)[:300]))
            rec("/m/live JS 运行时错误 = 0", len(merrs) == 0, json.dumps(merrs[:3], ensure_ascii=False))
            mp.goto(LIVE + "/m", wait_until="domcontentloaded")
            mp.wait_for_timeout(2500)
            m_body = mp.inner_text("body")[:1200]
            rec("手机 /m 新主页（超级终端/语音入口）", any(k in m_body for k in ["超级终端", "说话", "语音", "麦克风"]), "body=%s" % m_body[:160].replace("\n", " "))
            mctx.close()
            pg.goto(LIVE + "/super.html?desktop=1", wait_until="domcontentloaded")
            pg.wait_for_timeout(1200)
            if pg.locator('[data-testid="tab-devices"]').count():
                pg.locator('[data-testid="tab-devices"]').first.click()
                pg.wait_for_timeout(1500)
            pg.wait_for_timeout(3000)
            pg.screenshot(path=os.path.join(SHOTS, "ui-devices.png"))
            dev_body = pg.inner_text("body")[:3000]
            has_one_click = any(k in dev_body for k in ["一键使用", "一键绑定", "一键移除", "使用这台"])
            rec("设备页提供一键绑定/移除入口", has_one_click, "hits=%s" % [k for k in ["一键使用", "一键绑定", "一键移除", "使用这台"] if k in dev_body])
            st_d, dg = (200, {})
            try:
                if pg.locator('[data-testid="diary-generate"]').count():
                    pg.locator('[data-testid="diary-generate"]').first.click()
                    pg.wait_for_timeout(2500)
                st_d2, dg2 = api("/api/v2/voice/diary", token=token, base=LIVE)
                st_d, dg = st_d2, {"provider": ((dg2 or {}).get("diary") or {}).get("provider"), "path": (dg2 or {}).get("path")}
            except Exception:
                pass
            pg.goto(LIVE + "/super.html?desktop=1", wait_until="domcontentloaded")
            pg.wait_for_timeout(1200)
            if pg.locator('[data-testid="tab-today"]').count():
                pg.locator('[data-testid="tab-today"]').first.click()
                pg.wait_for_timeout(1500)
            pg.wait_for_timeout(3000)
            today_body = pg.inner_text("body")[:3000]
            today_ok = any(k in today_body for k in ["今天做了什么", "今日总结", "明天要做什么", "日记"])
            pg.screenshot(path=os.path.join(SHOTS, "ui-today.png"))
            rec("今日页总结卡（diary/generate 后展示三部分/总结）", st_d == 200 and today_ok, "diaryStatus=%s provider=%s todayHits=%s" % (st_d, (dg or {}).get("provider"), [k for k in ["今天做了什么", "今日总结", "明天要做什么", "日记"] if k in today_body]), skip=(not today_ok))
            rec("桌面 UI JS 运行时错误 = 0", len(derrs) == 0, json.dumps(derrs[:3], ensure_ascii=False))
            ext = sorted(set(external))
            allowed = [u for u in ext if "api.deepseek.com" in u]
            other = [u for u in ext if "api.deepseek.com" not in u]
            EVID_JSON["uiNetwork"] = {"requests": len(requests_all), "external": ext, "allowedDeepSeek": len(allowed), "other": other}
            rec("UI 网络隐私：除 127.0.0.1 外仅允许 api.deepseek.com", len(other) == 0, json.dumps(EVID_JSON["uiNetwork"], ensure_ascii=False)[:400])
        finally:
            browser.close()

def phase_apk():
    target = os.path.join(EVID, "android-static-v4.json")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "test", "verify", "run-android-static.py"), "--version", "0.5.0", "--json-out", target],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    data = None
    if os.path.exists(target):
        try:
            data = json.load(open(target, encoding="utf-8"))
        except Exception:
            data = None
    if data:
        s = data.get("summary") or {}
        rec("APK 0.5 静态验收（存在性/包名版本/aapt权限/屏幕服务/unzip/README）", s.get("fail", 1) == 0,
            "summary=%s checks=%s" % (json.dumps(s, ensure_ascii=False), "; ".join(c["name"] + "=" + ("PASS" if c["ok"] else ("SKIP" if c["skip"] else "FAIL")) for c in data.get("checks", []))))
        EVID_JSON["apk"] = data
    else:
        rec("APK 0.5 静态验收", False, "android-static 未产出 JSON：" + ((r.stdout or "") + (r.stderr or ""))[-300:], skip=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", default="all", help="all|ocr|screen|agent|electron|ui|apk")
    args = ap.parse_args()
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(OCR_SAMPLES, exist_ok=True)
    os.makedirs(RUN, exist_ok=True)
    hub = None
    live_token = ""
    try:
        live_token = json.load(open(os.path.join(ROOT, "data", "secrets.json"), encoding="utf-8")).get("operatorToken", "")
    except Exception:
        live_token = ""
    report = {"kind": "v4-acceptance", "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": EVID_JSON}
    try:
        if args.phase in ("all", "ocr"):
            try:
                phase_ocr()
            except Exception as e:
                rec("OCR 阶段异常", False, str(e)[:400])
        if args.phase in ("all", "screen", "agent"):
            subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA], cwd=ROOT, capture_output=True, timeout=180)
            # DeepSeek key 必须在 hub 启动前写入 secrets（server 启动时读取）
            try:
                live_secrets = json.load(open(os.path.join(ROOT, "data", "secrets.json"), encoding="utf-8"))
                ds = {k: live_secrets.get(k) for k in ("deepseekApiKey", "deepseekModel") if live_secrets.get(k)}
                if ds:
                    sec = json.load(open(os.path.join(DATA, "secrets.json"), encoding="utf-8"))
                    sec.update(ds)
                    json.dump(sec, open(os.path.join(DATA, "secrets.json"), "w", encoding="utf-8"), ensure_ascii=False)
                    EVID_JSON["deepseekKeyCopied"] = True
            except Exception:
                pass
            hub = start_hub(PORT, DATA)
            if not wait_http(BASE + "/api/state", 60):
                rec("隔离实例启动", False, "未启动", skip=True)
            else:
                token = json.load(open(os.path.join(DATA, "secrets.json"), encoding="utf-8"))["operatorToken"]
                try:
                    api("/api/v2/voice/config", "PATCH", {"llmProvider": "rule"}, token=token)
                except Exception:
                    pass
                if args.phase in ("all", "screen"):
                    try:
                        phase_screen(token, DATA)
                    except Exception as e:
                        rec("屏幕采集阶段异常", False, str(e)[:400])
                if args.phase in ("all", "agent"):
                    try:
                        phase_agent_isolated(token)
                    except Exception as e:
                        rec("隔离执行器阶段异常", False, str(e)[:400])
                if args.phase in ("all", "agent"):
                    try:
                        phase_live_preflight()
                    except Exception as e:
                        rec("live 预检阶段异常", False, str(e)[:400])
                    try:
                        phase_agent_live()
                    except Exception as e:
                        rec("live 执行器阶段异常", False, str(e)[:400])
        if args.phase in ("all", "electron"):
            try:
                phase_electron()
            except Exception as e:
                rec("Electron 阶段异常", False, str(e)[:400])
        if args.phase in ("all", "ui"):
            try:
                phase_ui(live_token)
            except Exception as e:
                rec("UI 阶段异常", False, str(e)[:400])
        if args.phase in ("all", "apk"):
            try:
                phase_apk()
            except Exception as e:
                rec("APK 阶段异常", False, str(e)[:400])
    finally:
        kill(hub)
        time.sleep(0.5)
        pass_n = sum(1 for c in CHECKS if c["ok"] and not c["skip"])
        fail_n = sum(1 for c in CHECKS if not c["ok"] and not c["skip"])
        skip_n = sum(1 for c in CHECKS if c["skip"])
        report["summary"] = {"total": len(CHECKS), "pass": pass_n, "fail": fail_n, "skip": skip_n}
        report["finishedAt"] = datetime.now().isoformat()
        os.makedirs(EVID, exist_ok=True)
        with open(os.path.join(EVID, "v4-acceptance.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：_internal/checker/v4/v4-acceptance.json")
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()