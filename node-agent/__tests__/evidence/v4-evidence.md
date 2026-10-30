# 榫卯 V4 · node-agent 执行器能力 · 真实中枢自测证据

- 时间：2026-10-30T11:39:07.245Z → 2026-10-30T11:39:27.844Z（20.6s）
- 中枢：http://127.0.0.1:7475（真实 server/start.js 隔离实例，未占 7410）
- 环境：win32 / Node v24.15.0 / Windows PowerShell 5.1
- 结论：**通过**（11/11 项通过）

## curl 调用示例（live 7410 同样适用）

```bash
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('data/secrets.json','utf8')).operatorToken)")
# 1) 执行命令 → 返回 {ok:true,queued:true,taskId}
curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d '{"type":"system.exec","payload":{"command":"dir"}}'
# 2) 查任务结果（result.data.stdout / exitCode / durationMs；result 里也有平铺字段）
curl -s "http://127.0.0.1:7410/api/v2/remote/node-local/task/<taskId>" -H "x-tenon-token: $TOKEN"
# 3) 窗口列表
curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d '{"type":"window.list","payload":{}}'
# 4) 聚焦窗口（按标题或进程名；失败返回可读 error）
curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d '{"type":"window.focus","payload":{"process":"notepad"}}'
# 5) 截屏（全屏省略 region；返回 PNG 路径+宽高，data/screen/ 下）
curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d '{"type":"screen.capture","payload":{"region":{"x":0,"y":0,"width":640,"height":480}}}'
```

> 前置：设备已绑定（`POST /api/v2/devices/node-local/bind`），node-agent 以新代码 + `TENON_V2=1` 启动。

| # | 检查项 | 结果 | 说明 |
|---|---|---|---|
| 1 | 真实中枢 /api/state 可见 20 项能力（含 V4 4 项） | ✅ 通过 | image.crop,file.hash,file.delete,printer.mock,system.open,system.volume,system.power,file.print,app.launch,url.open,media.show,handoff.show,app.list,input.mouse,input.key,input.media,system.exec,window.list,window.focus,screen.capture |
| 2 | 设备已绑定（remote/input 要求） | ✅ 通过 | 已绑定 |
| 3 | system.exec "dir" 真实执行（exitCode=0 + 目录内容） | ✅ 通过 | exit=0，stdout 1861 字符 |
| 4 | system.exec 中文回显正确（cmd GBK 输出解码） | ✅ 通过 | "榫卯V4中文回显_OK" |
| 5 | system.exec 危险词拒绝（shutdown） | ✅ 通过 | 命令被拒绝执行：命中危险操作黑名单「关机/重启」。如确需，请在电脑本地手动执行。 |
| 6 | window.list 枚举可见窗口（有数据） | ✅ 通过 | 20 个窗口；前台=上传视频到平台 - 豆包 / Doubao |
| 7 | window.focus 按进程名激活记事本 | ✅ 通过 | 无标题 - 记事本（notepad, PID 32888） |
| 8 | window.focus 失败返回可读错误 | ✅ 通过 | 未找到匹配的窗口；当前窗口示例：无标题 - 记事本 ｜ 上传视频到平台 - 豆包 ｜ QQ ｜ 下载 ｜ 现在把EXE里面的内容。，改成 — DeepSeek Harness 和另外 19 个页面 - 个人 - Microsoft​ Edge |
| 9 | screen.capture 全屏 PNG 非空 | ✅ 通过 | H:\minzzj文件\技术部\项目\官方\榫卯\_internal\nodeagent-v4-data\agent\screen\screen-20261030-193921-433.png · 2560×1440 · 335604 字节 |
| 10 | screen.capture 区域 640×480 PNG 非空 | ✅ 通过 | H:\minzzj文件\技术部\项目\官方\榫卯\_internal\nodeagent-v4-data\agent\screen\screen-20261030-193924-019.png · 640×480 · 28150 字节 |
| 11 | data/exec-audit.log 记录执行与拒绝 | ✅ 通过 | 6 行；dir 审计=true；拒绝审计=true |

## 原始数据

