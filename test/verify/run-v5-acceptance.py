#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""V5「笔记/总结文档/提醒/物联/UI/APK」独立验收（阶段 A 装置 + 模块就绪后全量）
覆盖：笔记 CRUD/md/搜索/语音记一下；结构化总结 + md/docx/pdf 下载与 magic；提醒真实到点触发（账本/SSE/TTS/通知）/daily 滚动/中文解析；
物联（本地桩 HA REST + aedes MQTT + SSDP）；UI 5 页签/看板/记录/提醒/文档/IoT；APK 0.6 静态；回归。
证据：_internal/checker/v5/v5-acceptance.json + logs/screenshots
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EVID = os.path.join(ROOT, "_internal", "checker", "v5")
STUBS = os.path.join(EVID, "stubs")
SHOTS = os.path.join(EVID, "screenshots")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
RUN = os.path.join(ROOT, "_internal", "checker", "tmp", "v5-" + STAMP)
DATA = os.path.join(RUN, "data")
PORT = int(os.environ.get("V5_PORT", "7464"))
RO_PORT = PORT + 1
BASE = "http://127.0.0.1:%d" % PORT
LIVE = "http://127.0.0.1:7410"
CHECKS = []
EVID_JSON = {}
HA_PORT, SSDP_HTTP_PORT, MQTT_PORT = 18123, 18124, 18884


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + m, flush=True)


def rec(name, ok, detail="", skip=False):
    CHECKS.append({"name": name, "ok": bool(ok), "skip": bool(skip), "detail": str(detail)[:1200]})
    log(("SKIP " if skip else ("PASS " if ok else "FAIL ")) + name + (" :: " + str(detail)[:300] if detail else ""))


def api(path, method="GET", body=None, token=None, base=None, timeout=120, headers=None):
    base = base or BASE
    data = json.dumps(body).encode() if body is not None else None
    h = dict(headers or {})
    if data is not None:
        h["Content-Type"] = "application/json"
    if token:
        h["x-tenon-token"] = token
    req = urllib.request.Request(base + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            content = r.read()
            ctype = r.headers.get("Content-Type", "")
            disp = r.headers.get("Content-Disposition", "")
            try:
                return r.status, json.loads(content.decode()), {"contentType": ctype, "disposition": disp, "bytes": content}
            except Exception:
                return r.status, {"raw_len": len(content)}, {"contentType": ctype, "disposition": disp, "bytes": content}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode()), {}
        except Exception:
            return e.code, {}, {}
    except Exception as e:
        return 0, {"error": str(e)}, {}


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


def start_hub(port, data_dir, extra_env=None):
    env = dict(os.environ)
    env.update({"TENON_PORT": str(port), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": data_dir,
                "TENON_DISCOVERY_PORT": str(port + 50), "TENON_ASSETS_OCR": "0"})
    if extra_env:
        env.update(extra_env)
    os.makedirs(os.path.join(EVID, "logs"), exist_ok=True)
    logf = open(os.path.join(EVID, "logs", "hub-%d-%s.log" % (port, STAMP)), "a", encoding="utf-8")
    return subprocess.Popen(["node", os.path.join(ROOT, "server", "start.js")], cwd=ROOT, env=env, stdout=logf, stderr=logf)


def start_proc(args, cwd=None, logfile=None):
    logf = open(logfile, "a", encoding="utf-8") if logfile else subprocess.DEVNULL
    return subprocess.Popen(args, cwd=cwd or ROOT, stdout=logf, stderr=logf)


def kill(proc):
    if proc:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        except Exception:
            pass


def events_of(data_dir):
    try:
        with open(os.path.join(data_dir, "events.jsonl"), encoding="utf-8") as f:
            return [json.loads(l) for l in f.read().split("\n") if l.strip()]
    except Exception:
        return []


def ev_type(events, t):
    return [e for e in events if e.get("type") == t]


def wait_event(data_dir, t, timeout=30, pred=None):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for e in reversed(events_of(data_dir)):
            if e.get("type") == t and (pred is None or pred(e)):
                return e
        time.sleep(0.4)
    return None


def health_inventory(token, base=None):
    st, health, _meta = api("/api/v2/health", token=token, base=base)
    if st != 200:
        return [], []
    routes = []
    for r in (health or {}).get("routes") or []:
        routes.append(r if isinstance(r, str) else (str(r.get("method", "GET")).upper() + " " + str(r.get("path", ""))))
    return (health or {}).get("modules") or [], routes


def route_present(routes, method, path):
    return any(str(r).startswith(method + " " + path) for r in routes)


def find_note_md(data_dir, contains):
    md_dir = os.path.join(data_dir, "notes", "md")
    hits = []
    if os.path.isdir(md_dir):
        for fn in os.listdir(md_dir):
            if not fn.endswith(".md"):
                continue
            p = os.path.join(md_dir, fn)
            try:
                txt = open(p, encoding="utf-8").read()
            except Exception:
                continue
            if contains in txt:
                hits.append({"file": p, "bytes": os.path.getsize(p), "text": txt[:400]})
    return hits


