#!/usr/bin/env python3
"""手机端真实链路 E2E（Lead 验收）：/m 页面用手机风格录音（Chromium fake audio 文件循环播放真实 TTS 音频）
→ POST /api/v2/voice/transcribe → /api/v2/voice/command → 检查 UI 卡片/回复/错误。
用法: python test/verify/run-phone-e2e.py [--base http://127.0.0.1:7410] [--audio models/tts-test.wav]
"""
import argparse, json, os, sys, time
from playwright.sync_api import sync_playwright

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:7410")
    ap.add_argument("--audio", default="models/tts-test.wav")
    args = ap.parse_args()
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    audio = os.path.abspath(os.path.join(root, args.audio))
    token = json.load(open(os.path.join(root, "data", "secrets.json"), encoding="utf-8"))["operatorToken"]
    results = []
    def rec(name, ok, detail=""):
        results.append((name, ok, detail)); print(("PASS " if ok else "FAIL ") + name + (" | " + str(detail)[:300] if detail else ""))
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--use-file-for-fake-audio-capture=" + audio,
            "--autoplay-policy=no-user-gesture-required",
        ])
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                                  user_agent="Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36")
        page = ctx.new_page()
        js_errors = []
        page.on("pageerror", lambda e: js_errors.append(str(e)))
        reqs = []
        page.on("request", lambda r: reqs.append(r.url))
        page.goto(args.base + "/m", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        page.evaluate("t => localStorage.setItem('tenon:token', t)", token)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        rec("页面加载 /m", page.locator("body").count() == 1)
        btn = page.locator("#pv-btn")
        rec("手机语音按钮存在", btn.count() == 1)
        rec("phone-voice.js 已加载", page.evaluate("() => !!window.TenonPhoneVoice"))
        # 开始录音 2.5s 后停止（fake audio 文件在循环播放真实 TTS 语音）
        btn.click()
        page.wait_for_timeout(2500)
        rec("录音已开始（按钮红态）", page.locator("#pv-btn[data-recording='1']").count() == 1)
        btn.click()
        # 等待 transcribe+command 完成（模型加载可能 10-30s）
        ok_trans = False
        for i in range(40):
            page.wait_for_timeout(1500)
            card = page.locator("#phone-voice-card")
            if card.count() and card.is_visible():
                txt = card.inner_text()
                if ("识别" in txt and "中…" not in txt) or "没听清" in txt or "已执行" in txt or "需要你确认" in txt or "部分未完成" in txt:
                    ok_trans = True; break
        card_txt = page.locator("#phone-voice-card").inner_text() if page.locator("#phone-voice-card").count() else ""
        rec("语音链路返回结果（识别/执行/确认任一）", ok_trans, card_txt[:300])
        trans = [u for u in reqs if "/voice/transcribe" in u]
        cmds = [u for u in reqs if "/voice/command" in u]
        rec("真实调用 transcribe", len(trans) >= 1, trans[:2])
        rec("真实调用 command", len(cmds) >= 1, cmds[:2])
        # 页面无旧 Web Speech 报错（不再出现“语音识别不可用”）
        body_txt = page.locator("body").inner_text()
        rec("无旧版「语音识别不可用」提示", "语音识别不可用" not in body_txt)
        rec("无 JS 异常", len(js_errors) == 0, js_errors[:3])
        os.makedirs(os.path.join(root, "_internal", "checker", "round5"), exist_ok=True)
        page.screenshot(path=os.path.join(root, "_internal", "checker", "round5", "phone-e2e.png"))
        browser.close()
    passed = sum(1 for _, ok, _ in results if ok)
    print("\nRESULT %d/%d PASS" % (passed, len(results)))
    json.dump([{ "name": n, "ok": o, "detail": d} for n, o, d in results],
              open(os.path.join(root, "_internal", "checker", "round5", "phone-e2e.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return 0 if passed == len(results) else 1

if __name__ == "__main__":
    sys.exit(main())
