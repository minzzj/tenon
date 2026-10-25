#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""榫卯 Tenon · 独立验收装置 · 真实 Chrome UI 全页面巡检

零 pip 新依赖（用本机已装的 python playwright + 真实 Chrome channel="chrome"）。

默认自启隔离实例（端口 7462 + 临时数据目录 + seed 演示数据 + 预置素材/剪贴板），
用真实 headless Chrome 打开桌面全部页面与手机 3 页，检查：
  - 页面渲染（body 文本 ≥ 80 字符、hash 路由命中）
  - JS 运行时错误 = 0、console.error = 0
  - 关键 data-testid 存在（按页面配置）
  - v2 页面无「v2-degrade」降级条
截图：_internal/checker/ui/<stamp>/<page>.png；结果：_internal/checker/ui-sweep.json

用法：
  python test/verify/run-ui-sweep.py                     # 自启隔离实例（阶段 A）
  python test/verify/run-ui-sweep.py --phase B           # 同上，但要求 #/devices 页（R1 验收）
  python test/verify/run-ui-sweep.py --base http://127.0.0.1:7462 --token tok_xxx
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CHECKER = os.path.join(ROOT, "_internal", "checker")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
SHOT_DIR = os.path.join(CHECKER, "ui", STAMP)
RUN_DIR = os.path.join(CHECKER, "tmp", "ui-sweep-" + STAMP)
DATA_DIR = os.path.join(RUN_DIR, "data")
LOG_DIR = os.path.join(CHECKER, "ui-sweep")
PORT = int(os.environ.get("TENON_VERIFY_PORT", "7462"))

TOKEN_KEY = "tenon:token"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 桌面页面配置：required = [(testid, 最少数量)]；optional 仅记录数量
DESKTOP_PAGES = [
    dict(name="super", route="#/super", required=[("super-ask-input", 1), ("super-send", 1), ("super-voice", 1)], v2=True),
    dict(name="assets", route="#/assets", required=[("asset-search", 1), ("asset-filter-kind", 1), ("asset-filter-device", 1)], v2=True),
    dict(name="link", route="#/link", required=[("pair-code", 1), ("btn-pair", 1), ("clipboard-input", 1)], v2=True),
    dict(name="basket", route="#/basket", required=[("basket-list", 1)], v2=True),
    dict(name="scenes", route="#/scenes", required=[("btn-scene-new", 1), ("scene-list", 1)], v2=True,
         actions=[("click_testid", "btn-scene-new")], post_required=[("scene-form", 1), ("scene-name", 1), ("btn-scene-save", 1)]),
    dict(name="enterprise-users", route="#/enterprise", required=[], v2=True,
         actions=[("click_css", '[data-v2="ent-tab"][data-tab="users"]')],
         post_required=[("org-user-list", 1), ("org-user-name", 1), ("btn-org-add-user", 1)]),
    dict(name="enterprise-approvals", route="#/enterprise", required=[], v2=True,
         actions=[("click_css", '[data-v2="ent-tab"][data-tab="approvals"]')],
         post_required=[("approval-list", 1)]),
    dict(name="enterprise-policy", route="#/enterprise", required=[], v2=True,
         actions=[("click_css", '[data-v2="ent-tab"][data-tab="policy"]')],
         post_required=[("org-policy-retention", 1), ("org-approval-toggle", 1)]),
    dict(name="devices", route="#/devices", required=[], v2=True,
         post_required=[("device-card", 1)],
         optional=[("btn-bind", 0), ("btn-unbind", 0), ("btn-install", 0), ("btn-download-install", 0), ("install-package", 0), ("btn-download-node", 0)]),
    dict(name="overview", route="#/overview", required=[("device-card", 0)], v2=False),
    dict(name="audit", route="#/audit", required=[("btn-export-csv", 1), ("btn-export-json", 1), ("btn-export-md", 1)], v2=False),
]
DESKTOP_PAGES_PHASE_B = [
    dict(name="devices", route="#/devices", required=[("device-card", 1)], v2=True,
         optional=[("btn-bind", 0), ("btn-unbind", 0), ("btn-download-install", 0), ("btn-install-download", 0),
                   ("device-bound-badge", 0), ("btn-download-node", 0), ("install-package", 0)]),
]
MOBILE_PAGES = [
    dict(name="m-home", path="/m", required=[("m-input", 1), ("m-send", 1)], optional=[("m-tilt-btn", 0), ("m-entry-link", 0), ("m-entry-assets", 0)]),
    dict(name="m-link", path="/m/link", required=[("m-link-code", 1), ("m-btn-pair", 1), ("m-clipboard-input", 1)]),
    dict(name="m-assets", path="/m/assets", required=[], optional=[("m-asset-card", 0), ("m-basket-item", 0)]),
]