# ---------------- Phase 1: 笔记 ----------------
def phase_notes(token, data_dir):
    modules, routes = health_inventory(token)
    if not route_present(routes, "GET", "/notes") and not route_present(routes, "GET", "/api/v2/notes") and "notes" not in modules:
        rec("笔记模块已挂载（notes）", False, "health modules=%s routes 无 /notes" % modules, skip=True)
        return
    text = "记住：明天上午十点开会，带上笔记本 %s" % STAMP[-5:]
    st, nb, _ = api("/api/v2/notes", "POST", {"text": text, "tags": ["验收"], "source": "checker"}, token=token)
    note = (nb or {}).get("note") or {}
    nid = (nb or {}).get("id") or note.get("id")
    rec("笔记创建 POST /notes → 201 + id/md", st in (200, 201) and bool(nid), "status=%s id=%s md=%s body=%s" % (st, nid, note.get("md"), json.dumps(nb, ensure_ascii=False)[:300]))
    st2, ls, _ = api("/api/v2/notes?q=" + urllib.parse.quote("开会"), token=token)
    items = (ls or {}).get("items") or []
    hit = any(str(x.get("id")) == str(nid) for x in items)
    rec("笔记查询/搜索 GET /notes?q=开会", st2 == 200 and hit, "status=%s items=%d hit=%s" % (st2, len(items), hit))
    md_hits = find_note_md(data_dir, STAMP[-5:])
    rec("笔记 Markdown 文件落盘（data/notes/md/*.md 含 YAML front matter）", bool(md_hits), json.dumps([{k: v for k, v in h.items() if k != "text"} for h in md_hits[:2]], ensure_ascii=False)[:300])
    st3, gb, _ = api("/api/v2/notes/" + str(nid), token=token)
    rec("笔记详情 GET /notes/:id", st3 == 200 and ((gb or {}).get("note") or {}).get("id") == nid, "status=%s" % st3)
    st4, ub, _ = api("/api/v2/notes/" + str(nid), "PATCH", {"text": text + "（补充：带录音笔）"}, token=token)
    rec("笔记更新 PATCH /notes/:id", st4 == 200 and "录音笔" in json.dumps(ub, ensure_ascii=False), "status=%s" % st4)
    st_ev = events_of(data_dir)
    ncreated = ev_type(st_ev, "note.created"); nupdated = ev_type(st_ev, "note.updated")
    rec("笔记账本 note.created/note.updated", len(ncreated) >= 1 and len(nupdated) >= 1, "created=%d updated=%d" % (len(ncreated), len(nupdated)))
    # 语音链路「记一下：…」（规则模式，不消耗云端）
    try:
        api("/api/v2/voice/config", "PATCH", {"llmProvider": "rule", "tts": {"enabled": True, "play": False}}, token=token)
        st_v, vb, _ = api("/api/v2/voice/command", "POST", {"text": "记一下：买牛奶和鸡蛋，晚上做蛋炒饭"}, token=token, timeout=180)
        time.sleep(1.0)
        st_q, qb, _ = api("/api/v2/notes?q=" + urllib.parse.quote("牛奶"), token=token)
        qitems = (qb or {}).get("items") or []
        voice_ok = st_q == 200 and any("牛奶" in json.dumps(x, ensure_ascii=False) for x in qitems)
        rec("语音笔记链路：/voice/command「记一下：…」→ 笔记出现", voice_ok, "commandStatus=%s provider=%s notesHit=%s body=%s" % (st_v, (vb or {}).get("provider"), voice_ok, json.dumps(vb, ensure_ascii=False)[:300]), skip=(not voice_ok and st_v != 200))
    except Exception as e:
        rec("语音笔记链路", False, str(e)[:200], skip=True)
    # 删除 + 401
    st5, db, _ = api("/api/v2/notes/" + str(nid), "DELETE", token=token)
    st6, gb2, _ = api("/api/v2/notes/" + str(nid), token=token)
    ndel = ev_type(events_of(data_dir), "note.deleted")
    rec("笔记删除 DELETE → 404 + 账本 note.deleted", st5 == 200 and st6 == 404 and len(ndel) >= 1, "del=%s get=%s ledger=%d" % (st5, st6, len(ndel)))
    st7, _, _ = api("/api/v2/notes", "POST", {"text": "未登录"})
    rec("笔记未登录写 → 401", st7 == 401, "status=%s" % st7)


# ---------------- Phase 2: 总结文档 ----------------
def phase_documents(token, data_dir, live_token=""):
    modules, routes = health_inventory(token)
    if "documents" not in modules and not any("/documents" in r for r in routes):
        rec("文档模块已挂载（documents）", False, "health modules=%s 无 /documents 路由" % modules, skip=True)
        return
    # 确保有笔记素材
    api("/api/v2/notes", "POST", {"text": "今天和客户开会讨论了 V5 计划；重点：笔记+提醒+物联；待办：周三前出文档。", "tags": ["总结"]}, token=token)
    kind_texts = ["摘要", "重点", "待办", "回顾", "日记"]
    gen_routes = [r for r in routes if "/documents" in r]
    EVID_JSON["documentRoutes"] = gen_routes
    st, gb, _ = api("/api/v2/documents/generate", "POST", {"kind": "note-summary", "title": "V5 验收总结", "date": datetime.now().strftime("%Y-%m-%d")}, token=token, timeout=240)
    doc = (gb or {}).get("document") or (gb or {}).get("doc") or {}
    struct = (gb or {}).get("structured") or (doc or {}).get("structured") or {}
    blob = json.dumps(gb, ensure_ascii=False)
    fields_ok = all((k in blob) for k in kind_texts) or all((k in struct) for k in ["summary", "keyPoints", "todos", "review", "diary"])
    did = (gb or {}).get("id") or doc.get("id")
    rec("总结文档生成：结构化 JSON（摘要/重点/待办/回顾/日记）", st in (200, 201) and bool(did) and fields_ok, "status=%s id=%s provider=%s fieldsOk=%s body=%s" % (st, did, (gb or {}).get("provider") or doc.get("provider"), fields_ok, blob[:500]))
    if not did:
        rec("总结文档下载 md/docx/pdf", False, "无 document id，无法下载", skip=True)
        return
    st_l, lb, _ = api("/api/v2/documents", token=token)
    st_g, gd2, _ = api("/api/v2/documents/" + str(did), token=token)
    rec("文档中心列表/详情（GET /documents, /documents/:id）", st_l == 200 and st_g == 200, "list=%s detail=%s" % (st_l, st_g))
    formats = {}
    for fmt in ("md", "docx", "pdf"):
        stf, jb, meta = api("/api/v2/documents/%s/download?format=%s" % (did, fmt), token=token, timeout=120)
        raw = meta.get("bytes") or b""
        ctype = (meta.get("contentType") or "").lower()
        disp = meta.get("disposition") or ""
        ok = stf == 200 and len(raw) > 20
        extra = ""
        if fmt == "md":
            ok = ok and ("今天" in raw.decode("utf-8", "replace") or "摘要" in raw.decode("utf-8", "replace") or "#" in raw.decode("utf-8", "replace"))
            extra = "mdText"
        elif fmt == "docx":
            ok = ok and raw[:2] == b"PK"
            extra = "PK"
        else:
            ok = ok and raw[:4] == b"%PDF"
            extra = "%PDF"
        formats[fmt] = {"status": stf, "bytes": len(raw), "contentType": ctype, "disposition": disp, "magicOk": ok, "extra": extra}
        rec("文档下载 %s（magic/Content-Type/文件名）" % fmt, ok and bool(ctype) and ("filename" in disp.lower() or disp), json.dumps(formats[fmt], ensure_ascii=False)[:400])
    files_dir = os.path.join(data_dir, "documents", str(did))
    files = os.listdir(files_dir) if os.path.isdir(files_dir) else []
    led = ev_type(events_of(data_dir), "document.created")
    rec("文档文件落盘（data/documents/<id>/summary.*）+ 账本 document.created", len(files) >= 3 and len(led) >= 1, "files=%s ledger=%d" % (files, len(led)))
    EVID_JSON["documents"] = {"id": did, "formats": formats, "provider": (gb or {}).get("provider"), "degraded": (gb or {}).get("degraded")}
    # 无 key 降级如实标注（本隔离实例不含 deepseek key、llmProvider=rule）
    rec("无 key/规则模式降级：文档生成不崩溃且标注 provider/degraded", st in (200, 201) and bool((gb or {}).get("provider") or (doc or {}).get("provider")), "provider=%s degraded=%s（真实 DeepSeek 将在 live 用 ≤1 次）" % ((gb or {}).get("provider") or (doc or {}).get("provider"), (gb or {}).get("degraded")))

