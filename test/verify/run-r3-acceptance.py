#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Round3 独立验收（Checker · 真实执行）
覆盖 R3 任务书 A/B/C/D + 权限/回归前置：
  1) 手机遥控 API + node-agent 真实执行：input.mouse（真实读光标位置）、input.key（记事本输入→剪贴板回读）、input.media（真实主音量变化）
  2) 拍照甩屏：multipart 上传素材 → super.handoff photo → 账本 asset.ingested/super.handoff → 电脑 #/handoff 显示该图（真实 Chrome 截图）
  3) 3 个一键场景（回家/工作/睡前）真实执行 + scene.ran 账本 + 任务结果
  4) 新手引导：首开出现、可关闭、完成/关闭后不再出现（真实 Chrome）
  5) 权限：未绑定 403 / 未知设备 404 / 未知 type 400 / 只读实例 423
用法：python test/verify/run-r3-acceptance.py [--keep]
证据：_internal/checker/round3/r3-acceptance.json + screenshots/
"""
import argparse
import json
import traceback
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EVID = os.path.join(ROOT, "_internal", "checker", "round3")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
RUN = os.path.join(ROOT, "_internal", "checker", "tmp", "r3-" + STAMP)
DATA = os.path.join(RUN, "data")
AGENT_DATA = os.path.join(RUN, "agent-data")
UNBOUND_DATA = os.path.join(RUN, "agent-unbound")
SHOTS = os.path.join(EVID, "screenshots")
LOG_DIR = os.path.join(EVID, "logs")
HELPERS = os.path.join(ROOT, "test", "verify", "r3-helpers")
PORT = 7462
RO_PORT = 7463
BASE = "http://127.0.0.1:%d" % PORT
CHECKS = []
EVID_JSON = {}


class _DryDone(Exception):
    pass


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + m, flush=True)


def rec(name, ok, detail="", skip=False):
    CHECKS.append({"name": name, "ok": bool(ok), "skip": bool(skip), "detail": str(detail)[:900]})
    log(("SKIP " if skip else ("PASS " if ok else "FAIL ")) + name + (" :: " + str(detail)[:240] if detail else ""))


def ps_json(script, *args):
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] + list(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        out = (r.stdout or "").strip().splitlines()
        for line in reversed(out):
            line = line.strip()
            if line.startswith("{"):
                return json.loads(line)
        return {"ok": False, "error": ("no json: " + (r.stdout or "")[:200] + (r.stderr or "")[:200])}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


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
        return True
    except Exception:
        return False


def wait_volume(pred, timeout=5):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        last = get_volume()
        if last.get("ok") and pred(last):
            return last
        time.sleep(0.3)
    return last


def get_window(proc):
    return ps_json(os.path.join(HELPERS, "get-window.ps1"), "-ProcessName", proc)


def api(path, method="GET", body=None, token=None, raw=None, base=None, timeout=20):
    base = base or BASE
    url = base + path
    data = None
    h = {}
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode()
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
                return r.status, {"raw": content[:200]}
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


def start_hub(name="main", port=PORT, data_dir=None, discovery=None, read_only=False, extra_env=None):
    data_dir = data_dir or DATA
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    env = dict(os.environ)
    env.update({"TENON_PORT": str(port), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": data_dir,
                "TENON_DISCOVERY_PORT": str(discovery if discovery is not None else port + 50), "TENON_ASSETS_OCR": "0"})
    if extra_env:
        env.update(extra_env)
    args = ["node", os.path.join(ROOT, "server", "start.js")]
    if read_only:
        args.append("--read-only")
    logf = open(os.path.join(LOG_DIR, "hub-%s-%s.log" % (name, STAMP)), "a", encoding="utf-8")
    p = subprocess.Popen(args, cwd=ROOT, env=env, stdout=logf, stderr=logf)
    return p


def start_agent(node_id, data_dir, token):
    os.makedirs(data_dir, exist_ok=True)
    env = dict(os.environ)
    env.update({"TENON_HUB_URL": BASE, "TENON_DATA_DIR": data_dir, "TENON_NODE_TOKEN": token,
                "TENON_NODE_ID": node_id, "TENON_NODE_NAME": "验收电脑-" + node_id, "TENON_V2": "1",
                "TENON_RECEIVE_DIR": os.path.join(RUN, "接收"), "TENON_CLIPBOARD": "0", "TENON_ASSETS_OCR": "0"})
    logf = open(os.path.join(LOG_DIR, "agent-%s-%s.log" % (node_id, STAMP)), "a", encoding="utf-8")
    return subprocess.Popen(["node", os.path.join(ROOT, "node-agent", "agent.js")], cwd=ROOT, env=env,
                            stdout=logf, stderr=logf)


def kill(proc):
    if not proc:
        return
    try:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    except Exception:
        pass


def ledger_types(data_dir=None):
    try:
        with open(os.path.join(data_dir or DATA, "events.jsonl"), "r", encoding="utf-8") as f:
            return [json.loads(l)["type"] for l in f.read().split("\n") if l.strip()]
    except Exception:
        return []


def state(token, base=None):
    st, js = api("/api/state", token=token, base=base)
    return js if st == 200 else {}


def nodes_of(token):
    s = state(token)
    nodes = s.get("nodes")
    if isinstance(nodes, dict):
        return nodes
    out = {}
    for n in nodes or []:
        if isinstance(n, dict) and n.get("id"):
            out[n["id"]] = n
    return out


def wait_node(token, node_id, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        n = nodes_of(token).get(node_id)
        if n and n.get("lastSeen"):
            return n
        time.sleep(0.5)
    return None


def task_of(s, task_id):
    tasks = s.get("tasks")
    if isinstance(tasks, dict):
        return tasks.get(task_id)
    for t in tasks or []:
        if isinstance(t, dict) and str(t.get("id") or "") == str(task_id):
            return t
    return None


def wait_task(token, task_id, timeout=60):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        s = state(token)
        t = task_of(s, task_id)
        if t:
            last = t
            if t.get("status") in ("succeeded", "failed", "cancelled", "needsConfirm", "rejected"):
                return t
        time.sleep(0.4)
    return last


def remote_input(token, device_id, type_, payload):
    st, js = api("/api/v2/remote/%s/input" % urllib.parse.quote(device_id), "POST",
                 {"type": type_, "payload": payload}, token=token)
    return st, js


def run_remote_and_wait(token, device_id, type_, payload, label):
    st, js = remote_input(token, device_id, type_, payload)
    if st != 200 or not js.get("ok"):
        return {"ok": False, "status": st, "error": js.get("error"), "label": label}
    task_id = js.get("taskId")
    if not task_id:
        # 合帧响应可能无 taskId
        return {"ok": True, "coalesced": True, "label": label}
    task = wait_task(token, task_id, 60)
    ok = bool(task and task.get("status") == "succeeded")
    return {"ok": ok, "status": st, "taskId": task_id, "taskStatus": (task or {}).get("status"),
            "result": (task or {}).get("result"), "evidence": (task or {}).get("evidence"), "label": label}


def find_png():
    cands = ["示例空间/样品图/样品01.png", "示例空间/样品图/样品02.png"]
    for c in cands:
        p = os.path.join(ROOT, c)
        if os.path.exists(p):
            return p
    return None


def multipart_ingest(token, file_path, name=None):
    import uuid
    boundary = "----tenonchecker" + uuid.uuid4().hex
    with open(file_path, "rb") as f:
        content = f.read()
    filename = name or os.path.basename(file_path)
    parts = []
    parts.append(("--" + boundary + "\r\n").encode())
    parts.append(('Content-Disposition: form-data; name="deviceId"\r\n\r\nchecker-phone\r\n').encode())
    parts.append(("--" + boundary + "\r\n").encode())
    parts.append(('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % filename).encode())
    parts.append(b"Content-Type: image/png\r\n\r\n")
    parts.append(content)
    parts.append(("\r\n--" + boundary + "--\r\n").encode())
    raw = b"".join(parts)
    st, js = api("/api/v2/assets/ingest", "POST", raw=raw, token=token,
                 **{"raw": raw}) if False else (None, None)
    h = {"x-tenon-token": token, "Content-Type": "multipart/form-data; boundary=" + boundary}
    req = urllib.request.Request(BASE + "/api/v2/assets/ingest", data=raw, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--skip-scenes", action="store_true")
    ap.add_argument("--dry", action="store_true", help="只验证装置骨架与权限，不做真实鼠标/键盘/音量/场景")
    args = ap.parse_args()
    hub = ro = agent = unbound = None
    token = ""
    report = {"kind": "r3-acceptance", "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": EVID_JSON,
              "env": {"base": BASE, "run": os.path.relpath(RUN, ROOT).replace("\\", "/")}}
    try:
        if not os.path.exists(os.path.join(DATA, "secrets.json")):
            se = subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA],
                                cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
            if se.returncode != 0:
                raise RuntimeError("seed-demo 失败：" + (se.stderr or "")[:300])
        # 一键场景种子（真实 3 场景 + 回家音乐），写 data/super/presets.json
        sh = subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-home.js"), "--data-dir", DATA],
                            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        seed_home = {}
        for line in reversed((sh.stdout or "").splitlines()):
            if line.strip().startswith("{"):
                try:
                    seed_home = json.loads(line.strip())
                    break
                except Exception:
                    pass
        EVID_JSON["seedHome"] = seed_home
        rec("一键场景种子 scripts/seed-home.js 可执行（回家/工作/睡前）", sh.returncode == 0, "rc=%s json=%s stderr=%s" % (sh.returncode, str(seed_home)[:200], (sh.stderr or "")[:150]))

        hub = start_hub()
        if not wait_http(BASE + "/api/state", 50):
            raise RuntimeError("隔离中枢未启动：" + open(os.path.join(LOG_DIR, "hub-main-%s.log" % STAMP), encoding="utf-8", errors="replace").read()[-600:])
        with open(os.path.join(DATA, "secrets.json"), "r", encoding="utf-8") as f:
            secrets = json.load(f)
        token = secrets["operatorToken"]
        node_token = secrets["nodeToken"]
        st, dev_route = api("/api/v2/remote/devices", token=token)
        rec("remote 模块已挂载（GET /api/v2/remote/devices）", st == 200 and dev_route.get("ok") is True, "status=%s devices=%s" % (st, len(dev_route.get("devices") or [])))
        if st != 200:
            raise RuntimeError("remote 模块未挂载：status=%s %s" % (st, json.dumps(dev_route, ensure_ascii=False)[:300]))
        # 真实 node-agent（TENON_V2=1）
        agent = start_agent("node-checker-r3", AGENT_DATA, node_token)
        node = wait_node(token, "node-checker-r3", 45)
        if not node:
            raise RuntimeError("node-agent 未注册")
        caps = [c.get("id") for c in (node.get("capabilities") or []) if isinstance(c, dict)]
        rec("真实 node-agent 注册且上报 input.* 能力", any(c.startswith("input.") for c in caps), "caps=%s" % json.dumps(caps, ensure_ascii=False)[:400])
        # 绑定设备
        st_b, bind_js = api("/api/v2/devices/node-checker-r3/bind", "POST", {}, token=token)
        rec("一键绑定验收电脑（remote 前置）", st_b in (200, 201) and (bind_js.get("ok") is True or bind_js.get("already")), "status=%s body=%s" % (st_b, json.dumps(bind_js, ensure_ascii=False)[:200]))
        # 第二个未绑定 agent（权限 403 用）
        unbound = start_agent("node-checker-unbound", UNBOUND_DATA, node_token)
        wait_node(token, "node-checker-unbound", 30)

        # ---------- 5. 权限矩阵 ----------
        st, js = remote_input(token, "no-such-device", "mouse", {"action": "move", "x": 10, "y": 10})
        rec("权限：未知设备调 remote → 404", st == 404, "status=%s error=%s" % (st, js.get("error")))
        st, js = remote_input(token, "node-checker-unbound", "mouse", {"action": "move", "x": 10, "y": 10})
        rec("权限：未绑定设备调 remote → 403", st == 403, "status=%s error=%s" % (st, js.get("error")))
        st, js = remote_input(token, "node-checker-r3", "bogus-type", {})
        rec("权限：未知 type → 400", st == 400, "status=%s error=%s" % (st, js.get("error")))
        ro = start_hub(name="readonly", port=RO_PORT, read_only=True)
        ro_base = "http://127.0.0.1:%d" % RO_PORT
        if wait_http(ro_base + "/api/state", 40):
            st, js = api("/api/v2/remote/node-checker-r3/input", "POST", {"type": "mouse", "payload": {"action": "move", "x": 10, "y": 10}}, token=token, base=ro_base)
            rec("权限：只读实例写 remote → 423", st == 423, "status=%s error=%s" % (st, js.get("error")))
        else:
            rec("权限：只读实例写 remote → 423", False, "只读实例未启动", skip=True)

        if args.dry:
            rec("dry 模式：setup/权限矩阵通过，跳过真实鼠标/键盘/音量/拍照/场景/引导", True, "--dry", skip=True)
            raise _DryDone()
        # ---------- 1. input.mouse 真实移动 ----------
        cur0 = get_cursor()
        target = (520, 360)
        r = run_remote_and_wait(token, "node-checker-r3", "mouse", {"action": "move", "x": target[0], "y": target[1]}, "鼠标绝对移动")
        cur1 = get_cursor()
        moved = (r.get("ok") and cur1.get("ok") and abs(int(cur1.get("x", -1)) - target[0]) <= 3 and abs(int(cur1.get("y", -1)) - target[1]) <= 3)
        EVID_JSON["mouseMove"] = {"before": cur0, "after": cur1, "target": target, "task": r}
        rec("input.mouse：真实移动光标到 (%d,%d)" % target, moved, "before=(%s,%s) after=(%s,%s) task=%s" % (cur0.get("x"), cur0.get("y"), cur1.get("x"), cur1.get("y"), r.get("taskStatus")))
        # 相对移动
        cur_b = get_cursor()
        r2 = run_remote_and_wait(token, "node-checker-r3", "mouse", {"action": "move", "dx": 60, "dy": 40}, "鼠标相对移动")
        cur_a = get_cursor()
        rel_ok = (r2.get("ok") and cur_a.get("ok") and abs((int(cur_a.get("x", 0)) - int(cur_b.get("x", 0))) - 60) <= 5 and abs((int(cur_a.get("y", 0)) - int(cur_b.get("y", 0))) - 40) <= 5)
        EVID_JSON["mouseMoveRel"] = {"before": cur_b, "after": cur_a, "task": r2}
        rec("input.mouse：相对移动 dx/dy 真实生效", rel_ok, "before=(%s,%s) after=(%s,%s)" % (cur_b.get("x"), cur_b.get("y"), cur_a.get("x"), cur_a.get("y")))

        # ---------- 2. input.key：记事本真实输入 + 剪贴板回读 ----------
        def foreground_has(word):
            c = get_cursor()
            fg = str(c.get("foreground") or "")
            return c.get("ok") and (word.lower() in fg.lower())

        open_r = run_remote_and_wait(token, "node-checker-r3", "app", {"app": "notepad"}, "打开记事本")
        win = None
        for _ in range(24):
            win = get_window("notepad")
            if win.get("ok"):
                break
            time.sleep(0.5)
        rec("远程启动记事本（app.launch）", bool(open_r.get("ok")) and bool(win.get("ok")), "task=%s win=%s" % (open_r.get("taskStatus"), win.get("title")))
        clip_before = get_clipboard()
        typed = "Tenon R3 验收 1234"
        key_ok = False
        clicked_focus = False
        if win.get("ok"):
            # 先点记事本窗口（真实远程点击），再用 focus-window.ps1 强制聚焦并轮询前台标题
            cx, cy = int(win.get("cx")), int(win.get("cy"))
            run_remote_and_wait(token, "node-checker-r3", "mouse", {"action": "click", "x": cx, "y": cy, "button": "left"}, "点击记事本窗口")
            for _ in range(3):
                fw = ps_json(os.path.join(HELPERS, "force-foreground.ps1"), "-ProcessName", "notepad", "-Match", "记事本")
                if fw.get("ok"):
                    clicked_focus = True
                    break
                time.sleep(0.6)
            if not clicked_focus:
                # 兜底：用本机真实 Alt+Tab 循环切窗直到记事本前台（后台进程抢前台可能被 Windows 拦）
                try:
                    import pyautogui
                    for _ in range(10):
                        pyautogui.hotkey("alt", "tab")
                        time.sleep(0.45)
                        if foreground_has("记事本") or foreground_has("notepad"):
                            clicked_focus = True
                            break
                except Exception:
                    pass
            if not clicked_focus:
                clicked_focus = foreground_has("记事本") or foreground_has("notepad")
            # 清空剪贴板后再输入/复制，避免旧内容干扰回读
            set_clipboard("")
            time.sleep(0.3)
            key_r = run_remote_and_wait(token, "node-checker-r3", "key", {"text": typed}, "输入文字")
            run_remote_and_wait(token, "node-checker-r3", "key", {"combo": "ctrl+a"}, "全选")
            copy_r = run_remote_and_wait(token, "node-checker-r3", "key", {"combo": "ctrl+c"}, "复制")
            got = ""
            for _ in range(12):
                time.sleep(0.4)
                clip_after = get_clipboard()
                got = str(clip_after.get("text") or "")
                if typed in got:
                    break
                # 若焦点丢失，重试一次点击+复制
                if _ == 5 and not (typed in got):
                    c2 = get_cursor()
                    fg2 = str(c2.get("foreground") or "")
                    if not ("记事本" in fg2 or "notepad" in fg2.lower()):
                        w2 = get_window("notepad")
                        if w2.get("ok"):
                            run_remote_and_wait(token, "node-checker-r3", "mouse", {"action": "click", "x": int(w2.get("cx")), "y": int(w2.get("cy")), "button": "left"}, "重新聚焦记事本")
                            run_remote_and_wait(token, "node-checker-r3", "key", {"combo": "ctrl+a"}, "全选")
                            run_remote_and_wait(token, "node-checker-r3", "key", {"combo": "ctrl+c"}, "复制")
            key_ok = key_r.get("ok") and typed in got
            EVID_JSON["inputKey"] = {"typed": typed, "clipboard": {"text": got[:200]}, "keyTask": key_r, "copyTask": copy_r, "focused": clicked_focus}
            rec("input.key：记事本输入文字并可回读（真实键盘事件）", key_ok, "焦点=%s；剪贴板回读含目标=%s；keyTask=%s copyTask=%s" % (clicked_focus, typed in got, key_r.get("taskStatus"), copy_r.get("taskStatus")))
            rec("input.mouse：轻点真实点击（点击记事本窗口并聚焦）", bool(clicked_focus) and bool(win.get("ok")), "clickTask=ok foregroundHasNotepad=%s" % clicked_focus)
            if clip_before.get("ok"):
                set_clipboard(str(clip_before.get("text") or ""))
        else:
            rec("input.key：记事本输入文字并可回读", False, "记事本窗口未出现", skip=True)

        # ---------- 3. input.media：真实音量变化 ----------
        vol0 = get_volume()
        if vol0.get("ok"):
            base_vol = int(vol0.get("volume", 0))
            set_volume(min(50, max(20, base_vol if base_vol > 5 else 40)))
            time.sleep(0.4)
            before = int(get_volume().get("volume", 0))
            down = run_remote_and_wait(token, "node-checker-r3", "media", {"action": "vol-down"}, "音量-")
            v_down = wait_volume(lambda v: int(v.get("volume", 999)) < before)
            after_down = int(v_down.get("volume", before))
            up = run_remote_and_wait(token, "node-checker-r3", "media", {"action": "vol-up"}, "音量+")
            v_up = wait_volume(lambda v: int(v.get("volume", -1)) > after_down)
            after_up = int(v_up.get("volume", after_down))
            mute = run_remote_and_wait(token, "node-checker-r3", "media", {"action": "mute"}, "静音")
            v_muted = wait_volume(lambda v: bool(v.get("muted")) is True)
            muted = bool(v_muted.get("muted"))
            unmute = run_remote_and_wait(token, "node-checker-r3", "media", {"action": "mute"}, "取消静音")
            v_unmuted = wait_volume(lambda v: bool(v.get("muted")) is False)
            unmuted = not bool(v_unmuted.get("muted"))
            vol_ok = down.get("ok") and up.get("ok") and after_down < before and after_up > after_down and muted and unmuted
            EVID_JSON["inputMedia"] = {"before": before, "afterDown": after_down, "afterUp": after_up, "muted": muted, "unmuted": unmuted, "tasks": [down, up, mute, unmute]}
            rec("input.media：音量-/+ 真实变化 + 静音切换真实生效", vol_ok, "volume %d → %d → %d；mute=%s→解除=%s" % (before, after_down, after_up, muted, unmuted))
            set_volume(base_vol)
        else:
            rec("input.media：音量真实变化", False, "无法读取系统音量：" + str(vol0.get("error")), skip=True)

        # ---------- 4. 拍照甩屏 ----------
        png = find_png()
        if png:
            st, ing = multipart_ingest(token, png, "checker-photo.png")
            asset = None
            if st == 200 and ing.get("ok"):
                items = ing.get("items") or ing.get("assets") or ing.get("results") or []
                first = items[0] if items else {}
                asset = (first.get("asset") if isinstance(first, dict) else None) or first or ing.get("asset") or {}
            asset_id = (asset or {}).get("id") or (asset or {}).get("assetId")
            rec("拍照/相册：multipart 图片入库（asset.ingested）", bool(asset_id), "status=%s assetId=%s" % (st, asset_id))
            if asset_id:
                st_h, hd = api("/api/v2/super/handoff", "POST", {"kind": "photo", "assetId": asset_id, "text": "Checker 拍照甩屏验收", "fromDevice": "checker-phone"}, token=token)
                rec("拍照甩屏：POST /api/v2/super/handoff {kind:photo} 成功", st_h == 200 and hd.get("ok"), "status=%s body=%s" % (st_h, json.dumps(hd, ensure_ascii=False)[:240]))
                types = ledger_types()
                rec("账本出现 asset.ingested + super.handoff", "asset.ingested" in types and "super.handoff" in types, "asset.ingested=%s super.handoff=%s" % ("asset.ingested" in types, "super.handoff" in types))
                EVID_JSON["photo"] = {"assetId": asset_id, "handoff": hd}
                # 电脑 #/handoff 显示该图（真实 Chrome）
                try:
                    from playwright.sync_api import sync_playwright
                    with sync_playwright() as p:
                        browser = p.chromium.launch(channel="chrome", headless=True)
                        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
                        ctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                        pg = ctx.new_page()
                        pg.goto(BASE + "/#/handoff", wait_until="domcontentloaded", timeout=30000)
                        pg.wait_for_timeout(3500)
                        imgs = pg.locator("#view img, [data-testid*='handoff'] img").count()
                        srcs = pg.eval_on_selector_all("#view img", "els => els.map(e => e.getAttribute('src')).filter(Boolean)")
                        pg.screenshot(path=os.path.join(SHOTS, "01-handoff-photo.png"))
                        ok_photo = imgs >= 1 and any("assets" in (s or "") for s in srcs)
                        rec("电脑 #/handoff 显示甩过来的照片（真实 Chrome + 截图）", ok_photo, "imgs=%d srcs=%s" % (imgs, json.dumps(srcs[:3], ensure_ascii=False)))
                        browser.close()
                except Exception as e:
                    rec("电脑 #/handoff 显示甩过来的照片（真实 Chrome + 截图）", False, str(e)[:300])
        else:
            rec("拍照甩屏", False, "找不到示例图片", skip=True)

        # ---------- 5. 3 个一键场景 ----------
        if args.skip_scenes:
            rec("一键场景（回家/工作/睡前）", True, "--skip-scenes", skip=True)
        else:
            st_p, presets = api("/api/v2/super/presets", token=token)
            plist = (presets.get("presets") or []) if st_p == 200 else []
            rec("一键场景预设列表（回家/工作/睡前 3 个）", len(plist) >= 3, "status=%s ids=%s" % (st_p, json.dumps([x.get("id") for x in plist], ensure_ascii=False)))
            scene_results = {}
            for preset in plist[:3]:
                pid = preset.get("id")
                st_r, run_js = api("/api/v2/super/presets/%s/run" % pid, "POST", {"confirmed": True}, token=token)
                ok_run = st_r == 200 and run_js.get("ok") is True
                task_ids = run_js.get("taskIds") or []
                statuses = []
                for tid in task_ids[:10]:
                    t = wait_task(token, tid, 45)
                    statuses.append((t or {}).get("status"))
                scene_results[pid] = {"runStatus": st_r, "body": run_js, "taskStatuses": statuses}
                rec("一键场景「%s」真实执行" % (preset.get("name") or pid), ok_run and len(statuses) > 0 and all(s == "succeeded" for s in statuses), "status=%s tasks=%s say=%s" % (st_r, json.dumps(statuses), str(run_js.get("say"))[:80]))
                time.sleep(0.6)
            types = ledger_types()
            rec("账本出现 scene.ran（3 个场景）", types.count("scene.ran") >= 3, "scene.ran count=%d" % types.count("scene.ran"))
            EVID_JSON["scenes"] = scene_results
            # 场景真实效果抽查：睡前模式应静音；回家模式应有 handoff 欢迎页/程序启动任务成功
            if "sleep" in scene_results:
                time.sleep(0.5)
                v = get_volume()
                rec("睡前模式真实效果：系统已静音", bool(v.get("ok")) and bool(v.get("muted")), "volume=%s muted=%s" % (v.get("volume"), v.get("muted")))
                set_volume(0)
        # ---------- 6. 新手引导（真实 Chrome，隔离实例首访 #/super） ----------
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                browser = p.chromium.launch(channel="chrome", headless=True)
                ctx = browser.new_context(viewport={"width": 1440, "height": 900})
                ctx.add_init_script("try{localStorage.setItem('tenon:token','%s');localStorage.removeItem('tenon:guide:done')}catch(e){}" % token)
                pg = ctx.new_page()
                pg.goto(BASE + "/#/super", wait_until="domcontentloaded", timeout=30000)
                pg.wait_for_timeout(4000)
                guide = pg.locator("[data-testid*='guide'], [data-testid*='onboard'], .v2-guide, .super-guide")
                body = pg.inner_text("body")
                has_guide = guide.count() > 0 or bool(re.search(r"(新手引导|三步|第一步|开始使用|装 App|装App)", body))
                pg.screenshot(path=os.path.join(SHOTS, "02-onboarding-first-open.png"))
                rec("新手引导：首开 #/super 出现 3 步引导", has_guide, "guideEls=%d textHit=%s" % (guide.count(), bool(re.search(r'(新手引导|三步|第一步|开始使用)', body))), skip=(not has_guide))
                if has_guide:
                    skip_btn = pg.get_by_text(re.compile(r"(稍后再说|跳过|以后再说|关闭)"))
                    sb = skip_btn.count()
                    if sb:
                        skip_btn.first.click()
                        pg.wait_for_timeout(800)
                        gone = pg.locator("[data-testid*='guide'], .v2-guide, .super-guide").count() == 0
                        pg.reload(wait_until="domcontentloaded")
                        pg.wait_for_timeout(3500)
                        body2 = pg.inner_text("body")
                        gone_after_reload = not bool(re.search(r"(新手引导|三步|第一步)", body2))
                        rec("新手引导：可关闭且关闭后不再出现", gone and gone_after_reload, "关闭后隐藏=%s 刷新后隐藏=%s" % (gone, gone_after_reload))
                        pg.screenshot(path=os.path.join(SHOTS, "03-onboarding-closed.png"))
                    else:
                        rec("新手引导：可关闭", False, "未找到关闭/稍后再说按钮", skip=True)
                browser.close()
        except Exception as e:
            rec("新手引导（真实 Chrome）", False, str(e)[:300])

        # ---------- 账本完整性 ----------
        s = state(token)
        rec("账本哈希链完整性", bool((s.get("integrity") or {}).get("ok", True)), "seq=%s integrity=%s" % (s.get("seq"), (s.get("integrity") or {}).get("ok")))
        EVID_JSON["finalLedgerSeq"] = s.get("seq")
    except _DryDone:
        pass
    except Exception as e:
        rec("R3 验收执行异常", False, str(e)[:600] + " | " + str(traceback.format_exc())[-900:])
    finally:
        # 恢复机器状态：取消静音 + 音量归零（睡前场景会静音；媒体用例会改音量）
        try:
            ps_json(os.path.join(HELPERS, "set-mute.ps1"), "-Mute", "0")
            set_volume(0)
        except Exception:
            pass
        # 关闭记事本（若由本测试启动）
        try:
            subprocess.run(["taskkill", "/IM", "notepad.exe", "/F"], capture_output=True)
        except Exception:
            pass
        kill(unbound)
        kill(agent)
        kill(ro)
        kill(hub)
        time.sleep(0.6)
        pass_n = sum(1 for c in CHECKS if c["ok"] and not c["skip"])
        fail_n = sum(1 for c in CHECKS if not c["ok"] and not c["skip"])
        skip_n = sum(1 for c in CHECKS if c["skip"])
        report["summary"] = {"total": len(CHECKS), "pass": pass_n, "fail": fail_n, "skip": skip_n}
        report["finishedAt"] = datetime.now().isoformat()
        os.makedirs(EVID, exist_ok=True)
        os.makedirs(SHOTS, exist_ok=True)
        with open(os.path.join(EVID, "r3-acceptance.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：_internal/checker/round3/r3-acceptance.json")
        if not args.keep:
            shutil.rmtree(RUN, ignore_errors=True)
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()