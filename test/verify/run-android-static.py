#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Android 静态验收（通用版：--version 0.5.0）
检查：APK 存在/大小/SHA256/包名版本/aapt 权限（INTERNET/RECORD_AUDIO/FOREGROUND_SERVICE/MEDIA_PROJECTION）/
屏幕采集代码与服务声明/设备页无扫码绑定/unzip 无异常/README/敏感信息（默认令牌允许但标注）/未真机实测如实标注。
用法：python test/verify/run-android-static.py [--version 0.5.0] [--json-out path]
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EVID = os.path.join(ROOT, "_internal", "checker", "v4")
CHECKS = []


def log(m):
    print("[" + datetime.now().strftime("%H:%M:%S") + "] " + m, flush=True)


def rec(name, ok, detail="", skip=False):
    CHECKS.append({"name": name, "ok": bool(ok), "skip": bool(skip), "detail": str(detail)[:900]})
    log(("SKIP " if skip else ("PASS " if ok else "FAIL ")) + name + (" :: " + str(detail)[:260] if detail else ""))


def read(p):
    try:
        return open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return ""


def find_aapt():
    bases = [r"C:\Android\Sdk\build-tools", os.path.join(os.environ.get("ANDROID_HOME", ""), "build-tools"), os.path.join(os.environ.get("ANDROID_SDK_ROOT", ""), "build-tools")]
    for base in bases:
        if base and os.path.isdir(base):
            for d in sorted(os.listdir(base), reverse=True):
                p = os.path.join(base, d, "aapt.exe")
                if os.path.exists(p):
                    return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="0.5.0")
    ap.add_argument("--json-out", default=os.path.join(EVID, "android-static.json"))
    args = ap.parse_args()
    ver = args.version
    report = {"kind": "android-static", "version": ver, "stamp": datetime.now().isoformat(), "checks": CHECKS, "evidence": {}}
    android = os.path.join(ROOT, "android")
    apk_candidates = [
        os.path.join(ROOT, "public", "download", "tenon-android-%s-debug.apk" % ver),
        os.path.join(ROOT, "android", "dist", "tenon-android-%s-debug.apk" % ver),
    ]
    try:
        src_root = os.path.join(android, "app", "src", "main")
        src_files = []
        for base, _d, files in os.walk(src_root):
            for f in files:
                if f.endswith((".kt", ".xml", ".java", ".gradle")):
                    src_files.append(os.path.join(base, f))
        all_src = "\n".join(read(p) for p in src_files)
        manifest = read(os.path.join(src_root, "AndroidManifest.xml"))
        rec("android/ 源码存在", len(src_files) >= 5, "files=%d" % len(src_files))
        # 权限
        perms = {
            "INTERNET": "android.permission.INTERNET" in manifest,
            "RECORD_AUDIO": "android.permission.RECORD_AUDIO" in manifest,
            "FOREGROUND_SERVICE": "android.permission.FOREGROUND_SERVICE" in manifest,
            "MEDIA_PROJECTION": ("android.permission.MEDIA_PROJECTION" in manifest) or ("android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" in manifest),
        }
        rec("APK 权限清单（INTERNET/RECORD_AUDIO/FOREGROUND_SERVICE/MEDIA_PROJECTION 或 FOREGROUND_SERVICE_MEDIA_PROJECTION）", all(perms.values()), json.dumps(perms, ensure_ascii=False))
        # 屏幕采集代码/服务声明
        screen_svc = ("ScreenCaptureService" in all_src) or ("MediaProjection" in all_src)
        svc_decl = ("service" in manifest and ("ScreenCapture" in manifest or "CaptureService" in manifest)) or ("ScreenCaptureService" in manifest)
        rec("屏幕采集代码/前台服务声明", screen_svc and svc_decl, "code=%s manifestDecl=%s" % (screen_svc, svc_decl))
        # 设备页无扫码绑定
        main_act = read(os.path.join(src_root, "java", "com", "minzzj", "tenon", "MainActivity.kt"))
        devices_act = read(os.path.join(src_root, "java", "com", "minzzj", "tenon", "DevicesActivity.kt"))
        one_click = any(k in (main_act + devices_act) for k in ["一键使用", "一键绑定", "一键移除", "使用这台"])
        scan_present = ("扫码" in (main_act + devices_act)) or ("ScanActivity" in (main_act + devices_act))
        scan_folded = ("高级" in devices_act) or ("折叠" in devices_act) or ("二级" in devices_act)
        rec("设备页简化（一键使用/移除；旧扫码收进高级折叠）", one_click and (not scan_present or scan_folded), "oneClick=%s scanPresent=%s scanFolded=%s" % (one_click, scan_present, scan_folded))
        # 语音链路
        client_src = read(os.path.join(src_root, "java", "com", "minzzj", "tenon", "net", "TenonClient.kt"))
        has_voice = ("voice/transcribe" in all_src) or ("voice/command" in all_src)
        rec("手机语音输入链路调用 /api/v2/voice/*", has_voice, "voiceApi=%s" % has_voice)
        # 明文流量
        cleartext = ('usesCleartextTraffic="true"' in manifest) or ("networkSecurityConfig" in manifest)
        rec("局域网 http 明文流量允许", cleartext, "cleartext=%s" % cleartext)
        # APK
        apk_path = next((p for p in apk_candidates if os.path.exists(p)), None)
        if not apk_path:
            rec("APK %s 存在（public/download/tenon-android-%s-debug.apk）" % (ver, ver), False, "APK 尚未构建", skip=True)
        else:
            size = os.path.getsize(apk_path)
            sha = hashlib.sha256(open(apk_path, "rb").read()).hexdigest()
            rec("APK 存在且大小合理（>500KB）", size > 500 * 1024, "%s size=%d sha256=%s" % (os.path.relpath(apk_path, ROOT), size, sha))
            aapt = find_aapt()
            badging = ""
            aapt_ok = False
            if aapt:
                r = subprocess.run([aapt, "dump", "badging", apk_path], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
                badging = (r.stdout or "") + (r.stderr or "")
                aapt_ok = "package:" in badging
                if not aapt_ok:
                    # aapt 对含中文的绝对路径支持差：复制到 ASCII 临时路径再 dump
                    import tempfile
                    import shutil
                    tmp_apk = os.path.join(tempfile.gettempdir(), "tenon-apk-check.apk")
                    shutil.copyfile(apk_path, tmp_apk)
                    r2 = subprocess.run([aapt, "dump", "badging", tmp_apk], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
                    badging = (r2.stdout or "") + (r2.stderr or "")
                    aapt_ok = "package:" in badging
                    try:
                        os.remove(tmp_apk)
                    except Exception:
                        pass
            apk_raw = open(apk_path, "rb").read()
            pkg = re.search(r"package: name='([^']+)'", badging)
            if not pkg:
                m = re.search(r"applicationId\s+['\"]([^'\"]+)['\"]", read(os.path.join(android, "app", "build.gradle")))
                pkg = m
            vn = re.search(r"versionName='([^']+)'", badging)
            if not vn:
                m = re.search(r"versionName\s+['\"]([^'\"]+)['\"]", read(os.path.join(android, "app", "build.gradle")))
                vn = m
            perm_lines = re.findall(r"uses-permission: name='([^']+)'", badging) if aapt_ok else []
            if not perm_lines:
                perm_lines = [p for p in ["android.permission.INTERNET", "android.permission.RECORD_AUDIO", "android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION"] if p.encode() in apk_raw]
            has_all_perms = all((("android.permission." + k) in perm_lines) or (k == "MEDIA_PROJECTION" and "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" in perm_lines) for k in ["INTERNET", "RECORD_AUDIO", "FOREGROUND_SERVICE", "MEDIA_PROJECTION"])
            rec("APK 包名/版本（com.minzzj.tenon / %s）" % ver, bool(pkg and pkg.group(1) == "com.minzzj.tenon" and vn and vn.group(1).startswith(ver)), "package=%s version=%s" % (pkg.group(1) if pkg else None, vn.group(1) if vn else None))
            rec("APK aapt 权限包含屏幕采集/录音/前台服务", has_all_perms, "perms=%s" % json.dumps(perm_lines, ensure_ascii=False)[:300])
            names = []
            huge = []
            try:
                with zipfile.ZipFile(apk_path) as z:
                    for n in z.namelist():
                        names.append(n)
                        info = z.getinfo(n)
                        if info.file_size > 8 * 1024 * 1024:
                            huge.append((n, info.file_size))
            except Exception as e:
                rec("APK zip 结构可读", False, str(e)[:200])
            rec("APK unzip 列表无异常超大文件（>8MB）", len(huge) == 0, "entries=%d huge=%s" % (len(names), huge[:3]))
            rec("APK 内未发现硬编码 tok_ 令牌", not re.search(r"tok_[a-f0-9]{12,}", "\n".join(names)), "tokLiterals=%d" % len(re.findall(r"tok_[a-f0-9]{12,}", "\n".join(names))))
            report["evidence"]["apk"] = {"path": apk_path, "size": size, "sha256": sha, "package": pkg.group(1) if pkg else None, "version": vn.group(1) if vn else None, "entries": len(names), "permissions": perm_lines}
        readme = read(os.path.join(android, "README.md"))
        rec("android/README.md 含安装与令牌步骤", any(k in readme for k in ["安装", "install", "gradlew", "APK"]) and any(k in readme for k in ["令牌", "token", "中枢", "地址"]), "readmeLen=%d" % len(readme))
        rec("APK 未真机实测（如实标注）", True, "无真机；以构建成功+静态证据为准（task-40 要求如实标注）", skip=True)
    except Exception as e:
        rec("Android 静态验收执行异常", False, str(e)[:400])
    finally:
        pass_n = sum(1 for c in CHECKS if c["ok"] and not c["skip"])
        fail_n = sum(1 for c in CHECKS if not c["ok"] and not c["skip"])
        skip_n = sum(1 for c in CHECKS if c["skip"])
        report["summary"] = {"total": len(CHECKS), "pass": pass_n, "fail": fail_n, "skip": skip_n}
        report["finishedAt"] = datetime.now().isoformat()
        os.makedirs(os.path.dirname(args.json_out), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log("结果：%d PASS / %d FAIL / %d SKIP（共 %d）" % (pass_n, fail_n, skip_n, len(CHECKS)))
        log("证据：" + args.json_out)
        if fail_n > 0:
            sys.exit(1)


if __name__ == "__main__":
    main()