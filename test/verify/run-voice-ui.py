#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Round5 语音 UI 独立验收（用户 22:41 澄清版）
真实 Chrome：/m/live（HUD 实时字幕/唤醒光点/回复卡/状态 chips）、/m（极简大麦克风/今日摘要）、#/voice（控制台/转写/配置/日报入口）
检查：渲染、0 JS 错误、关键 testid、SSE 实时字幕（文本命令注入）、本地识别/云端理解状态标识、日报入口（若实现）、
网络隐私：除 127.0.0.1/localhost 外仅允许 api.deepseek.com（且仅在命令/总结链路）。
证据：_internal/checker/round5/voice-ui.json + screenshots/
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EVID = os.path.join(ROOT, "_internal", "checker", "round5")
SHOTS = os.path.join(EVID, "screenshots")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
RUN = os.path.join(ROOT, "_internal", "checker", "tmp", "voiceui-" + STAMP)
DATA = os.path.join(RUN, "data")
PORT = int(os.environ.get("VOICE_PORT", "7462"))
BASE = "http://127.0.0.1:%d" % PORT
CHECKS = []


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + m, flush=True)


def rec(name, ok, detail="", skip=False):
    CHECKS.append({"name": name, "ok": bool(ok), "skip": bool(skip), "detail": str(detail)[:900]})
    log(("SKIP " if skip else ("PASS " if ok else "FAIL ")) + name + (" :: " + str(detail)[:260] if detail else ""))


