#!/usr/bin/env python3
"""榫卯 V3 · 本地小模型 worker（Qwen2.5 GGUF via llama-cpp-python）

协议：
  stdin  每行一个 JSON: {"id":1,"messages":[{"role":"user","content":"..."}],"max_tokens":256,"temperature":0.2}
  stdout 每行一个 JSON: {"id":1,"ok":true,"text":"...","provider":"local-qwen2.5-0.5b","ms":123}
        错误时: {"id":1,"ok":false,"error":"..."}
启动参数：
  --model <gguf路径>   默认 models/llm/qwen2.5-0.5b-instruct-q4_k_m.gguf（不存在则尝试 C:\TenonModels\...）
  --threads N          默认 8
  --ctx N              默认 2048
"""
import argparse, json, os, sys, time, threading
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def pick_model(arg):
    candidates = [arg] if arg else []
    candidates += [
        os.path.join("models", "llm", "qwen2.5-0.5b-instruct-q4_k_m.gguf"),
        r"C:\TenonModels\qwen2.5-0.5b-instruct-q4_k_m.gguf",
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return os.path.abspath(c)
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--ctx", type=int, default=2048)
    args = ap.parse_args()
    try:
        from llama_cpp import Llama
    except Exception as e:
        print(json.dumps({"type": "error", "error": "llama_cpp 不可用: %s" % e}, ensure_ascii=False), flush=True)
        return 1
    path = pick_model(args.model)
    if not path:
        print(json.dumps({"type": "error", "error": "找不到 GGUF 模型文件"}, ensure_ascii=False), flush=True)
        return 1
    log("[llm_worker] loading", path)
    llm = Llama(model_path=path, n_ctx=args.ctx, n_threads=args.threads, verbose=False)
    model_name = os.path.basename(path)
    print(json.dumps({"type": "ready", "provider": "local-qwen", "model": model_name}, ensure_ascii=False), flush=True)
    lock = threading.Lock()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            messages = req.get("messages") or [{"role": "user", "content": str(req.get("prompt", ""))}]
            t0 = time.time()
            with lock:
                out = llm.create_chat_completion(
                    messages=messages,
                    max_tokens=int(req.get("max_tokens") or 256),
                    temperature=float(req.get("temperature") if req.get("temperature") is not None else 0.2),
                )
            text = (out.get("choices") or [{}])[0].get("message", {}).get("content", "")
            print(json.dumps({"id": rid, "ok": True, "text": text, "provider": "local-qwen", "model": model_name,
                              "ms": int((time.time() - t0) * 1000)}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"id": rid, "ok": False, "error": str(e)[:400]}, ensure_ascii=False), flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
