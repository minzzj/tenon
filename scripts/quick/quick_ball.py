#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""榫卯 · 桌面悬浮快捷录音球（无需 Electron 的轻量实现）

- 常驻桌面右下角（置顶、无边框、可拖动的小圆球）
- 点一下 = 立即录音（无需唤醒词）→ 本地识别 → AI 直接执行（不是总结）→ 气泡显示识别文字/回复；再点结束
- 全局快捷键：MediaPlayPause（蓝牙耳机播放/暂停键）+ Ctrl+Alt+Space 同样触发
- 随中枢退出而自动关闭（轮询失败 60s 退出）；单实例
"""
import json, os, sys, threading, time, ctypes, tkinter as tk
from urllib import request as urlrequest

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
HUB = os.environ.get("TENON_HUB_URL") or "http://127.0.0.1:7410"
PID_FILE = os.path.join(ROOT, "data", "quick", "ball.pid")

def read_token():
    tok = os.environ.get("TENON_TOKEN") or ""
    if tok:
        return tok
    try:
        base = os.environ.get("TENON_DATA_DIR") or os.path.join(ROOT, "data")
        return json.load(open(os.path.join(base, "secrets.json"), encoding="utf-8")).get("operatorToken", "")
    except Exception:
        return ""

TOKEN = read_token()

def api(method, path, body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urlrequest.Request(HUB + path, data=data, method=method,
                             headers={"Content-Type": "application/json", "x-tenon-token": TOKEN})
    try:
        with urlrequest.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}

class Ball:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("榫卯快捷录音")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        try: self.root.attributes("-alpha", 0.94)
        except Exception: pass
        self.root.configure(bg="#0b0f14")
        w, h = 230, 150
        sw = self.root.winfo_screenwidth(); sh = self.root.winfo_screenheight()
        self.root.geometry("%dx%d+%d+%d" % (w, h, sw - w - 24, sh - h - 64))
        self.phase = "idle"; self.active = False; self.said = ""; self.reply = ""; self.busy = False
        self.hub_fail = 0; self.drag = None
        # 气泡
        self.bubble = tk.Label(self.root, text="", bg="#101823", fg="#dbe7f3", font=("Microsoft YaHei", 9),
                               justify="left", wraplength=210, padx=8, pady=6, bd=0, relief="flat")
        self.bubble.place(x=8, y=6, width=214, height=56)
        self.bubble.place_forget()
        # 圆球
        self.canvas = tk.Canvas(self.root, width=92, height=92, bg="#0b0f14", highlightthickness=0, bd=0)
        self.canvas.place(x=4, y=52)
        self.orb = self.canvas.create_oval(4, 4, 88, 88, fill="#12518f", outline="#5aaaff", width=2)
        self.icon = self.canvas.create_text(46, 34, text="🎙", fill="#ffffff", font=("Segoe UI Emoji", 22))
        self.label = self.canvas.create_text(46, 70, text="点我说话", fill="#dbe7f3", font=("Microsoft YaHei", 9))
        self.tip = tk.Label(self.root, text="耳机键 / Ctrl+Alt+空格", bg="#0b0f14", fg="#7f93a8", font=("Microsoft YaHei", 8))
        self.tip.place(x=100, y=118)
        self.root.bind("<ButtonPress-1>", self.on_press)
        self.root.bind("<B1-Motion>", self.on_drag)
        self.root.bind("<ButtonRelease-1>", self.on_release)
        # 只保留 root 绑定：事件会从 canvas 冒泡到 root，重复绑定会导致单击触发 start+stop 两个动作
        self.root.bind("<Button-3>", self.on_right_click)
        threading.Thread(target=self.hotkey_loop, daemon=True).start()
        threading.Thread(target=self.poll_loop, daemon=True).start()
        self.render()
        self.root.mainloop()

    # ---------- 交互 ----------
    def on_press(self, e):
        self.drag = (e.x_root, e.y_root, self.root.winfo_x(), self.root.winfo_y())

    def on_drag(self, e):
        if not self.drag: return
        x0, y0, wx, wy = self.drag
        self.root.geometry("+%d+%d" % (wx + e.x_root - x0, wy + e.y_root - y0))

    def on_release(self, e):
        moved = False
        if self.drag:
            dx = abs(e.x_root - self.drag[0]); dy = abs(e.y_root - self.drag[1])
            moved = dx > 4 or dy > 4
            self.drag = None
        if not moved:
            self.toggle()

    def on_right_click(self, e):
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="隐藏 10 分钟", command=self.hide_temporarily)
        menu.add_command(label="退出悬浮球", command=self.quit)
        try: menu.tk_popup(e.x_root, e.y_root)
        finally: menu.grab_release()

    def hide_temporarily(self):
        self.root.withdraw()
        self.root.after(600000, self.root.deiconify)

    def quit(self):
        try: os.remove(PID_FILE)
        except Exception: pass
        try: self.root.destroy()
        except Exception: pass
        os._exit(0)

    def toggle(self):
        if self.busy: return
        self.busy = True
        try:
            if self.active:
                api("POST", "/api/v2/voice/quick/stop", {})
                self.active = False; self.phase = "idle"; self.reply = ""
            else:
                self.active = True; self.phase = "thinking"; self.said = ""; self.reply = ""
                self.render()
                r = api("POST", "/api/v2/voice/quick/start", {}, timeout=90)
                if not r.get("ok"):
                    self.active = False; self.phase = "idle"
                    self.reply = r.get("error") or "语音引擎还没准备好，请稍等几秒再点"
                    self.root.after(3500, self.clear_reply)
                else:
                    self.phase = "listening"
        finally:
            self.busy = False
            self.render()

    def clear_reply(self):
        if not self.active:
            self.reply = ""; self.render()

    # ---------- 热键 ----------
    def hotkey_loop(self):
        user32 = ctypes.windll.user32
        try:
            ok1 = user32.RegisterHotKey(None, 1, 0, 0xB3)  # MediaPlayPause
            ok2 = user32.RegisterHotKey(None, 2, 0x0002 | 0x0001, 0x20)  # Ctrl+Alt+Space
        except Exception:
            return
        msg = ctypes.wintypes.MSG() if hasattr(ctypes, "wintypes") else None
        try:
            import ctypes.wintypes as wt
            msg = wt.MSG()
        except Exception:
            return
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            if msg.message == 0x0312:  # WM_HOTKEY
                try: self.toggle()
                except Exception: pass
            user32.TranslateMessage(ctypes.byref(msg)); user32.DispatchMessageW(ctypes.byref(msg))

    # ---------- 状态轮询 ----------
    def poll_loop(self):
        while True:
            time.sleep(1.0)
            try:
                st = api("GET", "/api/v2/voice/status", timeout=5)
            except Exception:
                st = {}
            if not st or st.get("ok") is False:
                self.hub_fail += 1
                if self.hub_fail > 60:
                    self.quit()
                continue
            self.hub_fail = 0
            state = st.get("state") or "idle"
            self.active = state in ("session", "reply") or bool(st.get("busy"))
            if self.active:
                self.phase = "listening" if state == "session" else ("thinking" if st.get("busy") else "speaking")
            elif self.phase != "listening":
                if self.phase in ("speaking", "thinking"):
                    self.phase = "idle"
            lt = st.get("lastTranscript") or {}
            if lt.get("text") and lt.get("source") == "mic":
                self.said = lt.get("text") or ""
            lr = st.get("lastReply") or {}
            if lr.get("text"):
                self.reply = lr.get("text") or ""
                if state not in ("session",):
                    self.phase = "speaking"
                    self.root.after(8000, self.clear_reply)
            self.root.after(0, self.render)

    # ---------- 渲染 ----------
    def render(self):
        try:
            color = {"idle": ("#12518f", "#5aaaff"), "listening": ("#a11d1d", "#ff7070"),
                     "thinking": ("#8a5a10", "#ffc45c"), "speaking": ("#0f6b4b", "#5cf0b4")}.get(self.phase, ("#12518f", "#5aaaff"))
            self.canvas.itemconfig(self.orb, fill=color[0], outline=color[1])
            label = {"idle": "点我说话", "listening": "正在听…", "thinking": "理解中…", "speaking": "已执行"}.get(self.phase, "点我说话")
            self.canvas.itemconfig(self.label, text=label)
            self.canvas.itemconfig(self.icon, text={"idle": "🎙", "listening": "🔴", "thinking": "⏳", "speaking": "🔊"}.get(self.phase, "🎙"))
            text = ""
            if self.phase == "listening" and self.said: text = "听到：" + self.said
            elif self.reply: text = "榫卯：" + self.reply
            elif self.said: text = "你说：" + self.said
            if text:
                self.bubble.config(text=text[:120]); self.bubble.place(x=8, y=6, width=214, height=56)
            else:
                self.bubble.place_forget()
        except Exception:
            pass

if __name__ == "__main__":
    os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
    try:
        if os.path.exists(PID_FILE):
            old = int(open(PID_FILE).read().strip() or 0)
            import psutil
            if old and psutil.pid_exists(old):
                print("already running", old); sys.exit(0)
    except Exception:
        pass
    try: open(PID_FILE, "w").write(str(os.getpid()))
    except Exception: pass
    Ball()