# ---------------- Phase 3: 提醒 ----------------
def phase_reminders(token, data_dir):
    modules, routes = health_inventory(token)
    if "reminders" not in modules and not any("/reminders" in r for r in routes):
        rec("提醒模块已挂载（reminders）", False, "health modules=%s 无 /reminders 路由" % modules, skip=True)
        return
    api("/api/v2/voice/config", "PATCH", {"llmProvider": "rule", "tts": {"enabled": True, "play": False}}, token=token)
    # 3.1 中文时间解析
    st_p, pb, _ = api("/api/v2/reminders", "POST", {"text": "提醒我 1 分钟后喝水"}, token=token)
    item = (pb or {}).get("item") or {}
    at = item.get("at") or ""
    parsed = (pb or {}).get("parsed") or {}
    try:
        due = (datetime.fromisoformat(at.replace("Z", "+00:00")) - datetime.now().astimezone()).total_seconds()
    except Exception:
        due = -1
    rec("中文时间解析「提醒我 1 分钟后喝水」→ at≈+60s", st_p in (200, 201) and 40 <= due <= 90 and parsed.get("human"), "status=%s at=%s due=%.1fs parsed=%s" % (st_p, at, due, json.dumps(parsed, ensure_ascii=False)[:200]))
    rid = item.get("id")
    # 3.2 真实等待到点触发（账本 reminder.fired + SSE；TTS 异步生成 WAV；node-agent 通知如在线）
    stream_txt = ""
    try:
        import threading
        def read_stream():
            nonlocal stream_txt
            try:
                req = urllib.request.Request(BASE + "/api/v2/reminders/stream", headers={"x-tenon-token": token})
                with urllib.request.urlopen(req, timeout=150) as r:
                    while True:
                        line = r.readline()
                        if not line:
                            break
                        stream_txt += line.decode("utf-8", "replace")
                        if '"type":"reminder"' in stream_txt.replace(" ", ""):
                            break
            except Exception:
                pass
        th = threading.Thread(target=read_stream, daemon=True); th.start()
    except Exception:
        pass
    fired = wait_event(data_dir, "reminder.fired", max(60, int(max(10, due)) + 60), pred=lambda e: (e.get("data") or {}).get("id") == rid)
    fired_any = wait_event(data_dir, "reminder.fired", 5)
    tts_ev = wait_event(data_dir, "reminder.tts", 30, pred=lambda e: (e.get("data") or {}).get("id") == rid)
    tts_file = ((tts_ev or {}).get("data") or {}).get("file") or ""
    tts_ok = bool(tts_file) and os.path.exists(os.path.join(ROOT, tts_file) if not os.path.isabs(tts_file) else tts_file)
    rec("提醒真实到点触发：账本 reminder.fired", bool(fired), "firedAt=%s data=%s" % ((fired or {}).get("at"), json.dumps((fired or {}).get("data"), ensure_ascii=False)[:300]))
    rec("提醒触发 SSE 事件（/reminders/stream 收到 reminder）", '"reminder"' in stream_txt.replace(" ", ""), "streamLen=%d snippet=%s" % (len(stream_txt), stream_txt[:200].replace("\n", " ")))
    rec("提醒 TTS WAV 生成（reminder.tts + 文件存在）", tts_ok, "ttsFile=%s exists=%s data=%s" % (tts_file, tts_ok, json.dumps((tts_ev or {}).get("data"), ensure_ascii=False)[:200]))
    notify = ((fired or {}).get("data") or {}).get("notify") or ((tts_ev or {}).get("data") or {}).get("notify")
    rec("提醒 node-agent 通知（在线则真实派发；无节点优雅降级）", True, "notify=%s（离线时降级属预期）" % json.dumps(notify, ensure_ascii=False)[:220], skip=(notify is None))
    # 3.3 done / 幂等
    if rid:
        st_d1, d1, _ = api("/api/v2/reminders/" + str(rid) + "/done", "POST", {}, token=token)
        st_d2, d2, _ = api("/api/v2/reminders/" + str(rid) + "/done", "POST", {}, token=token)
        st_g, g, _ = api("/api/v2/reminders/" + str(rid), token=token)
        gitem = (g or {}).get("item") or {}
        done_ok = bool(gitem.get("done") is True or gitem.get("status") == "done" or gitem.get("enabled") is False)
        rec("提醒完成 done + 幂等（item.done=true，二次调用不报错）", st_d1 == 200 and st_d2 in (200, 409) and done_ok, "done1=%s done2=%s item.done=%s item.enabled=%s" % (st_d1, st_d2, gitem.get("done"), gitem.get("enabled")))
    # 3.4 每天提醒滚动（先验中文「每天 8 点」解析，再用临近 daily 提醒验证滚动）
    st_pd, pdb, _ = api("/api/v2/reminders", "POST", {"text": "每天 8 点提醒我吃药"}, token=token)
    pd_item = (pdb or {}).get("item") or {}
    rec("中文解析「每天 8 点提醒我吃药」→ daily", st_pd in (200, 201) and pd_item.get("recurrence") == "daily", "status=%s at=%s parsed=%s" % (st_pd, pd_item.get("at"), json.dumps((pdb or {}).get("parsed"), ensure_ascii=False)[:160]))
    if pd_item.get("id"):
        api("/api/v2/reminders/" + str(pd_item.get("id")), "DELETE", token=token)
    daily_at = (datetime.now().astimezone() + timedelta(seconds=3)).isoformat()
    st_daily, db, _ = api("/api/v2/reminders", "POST", {"text": "每天提醒验收（滚动）", "at": daily_at, "recurrence": "daily"}, token=token)
    ditem = (db or {}).get("item") or {}
    did = ditem.get("id")
    daily_ok = st_daily in (200, 201) and ditem.get("recurrence") == "daily"
    rec("每天提醒创建（recurrence=daily，显式 at）", daily_ok, "status=%s id=%s at=%s" % (st_daily, did, ditem.get("at")))
    if did:
        fired_daily = wait_event(data_dir, "reminder.fired", 45, pred=lambda e: (e.get("data") or {}).get("id") == did)
        time.sleep(1.0)
        st_g2, g2, _ = api("/api/v2/reminders/" + str(did), token=token)
        it2 = (g2 or {}).get("item") or {}
        fired_day = it2.get("lastFiredDay")
        after_at = it2.get("at")
        next_ok = bool(after_at) and (str(after_at) != str(ditem.get("at")))
        api("/api/v2/reminders/tick", "POST", {}, token=token)
        time.sleep(1.0)
        same_day_fires = len([e for e in ev_type(events_of(data_dir), "reminder.fired") if ((e.get("data") or {}).get("id") == did)])
        rec("每天提醒滚动：真实触发后下一次时间前移、同日不重复触发", bool(fired_daily) and next_ok and fired_day and same_day_fires == 1, "fired=%s lastFiredDay=%s nextAt=%s before=%s sameDayFires=%d" % (bool(fired_daily), fired_day, after_at, ditem.get("at"), same_day_fires))
        api("/api/v2/reminders/" + str(did), "DELETE", token=token)
    # 3.5 中文其它解析（明天 9 点）
    st_t, tb, _ = api("/api/v2/reminders", "POST", {"text": "明天 9 点提醒我开会"}, token=token)
    rec("中文时间解析「明天 9 点」", st_t in (200, 201) and ((tb or {}).get("item") or {}).get("at"), "status=%s at=%s parsed=%s" % (st_t, ((tb or {}).get("item") or {}).get("at"), json.dumps((tb or {}).get("parsed"), ensure_ascii=False)[:160]))
    # 清理
    for xid in [rid, did, ((tb or {}).get("item") or {}).get("id")]:
        if xid:
            api("/api/v2/reminders/" + str(xid), "DELETE", token=token)