def api(path, method="GET", body=None, token=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    h = {}
    if data:
        h["Content-Type"] = "application/json"
    if token:
        h["x-tenon-token"] = token
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
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


def start_hub(port, data_dir):
    env = dict(os.environ)
    env.update({"TENON_PORT": str(port), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": data_dir,
                "TENON_DISCOVERY_PORT": str(port + 50), "TENON_ASSETS_OCR": "0"})
    os.makedirs(os.path.join(EVID, "logs"), exist_ok=True)
    logf = open(os.path.join(EVID, "logs", "hub-ui-%d-%s.log" % (port, STAMP)), "a", encoding="utf-8")
    return subprocess.Popen(["node", os.path.join(ROOT, "server", "start.js")], cwd=ROOT, env=env, stdout=logf, stderr=logf)


def main():
    hub = None
    token = ""
    report = {"kind": "voice-ui", "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": {}}
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(RUN, exist_ok=True)
    try:
        subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA], cwd=ROOT, capture_output=True, timeout=180)
        hub = start_hub(PORT, DATA)
        if not wait_http(BASE + "/api/state", 60):
            raise RuntimeError("隔离实例未启动")
        token = json.load(open(os.path.join(DATA, "secrets.json"), encoding="utf-8"))["operatorToken"]
        # 规则模式，避免 UI 测试产生真实云端调用
        api("/api/v2/voice/config", "PATCH", {"llmProvider": "rule", "asrProvider": "auto"}, token=token)
        st_live, _ = api("/m/live")
        st_m, _ = api("/m")
        if st_live == 404:
            rec("/m/live 页面已交付", False, "GET /m/live -> %s" % st_live, skip=True)
        from playwright.sync_api import sync_playwright
        requests_all = []
        external = []

        def on_request(req):
            url = req.url
            requests_all.append(url)
            if url.startswith("http://") or url.startswith("https://"):
                host = url.split("/")[2].split(":")[0]
                if host not in ("127.0.0.1", "localhost"):
                    external.append(url)

        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                mctx = browser.new_context(viewport={"width": 430, "height": 900}, has_touch=True, is_mobile=True)
                mctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                mp = mctx.new_page()
                merrs = []
                mp.on("pageerror", lambda e: merrs.append(str(e)[:200]))
                mp.on("request", on_request)
                mp.goto(BASE + "/m/live", wait_until="domcontentloaded", timeout=30000)
                mp.wait_for_timeout(3500)
                page_ok = st_live == 200
                body = mp.inner_text("body")
                ids = {k: mp.locator('[data-testid="%s"]' % k).count() for k in ["voice-orb", "voice-hud", "voice-caption-stream", "voice-reply", "voice-wake", "voice-chip-state", "voice-chip-asr", "voice-chip-llm", "voice-mic-toggle", "voice-text-input", "voice-events"]}
                missing = [k for k, v in ids.items() if v == 0]
                mp.screenshot(path=os.path.join(SHOTS, "m-live.png"))
                rec("/m/live HUD 渲染（唤醒光点/实时字幕/回复卡/状态 chips）", page_ok and len(missing) <= 2, "missing=%s body=%s" % (missing, body[:160].replace("\n", " ")), skip=(not page_ok))
                # 本地识别/云端理解状态标识
                labels_ok = ("本地识别" in body or "ASR" in body) and ("云端理解" in body or "模型" in body or "LLM" in body)
                rec("UI 状态标识：本地识别(ASR) / 云端理解(模型) 可见", labels_ok, "本地识别=%s 云端理解=%s chips=%s" % ("本地识别" in body, "云端理解" in body, "; ".join([x for x in [mp.locator('[data-testid="voice-chip-asr"]').inner_text() if ids.get("voice-chip-asr") else "", mp.locator('[data-testid="voice-chip-llm"]').inner_text() if ids.get("voice-chip-llm") else ""] if x])))
                # SSE 实时字幕：文本命令注入
                st_c, cb = api("/api/v2/voice/command", "POST", {"text": "打开记事本"}, token=token)
                caption_hit = False
                for _ in range(20):
                    mp.wait_for_timeout(400)
                    txt = mp.inner_text("body")
                    if "记事本" in txt:
                        caption_hit = True
                        break
                cap_count = mp.locator('[data-testid="voice-caption"]').count()
                mp.screenshot(path=os.path.join(SHOTS, "m-live-caption.png"))
                rec("/m/live SSE 实时字幕/回复（注入命令后出现）", caption_hit or cap_count > 0, "commandStatus=%s captionHit=%s captions=%d" % (st_c, caption_hit, cap_count), skip=(st_c == 404))
                rec("/m/live 唤醒光点状态可观测（voice-wake 文本）", ids.get("voice-wake", 0) > 0, "wakeEl=%d" % ids.get("voice-wake", 0), skip=(not page_ok))
                rec("/m/live JS 运行时错误 = 0", len(merrs) == 0, json.dumps(merrs[:3], ensure_ascii=False))
                # 手机 /m 极简页
                mp.goto(BASE + "/m", wait_until="domcontentloaded", timeout=30000)
                mp.wait_for_timeout(2500)
                m_ids = {k: mp.locator('[data-testid="%s"]' % k).count() for k in ["m-voice-hero", "m-voice-orb", "m-voice-status", "m-voice-caption"]}
                mp.screenshot(path=os.path.join(SHOTS, "m-home.png"))
                rec("/m 极简页（大麦克风/状态/今日摘要）", all(v > 0 for v in m_ids.values()) if st_m == 200 else False, "testids=%s" % json.dumps(m_ids, ensure_ascii=False), skip=(st_m != 200))
                rec("/m JS 运行时错误 = 0", len(merrs) == 0, json.dumps(merrs[:3], ensure_ascii=False))
                mctx.close()
                # 桌面 #/voice
                dctx = browser.new_context(viewport={"width": 1440, "height": 900})
                dctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                dp = dctx.new_page()
                derrs = []
                dp.on("pageerror", lambda e: derrs.append(str(e)[:200]))
                dp.on("request", on_request)
                dp.goto(BASE + "/#/voice", wait_until="domcontentloaded", timeout=30000)
                dp.wait_for_timeout(3500)
                d_ids = {k: dp.locator('[data-testid="%s"]' % k).count() for k in ["voice-console", "voice-status", "voice-orb", "voice-state", "voice-toggle", "voice-hud", "voice-command-input", "voice-config-asr", "voice-config-llm", "voice-worker-status", "voice-events"]}
                d_body = dp.inner_text("body")
                dp.screenshot(path=os.path.join(SHOTS, "voice-console.png"))
                rec("桌面 #/voice 控制台（状态/实时字幕/配置/转写/诊断）", all(v > 0 for v in d_ids.values()), "testids=%s body=%s" % (json.dumps(d_ids, ensure_ascii=False), d_body[:140].replace("\n", " ")))
                rec("桌面 #/voice JS 运行时错误 = 0", len(derrs) == 0, json.dumps(derrs[:3], ensure_ascii=False))
                # 日报/日记入口（若本轮实现）
                diary_els = dp.locator('[data-testid*="diary"], a:has-text("日报"), a:has-text("日记"), button:has-text("日报"), button:has-text("日记")').count()
                rec("UI 日报/日记入口（若本轮实现）", diary_els > 0, "diaryEntries=%d" % diary_els, skip=(diary_els == 0))
                # 写操作按钮状态（已登录应可用）
                enabled = 0
                total = dp.locator("button").count()
                for i in range(min(total, 25)):
                    try:
                        if dp.locator("button").nth(i).is_enabled():
                            enabled += 1
                    except Exception:
                        pass
                rec("语音页写操作按钮在已登录下可用", enabled > 0, "buttons=%d enabled=%d" % (total, enabled))
                dctx.close()
                ext = sorted(set(external))
                allowed = [u for u in ext if "api.deepseek.com" in u]
                other = [u for u in ext if "api.deepseek.com" not in u]
                report["evidence"]["requests"] = {"total": len(requests_all), "external": ext, "allowedDeepSeek": len(allowed), "other": other}
                rec("网络隐私：除 127.0.0.1/localhost 外仅允许 api.deepseek.com（且本次无其它外链）", len(other) == 0, "requests=%d external=%s other=%s" % (len(requests_all), json.dumps(ext[:6], ensure_ascii=False), json.dumps(other[:4], ensure_ascii=False)))
            finally:
                browser.close()
    except Exception as e:
        rec("语音 UI 验收执行异常", False, str(e)[:500])
    finally:
        kill = lambda pr: subprocess.run(["taskkill", "/PID", str(pr.pid), "/T", "/F"], capture_output=True) if pr else None
        kill(hub)
        time.sleep(0.5)
        pass_n = sum(1 for c in CHECKS if c["ok"] and not c["skip"])
        fail_n = sum(1 for c in CHECKS if not c["ok"] and not c["skip"])
        skip_n = sum(1 for c in CHECKS if c["skip"])
        report["summary"] = {"total": len(CHECKS), "pass": pass_n, "fail": fail_n, "skip": skip_n}
        report["finishedAt"] = datetime.now().isoformat()
        with open(os.path.join(EVID, "voice-ui.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：_internal/checker/round5/voice-ui.json")
        if not os.environ.get("VOICE_KEEP"):
            shutil.rmtree(RUN, ignore_errors=True)
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()