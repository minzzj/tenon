# 榫卯 v2-P0 桌面端 Agent · 本机实测证据

- 时间：2026-10-25T14:41:26.631Z → 2026-10-25T14:41:35.819Z（耗时 9.2s）
- 环境：win32 / Node v24.15.0 / PowerShell 5.1
- 结论：**通过**（20/20 项通过，失败 0 项）

| # | 检查项 | 结果 | 说明 |
|---|---|---|---|
| 1 | PowerShell 写本机剪贴板 | ✅ 通过 | 31 字 |
| 2 | PowerShell 读回本机剪贴板 | ✅ 通过 | 内容一致 |
| 3 | 本机剪贴板变化上报中枢 /api/v2/link/clipboard | ✅ 通过 | kind=text from=node-local |
| 4 | 中枢最新剪贴板写回本机（手机→电脑） | ✅ 通过 | PowerShell 回读一致 |
| 5 | 防止剪贴板回环（写回内容不再上报） | ✅ 通过 | 额外上报 0 条 |
| 6 | 扫描示例空间/样品图 | ✅ 通过 | 发现 10 个文件 |
| 7 | 调用 POST /api/v2/assets/ingest 入库（stub 接收） | ✅ 通过 | 入库 5 个，stub 收到 5 条 |
| 8 | system.open 真实打开文件 | ✅ 通过 | 已打开文件：H:\minzzj文件\技术部\项目\官方\榫卯\_internal\v2-desktop-data\open\榫卯-打开动作证据.txt |
| 9 | system.volume 真实执行（静音/恢复各 1 次） | ✅ 通过 | 已执行：切换静音（P0 近似实现：按键级音量控制，绝对值需 P1 CoreAudio） / 已执行：切换静音（P0 近似实现：按键级音量控制，绝对值需 P1 CoreAudio） |
| 10 | system.power 默认禁用 + 双闸后演练 | ✅ 通过 | system.power 默认禁用：设置环境变量 TENON_ALLOW_POWER=1 并在 params.confirm=true 后才允许执行｜（演练）已模拟电源动作：shutdown（TENON_POWER_DRYRUN=1，未真正执行） |
| 11 | file.print 真实调用系统打印动词 | ✅ 通过 | 已向系统默认打印机发起打印：示例空间/样品图/样品01.png × 1 份（打印为不可逆动作） |
| 12 | Windows 通知通道探测 | ✅ 通过 | method=winrt |
| 13 | 节点注册上报 13 项能力（4 基础 + 4 受控动作 + 5 超级终端动作） | ✅ 通过 | image.crop,file.hash,file.delete,printer.mock,system.open,system.volume,system.power,file.print,app.launch,url.open,media.show,handoff.show,app.list |
| 14 | 节点心跳上报 | ✅ 通过 | nodeId=node-local |
| 15 | agent 后台把本机剪贴板上报中枢 | ✅ 通过 | v2agent 本机复制 1792939293437 中文 |
| 16 | agent 把手机剪贴板写回本机（PowerShell 回读一致） | ✅ 通过 | v2agent 手机发来 1792939294059 写回 |
| 17 | 入站文件落盘 示例空间/接收/ 且 sha256 校验通过并 ack | ✅ 通过 | H:\minzzj文件\技术部\项目\官方\榫卯\_internal\v2-desktop-data\receive\手机截图证据.png |
| 18 | 任务链路 task.step → task.succeeded | ✅ 通过 | （演练）已执行：切换静音 |
| 19 | SSE notification.relayed → 本机通知镜像 | ✅ 通过 | agent.log 出现「手机通知证据」 |
| 20 | 关闭 stdin 后优雅退出（exit code 0） | ✅ 通过 | code=0 signal= |

## 原始数据