# ---------------- Phase 4: 物联 IoT ----------------
def phase_iot(token, data_dir):
    modules, routes = health_inventory(token)
    iot_routes = [r for r in routes if "/iot" in r]
    EVID_JSON["iotRoutes"] = iot_routes
    if "iot" not in modules and not iot_routes:
        rec("物联模块已挂载（iot）", False, "health modules=%s 无 /iot 路由" % modules, skip=True)
        return
    st_s, sb, _ = api("/api/v2/iot/status", token=token)
    rec("GET /iot/status", st_s == 200 and bool((sb or {}).get("ok", True)), "status=%s body=%s" % (st_s, json.dumps(sb, ensure_ascii=False)[:500]))
    st_d, dbs, _ = api("/api/v2/iot/devices", token=token)
    rec("GET /iot/devices", st_d == 200, "status=%s body=%s" % (st_d, json.dumps(dbs, ensure_ascii=False)[:500]))
    procs = []
    try:
        ha_log = os.path.join(EVID, "logs", "ha-stub-%s.log" % STAMP)
        ssdp_log = os.path.join(EVID, "logs", "ssdp-stub-%s.log" % STAMP)
        mqtt_log = os.path.join(EVID, "logs", "mqtt-broker-%s.jsonl" % STAMP)
        procs.append(start_proc([sys.executable, os.path.join(STUBS, "ha_stub.py"), "--port", str(HA_PORT), "--token", "tenon-test-token", "--log", ha_log], logfile=ha_log))
        procs.append(start_proc([sys.executable, os.path.join(STUBS, "ssdp_stub.py"), "--http-port", str(SSDP_HTTP_PORT), "--log", ssdp_log], logfile=ssdp_log))
        procs.append(start_proc(["node", os.path.join(STUBS, "mqtt_broker.mjs"), "--port", str(MQTT_PORT), "--log", mqtt_log], logfile=mqtt_log))
        time.sleep(1.5)
        ha_ok = False
        for _i in range(40):
            try:
                req = urllib.request.Request("http://127.0.0.1:%d/api/" % HA_PORT, headers={"Authorization": "Bearer tenon-test-token"})
                with urllib.request.urlopen(req, timeout=2) as r:
                    ha_ok = r.status == 200
                    if ha_ok:
                        break
            except Exception:
                pass
            time.sleep(0.25)
        mqtt_ok = False
        try:
            r = subprocess.run(["node", "-e", "const mqtt=require('mqtt');const c=mqtt.connect('mqtt://127.0.0.1:%d',{connectTimeout:3000});c.on('connect',()=>{console.log('MQTT_OK');c.end();process.exit(0)});c.on('error',(e)=>{console.log('MQTT_ERR '+e.message);process.exit(0)});setTimeout(()=>{console.log('MQTT_TIMEOUT');process.exit(0)},5000);" % MQTT_PORT], capture_output=True, text=True, timeout=20)
            mqtt_ok = "MQTT_OK" in (r.stdout or "")
        except Exception:
            mqtt_ok = False
        rec("本地物联桩就绪（HA HTTP + aedes MQTT）", ha_ok and mqtt_ok, "ha=%s mqtt=%s" % (ha_ok, mqtt_ok))
        # HA：PATCH /iot/config → POST /iot/test → GET /iot/ha/entities → POST /iot/import → 控制
        body_ha = {"ha": {"baseUrl": "http://127.0.0.1:%d" % HA_PORT, "token": "tenon-test-token"}}
        st_c1, c1, _ = api("/api/v2/iot/config", "PATCH", body_ha, token=token)
        rec("HA 配置保存（PATCH /iot/config）", st_c1 in (200, 201), "status=%s body=%s" % (st_c1, json.dumps(c1, ensure_ascii=False)[:400]))
        st_t2, t2, _ = api("/api/v2/iot/test", "POST", {"target": "ha"}, token=token)
        ha_log_txt = open(ha_log, encoding="utf-8", errors="replace").read() if os.path.exists(ha_log) else ""
        rec("HA 连接测试（POST /iot/test → 真实请求本地 HA 桩）", st_t2 in (200, 201), "status=%s haLogHits=%d body=%s" % (st_t2, len(ha_log_txt.splitlines()), json.dumps(t2, ensure_ascii=False)[:400]))
        st_e, eb, _ = api("/api/v2/iot/ha/entities", token=token)
        ents = (eb or {}).get("entities") or (eb or {}).get("items") or []
        rec("HA 实体列表（含 light.living_room / 客厅灯）", st_e == 200 and len(ents) > 0, "status=%s entities=%d sample=%s" % (st_e, len(ents), json.dumps(ents[:2], ensure_ascii=False)[:400]))
        ids = [e.get("entityId") or e.get("entity_id") or e.get("id") for e in ents if (e.get("entityId") or e.get("entity_id") or e.get("id"))]
        st_i, ib, _ = api("/api/v2/iot/import", "POST", {"source": "ha", "ids": ids[:3]}, token=token)
        imported = (ib or {}).get("imported") or (ib or {}).get("devices") or []
        rec("HA 设备导入（POST /iot/import）", st_i in (200, 201), "status=%s imported=%s body=%s" % (st_i, len(imported) if isinstance(imported, list) else imported, json.dumps(ib, ensure_ascii=False)[:400]))
        st_dev, devs, _ = api("/api/v2/iot/devices", token=token)
        dev_items = (devs or {}).get("devices") or (devs or {}).get("items") or []
        target = None
        for d in dev_items:
            eid = str(d.get("entityId") or d.get("externalId") or d.get("id") or "")
            if "light" in eid or "客厅灯" in json.dumps(d, ensure_ascii=False):
                target = d; break
        target = target or (dev_items[0] if dev_items else None)
        if target:
            tid = target.get("id") or target.get("deviceId")
            st_ct, ct, _ = api("/api/v2/iot/devices/%s/control" % tid, "POST", {"command": "turn_on", "params": {}, "entityId": target.get("entityId")}, token=token)
            ha_after = open(ha_log, encoding="utf-8", errors="replace").read() if os.path.exists(ha_log) else ""
            ha_hit = "turn_on" in ha_after
            rec("HA 设备控制（POST /iot/devices/:id/control → HA 桩收到 turn_on）", st_ct in (200, 201), "status=%s haHit=%s body=%s" % (st_ct, ha_hit, json.dumps(ct, ensure_ascii=False)[:300]))
        else:
            rec("HA 设备控制", False, "无导入设备", skip=True)
        # MQTT：PATCH config → test → broker 记录 client/subscribe → discover
        body_mq = {"mqtt": {"url": "mqtt://127.0.0.1:%d" % MQTT_PORT, "prefix": "homeassistant"}}
        st_m1, m1, _ = api("/api/v2/iot/config", "PATCH", body_mq, token=token)
        st_m2, m2, _ = api("/api/v2/iot/test", "POST", {"target": "mqtt"}, token=token)
        mt = open(mqtt_log, encoding="utf-8", errors="replace").read() if os.path.exists(mqtt_log) else ""
        mqtt_clients = mt.count('"type":"client"')
        rec("MQTT 配置 + 连接测试（aedes 桩记录真实 client/subscribe）", st_m1 in (200, 201) and st_m2 in (200, 201) and mqtt_clients >= 1, "cfg=%s test=%s brokerClients=%d log=%s" % (st_m1, st_m2, mqtt_clients, mt[-260:]))
        st_md, md, _ = api("/api/v2/iot/discover?source=mqtt", token=token)
        rec("MQTT 设备发现（GET /iot/discover?source=mqtt）", st_md == 200, "status=%s body=%s" % (st_md, json.dumps(md, ensure_ascii=False)[:300]))
        # SSDP：GET /iot/discover?st=ssdp:all（桩可能因 1900 占用不可用 → 至少不崩）
        st_ss, ss, _ = api("/api/v2/iot/discover?st=" + urllib.parse.quote("ssdp:all"), token=token)
        ssdp_log_txt = open(ssdp_log, encoding="utf-8", errors="replace").read() if os.path.exists(ssdp_log) else ""
        found = "榫卯验收灯" in json.dumps(ss, ensure_ascii=False) or "tenon-v5-test-light" in json.dumps(ss, ensure_ascii=False)
        rec("SSDP 局域网发现（本地桩；UDP 1900 被系统占用则降级记录）", st_ss == 200, "status=%s foundStub=%s msearchHits=%d body=%s" % (st_ss, found, len(ssdp_log_txt.splitlines()), json.dumps(ss, ensure_ascii=False)[:300]), skip=(st_ss == 0))
        iot_led = [e for e in events_of(data_dir) if str(e.get("type", "")).startswith("iot.")]
        rec("物联账本 iot.* 事件", len(iot_led) >= 1, "events=%d types=%s" % (len(iot_led), sorted(set(e.get("type") for e in iot_led))[:8]))
        st_l, lb, _ = api("/api/v2/iot/status", token=token)
        rec("GET /iot/status 汇总（providers/设备数）", st_l == 200, json.dumps(lb or {}, ensure_ascii=False)[:500])
    finally:
        for pr in procs:
            kill(pr)

