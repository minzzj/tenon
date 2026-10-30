# scripts/voice · 榫卯 V3 本地语音/模型 worker

| 文件 | 作用 | 用法 |
|---|---|---|
| `asr_worker.py` | 常驻中文语音识别（FunASR SenseVoice 优先，Windows SR 兜底） | `--file x.wav` 一次性识别输出 JSON；`--mic` 持续输出 JSONL partial/final |
| `llm_worker.py` | 本地小模型（Qwen2.5 GGUF，llama-cpp-python）常驻服务 | stdin/stdout 每行 JSON |
| `speak.ps1` | Windows SAPI 中文 TTS（可存 WAV） | `-Text "..." [-OutFile x.wav]` |
| `transcribe.ps1` | Windows SR 兜底识别 | `-Wav x.wav` |

契约（Node `server/lib/voice/` 依赖）：
- ASR `--file`：stdout 单行 JSON `{ok,text,confidence,provider,ms}`
- ASR `--mic`：stdout JSONL `{type:"partial"|"final",text,ts,provider}`（final 每段一行）
- LLM：stdin `{id,messages,max_tokens,temperature}` → stdout `{id,ok,text,provider,model,ms}`；启动时输出 `{type:"ready",provider,model}`
- 所有 worker 只在 127.0.0.1/本机子进程运行，不上传任何数据。
