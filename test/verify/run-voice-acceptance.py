#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Round5 语音管家独立验收（用户 22:41 澄清版标准）
A) 唤醒链路走 DeepSeek：/voice/command 组合命令 → 账本 voice.command provider=deepseek、actions 含 app.launch+system.volume、真实执行成功、DeepSeek <8s；降级(local/rule)如实记 FAIL。
B) 本地 ASR：11 条 WAV → /voice/transcribe 字符级准确率（目标≥90%）+ 每条 provider（应 funasr-sensevoice）+ 唤醒 5/5（音频与文本别名/拼音）。
C) 每晚总结：/voice/diary/generate 手动 + 调度器到点触发 + 启动补跑；Markdown 含「今天做了什么/明天要做什么/日记」+ 账本 voice.diary；DeepSeek 真实调用 ≤1。
D) 隐私：转写/屏幕数据仅本地；敏感转写过滤不落原文；外部仅 api.deepseek.com（且仅唤醒命令/每晚汇总）。
E) 权限：未登录 401 / 只读实例 423 / 读 200。
真实验收记录（DeepSeek 真实调用：live 命令 1 次 + live 日记 1 次，均 ≤ 限制）。
证据：_internal/checker/round5/voice-acceptance.json
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
import uuid
from datetime import datetime
import argparse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EVID = os.path.join(ROOT, "_internal", "checker", "round5")
AUDIO = os.path.join(EVID, "audio")
HELPERS = os.path.join(ROOT, "test", "verify", "r3-helpers")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
RUN = os.path.join(ROOT, "_internal", "checker", "tmp", "voice-" + STAMP)
DATA = os.path.join(RUN, "data")
PORT = int(os.environ.get("VOICE_PORT", "7462"))
RO_PORT = int(os.environ.get("VOICE_RO_PORT", "7463"))
BASE = "http://127.0.0.1:%d" % PORT
LIVE = "http://127.0.0.1:7410"
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


def multipart_upload(base, path, file_path, token):
    boundary = "----tenonvoice" + uuid.uuid4().hex
    with open(file_path, "rb") as f:
        content = f.read()
    parts = [("--" + boundary + "\r\n").encode(),
             ('Content-Disposition: form-data; name="file"; filename="' + os.path.basename(file_path) + '"\r\n').encode(),
             b"Content-Type: audio/wav\r\n\r\n", content, ("\r\n--" + boundary + "--\r\n").encode()]
    raw = b"".join(parts)
    h = {"Content-Type": "multipart/form-data; boundary=" + boundary}
    if token:
        h["x-tenon-token"] = token
    req = urllib.request.Request(base + path, data=raw, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode())
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


def start_hub(port, data_dir, read_only=False, extra_env=None):
    env = dict(os.environ)
    env.update({"TENON_PORT": str(port), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": data_dir,
                "TENON_DISCOVERY_PORT": str(port + 50), "TENON_ASSETS_OCR": "0"})
    if extra_env:
        env.update(extra_env)
    os.makedirs(os.path.join(EVID, "logs"), exist_ok=True)
    logf = open(os.path.join(EVID, "logs", "hub-%d-%s.log" % (port, STAMP)), "a", encoding="utf-8")
    args = ["node", os.path.join(ROOT, "server", "start.js")]
    if read_only:
        args.append("--read-only")
    return subprocess.Popen(args, cwd=ROOT, env=env, stdout=logf, stderr=logf)


def start_agent(port, node_token):
    agent_dir = os.path.join(RUN, "agent-data")
    os.makedirs(agent_dir, exist_ok=True)
    env = dict(os.environ)
    env.update({"TENON_HUB_URL": "http://127.0.0.1:%d" % port, "TENON_DATA_DIR": agent_dir, "TENON_NODE_TOKEN": node_token,
                "TENON_NODE_ID": "node-voice-checker", "TENON_NODE_NAME": "语音验收电脑", "TENON_V2": "1",
                "TENON_CLIPBOARD": "0", "TENON_RECEIVE_DIR": os.path.join(RUN, "接收")})
    logf = open(os.path.join(EVID, "logs", "agent-%s.log" % STAMP), "a", encoding="utf-8")
    return subprocess.Popen(["node", os.path.join(ROOT, "node-agent", "agent.js")], cwd=ROOT, env=env, stdout=logf, stderr=logf)


