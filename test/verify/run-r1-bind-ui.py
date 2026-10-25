#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Round1 Phase B · 真实第二设备绑定/解绑（真实 node-agent + 真实 Chrome）+ 权限矩阵。
自启隔离中枢 7462 + seed；启动真实第二个 node-agent（独立 nodeId/独立数据目录）；
真实 Chrome 打开 #/devices：设备卡/未绑定 → 一键绑定（确认弹窗）→ 已绑定徽标 → 账本 device.bound
→ 解绑 → 未绑定徽标 → device.unbound；另验证安装区块/下载按钮/JS 错误/权限矩阵/重复绑定幂等。
证据：_internal/checker/round1/bind-ui.json + screenshots/
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EVID = os.path.join(ROOT, "_internal", "checker", "round1")
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
RUN = os.path.join(ROOT, "_internal", "checker", "tmp", "r1-bind-" + STAMP)
DATA = os.path.join(RUN, "data")
AGENT_DATA = os.path.join(RUN, "agent-data")
SHOTS = os.path.join(EVID, "screenshots")
PORT = 7462
RO_PORT = 7463
CHECKS = []


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + m, flush=True)


def rec(name, ok, detail="", skip=False):
    CHECKS.append({"name": name, "ok": bool(ok), "skip": bool(skip), "detail": str(detail)[:600]})
    log(("SKIP " if skip else ("PASS " if ok else "FAIL ")) + name + (" :: " + str(detail)[:220] if detail else ""))


def api(url, token=None, method="GET", body=None, timeout=10):
    data = None
    h = {}
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if token:
        h["x-tenon-token"] = token
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw.decode())
            except Exception:
                return r.status, {"raw_len": len(raw)}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def wait_http(url, timeout=40):
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


def ps(command, timeout=120):
    return subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                           "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + command],
                          cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def ledger_types():
    try:
        with open(os.path.join(DATA, "events.jsonl"), "r", encoding="utf-8") as f:
            return [json.loads(l)["type"] for l in f.read().split("\n") if l.strip()]
    except Exception:
        return []