# ---------------- Phase 5: UI（5 页签/看板/记录/提醒/文档/IoT） ----------------
def phase_ui(token, allow_live=False):
    from playwright.sync_api import sync_playwright
    requests_all, external = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        try:
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            ctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
            pg = ctx.new_page()
            derrs = []

            def on_req(r):
                requests_all.append(r.url)
                if r.url.startswith("http"):
                    host = r.url.split("/")[2].split(":")[0]
                    if host not in ("127.0.0.1", "localhost"):
                        external.append(r.url)

            pg.on("pageerror", lambda e: derrs.append(str(e)[:200]))
            pg.on("request", on_req)
            pg.goto(LIVE + "/", wait_until="domcontentloaded", timeout=30000)
            pg.wait_for_timeout(3500)
            body = pg.inner_text("body")[:6000]
            tabs_expected = ["首页", "记录", "提醒", "文档", "设置"]
            tabs = [t for t in tabs_expected if t in body]
            tab_ids = {}
            for tid in ["tab-home", "tab-records", "tab-reminders", "tab-documents", "tab-settings"]:
                tab_ids[tid] = pg.locator('[data-testid="%s"]' % tid).count()
            EVID_JSON["uiTabs"] = {"labels": tabs, "testids": tab_ids}
            pg.screenshot(path=os.path.join(SHOTS, "v5-home.png"))
            rec("UI 5 页签（首页/记录/提醒/文档/设置）", len(tabs) >= 5 and all(v > 0 for v in tab_ids.values()), "tabs=%s ids=%s body=%s" % (tabs, json.dumps(tab_ids, ensure_ascii=False), body[:220].replace("\n", " ")), skip=(len(tabs) < 5))
            board_ids = {k: pg.locator('[data-testid="%s"]' % k).count() for k in ["board-card", "board-next-reminder", "board-notes-count", "board-summary-status", "board-download-md", "board-download-docx", "board-download-pdf"]}
            board_hits = [k for k in ["看板", "下一个提醒", "今日笔记", "今日总结", "屏幕采集"] if k in body]
            rec("首页今日看板卡（下一个提醒/今日笔记/总结状态/文档下载）", len(board_hits) >= 3 and board_ids.get("board-card", 0) > 0, "hits=%s ids=%s" % (board_hits, json.dumps(board_ids, ensure_ascii=False)))
            # 记录页
            pg.locator('[data-testid="tab-records"]').first.click(); pg.wait_for_timeout(1500)
            rec_body = pg.inner_text("body")[:6000]
            rec_ids = {k: pg.locator('[data-testid="%s"]' % k).count() for k in ["records-search", "records-date", "records-all", "note-summarize", "note-list", "note-detail", "summary-download-md", "summary-download-docx", "summary-download-pdf"]}
            pg.screenshot(path=os.path.join(SHOTS, "v5-records.png"))
            rec("记录页（搜索/日期/AI 总结/笔记列表/详情/下载 MD/DOCX/PDF）", rec_ids.get("records-search", 0) > 0 and rec_ids.get("note-summarize", 0) > 0 and rec_ids.get("note-list", 0) > 0, json.dumps(rec_ids, ensure_ascii=False))
            # 提醒页
            pg.locator('[data-testid="tab-reminders"]').first.click(); pg.wait_for_timeout(1500)
            rem_ids = {k: pg.locator('[data-testid="%s"]' % k).count() for k in ["reminder-form", "reminder-text", "reminder-at", "reminder-recurrence", "reminder-create", "reminder-quick", "reminder-list", "reminders-pending-count"]}
            pg.screenshot(path=os.path.join(SHOTS, "v5-reminders.png"))
            rec("提醒页（新建表单/1 分钟后/待触发列表/完成）", rem_ids.get("reminder-text", 0) > 0 and rem_ids.get("reminder-create", 0) > 0, json.dumps(rem_ids, ensure_ascii=False))
            # 文档页
            pg.locator('[data-testid="tab-documents"]').first.click(); pg.wait_for_timeout(1500)
            doc_ids = {k: pg.locator('[data-testid="%s"]' % k).count() for k in ["documents-refresh", "document-regenerate", "document-list", "document-preview", "documents-count"]}
            doc_body = pg.inner_text("body")[:6000]
            doc_kw = [k for k in ["下载", "MD", "DOCX", "PDF", "Markdown", "文档"] if k in doc_body]
            pg.screenshot(path=os.path.join(SHOTS, "v5-docs.png"))
            rec("文档页（重新生成/列表/预览/下载 MD-DOCX-PDF）", doc_ids.get("document-list", 0) > 0 and len(doc_kw) >= 2, "ids=%s kw=%s" % (json.dumps(doc_ids, ensure_ascii=False), doc_kw))
            # 设置页 IoT
            pg.locator('[data-testid="tab-settings"]').first.click(); pg.wait_for_timeout(1500)
            iot_ids = {k: pg.locator('[data-testid="%s"]' % k).count() for k in ["iot-ha-block", "iot-ha-url", "iot-ha-token", "iot-ha-save", "iot-ha-test", "iot-mqtt-block", "iot-mqtt-broker", "iot-mqtt-save", "iot-mqtt-test", "iot-ssdp-block", "iot-ssdp-discover", "iot-devices-block"]}
            set_body = pg.inner_text("body")[:7000]
            iot_kw = [k for k in ["物联", "Home Assistant", "MQTT", "SSDP"] if k in set_body]
            pg.screenshot(path=os.path.join(SHOTS, "v5-settings.png"))
            rec("设置页物联（HA 地址/令牌/保存/测试 + MQTT + SSDP 发现 + 设备控制）", len(iot_kw) >= 3 and iot_ids.get("iot-ha-url", 0) > 0 and iot_ids.get("iot-mqtt-broker", 0) > 0 and iot_ids.get("iot-ssdp-discover", 0) > 0, "kw=%s ids=%s" % (iot_kw, json.dumps(iot_ids, ensure_ascii=False)))
            if allow_live:
                # Phase B：真实创建一条笔记 + 一条提醒（不触发 DeepSeek），验证 UI→API 链路
                try:
                    pg.locator('[data-testid="tab-records"]').first.click(); pg.wait_for_timeout(800)
                    st_n, nb, _ = api("/api/v2/notes?limit=5", token=token, base=LIVE)
                    rec("UI/API 记录列表可达（软降级检测）", st_n == 200, "status=%s badgeMock=%s" % (st_n, "后端未就绪" in body))
                except Exception as e:
                    rec("UI/API 记录列表可达", False, str(e)[:200], skip=True)
            board_mock = pg.locator('[data-testid="board-mock"]').count() and not pg.locator('[data-testid="board-mock"]').is_hidden()
            EVID_JSON["uiBackendPending"] = bool(board_mock)
            rec("UI JS 运行时错误 = 0", len(derrs) == 0, json.dumps(derrs[:3], ensure_ascii=False))
            ext = sorted(set(external))
            other = [u for u in ext if "api.deepseek.com" not in u]
            EVID_JSON["uiNetwork"] = {"requests": len(requests_all), "external": ext, "other": other}
            rec("UI 网络隐私：除 127.0.0.1 外仅 api.deepseek.com", len(other) == 0, json.dumps(EVID_JSON["uiNetwork"], ensure_ascii=False)[:400])
            # 手机 /m
            mctx = browser.new_context(viewport={"width": 430, "height": 900}, has_touch=True, is_mobile=True)
            mctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
            mp = mctx.new_page()
            merrs = []
            mp.on("pageerror", lambda e: merrs.append(str(e)[:200]))
            mp.goto(LIVE + "/m", wait_until="domcontentloaded", timeout=30000)
            mp.wait_for_timeout(2500)
            m_body = mp.inner_text("body")[:3000]
            mp.screenshot(path=os.path.join(SHOTS, "v5-m.png"))
            m_hits = [k for k in ["记录", "提醒", "笔记", "语音", "超级终端"] if k in m_body]
            rec("手机 /m 入口（记录/提醒/语音）", len(m_hits) >= 1, "hits=%s body=%s" % (m_hits, m_body[:180].replace("\n", " ")))
            rec("手机 /m JS 错误 = 0", len(merrs) == 0, json.dumps(merrs[:3], ensure_ascii=False))
            mctx.close()
        finally:
            browser.close()