```json
{
  "clipboard": {
    "writeLocal": {
      "ok": true,
      "error": null
    },
    "readBack": {
      "ok": true,
      "text": "电脑→中枢 剪贴板 1792939286884 中文与符号 ✓",
      "match": true
    },
    "report": {
      "syncOk": true,
      "reported": true,
      "kind": "text",
      "from": "node-local"
    },
    "hubToLocal": {
      "applied": true,
      "readBack": "手机→电脑 剪贴板 1792939287576 来自 Android",
      "match": true
    },
    "noEcho": {
      "extraPosts": 0
    }
  },
  "files": {
    "scan": {
      "dir": "示例空间/样品图",
      "total": 10,
      "truncated": false,
      "kinds": [
        "image"
      ]
    },
    "ingest": {
      "ok": true,
      "ingested": 5,
      "failed": 0,
      "stubReceived": 5,
      "sample": [
        {
          "deviceId": "node-local",
          "path": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\示例空间\\样品图\\样品01.png"
        },
        {
          "deviceId": "node-local",
          "path": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\示例空间\\样品图\\样品02.png"
        }
      ]
    }
  },
  "actions": {
    "open": {
      "target": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\open\\榫卯-打开动作证据.txt",
      "summary": "已打开文件：H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\open\\榫卯-打开动作证据.txt",
      "newProcesses": [
        "code"
      ]
    },
    "volume": {
      "mute": "已执行：切换静音（P0 近似实现：按键级音量控制，绝对值需 P1 CoreAudio）",
      "restore": "已执行：切换静音（P0 近似实现：按键级音量控制，绝对值需 P1 CoreAudio）",
      "note": "P0 近似：按键级音量控制，无法回读当前音量（绝对值 P1 CoreAudio）"
    },
    "power": {
      "denied": "system.power 默认禁用：设置环境变量 TENON_ALLOW_POWER=1 并在 params.confirm=true 后才允许执行",
      "dryrun": "（演练）已模拟电源动作：shutdown（TENON_POWER_DRYRUN=1，未真正执行）"
    },
    "print": {
      "ok": true,
      "summary": "已向系统默认打印机发起打印：示例空间/样品图/样品01.png × 1 份（打印为不可逆动作）",
      "error": null
    }
  },
  "notification": {
    "ok": true,
    "method": "winrt",
    "error": null
  },
  "agent": {
    "register": {
      "nodeId": "node-local",
      "name": "证据节点",
      "capabilityCount": 13,
      "capabilityIds": [
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
        "app.list"
      ]
    },
    "heartbeat": {
      "nodeId": "node-local",
      "at": "2026-10-25T14:41:33.366Z",
      "name": "证据节点"
    },
    "clipboardLocalToHub": {
      "marker": "v2agent 本机复制 1792939293437 中文",
      "reported": true
    },
    "clipboardHubToLocal": {
      "text": "v2agent 手机发来 1792939294059 写回",
      "readBackMatched": true
    },
    "inboundTransfer": {
      "transferId": "evidence_in_1",
      "ack": {
        "nodeId": "node-local",
        "saved": [
          {
            "name": "手机截图证据.png",
            "path": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\receive\\手机截图证据.png",
            "bytes": 53,
            "sha256": "56b8385937165858699cdd9c3362e09f3fec6c0f7bc3631573c57fd46fe11405",
            "expectedSha256": "56b8385937165858699cdd9c3362e09f3fec6c0f7bc3631573c57fd46fe11405",
            "ok": true
          }
        ],
        "ok": true
      },
      "savedPath": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\receive\\手机截图证据.png",
      "savedOnDisk": true,
      "receiveDir": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\receive"
    },
    "task": {
      "steps": [
        "开始执行",
        "调整音量"
      ],
      "result": {
        "summary": "（演练）已执行：切换静音",
        "items": [
          {
            "name": "mute",
            "ok": true,
            "detail": "TENON_ACTION_DRYRUN=1 未真正按键"
          }
        ],
        "partial": false
      }
    },
    "notificationMirror": {
      "title": "手机通知证据",
      "seenInLog": true
    },
    "exit": {
      "code": 0,
      "signal": null
    },
    "logTail": [
      "[22:41:33] 首次运行，已生成节点身份 node-local（保存在 H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\agent\\node-identity.json）",
      "[22:41:33] 榫卯节点 Agent v0.2.0 启动",
      "[22:41:33] 仓库根：H:\\minzzj文件\\技术部\\项目\\官方\\榫卯",
      "[22:41:33] 中枢：http://127.0.0.1:63178",
      "[22:41:33] 节点：证据节点（node-local）",
      "[22:41:33] 数据目录：H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\agent｜已有幂等记录 0 条",
      "[22:41:33] 已注册到中枢 http://127.0.0.1:63178：node-local（能力 13 项，含 v2 动作）",
      "[22:41:33] 已上线：心跳每 2 秒，拉任务每 1 秒（v2 桌面模块随之启动）；Ctrl+C 优雅退出",
      "[22:41:33] v2 桌面端模块启用（TENON_V2=1）：剪贴板 / 文件收发 / 通知 / 受控动作",
      "[22:41:33] [通知] 已发送（method=log）：榫卯 v2 · 桌面端已连接 · 证据节点 已上线：剪贴板、文件收发、通知同步已启用",
      "[22:41:33] 桌面通知通道：log（回退）",
      "[22:41:33] [剪贴板] 已启动：每 0.3 秒轮询（读+写双向，防回环）",
      "[22:41:33] [传输] 已启动：每 0.5 秒查询入站传输，接收目录 H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\receive",
      "[22:41:33] v2 模块就绪：受控动作 4 项 + 超级终端动作 5 项已随注册上报；接收目录 H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\receive",
      "[22:41:34] [剪贴板] 已接收来自 phone-android 的文本（29 字）",
      "[22:41:35] [传输] 已接收 手机截图证据.png（53 字节）→ H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\receive\\手机截图证据.png",
      "[22:41:35] 任务 evidence_task_1 成功（4ms）：（演练）已执行：切换静音",
      "[22:41:35] [通知] 已发送（method=log）：手机通知证据 · 来自 Android 的通知镜像",
      "[22:41:35] 收到 stdin，准备优雅退出…",
      "[22:41:35] v2 模块已停止",
      "[22:41:35] 节点已停止（已执行任务 1 个，幂等状态保存在 H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\_internal\\v2-desktop-data\\agent\\node-state.json）"
    ]
  }
}
```

agent 原始日志：`node-agent/__tests__/evidence/agent.log`