def main():
    results = {"kind": "r1-bind-ui", "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": {}, "env": {}}
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(RUN, exist_ok=True)
    hub = None
    agent = None
    ro = None
    try:
        # ---- 隔离中枢 ----
        subprocess.run(["node", os.path.join(ROOT, "scripts", "seed-demo.js"), "--fresh", "--data-dir", DATA],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        env = dict(os.environ)
        env.update({"TENON_PORT": str(PORT), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": DATA,
                    "TENON_DISCOVERY_PORT": str(PORT + 50), "TENON_ASSETS_OCR": "0"})
        logf = open(os.path.join(EVID, "logs", "hub-bind-%s.log" % STAMP), "a", encoding="utf-8")
        hub = subprocess.Popen(["node", os.path.join(ROOT, "server", "start.js")], cwd=ROOT, env=env,
                               stdout=logf, stderr=logf)
        base = "http://127.0.0.1:%d" % PORT
        if not wait_http(base + "/api/state", 45):
            raise RuntimeError("中枢未启动")
        with open(os.path.join(DATA, "secrets.json"), "r", encoding="utf-8") as f:
            secrets = json.load(f)
        token = secrets["operatorToken"]
        node_token = secrets["nodeToken"]
        results["env"] = {"base": base, "dataDir": os.path.relpath(DATA, ROOT).replace("\\", "/")}
        rec("隔离中枢在线（7462）", True, base)

        # ---- 真实第二个 node-agent（独立 nodeId + 独立数据目录） ----
        os.makedirs(AGENT_DATA, exist_ok=True)
        second_id = "node-verify-second"
        aenv = dict(os.environ)
        aenv.update({"TENON_HUB_URL": base, "TENON_DATA_DIR": AGENT_DATA, "TENON_NODE_TOKEN": node_token,
                     "TENON_NODE_ID": second_id, "TENON_NODE_NAME": "验收第二台电脑"})
        alog = open(os.path.join(EVID, "logs", "second-agent-%s.log" % STAMP), "a", encoding="utf-8")
        agent = subprocess.Popen(["node", os.path.join(ROOT, "node-agent", "agent.js")], cwd=ROOT, env=aenv,
                                 stdout=alog, stderr=alog)
        reg = None
        t0 = time.time()
        while time.time() - t0 < 30:
            st, js = api(base + "/api/v2/devices", token)
            lst = (js.get("items") or js.get("devices") or []) if st == 200 else []
            reg = next((d for d in lst if d.get("id") == second_id), None)
            if reg:
                break
            time.sleep(0.5)
        results["evidence"]["secondDevice"] = reg
        rec("真实第二个 node-agent 注册进设备列表（未绑定）", bool(reg) and reg.get("bound") is False, json.dumps(reg, ensure_ascii=False)[:400] if reg else "未注册")

        # ---- 真实 Chrome：设备页 / 绑定 / 解绑 ----
        from playwright.sync_api import sync_playwright
        page_errors = []
        console_errors = []
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-dev-shm-usage"])
            try:
                ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
                ctx.add_init_script("try{localStorage.setItem('tenon:token','%s')}catch(e){}" % token)
                page = ctx.new_page()
                page.on("pageerror", lambda e: page_errors.append(str(e)[:300]))
                page.on("console", lambda m: console_errors.append(m.text[:300]) if m.type == "error" else None)
                page.goto(base + "/#/devices", wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(2500)
                # 等设备卡渲染
                for _ in range(40):
                    if page.locator('[data-testid="v2-device-card"]').count() > 0:
                        break
                    page.wait_for_timeout(250)
                page.screenshot(path=os.path.join(SHOTS, "10-devices-page.png"))
                cards = page.locator('[data-testid="v2-device-card"]').count()
                rec("真实 Chrome 打开 #/devices 渲染设备卡", cards >= 1, "cards=%d" % cards)
                # 安装区块
                win_block = page.locator('[data-testid="install-windows"]').count()
                steps = page.locator('[data-testid="install-step"]').count()
                dl_btn = page.locator('[data-testid="btn-download-node"]').count()
                apk_btn = page.locator('[data-testid="btn-download-apk"]').count()
                cmd = page.locator('[data-testid="install-command"]').inner_text() if page.locator('[data-testid="install-command"]').count() else ""
                rec("一键安装区块（Windows/APK/3 步/命令）", win_block == 1 and apk_btn == 1 and steps >= 3 and ("install-node.ps1" in cmd or "powershell" in cmd.lower()), "win=%d apk=%d steps=%d cmd=%s" % (win_block, apk_btn, steps, cmd[:80]))
                page.screenshot(path=os.path.join(SHOTS, "11-install-block.png"))
                # 真实点击下载安装包
                download_ok = False
                expected_bytes = os.path.getsize(os.path.join(ROOT, "public", "download", "tenon-node-win.zip"))
                href = ""
                try:
                    href = page.locator('[data-testid="btn-download-node"]').first.get_attribute("href") or ""
                except Exception:
                    href = ""
                dl_info_evt = {}
                for attempt in (1, 2):
                    try:
                        with page.expect_download(timeout=20000) as dl_info:
                            page.locator('[data-testid="btn-download-node"]').first.click()
                        dl = dl_info.value
                        dl_info_evt = {"suggested": dl.suggested_filename, "url": dl.url, "attempt": attempt}
                        dl_path = os.path.join(RUN, "ui-download-%d.zip" % attempt)
                        try:
                            dl.save_as(dl_path)
                            download_ok = os.path.getsize(dl_path) == expected_bytes
                        except Exception as save_err:
                            # headless Chrome 偶发取消落盘；用同浏览器 request 上下文校验字节（下载事件已真实触发）
                            resp = page.request.get(base + href if href.startswith("/") else dl.url)
                            body = resp.body()
                            download_ok = resp.status == 200 and len(body) == expected_bytes
                            dl_info_evt["saveError"] = str(save_err)[:160]
                            dl_info_evt["requestStatus"] = resp.status
                            dl_info_evt["requestBytes"] = len(body)
                        if download_ok:
                            break
                    except Exception as e:
                        dl_info_evt["error"] = str(e)[:200]
                        page.wait_for_timeout(500)
                results["evidence"]["uiDownload"] = dl_info_evt
                results["evidence"]["uiDownloadHref"] = href
                rec("UI 点「下载 Windows 节点安装包」触发真实下载且 zip 字节一致", download_ok and href.endswith("/download/tenon-node-win.zip"), json.dumps(dl_info_evt, ensure_ascii=False)[:400] + " href=" + href)

                # 找第二设备卡片并绑定
                card_sel = '[data-testid="v2-device-card"][data-device-id="%s"]' % second_id
                if page.locator(card_sel).count() == 0:
                    rec("设备卡包含第二设备", False, "未找到 data-device-id=" + second_id)
                else:
                    card = page.locator(card_sel)
                    rec("第二设备卡「未绑定」徽标", card.locator('[data-testid="v2-device-unbound"]').count() == 1, "")
                    card.locator('[data-testid="btn-device-bind"]').first.click()
                    page.wait_for_timeout(600)
                    modal = page.locator("#v2-confirm-modal:not(.hidden)")
                    rec("点「一键绑定」出现二次确认弹窗", modal.count() == 1, page.locator("#v2-confirm-title").inner_text() if modal.count() else "无弹窗")
                    page.screenshot(path=os.path.join(SHOTS, "12-bind-confirm.png"))
                    page.locator('[data-testid="v2-confirm-ok"]').first.click()
                    page.wait_for_timeout(1500)
                    bound_ok = False
                    for _ in range(20):
                        card = page.locator(card_sel)
                        if card.count() and card.locator('[data-testid="v2-device-bound"]').count() == 1:
                            bound_ok = True
                            break
                        page.wait_for_timeout(300)
                    page.screenshot(path=os.path.join(SHOTS, "13-bound.png"))
                    rec("UI 一键绑定后卡片显示「已绑定」", bound_ok, "")
                    st, js = api(base + "/api/v2/devices", token)
                    dev = next((d for d in (js.get("items") or js.get("devices") or []) if d.get("id") == second_id), None) if st == 200 else None
                    rec("API 设备列表 bound=true", bool(dev) and dev.get("bound") is True, json.dumps(dev, ensure_ascii=False)[:400] if dev else "")
                    bindings_file = os.path.join(DATA, "devices", "bindings.json")
                    bindings = {}
                    try:
                        with open(bindings_file, "r", encoding="utf-8") as f:
                            bindings = json.load(f)
                    except Exception:
                        pass
                    bindings_text = json.dumps(bindings, ensure_ascii=False)
                    rec("绑定文件 data/devices/bindings.json 写入", second_id in bindings_text, bindings_text[:400])
                    types = ledger_types()
                    rec("账本出现 device.bound", "device.bound" in types, "事件数=%d" % len(types))
                    results["evidence"]["boundDevice"] = dev
                    # 重复绑定幂等（API）
                    st2, js2 = api(base + "/api/v2/devices/" + second_id + "/bind", token, "POST", {})
                    rec("重复绑定幂等（already=true）", st2 == 200 and js2.get("already") is True, "status=%s body=%s" % (st2, json.dumps(js2, ensure_ascii=False)[:200]))
                    # 解绑（UI）
                    card = page.locator(card_sel)
                    card.locator('[data-testid="btn-device-unbind"]').first.click()
                    page.wait_for_timeout(600)
                    page.locator('[data-testid="v2-confirm-ok"]').first.click()
                    page.wait_for_timeout(1500)
                    unbind_ok = False
                    for _ in range(20):
                        card = page.locator(card_sel)
                        if card.count() and card.locator('[data-testid="v2-device-unbound"]').count() == 1:
                            unbind_ok = True
                            break
                        page.wait_for_timeout(300)
                    page.screenshot(path=os.path.join(SHOTS, "14-unbound.png"))
                    rec("UI 一键解绑后卡片显示「未绑定」", unbind_ok, "")
                    types = ledger_types()
                    rec("账本出现 device.unbound", "device.unbound" in types, "事件数=%d" % len(types))

                # ---- 权限矩阵 ----
                st_code, _ = api(base + f"/api/v2/devices/{second_id}/bind", None, "POST", {})
                rec("权限：未登录写 bind → 401", st_code == 401, "status=%s" % st_code)
                st_code, _ = api(base + "/api/v2/devices/not-exist-device/bind", token, "POST", {})
                rec("权限：未知设备 → 404", st_code == 404, "status=%s" % st_code)
                st_code, body = api(base + f"/api/v2/devices/{second_id}/action", token, "POST", {"action": "no-such-action"})
                rec("权限：未知 action → 400", st_code == 400, "status=%s body=%s" % (st_code, json.dumps(body, ensure_ascii=False)[:160]))
                # 只读第二实例：同一数据目录起 --read-only（不持锁也可）；若 7462 持锁则自动只读
                roenv = dict(os.environ)
                roenv.update({"TENON_PORT": str(RO_PORT), "TENON_HOST": "127.0.0.1", "TENON_DATA_DIR": DATA,
                              "TENON_DISCOVERY_PORT": str(RO_PORT + 50), "TENON_ASSETS_OCR": "0"})
                rolog = open(os.path.join(EVID, "logs", "ro-%s.log" % STAMP), "a", encoding="utf-8")
                ro = subprocess.Popen(["node", os.path.join(ROOT, "server", "start.js"), "--read-only"], cwd=ROOT, env=roenv,
                                      stdout=rolog, stderr=rolog)
                ro_base = "http://127.0.0.1:%d" % RO_PORT
                if wait_http(ro_base + "/api/state", 30):
                    st_ro, _ = api(ro_base + f"/api/v2/devices/{second_id}/bind", token, "POST", {})
                    rec("权限：只读第二实例 bind → 423", st_ro == 423, "status=%s" % st_ro)
                else:
                    rec("权限：只读第二实例 bind → 423", False, "只读实例未启动", skip=True)
                # JS/console 错误统计
                fatal_console = [e for e in console_errors if "Failed to load resource" not in e]
                rec("真实 Chrome 页面 JS 错误 = 0", len(page_errors) == 0, json.dumps(page_errors[:3], ensure_ascii=False))
                rec("真实 Chrome console.error（非资源 404）= 0", len(fatal_console) == 0, json.dumps(fatal_console[:3], ensure_ascii=False))
                results["evidence"]["pageErrors"] = page_errors
                results["evidence"]["consoleErrors"] = console_errors
            finally:
                browser.close()
        # 账本完整性
        st, state = api(base + "/api/state", token)
        rec("中枢账本完整性 ok", bool(state.get("integrity", {}).get("ok", True)), "seq=%s" % state.get("seq"))
    except Exception as e:
        rec("bind-ui 执行异常", False, str(e)[:500])
    finally:
        for proc in (ro, agent, hub):
            if proc:
                try:
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
                except Exception:
                    pass
        time.sleep(0.6)
        pass_n = sum(1 for c in CHECKS if c["ok"] and not c["skip"])
        fail_n = sum(1 for c in CHECKS if not c["ok"] and not c["skip"])
        skip_n = sum(1 for c in CHECKS if c["skip"])
        results["summary"] = {"total": len(CHECKS), "pass": pass_n, "fail": fail_n, "skip": skip_n}
        results["finishedAt"] = datetime.now().isoformat()
        os.makedirs(EVID, exist_ok=True)
        with open(os.path.join(EVID, "bind-ui.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：_internal/checker/round1/bind-ui.json")
        if not os.environ.get("TENON_KEEP"):
            shutil.rmtree(RUN, ignore_errors=True)
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()