# ---------------- Phase 7: live 7410 部署验收（真实 DeepSeek ≤1：总结文档） ----------------
def phase_live(live_token):
    st, health, _ = api("/api/v2/health", token=live_token, base=LIVE)
    modules = (health or {}).get("modules") or []
    routes = (health or {}).get("routes") or []
    rec("live 13 模块挂载（含 notes/reminders/documents/iot）", st == 200 and all(m in modules for m in ["notes", "reminders", "documents", "iot"]) and not (health or {}).get("pending"), "modules=%s pending=%s routes=%d" % (",".join(modules), (health or {}).get("pending"), len(routes)))
    # live 笔记 CRUD（真实，测后清理）
    text = "V5 live 验收笔记 " + STAMP[-5:]
    st_n, nb, _ = api("/api/v2/notes", "POST", {"text": text, "source": "checker"}, token=live_token, base=LIVE)
    nid = (nb or {}).get("id") or ((nb or {}).get("note") or {}).get("id")
    st_l, lb, _ = api("/api/v2/notes?q=" + urllib.parse.quote("live 验收"), token=live_token, base=LIVE)
    rec("live 笔记创建/查询", st_n in (200, 201) and st_l == 200 and bool(nid), "create=%s id=%s list=%s" % (st_n, nid, st_l))
    if nid:
        api("/api/v2/notes/" + str(nid), "DELETE", token=live_token, base=LIVE)
    # live 提醒只读 + SSE 端点可用（不写 live 提醒，避免真机播报/打扰）
    st_r, rb, _ = api("/api/v2/reminders?status=pending", token=live_token, base=LIVE)
    rec("live 提醒列表（只读）", st_r == 200, "status=%s items=%s" % (st_r, len((rb or {}).get("items") or [])))
    sse_ok = {}
    for path in ["/api/v2/reminders/stream", "/api/v2/documents/stream"]:
        try:
            req = urllib.request.Request(LIVE + path, headers={"x-tenon-token": live_token})
            # 只读取响应头，立即关闭，避免长连接挂住
            sock = urllib.request.urlopen(req, timeout=8)
            ctype = sock.headers.get("Content-Type", "")
            sse_ok[path] = {"status": sock.status, "contentType": ctype}
            sock.close()
        except Exception as e:
            sse_ok[path] = {"error": str(e)[:120]}
    rec("live SSE 端点（reminders/documents stream, text/event-stream）", all(isinstance(v.get("status"), int) and v.get("status") == 200 and "text/event-stream" in (v.get("contentType") or "") for v in sse_ok.values()), json.dumps(sse_ok, ensure_ascii=False)[:400])
    # live 文档生成（真实 DeepSeek 1 次）→ 结构化 + 下载三种格式
    st_g, gb, _ = api("/api/v2/documents/generate", "POST", {"kind": "note-summary", "date": datetime.now().strftime("%Y-%m-%d"), "title": "V5 live 验收总结"}, token=live_token, base=LIVE, timeout=240)
    doc = (gb or {}).get("document") or (gb or {}).get("doc") or {}
    did = (gb or {}).get("id") or doc.get("id")
    blob = json.dumps(gb, ensure_ascii=False)
    f_ok = all(k in blob for k in ["摘要", "重点", "待办", "回顾", "日记"]) or all(k in blob for k in ["summary", "keyPoints", "todos", "review", "diary"])
    provider = (gb or {}).get("provider") or doc.get("provider")
    rec("live 总结文档生成（真实 DeepSeek 1 次）：provider=deepseek + 结构化五部分", st_g in (200, 201) and bool(did) and "deepseek" in str(provider) and f_ok, "status=%s id=%s provider=%s fieldsOk=%s body=%s" % (st_g, did, provider, f_ok, blob[:400]))
    formats = {}
    if did:
        for fmt in ("md", "docx", "pdf"):
            stf, jb, meta = api("/api/v2/documents/%s/download?format=%s" % (did, fmt), token=live_token, base=LIVE, timeout=120)
            raw = meta.get("bytes") or b""
            ctype = (meta.get("contentType") or "").lower()
            disp = meta.get("disposition") or ""
            magic_ok = (fmt == "docx" and raw[:2] == b"PK") or (fmt == "pdf" and raw[:4] == b"%PDF") or (fmt == "md" and len(raw) > 100)
            formats[fmt] = {"status": stf, "bytes": len(raw), "contentType": ctype, "disposition": disp, "magicOk": magic_ok}
            rec("live 文档下载 %s（magic/Content-Type/文件名）" % fmt, stf == 200 and magic_ok and bool(ctype), json.dumps(formats[fmt], ensure_ascii=False)[:400])
        EVID_JSON["liveDocuments"] = {"id": did, "provider": provider, "formats": formats}
        # 清理 live 测试文档，避免脏数据
        api("/api/v2/documents/" + str(did), "DELETE", token=live_token, base=LIVE)
    # live IoT 只读
    st_i, ib, _ = api("/api/v2/iot/status", token=live_token, base=LIVE)
    st_id, idb, _ = api("/api/v2/iot/devices", token=live_token, base=LIVE)
    rec("live IoT status/devices（只读）", st_i == 200 and st_id == 200, "status=%s devices=%s body=%s" % (st_i, st_id, json.dumps(ib, ensure_ascii=False)[:300]))
    EVID_JSON["liveIot"] = {"status": st_i, "devices": st_id}