def log(msg):
    print("[" + time.strftime("%H:%M:%S") + "] " + msg, flush=True)


def ensure_dir(p):
    os.makedirs(p, exist_ok=True)
    return p


def http_json(url, token=None, method="GET", body=None, timeout=10):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["x-tenon-token"] = token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw.decode("utf-8"))
            except Exception:
                return r.status, {"raw_len": len(raw)}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def wait_http(url, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError("等待实例启动超时：" + url)


def start_instance():
    ensure_dir(DATA_DIR)
    ensure_dir(LOG_DIR)
    log("种子演示数据 → " + DATA_DIR)
    r = subprocess.run([sys.executable and "node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA_DIR],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if r.returncode != 0:
        raise RuntimeError("seed 失败：" + (r.stderr or r.stdout or "")[:500])
    env = dict(os.environ)
    env.update({"TENON_PORT": str(PORT), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": DATA_DIR,
                "TENON_DISCOVERY_PORT": str(PORT + 50), "TENON_ASSETS_OCR": "0"})
    log("启动隔离实例 :%d" % PORT)
    logf = open(os.path.join(LOG_DIR, "hub-%s.log" % STAMP), "a", encoding="utf-8")
    proc = subprocess.Popen(["node", os.path.join(ROOT, "server", "start.js")], cwd=ROOT, env=env,
                            stdout=logf, stderr=logf, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    base = "http://127.0.0.1:%d" % PORT
    wait_http(base + "/api/state", 40)
    with open(os.path.join(DATA_DIR, "secrets.json"), "r", encoding="utf-8") as f:
        token = json.load(f)["operatorToken"]
    # 预置：素材、剪贴板、流转，让页面有真实数据
    try:
        http_json(base + "/api/v2/assets/ingest", token, "POST",
                  {"deviceId": "node-local", "path": "示例空间/样品图/样品01.png"})
        http_json(base + "/api/v2/link/clipboard", token, "POST", {"kind": "text", "text": "UI 巡检剪贴板内容"})
        http_json(base + "/api/v2/super/handoff", token, "POST",
                  {"kind": "page", "url": "https://example.com/ui-sweep", "fromDevice": "phone"})
    except Exception as e:
        log("预置数据部分失败（不阻塞巡检）：" + str(e)[:200])
    return proc, base, token


def kill_process(proc):
    if not proc:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            proc.kill()
    except Exception:
        pass


def collect_page(page, errors, console_errors, failed_requests=None):
    def on_pageerror(e):
        errors.append(str(e)[:300])

    def on_console(msg):
        try:
            if msg.type == "error":
                loc = ""
                try:
                    loc = str(((msg.location or {}).get("url")) or "")[:200]
                except Exception:
                    loc = ""
                console_errors.append((loc + " :: " if loc else "") + str(msg.text)[:300])
        except Exception:
            pass
    page.on("pageerror", on_pageerror)
    page.on("console", on_console)
    if failed_requests is not None:
        def on_failed(req):
            try:
                failed_requests.append(req.url[:200] + " :: " + str(req.failure)[:120])
            except Exception:
                pass
        page.on("requestfailed", on_failed)


def check_page(context, base, spec, phase, mobile=False):
    page = context.new_page()
    errors, console_errors, failed_requests = [], [], []
    collect_page(page, errors, console_errors, failed_requests)
    route = spec.get("route") or spec.get("path")
    url = base + (route if route.startswith("/") else "/" + route)
    result = {"name": spec["name"], "url": url, "jsErrors": errors, "consoleErrors": console_errors, "requestFailed": failed_requests,
              "testids": {}, "pass": False, "skip": False, "detail": ""}
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1600)
        # 等应用渲染（至少出现一个 data-testid）；v2 页面等 v2 检测结束
        try:
            page.wait_for_selector("[data-testid]", timeout=8000)
        except Exception:
            pass
        try:
            page.wait_for_function("() => !document.querySelector('[data-testid=\"v2-loading\"]')", timeout=8000)
        except Exception:
            pass
        page.wait_for_timeout(600)
        # 等待 required testid 真正渲染（v2 页面异步加载）：最多 10s
        for testid, min_count in spec.get("required", []):
            if min_count <= 0:
                continue
            t0 = time.time()
            while time.time() - t0 < 10:
                try:
                    if page.locator('[data-testid="%s"]' % testid).count() >= min_count:
                        break
                except Exception:
                    pass
                page.wait_for_timeout(200)
        action_problems = []
        for act in spec.get("actions", []):
            try:
                if act[0] == "click_testid":
                    page.locator('[data-testid="%s"]' % act[1]).first.click(timeout=6000)
                elif act[0] == "click_css":
                    page.locator(act[1]).first.click(timeout=6000)
                elif act[0] == "wait":
                    page.wait_for_timeout(act[1])
                page.wait_for_timeout(500)
            except Exception as e:
                action_problems.append("交互动作失败 %s：%s" % (act, str(e)[:140]))
        for testid, min_count in spec.get("post_required", []):
            t0 = time.time()
            while time.time() - t0 < 10:
                try:
                    if page.locator('[data-testid="%s"]' % testid).count() >= min_count:
                        break
                except Exception:
                    pass
                page.wait_for_timeout(200)
        ensure_dir(SHOT_DIR)
        shot = os.path.join(SHOT_DIR, ("mobile-" if mobile else "desktop-") + spec["name"] + ".png")
        page.screenshot(path=shot)
        result["screenshot"] = os.path.relpath(shot, ROOT).replace("\\", "/")
        body = page.inner_text("body")
        result["bodyLen"] = len(body)
        hash_val = page.evaluate("() => location.hash")
        result["hash"] = hash_val
        expected_route = spec.get("route") or ""
        hash_ok = ("#" not in expected_route) or hash_val.startswith(expected_route.split("?")[0]) or expected_route.startswith(hash_val)
        result["hashOk"] = hash_ok
        problems = list(action_problems)
        if not hash_ok:
            problems.append("hash 不匹配：期望 %s 实际 %s" % (expected_route, hash_val))
        if result["bodyLen"] < 80:
            problems.append("页面文本过短（%d），疑似未渲染" % result["bodyLen"])
        if errors:
            problems.append("JS 运行时错误 %d 个" % len(errors))
        resource_errs = [e for e in console_errors if "Failed to load resource" in e]
        fatal_console = [e for e in console_errors if "Failed to load resource" not in e]
        result["consoleResourceErrors"] = resource_errs
        if fatal_console:
            problems.append("console.error %d 个" % len(fatal_console))
        # v2 降级条：后端可用时不应出现
        degrade = 0
        try:
            degrade = page.locator('[data-testid="v2-degrade"], [data-testid="m-v2-degrade"]').count()
        except Exception:
            degrade = 0
        result["v2Degrade"] = degrade
        if spec.get("v2") and degrade > 0:
            problems.append("出现 v2 降级条（后端接口异常）")
        # testid 断言
        for testid, min_count in list(spec.get("required", [])) + list(spec.get("post_required", [])):
            try:
                cnt = page.locator('[data-testid="%s"]' % testid).count()
            except Exception:
                cnt = 0
            result["testids"][testid] = cnt
            if cnt < min_count:
                problems.append("缺少 testid %s（%d < %d）" % (testid, cnt, min_count))
        for opt in spec.get("optional", []):
            testid = opt[0] if isinstance(opt, (tuple, list)) else opt
            try:
                result["testids"][testid] = page.locator('[data-testid="%s"]' % testid).count()
            except Exception:
                result["testids"][testid] = 0
        result["problems"] = problems
        result["pass"] = len(problems) == 0
        result["detail"] = "; ".join(problems)[:400]
        if problems:
            result["bodySnippet"] = body[:300]
    except Exception as e:
        result["problems"] = [str(e)[:300]]
        result["detail"] = str(e)[:400]
        try:
            ensure_dir(SHOT_DIR)
            shot = os.path.join(SHOT_DIR, ("mobile-" if mobile else "desktop-") + spec["name"] + "-error.png")
            page.screenshot(path=shot)
            result["screenshot"] = os.path.relpath(shot, ROOT).replace("\\", "/")
        except Exception:
            pass
    finally:
        try:
            page.close()
        except Exception:
            pass
    flag = "SKIP" if result["skip"] else ("PASS" if result["pass"] else "FAIL")
    log("%s %s :: %s" % (flag, spec["name"], result.get("detail", "")))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--phase", default="A", choices=["A", "B"])
    ap.add_argument("--keep", action="store_true", help="保留隔离实例数据目录")
    args = ap.parse_args()

    ensure_dir(CHECKER)
    ensure_dir(SHOT_DIR)
    ensure_dir(LOG_DIR)
    proc = None
    if args.base:
        base = args.base.rstrip("/")
        token = args.token
        if not token:
            raise SystemExit("--base 模式必须提供 --token")
    else:
        proc, base, token = start_instance()

    pages = list(DESKTOP_PAGES)
    if args.phase == "B":
        pages = pages + DESKTOP_PAGES_PHASE_B
    results = []
    summary = {"pass": 0, "fail": 0, "skip": 0, "total": 0}
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-dev-shm-usage"])
            try:
                ctx = browser.new_context(viewport={"width": 1440, "height": 900})
                ctx.add_init_script("try{localStorage.setItem('%s','%s')}catch(e){}" % (TOKEN_KEY, token))
                for spec in pages:
                    results.append(check_page(ctx, base, spec, args.phase, mobile=False))
                mctx = browser.new_context(viewport={"width": 430, "height": 860}, device_scale_factor=1)
                mctx.add_init_script("try{localStorage.setItem('%s','%s')}catch(e){}" % (TOKEN_KEY, token))
                for spec in MOBILE_PAGES:
                    results.append(check_page(mctx, base, spec, args.phase, mobile=True))
            finally:
                try:
                    browser.close()
                except Exception:
                    pass
    except Exception as e:
        results.append({"name": "fatal", "pass": False, "skip": False, "detail": "浏览器/巡检异常：" + str(e)[:400], "problems": [str(e)[:400]]})
    finally:
        kill_process(proc)
        if proc and not args.keep:
            try:
                shutil.rmtree(RUN_DIR)
            except Exception:
                pass

    for r in results:
        summary["total"] += 1
        if r.get("skip"):
            summary["skip"] += 1
        elif r.get("pass"):
            summary["pass"] += 1
        else:
            summary["fail"] += 1
    report = {
        "stamp": datetime.now().isoformat(),
        "kind": "ui-sweep",
        "phase": args.phase,
        "base": base,
        "browser": "real Chrome via playwright channel=chrome (headless)",
        "screenshotDir": os.path.relpath(SHOT_DIR, ROOT).replace("\\", "/"),
        "summary": summary,
        "pages": results,
    }
    ensure_dir(CHECKER)
    out = os.path.join(CHECKER, "ui-sweep.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    run_copy = os.path.join(LOG_DIR, "run-%s.json" % STAMP)
    with open(run_copy, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (summary["pass"], summary["fail"], summary["skip"], summary["total"]))
    log("明细：" + os.path.relpath(out, ROOT))
    log("截图：" + report["screenshotDir"])
    if summary["fail"] > 0:
        for r in results:
            if not r.get("pass") and not r.get("skip"):
                log("  ✗ " + r["name"] + " :: " + str(r.get("detail", ""))[:300])
        sys.exit(1)


if __name__ == "__main__":
    main()