```json
{
  "hub": {
    "url": "http://127.0.0.1:7475",
    "healthModules": [
      "link",
      "assets",
      "things",
      "enterprise",
      "super",
      "devices",
      "remote",
      "voice",
      "agent"
    ],
    "operatorToken": "tok_7683c5…"
  },
  "register": {
    "nodeId": "node-local",
    "name": "V4 证据节点",
    "online": true,
    "capabilityCount": 20,
    "capabilities": [
      "image.crop",
      "file.hash",
      "file.delete",
      "printer.mock",
      "system.open",
      "system.volume",
      "system.power",
      "file.print",
      "app.launch",
      "url.open",
      "media.show",
      "handoff.show",
      "app.list",
      "input.mouse",
      "input.key",
      "input.media",
      "system.exec",
      "window.list",
      "window.focus",
      "screen.capture"
    ]
  },
  "bind": {
    "ok": true,
    "bound": null
  },
  "lastDispatch": {
    "type": "screen.capture",
    "payload": {
      "region": {
        "x": 0,
        "y": 0,
        "width": 640,
        "height": 480
      }
    },
    "dispatch": {
      "ok": true,
      "queued": true,
      "taskId": "task_mvuwgg8l466f1e11",
      "deviceId": "node-local",
      "type": "screen.capture",
      "summary": "截取屏幕区域 640×480",
      "at": "2026-10-30T11:39:23.061Z",
      "coalesced": false
    }
  },
  "execDir": {
    "taskId": "task_mvuwg53q4cdfa560",
    "status": "succeeded",
    "result": {
      "exitCode": 0,
      "durationMs": 28,
      "stdoutHead": [
        " 驱动器 H 中的卷是 minzzj",
        " 卷的序列号是 3055-F789",
        " H:\\minzzj文件\\技术部\\项目\\官方\\榫卯 的目录",
        "2026/10/25  16:13    <DIR>          .",
        "2026/10/25  16:13    <DIR>          ..",
        "2026/10/25  16:14           629,268 榫卯-产品愿景与实现要求.docx"
      ]
    }
  },
  "execChinese": {
    "taskId": "task_mvuwg5fe0fbf9305",
    "stdout": "榫卯V4中文回显_OK",
    "status": "succeeded"
  },
  "execDangerous": {
    "taskId": "task_mvuwg68b692aafca",
    "status": "failed",
    "error": "命令被拒绝执行：命中危险操作黑名单「关机/重启」。如确需，请在电脑本地手动执行。"
  },
  "windowList": {
    "taskId": "task_mvuwg7146c86f98c",
    "status": "succeeded",
    "count": 20,
    "foreground": {
      "handle": 8719524,
      "title": "上传视频到平台 - 豆包",
      "pid": 13468,
      "process": "Doubao",
      "foreground": true,
      "minimized": false
    },
    "sample": [
      {
        "handle": 8719524,
        "title": "上传视频到平台 - 豆包",
        "pid": 13468,
        "process": "Doubao",
        "foreground": true,
        "minimized": false
      },
      {
        "handle": 264552,
        "title": "计算器",
        "pid": 10360,
        "process": "ApplicationFrameHost",
        "foreground": false,
        "minimized": false
      },
      {
        "handle": 131668,
        "title": "计算器",
        "pid": 22660,
        "process": "CalculatorApp",
        "foreground": false,
        "minimized": false
      },
      {
        "handle": 135410,
        "title": "Cherry Studio",
        "pid": 25336,
        "process": "Cherry Studio",
        "foreground": false,
        "minimized": true
      },
      {
        "handle": 68216,
        "title": "ClawsGO Science",
        "pid": 18736,
        "process": "ClawsGO",
        "foreground": false,
        "minimized": true
      },
      {
        "handle": 1770516,
        "title": "管理员: Administrator:  C:\\WINDOWS\\system32\\cmd.exe ",
        "pid": 11964,
        "process": "cmd",
        "foreground": false,
        "minimized": false
      }
    ]
  },
  "notepadLaunch": {
    "taskId": "task_mvuwg86n0b1da24d",
    "status": "succeeded",
    "summary": "已打开「记事本」（进程已确认运行，PID 32888）"
  },
  "windowFocus": {
    "taskId": "task_mvuwgatf22386e9a",
    "status": "succeeded",
    "focused": {
      "handle": 1250488,
      "title": "无标题 - 记事本",
      "pid": 32888,
      "process": "notepad",
      "foreground": false,
      "minimized": false
    },
    "summary": "已切换到窗口：无标题 - 记事本（notepad，PID 32888）"
  },
  "windowFocusFail": {
    "taskId": "task_mvuwgcb12a7c22b7",
    "status": "failed",
    "error": "未找到匹配的窗口；当前窗口示例：无标题 - 记事本 ｜ 上传视频到平台 - 豆包 ｜ QQ ｜ 下载 ｜ 现在把EXE里面的内容。，改成 — DeepSeek Harness 和另外 19 个页面 - 个人 - Microsoft​ Edge"
  },
  "screenFull": {
    "taskId": "task_mvuwge9c75de1f27",
    "status": "succeeded",
    "path": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\nodeagent-v4-data\\agent\\screen\\screen-20261030-193921-433.png",
    "width": 2560,
    "height": 1440,
    "bytes": 335604
  },
  "screenRegion": {
    "taskId": "task_mvuwgg8l466f1e11",
    "status": "succeeded",
    "path": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\nodeagent-v4-data\\agent\\screen\\screen-20261030-193924-019.png",
    "width": 640,
    "height": 480,
    "bytes": 28150
  },
  "execAudit": {
    "file": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\nodeagent-v4-data\\agent\\exec-audit.log",
    "lines": 6,
    "hasDirAudit": true,
    "hasRejectedAudit": true,
    "sample": [
      {
        "at": "2026-10-30T11:39:20.384Z",
        "nodeId": "node-local",
        "taskId": "task_mvuwgdg2f22ad15f",
        "via": "node-agent",
        "command": "taskkill /IM notepad.exe /F",
        "cwd": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯",
        "timeoutMs": 15000,
        "ok": true,
        "exitCode": 0,
        "timeout": false,
        "durationMs": 114,
        "stdoutPreview": "成功: 已终止进程 \"notepad.exe\"，其 PID 为 32888。\r\n",
        "stderrPreview": "",
        "error": null
      },
      {
        "at": "2026-10-30T11:39:22.998Z",
        "nodeId": "node-local",
        "taskId": "task_mvuwge9c75de1f27",
        "via": "node-agent",
        "action": "screen.capture",
        "path": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\nodeagent-v4-data\\agent\\screen\\screen-20261030-193921-433.png",
        "width": 2560,
        "height": 1440,
        "bytes": 335604,
        "ok": true
      },
      {
        "at": "2026-10-30T11:39:27.403Z",
        "nodeId": "node-local",
        "taskId": "task_mvuwgg8l466f1e11",
        "via": "node-agent",
        "action": "screen.capture",
        "path": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\nodeagent-v4-data\\agent\\screen\\screen-20261030-193924-019.png",
        "width": 640,
        "height": 480,
        "bytes": 28150,
        "ok": true
      }
    ]
  },
  "curlExamples": [
    "TOKEN=<data/secrets.json 的 operatorToken>",
    "curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H \"x-tenon-token: $TOKEN\" -H \"Content-Type: application/json\" -d \"{\\\"type\\\":\\\"system.exec\\\",\\\"payload\\\":{\\\"command\\\":\\\"dir\\\"}}\"",
    "curl -s http://127.0.0.1:7410/api/v2/remote/node-local/task/<taskId> -H \"x-tenon-token: $TOKEN\"",
    "curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H \"x-tenon-token: $TOKEN\" -H \"Content-Type: application/json\" -d \"{\\\"type\\\":\\\"window.list\\\",\\\"payload\\\":{}}\"",
    "curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H \"x-tenon-token: $TOKEN\" -H \"Content-Type: application/json\" -d \"{\\\"type\\\":\\\"window.focus\\\",\\\"payload\\\":{\\\"process\\\":\\\"notepad\\\"}}\"",
    "curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H \"x-tenon-token: $TOKEN\" -H \"Content-Type: application/json\" -d \"{\\\"type\\\":\\\"screen.capture\\\",\\\"payload\\\":{\\\"region\\\":{\\\"x\\\":0,\\\"y\\\":0,\\\"width\\\":640,\\\"height\\\":480}}}\""
  ]
}
```

日志：`node-agent/__tests__/evidence/agent.log`、`hub.log`