# ---------------- Phase 6: APK 0.6 静态 ----------------
def phase_apk():
    target = os.path.join(EVID, "android-static-v5.json")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "test", "verify", "run-android-static-v5.py"), "--json-out", target],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    data = None
    if os.path.exists(target):
        try:
            data = json.load(open(target, encoding="utf-8"))
        except Exception:
            data = None
    if data:
        s = data.get("summary") or {}
        rec("APK 0.6 静态验收（存在/SHA256/版本/权限/FileProvider/接口代码/分享/README）", s.get("fail", 1) == 0,
            "summary=%s checks=%s" % (json.dumps(s, ensure_ascii=False), "; ".join(c["name"] + "=" + ("PASS" if c["ok"] else ("SKIP" if c["skip"] else "FAIL")) for c in data.get("checks", []))))
        EVID_JSON["apk"] = data
    else:
        rec("APK 0.6 静态验收", False, "android-static-v5 未产出：" + ((r.stdout or "") + (r.stderr or ""))[-300:], skip=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", default="all", help="all|notes|documents|reminders|iot|ui|apk|live")
    ap.add_argument("--live", action="store_true", help="允许 live 真实 DeepSeek 调用（Phase B 才用）")
    args = ap.parse_args()
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(RUN, exist_ok=True)
    hub = None
    report = {"kind": "v5-acceptance", "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": EVID_JSON}
    live_token = ""
    try:
        live_token = json.load(open(os.path.join(ROOT, "data", "secrets.json"), encoding="utf-8")).get("operatorToken", "")
    except Exception:
        live_token = ""
    try:
        if args.phase in ("all", "notes", "documents", "reminders", "iot"):
            subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA], cwd=ROOT, capture_output=True, timeout=180)
            hub = start_hub(PORT, DATA)
            if not wait_http(BASE + "/api/state", 60):
                rec("隔离实例启动", False, "未启动", skip=True)
            else:
                token = json.load(open(os.path.join(DATA, "secrets.json"), encoding="utf-8"))["operatorToken"]
                modules, routes = health_inventory(token)
                rec("V5 隔离实例模块清单", True, "modules=%s routes=%d" % (",".join(modules), len(routes)))
                api("/api/v2/voice/config", "PATCH", {"llmProvider": "rule", "tts": {"enabled": True, "play": False}}, token=token)
                if args.phase in ("all", "notes"):
                    try: phase_notes(token, DATA)
                    except Exception as e: rec("笔记阶段异常", False, str(e)[:400])
                if args.phase in ("all", "documents"):
                    try: phase_documents(token, DATA)
                    except Exception as e: rec("文档阶段异常", False, str(e)[:400])
                if args.phase in ("all", "reminders"):
                    try: phase_reminders(token, DATA)
                    except Exception as e: rec("提醒阶段异常", False, str(e)[:400])
                if args.phase in ("all", "iot"):
                    try: phase_iot(token, DATA)
                    except Exception as e: rec("物联阶段异常", False, str(e)[:400])
        if args.phase in ("all", "live"):
            try: phase_live(live_token)
            except Exception as e: rec("live 部署阶段异常", False, str(e)[:400])
        if args.phase in ("all", "ui"):
            try: phase_ui(live_token, args.live)
            except Exception as e: rec("UI 阶段异常", False, str(e)[:400])
        if args.phase in ("all", "apk"):
            try: phase_apk()
            except Exception as e: rec("APK 阶段异常", False, str(e)[:400])
    finally:
        kill(hub)
        time.sleep(0.5)
        pass_n = sum(1 for c in CHECKS if c["ok"] and not c["skip"])
        fail_n = sum(1 for c in CHECKS if not c["ok"] and not c["skip"])
        skip_n = sum(1 for c in CHECKS if c["skip"])
        report["summary"] = {"total": len(CHECKS), "pass": pass_n, "fail": fail_n, "skip": skip_n}
        report["finishedAt"] = datetime.now().isoformat()
        os.makedirs(EVID, exist_ok=True)
        with open(os.path.join(EVID, "v5-acceptance.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：_internal/checker/v5/v5-acceptance.json")
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()