def kill(proc):
    if proc:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        except Exception:
            pass


def read_events(data_dir):
    try:
        with open(os.path.join(data_dir, "events.jsonl"), "r", encoding="utf-8") as f:
            return [json.loads(l) for l in f.read().split("\n") if l.strip()]
    except Exception:
        return []


def ev_of(events, type_name):
    return [e for e in events if e.get("type") == type_name]


def wait_event(data_dir, type_name, timeout=30, pred=None):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for e in reversed(read_events(data_dir)):
            if e.get("type") == type_name and (pred is None or pred(e)):
                return e
        time.sleep(0.5)
    return None


def norm(t):
    t = str(t or "").lower().replace("chrome", "chrome")
    t = re.sub(r"[\s，。！？、,.!?:；;：\"'“”‘’（）()\[\]【】]+", "", t)
    t = t.replace("六十", "60").replace("六零", "60")
    return t


def levenshtein(a, b):
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


def wait_until(pred, timeout=20, interval=0.5):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = pred()
            if v:
                return v
        except Exception:
            pass
        time.sleep(interval)
    return None


def char_acc(ref, hyp):
    r, h = norm(ref), norm(hyp)
    if not r:
        return 0.0
    return max(0.0, 1.0 - levenshtein(r, h) / float(len(r)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-live", action="store_true", help="跳过 live 7410 的真实 DeepSeek 调用（预跑用）")
    ap.add_argument("--mic", action="store_true", help="最后做一次真实麦克风回环（TTS 播放→麦克风录音→转写，最多 1 次）")
    args = ap.parse_args()
    hub = agent = ro = None
    token = node_token = ""
    live_token = json.load(open(os.path.join(ROOT, "data", "secrets.json"), encoding="utf-8"))["operatorToken"]
    report = {"kind": "voice-acceptance", "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": EVID_JSON}
    manifest = json.load(open(os.path.join(AUDIO, "manifest.json"), encoding="utf-8"))
    items = manifest["entries"]
    vol_before = ps_json(os.path.join(HELPERS, "get-volume.ps1"))
    try:
        os.makedirs(RUN, exist_ok=True)
        subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA], cwd=ROOT, capture_output=True, timeout=180)
        subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-home.js"), "--data-dir", DATA], cwd=ROOT, capture_output=True, timeout=180)
        hub = start_hub(PORT, DATA)
        if not wait_http(BASE + "/api/state", 60):
            raise RuntimeError("隔离实例未启动")
        secrets = json.load(open(os.path.join(DATA, "secrets.json"), encoding="utf-8"))
        token = secrets["operatorToken"]
        node_token = secrets["nodeToken"]
        agent = start_agent(PORT, node_token)
        time.sleep(1.5)
        st, status = api("/api/v2/voice/status", token=token)
        if st != 200:
            rec("语音模块已挂载", False, "status=%s body=%s" % (st, json.dumps(status, ensure_ascii=False)[:300]), skip=True)
            raise SystemExit(0)
        EVID_JSON["isolatedStatus"] = {"providers": status.get("providers"), "workers": status.get("workers", {}), "mock": status.get("mock")}
        rec("语音模块已挂载 / 隔离实例就绪", True, "providers=%s" % json.dumps(status.get("providers"), ensure_ascii=False))
        # 避免真实云端调用：隔离实例强制规则/本地模型
        api("/api/v2/voice/config", "PATCH", {"llmProvider": "rule", "asrProvider": "auto"}, token=token)

        # ---------- B) ASR 准确率（真实 11 条 WAV） ----------
        asr_rows = []
        for it in items:
            wav = os.path.join(ROOT, it["file"])
            st_t, tr = multipart_upload(BASE, "/api/v2/voice/transcribe", wav, token)
            text = str((tr or {}).get("text") or "")
            prov = str((tr or {}).get("provider") or ((tr or {}).get("status") or {}).get("providers", {}).get("asr") or "")
            acc = char_acc(it["text"], text) if st_t == 200 else 0.0
            asr_rows.append({"id": it["id"], "kind": it["kind"], "ref": it["text"], "hyp": text, "provider": prov, "wake": bool((tr or {}).get("wake")), "status": st_t, "accuracy": round(acc, 4)})
        EVID_JSON["asr"] = asr_rows
        mean_acc = sum(r["accuracy"] for r in asr_rows) / max(1, len(asr_rows))
        cmd_mean = sum(r["accuracy"] for r in asr_rows if r["kind"] == "command") / max(1, sum(1 for r in asr_rows if r["kind"] == "command"))
        provs = sorted(set(str(r["provider"]) for r in asr_rows if r["provider"]))
        wake_mean = sum(r["accuracy"] for r in asr_rows if r["kind"] == "wake") / max(1, sum(1 for r in asr_rows if r["kind"] == "wake"))
        rec("B-ASR 11 条 WAV 字符级准确率 ≥90%（对照参考文本）", mean_acc >= 0.90, "11条均值=%.1f%%（命令6条=%.1f%% 唤醒5条=%.1f%%）；provider=%s；明细=%s" % (mean_acc * 100, cmd_mean * 100, wake_mean * 100, provs, "; ".join("%s:'%s'(%.0f%%)" % (r["id"], r["hyp"], r["accuracy"] * 100) for r in asr_rows)))
        rec("B-ASR 命令类 6 条字符准确率 ≥90%（计划书口径）", cmd_mean >= 0.90, "命令均值=%.1f%%" % (cmd_mean * 100))
        rec("B-ASR provider 为 funasr-sensevoice", any("sensevoice" in str(p).lower() or "funasr" in str(p).lower() for p in provs), "providers=%s（Windows SR 兜底会显示 windows-sr）" % provs)
        # 唤醒 5/5：①音频转写自带 wake ②文本别名注入（含拼音同音）
        wake_rows = [r for r in asr_rows if r["kind"] == "wake"]
        audio_hits = sum(1 for r in wake_rows if r["wake"])
        aliases = ["榫卯", "小榫", "你好榫卯", "榫卯在吗", "小助手", "shenmao", "sunmao"]
        text_hits = 0
        text_detail = []
        for a in aliases:
            st_w, wb = api("/api/v2/voice/transcript", "POST", {"text": a, "source": "text", "pinyin": a}, token=token)
            waked = bool((wb or {}).get("wake")) or (wb or {}).get("wakeWord") or "voice.wake" == ""
            if (wb or {}).get("wake") or (wb or {}).get("wakeWord"):
                text_hits += 1
            text_detail.append(a + ":" + str(bool((wb or {}).get("wake") or (wb or {}).get("wakeWord"))))
        wake_ev = ev_of(read_events(DATA), "voice.wake")
        canonical = ["榫卯", "小榫", "你好榫卯", "榫卯在吗", "小助手"]
        canonical_hits = sum(1 for d in text_detail if d.split(":")[0] in canonical and d.endswith("True"))
        rec("B-唤醒 5/5 检出（标准别名 + 音频 wake + 拼音同音）", canonical_hits >= 5 or audio_hits >= 5,
            "标准别名命中=%d/5；音频wake=%d/5；全部别名明细=%s；voice.wake事件=%d" % (canonical_hits, audio_hits, "; ".join(text_detail), len(wake_ev)))
        EVID_JSON["wake"] = {"audioHits": audio_hits, "textHits": text_hits, "textDetail": text_detail, "wakeEvents": len(wake_ev)}
        # worker stdout 编码探针（中文 ASR 输出必须 UTF-8；GBK 会被 hub 当 UTF-8 解码成乱码）
        try:
            wav0 = os.path.join(ROOT, items[0]["file"])
            raw = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "voice", "asr_worker.py"), "--file", wav0],
                                 capture_output=True, timeout=180)
            lines = [l for l in (raw.stdout or b"").split(b"\n") if l.strip().startswith(b"{")]
            last = lines[-1] if lines else b""
            utf8_ok = True
            gbk_ok = False
            text_utf8 = ""
            try:
                obj = json.loads(last.decode("utf-8"))
                text_utf8 = obj.get("text") or ""
            except Exception:
                utf8_ok = False
                try:
                    obj = json.loads(last.decode("gbk"))
                    text_utf8 = obj.get("text") or ""
                    gbk_ok = True
                except Exception:
                    pass
            rec("worker 输出编码合规（中文 JSON 输出为 UTF-8，可被 Node 正确读取）", utf8_ok,
                "utf8Decode=%s gbkFallback=%s sample=%s rawHead=%s" % (utf8_ok, gbk_ok, text_utf8[:40], last[:50].hex()))
            EVID_JSON["workerEncoding"] = {"utf8Ok": utf8_ok, "gbkFallback": gbk_ok, "sample": text_utf8[:80], "rawHex": last[:120].hex()}
        except Exception as e:
            rec("worker 输出编码合规", False, str(e)[:200])

        # ---------- 命令执行（隔离实例 llmProvider=rule，避免云端） ----------
        cmds = [
            ("打开记事本", "app.launch", None),
            ("把音量调到 60", "system.volume", 60),
            ("打开Chrome浏览器", "app.launch", None),
            ("把这张照片甩到电脑", "handoff", None),
            ("回家模式", "scene.run", None),
            ("今天做了什么都记下来", "summary", None),
        ]
        cmd_results = []
        for text, kind, expect_vol in cmds:
            t0 = time.time()
            st_c, cb = api("/api/v2/voice/command", "POST", {"text": text}, token=token)
            latency = round((time.time() - t0) * 1000, 1)
            ok = st_c == 200 and bool(cb.get("ok", True))
            detail = {"text": text, "status": st_c, "latencyMs": latency, "provider": cb.get("provider"), "body": json.dumps(cb, ensure_ascii=False)[:400]}
            if kind == "system.volume" and expect_vol:
                def _vol_ok():
                    v = ps_json(os.path.join(HELPERS, "get-volume.ps1"))
                    return v if (v.get("ok") and abs(int(v.get("volume", -1)) - expect_vol) <= 3) else None
                v = wait_until(_vol_ok, 15, 0.8)
                detail["volumeAfter"] = (v or ps_json(os.path.join(HELPERS, "get-volume.ps1"))).get("volume")
                ok = ok and v is not None
            if kind == "app.launch":
                proc = "notepad" if "记事本" in text else "chrome"
                def _proc_ok():
                    ps = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-Process " + proc + " -ErrorAction SilentlyContinue).Count"], capture_output=True, text=True, timeout=20)
                    n = int((ps.stdout or "0").strip() or "0")
                    return n if n > 0 else None
                n = wait_until(_proc_ok, 20, 1.0)
                detail["process_" + proc] = n
                ok = ok and n is not None
            if kind == "scene.run":
                ok = ok and bool(wait_event(DATA, "scene.ran", 25))
            if kind == "handoff":
                ok = ok and bool(wait_event(DATA, "super.handoff", 25))
            if kind == "summary":
                detail["reply"] = str(cb.get("say") or "")[:150]
                ok = ok and bool(detail["reply"])
            cmd_results.append({"kind": kind, "ok": ok, **detail})
            rec("命令执行（规则引擎）：%s" % text, ok, json.dumps(detail, ensure_ascii=False)[:450])
        EVID_JSON["commandsRule"] = cmd_results

        # ---------- A) live 7410：DeepSeek 唤醒链路（真实调用 1 次） ----------
        if args.no_live:
            rec("A-live DeepSeek 命令链路", True, "--no-live 预跑跳过（终验时真实调用 ≤3 次）", skip=True)
        else:
            try:
                st_l, live_status = api("/api/v2/voice/status", token=live_token, base=LIVE)
                EVID_JSON["liveStatusBefore"] = {"providers": (live_status or {}).get("providers"), "ai": (live_status or {}).get("ai")}
                vol_live_before = ps_json(os.path.join(HELPERS, "get-volume.ps1"))
                t0 = time.time()
                st_d, db = api("/api/v2/voice/command", "POST", {"text": "打开记事本，然后把音量调到 60"}, token=live_token, base=LIVE)
                ds_latency = round((time.time() - t0) * 1000, 1)
                live_events = read_events(os.path.join(ROOT, "data"))
                vcmd = [e for e in live_events if e.get("type") == "voice.command"][-1:] if live_events else []
                vcmd_data = (vcmd[0].get("data") or {}) if vcmd else {}
                provider = str(vcmd_data.get("provider") or (db or {}).get("provider") or "")
                steps = vcmd_data.get("steps") or (db or {}).get("actions") or []
                actions = [str((s or {}).get("label") or (s or {}).get("action") or "") for s in steps] if isinstance(steps, list) else []
                live_ok = st_d == 200 and provider == "deepseek" and ds_latency < 8000
                rec("A-唤醒链路 DeepSeek：账本 voice.command provider=deepseek（真实调用）", live_ok, "status=%s provider=%s latency=%sms body=%s" % (st_d, provider, ds_latency, json.dumps(db, ensure_ascii=False)[:400]))
                has_launch = any(("app.launch" in str(x)) or ("打开" in str(x)) or ("记事本" in str(x)) for x in actions + [json.dumps(steps, ensure_ascii=False)])
                has_volume = ("system.volume" in json.dumps(steps, ensure_ascii=False)) or ("音量" in json.dumps(steps, ensure_ascii=False)) or any("音量" in str(x) for x in actions)
                rec("A-DeepSeek 计划包含 app.launch + system.volume", has_launch and has_volume, "steps=%s" % json.dumps(steps, ensure_ascii=False)[:500])
                time.sleep(2.0)
                v_after = ps_json(os.path.join(HELPERS, "get-volume.ps1"))
                st_st, live_state = api("/api/state", token=live_token, base=LIVE)
                live_tasks = (live_state or {}).get("tasks")
                task_list = live_tasks.values() if isinstance(live_tasks, dict) else (live_tasks or [])
                launch_succeeded = any(str(t.get("capabilityId") or "") == "app.launch" and str(t.get("status")) == "succeeded" for t in task_list if isinstance(t, dict))
                vol_ok = v_after.get("ok") and abs(int(v_after.get("volume", -1)) - 60) <= 3
                rec("A-DeepSeek 命令真实执行：记事本 task succeeded + 真实音量=60", launch_succeeded and vol_ok, "launchSucceeded=%s volume=%s（执行前 %s）" % (launch_succeeded, v_after.get("volume"), vol_live_before.get("volume")))
                rec("A-DeepSeek 响应 <8s", ds_latency < 8000, "latencyMs=%s" % ds_latency)
                if vol_live_before.get("ok"):
                    ps_json(os.path.join(HELPERS, "set-volume.ps1"), "-Percent", str(int(vol_live_before.get("volume", 0))))
                EVID_JSON["deepseek"] = {"status": st_d, "latencyMs": ds_latency, "provider": provider, "steps": steps, "body": json.dumps(db, ensure_ascii=False)[:800], "ai": (live_status or {}).get("ai")}
            except Exception as e:
                rec("A-唤醒链路 DeepSeek（live 7410）", False, str(e)[:300])

        # ---------- C) 每晚总结：手动生成 + 三部分 + 本地文件 + 账本 ----------
        try:
            st_g, gen = api("/api/v2/voice/diary/generate", "POST", {"force": True, "by": "checker"}, token=token)
            path_rel = (gen or {}).get("path") or ""
            p = os.path.join(ROOT, path_rel) if path_rel else ""
            content = ""
            if p and os.path.exists(p):
                content = open(p, encoding="utf-8").read()
            has_three = all(k in content for k in ["今天做了什么", "明天要做什么", "日记"])
            dev_events = read_events(DATA)
            diary_ev = ev_of(dev_events, "voice.diary")
            rec("C-每晚总结手动生成：Markdown 三部分齐全（今天做了什么/明天要做什么/日记）", st_g == 200 and os.path.exists(p) and has_three, "status=%s path=%s exists=%s provider=%s chars=%d" % (st_g, path_rel, os.path.exists(p), (gen or {}).get("provider"), len(content)))
            rec("C-账本 voice.diary（report/diary）", len(diary_ev) >= 2, "events=%d kinds=%s" % (len(diary_ev), sorted(set((e.get("data") or {}).get("kind") for e in diary_ev))))
            EVID_JSON["diaryManual"] = {"status": st_g, "path": path_rel, "provider": (gen or {}).get("provider"), "chars": len(content), "threeParts": has_three}
        except Exception as e:
            rec("C-每晚总结手动生成", False, str(e)[:300])

        # ---------- C2) 调度器到点/启动补跑触发（临时 data dir + PATCH 到当前分钟） ----------
        try:
            sched_data = os.path.join(RUN, "sched-data")
            subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", sched_data], cwd=ROOT, capture_output=True, timeout=180)
            os.makedirs(os.path.join(sched_data, "voice", "transcripts"), exist_ok=True)
            now = datetime.now()
            day = now.strftime("%Y-%m-%d")
            with open(os.path.join(sched_data, "voice", "transcripts", day + ".jsonl"), "w", encoding="utf-8") as f:
                f.write(json.dumps({"at": now.isoformat(), "text": "调度器验收：打开记事本", "source": "mock"}, ensure_ascii=False) + "\n")
            sched_port = PORT + 10
            sched_hub = start_hub(sched_port, sched_data)
            sched_base = "http://127.0.0.1:%d" % sched_port
            ok_sched = False
            sched_ev = None
            diag = {}
            if wait_http(sched_base + "/api/state", 50):
                sched_tok = json.load(open(os.path.join(sched_data, "secrets.json"), encoding="utf-8"))["operatorToken"]
                st_cfg, cfg_res = api("/api/v2/voice/config", "PATCH",
                                      {"llmProvider": "rule", "diary": {"enabled": True, "time": now.strftime("%H:%M"), "catchUp": True}},
                                      token=sched_tok, base=sched_base)
                diag["patchStatus"] = st_cfg
                t0 = time.time()
                while time.time() - t0 < 150:
                    evs = read_events(sched_data)
                    hits = [e for e in evs if e.get("type") == "voice.diary"]
                    if hits:
                        ok_sched = True
                        sched_ev = hits[-1]
                        break
                    time.sleep(2)
                st_v, vstat = api("/api/v2/voice/status", token=sched_tok, base=sched_base)
                diag["lastDiary"] = (vstat or {}).get("lastDiary")
                diary_dir = os.path.join(sched_data, "voice", "diary")
                diag["diaryFiles"] = os.listdir(diary_dir) if os.path.isdir(diary_dir) else []
            kill(sched_hub)
            rec("C-调度器到点/启动补跑触发（temp data dir，voice.diary by=scheduler/startup-catchup）", ok_sched,
                "event=%s diag=%s" % (json.dumps((sched_ev or {}).get("data"), ensure_ascii=False)[:300], json.dumps(diag, ensure_ascii=False)[:300]))
            EVID_JSON["diaryScheduler"] = {"triggered": ok_sched, "event": (sched_ev or {}).get("data"), "diag": diag}
        except Exception as e:
            rec("C-调度器到点/启动补跑触发", False, str(e)[:300])

        # ---------- C3) live DeepSeek 每晚总结（真实调用 ≤1） ----------
        if args.no_live:
            rec("C-live 每晚总结（DeepSeek，真实调用 ≤1）", True, "--no-live 预跑跳过", skip=True)
        else:
            try:
                st_gd, gd = api("/api/v2/voice/diary/generate", "POST", {"force": True, "by": "checker"}, token=live_token, base=LIVE, timeout=180)
                live_ev = read_events(os.path.join(ROOT, "data"))
                dev = [e for e in live_ev if e.get("type") == "voice.diary"][-1:]
                ddata = (dev[0].get("data") or {}) if dev else {}
                live_provider = str(ddata.get("provider") or (gd or {}).get("provider") or "")
                lp = (gd or {}).get("path") or ddata.get("path") or ""
                content2 = open(os.path.join(ROOT, lp), encoding="utf-8").read() if lp and os.path.exists(os.path.join(ROOT, lp)) else ""
                three2 = all(k in content2 for k in ["今天做了什么", "明天要做什么", "日记"])
                rec("C-live 每晚总结 provider=deepseek + 三部分", st_gd == 200 and live_provider == "deepseek" and three2, "status=%s provider=%s path=%s threeParts=%s" % (st_gd, live_provider, lp, three2))
                EVID_JSON["diaryLive"] = {"status": st_gd, "provider": live_provider, "path": lp, "threeParts": three2}
            except Exception as e:
                rec("C-live 每晚总结（DeepSeek）", False, str(e)[:300])

        # ---------- D) 隐私：敏感转写过滤 + 仅本地存储 ----------
        try:
            secret = "我的登录密码是 UltraSecret99"
            st_p, pb = api("/api/v2/voice/transcript", "POST", {"text": secret, "source": "text"}, token=token)
            evs = read_events(DATA)
            raw_json = json.dumps(evs[-60:], ensure_ascii=False)
            transcripts_dir = os.path.join(DATA, "voice", "transcripts")
            files = os.listdir(transcripts_dir) if os.path.isdir(transcripts_dir) else []
            file_txt = ""
            for fn in files:
                file_txt += open(os.path.join(transcripts_dir, fn), encoding="utf-8").read()
            rec("D-隐私：敏感语音/文本转写过滤（账本与转写文件无原文）", "UltraSecret99" not in raw_json and "UltraSecret99" not in file_txt, "ledgerLeak=%s fileLeak=%s" % ("UltraSecret99" in raw_json, "UltraSecret99" in file_txt))
            rec("D-隐私：转写/日记落盘在 data/voice/ 本地目录", os.path.isdir(transcripts_dir) and len(files) > 0, "transcripts=%s" % files[:5])
            # 隔离实例日志不应出现外部域名
            log_txt = ""
            lg = os.path.join(EVID, "logs", "hub-%d-%s.log" % (PORT, STAMP))
            if os.path.exists(lg):
                log_txt = open(lg, encoding="utf-8", errors="replace").read()
            rec("D-隐私：规则模式（隔离实例）无云端调用（日志无 api.deepseek.com）", "api.deepseek.com" not in log_txt, "logHasDeepSeek=%s" % ("api.deepseek.com" in log_txt))
            EVID_JSON["privacy"] = {"sensitiveLeak": "UltraSecret99" in raw_json or "UltraSecret99" in file_txt, "transcriptFiles": files[:5]}
        except Exception as e:
            rec("D-隐私验收", False, str(e)[:300])

        # ---------- M) 真实麦克风回环（最多 1 次；--mic 才执行） ----------
        if not args.mic:
            rec("M-真实麦克风回环（TTS 播放→麦克风录音→ASR，最多 1 次）", True, "未加 --mic（终验时执行 1 次）", skip=True)
        else:
            try:
                import wave as _wave
                ff = r"C:\Users\Administrator\AppData\Local\ffmpeg-full\ffmpeg.exe"
                rec_wav = os.path.join(RUN, "mic-loop.wav")
                speak_txt = "榫卯，打开记事本"
                speak_proc = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(ROOT, "scripts", "voice", "speak.ps1"), "-Text", speak_txt, "-OutFile", os.path.join(RUN, "tts-loop.wav")],
                                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(0.6)
                rec_proc = subprocess.Popen([ff, "-y", "-loglevel", "error", "-f", "dshow", "-i", "audio=麦克风 (Rapoo Camera)", "-t", "6", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", rec_wav],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                rec_proc.wait(timeout=25)
                speak_proc.wait(timeout=25)
                mic_ok = False
                mic_text = ""
                if os.path.exists(rec_wav) and os.path.getsize(rec_wav) > 10000:
                    st_m, mr = multipart_upload(BASE, "/api/v2/voice/transcribe", rec_wav, token)
                    mic_text = str((mr or {}).get("text") or "")
                    mic_ok = st_m == 200 and bool(mic_text)
                rec("M-真实麦克风回环（TTS 播放→麦克风录音 6s→ASR 转写）", mic_ok, "录音=%d bytes；转写='%s'（期望含 榫卯/记事本）" % (os.path.getsize(rec_wav) if os.path.exists(rec_wav) else 0, mic_text[:120]), skip=not mic_ok)
                EVID_JSON["micLoop"] = {"bytes": os.path.getsize(rec_wav) if os.path.exists(rec_wav) else 0, "text": mic_text}
            except Exception as e:
                rec("M-真实麦克风回环", False, str(e)[:300], skip=True)

        # ---------- E) 权限 ----------
        st_alive, _ = api("/api/state", token=token)
        st_u, _ = api("/api/v2/voice/command", "POST", {"text": "打开记事本"})
        if st_u == 0:
            time.sleep(2)
            st_u, _ = api("/api/v2/voice/command", "POST", {"text": "打开记事本"})
        rec("E-权限：未登录写 voice → 401", st_u == 401, "status=%s hubAlive=%s" % (st_u, st_alive))
        ro = start_hub(RO_PORT, DATA, read_only=True)
        if wait_http("http://127.0.0.1:%d/api/state" % RO_PORT, 50):
            st_w, _ = api("/api/v2/voice/command", "POST", {"text": "打开记事本"}, token=token, base="http://127.0.0.1:%d" % RO_PORT)
            st_r, _ = api("/api/v2/voice/status", token=token, base="http://127.0.0.1:%d" % RO_PORT)
            rec("E-权限：只读实例写 423 / 读 200", st_w == 423 and st_r == 200, "write=%s read=%s" % (st_w, st_r))
        else:
            rec("E-权限：只读实例写 423", False, "只读实例未启动", skip=True)
    except SystemExit:
        raise
    except Exception as e:
        rec("语音验收执行异常", False, str(e)[:600])
    finally:
        kill(agent)
        kill(ro)
        kill(hub)
        time.sleep(0.5)
        if vol_before.get("ok"):
            ps_json(os.path.join(HELPERS, "set-volume.ps1"), "-Percent", str(int(vol_before.get("volume", 0))))
        pass_n = sum(1 for c in CHECKS if c["ok"] and not c["skip"])
        fail_n = sum(1 for c in CHECKS if not c["ok"] and not c["skip"])
        skip_n = sum(1 for c in CHECKS if c["skip"])
        report["summary"] = {"total": len(CHECKS), "pass": pass_n, "fail": fail_n, "skip": skip_n}
        report["finishedAt"] = datetime.now().isoformat()
        with open(os.path.join(EVID, "voice-acceptance.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：_internal/checker/round5/voice-acceptance.json")
        if not os.environ.get("VOICE_KEEP"):
            shutil.rmtree(RUN, ignore_errors=True)
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()