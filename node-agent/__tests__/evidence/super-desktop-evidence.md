# 榫卯 v2.1 · 超级终端桌面动作 · 本机真实执行证据

- 时间：2026-10-25T14:42:01.782Z → 2026-10-25T14:42:30.859Z（29.1s）
- 环境：win32 / Node v24.15.0 / Windows PowerShell 5.1
- 结论：**通过**（13/13 项通过）

| # | 检查项 | 结果 | 说明 |
|---|---|---|---|
| 1 | app.list 返回本机程序清单 | ✅ 通过 | 可用 12/12 |
| 2 | app.launch("notepad") 真实启动进程 | ✅ 通过 | 进程 792:notepad；截图 已保存 |
| 3 | url.open("https://github.com") 真实打开浏览器 | ✅ 通过 | 浏览器进程 58 个（新增 1）；截图 已保存 |
| 4 | media.show 用默认程序真实打开图片 | ✅ 通过 | 已用默认程序打开图片：样品01.png（8.3 KB）；截图 已保存 |
| 5 | handoff.show 打开 #/handoff 页面 | ✅ 通过 | http://127.0.0.1:7439/#/handoff?kind=page&url=https%3A%2F%2Fgithub.com%2Fminzzj%2Ftenon&text=%E4%BB%8E%E6%89%8B%E6%9C%BA%E7%94%A9%E5%88%B0%E7%94%B5%E8%84%91%E5%A4%A7%E5%B1%8F%E7%9A%84%E9%A1%B5%E9%9D%A2+%C2%B7+v2.1+%E8%B6%85%E7%BA%A7%E7%BB%88%E7%AB%AF%E8%AF%81%E6%8D%AE |
| 6 | url.open fullscreen 走 Chrome/Edge --start-fullscreen | ✅ 通过 | 已全屏打开网页：https://github.com（Chrome --start-fullscreen） |
| 7 | agent 注册 13 能力（含 5 个超级终端动作） | ✅ 通过 | image.crop,file.hash,file.delete,printer.mock,system.open,system.volume,system.power,file.print,app.launch,url.open,media.show,handoff.show,app.list |
| 8 | 走现有 task pull 执行 app.list / app.launch("notepad") | ✅ 通过 | 本机可用程序 12/12 个：微信、Chrome 浏览器、Edge 浏览器、记事本、资源管理器、计算器、任务管理器、终端、系统设置、照片、画图、音乐播放器；另支持完整路径、http(s) URL 与 PATH 命令｜已打开「记事本」（进程已确认运行，PID 42936） |
| 9 | agent 优雅退出（exit 0） | ✅ 通过 | code=0 |
| 10 | 真实中枢 /api/state 可见 13 能力 | ✅ 通过 | image.crop,file.hash,file.delete,printer.mock,system.open,system.volume,system.power,file.print,app.launch,url.open,media.show,handoff.show,app.list |
| 11 | 真实中枢 /api/v2/super/programs 可用（可选） | ✅ 通过 | {"ok":true,"programs":[{"id":"wechat","name":"微信","emoji":"💬","app":"微信","mode":"program","actionId":"app.launch","keyw |
| 12 | 真实节点优雅退出（exit 0） | ✅ 通过 | code=0 |
| 13 | 真实中枢优雅停止（system.stopped） | ✅ 通过 | events=4 |

## 截屏证据

| 文件 | 尺寸 | 大小 |
|---|---|---|
| super-01-app-launch-notepad.png | 1152×674 | 12 KB |
| super-02-url-open-github.png | 2560×1440 | 280 KB |
| super-03-media-show-photo.png | 2560×1440 | 251 KB |
| super-04-handoff-show.png | 2560×1440 | 198 KB |
| super-05-url-fullscreen.png | 2560×1440 | 1038 KB |
| super-06-task-pull-notepad.png | 1152×674 | 12 KB |

## 原始数据

```json
{
  "appList": {
    "summary": "本机可用程序 12/12 个：微信、Chrome 浏览器、Edge 浏览器、记事本、资源管理器、计算器、任务管理器、终端、系统设置、照片、画图、音乐播放器；另支持完整路径、http(s) URL 与 PATH 命令",
    "items": [
      {
        "name": "微信",
        "ok": true,
        "detail": "path · C:\\Program Files\\Tencent\\Weixin\\Weixin.exe"
      },
      {
        "name": "Chrome 浏览器",
        "ok": true,
        "detail": "path · C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      },
      {
        "name": "Edge 浏览器",
        "ok": true,
        "detail": "path · C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      },
      {
        "name": "记事本",
        "ok": true,
        "detail": "path · C:\\Windows\\System32\\notepad.exe"
      },
      {
        "name": "资源管理器",
        "ok": true,
        "detail": "path · C:\\Windows\\explorer.exe"
      },
      {
        "name": "计算器",
        "ok": true,
        "detail": "path · C:\\Windows\\System32\\calc.exe"
      },
      {
        "name": "任务管理器",
        "ok": true,
        "detail": "path · C:\\Windows\\System32\\Taskmgr.exe"
      },
      {
        "name": "终端",
        "ok": true,
        "detail": "path · C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      },
      {
        "name": "系统设置",
        "ok": true,
        "detail": "protocol · ms-settings:"
      },
      {
        "name": "照片",
        "ok": true,
        "detail": "protocol · ms-photos:"
      },
      {
        "name": "画图",
        "ok": true,
        "detail": "path · C:\\Windows\\System32\\mspaint.exe"
      },
      {
        "name": "音乐播放器",
        "ok": true,
        "detail": "path · C:\\Program Files\\Windows Media Player\\wmplayer.exe"
      }
    ],
    "available": 12,
    "total": 12
  },
  "appLaunch": {
    "params": {
      "app": "notepad"
    },
    "summary": "已打开「记事本」（进程已确认运行，PID 792）",
    "notepadProcesses": [
      {
        "title": "无标题 - 记事本",
        "name": "notepad",
        "id": 792
      }
    ],
    "newProcesses": [
      {
        "title": "",
        "name": "conhost",
        "id": 37608
      },
      {
        "title": "无标题 - 记事本",
        "name": "notepad",
        "id": 792
      },
      {
        "title": "",
        "name": "powershell",
        "id": 32772
      }
    ],
    "screenshot": {
      "name": "super-01-app-launch-notepad.png",
      "file": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\node-agent\\__tests__\\evidence\\super-01-app-launch-notepad.png",
      "bytes": 12087,
      "width": 1152,
      "height": 674,
      "pid": 792,
      "title": "无标题 - 记事本",
      "ok": true,
      "kind": "window"
    }
  },
  "urlOpen": {
    "params": {
      "url": "https://github.com"
    },
    "summary": "已打开网页：https://github.com（默认浏览器）",
    "browserProcesses": 58,
    "newBrowserProcesses": [
      {
        "title": "",
        "name": "msedge",
        "id": 35668
      }
    ],
    "screenshot": {
      "name": "super-02-url-open-github.png",
      "file": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\node-agent\\__tests__\\evidence\\super-02-url-open-github.png",
      "bytes": 286901,
      "width": 2560,
      "height": 1440,
      "ok": true
    },
    "cleanup": {
      "ok": false,
      "killed": 0
    }
  },
  "mediaShow": {
    "params": {
      "path": "示例空间/样品图/样品01.png"
    },
    "summary": "已用默认程序打开图片：样品01.png（8.3 KB）",
    "newProcesses": [
      {
        "title": "",
        "name": "conhost",
        "id": 19260
      },
      {
        "title": "",
        "name": "Photos",
        "id": 35520
      },
      {
        "title": "",
        "name": "powershell",
        "id": 24996
      },
      {
        "title": "",
        "name": "sppsvc",
        "id": 19624
      }
    ],
    "screenshot": {
      "name": "super-03-media-show-photo.png",
      "file": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\node-agent\\__tests__\\evidence\\super-03-media-show-photo.png",
      "bytes": 256914,
      "width": 2560,
      "height": 1440,
      "ok": true
    },
    "cleanup": {
      "ok": false,
      "killed": 0
    }
  },
  "handoffShow": {
    "params": {
      "kind": "page",
      "url": "https://github.com/minzzj/tenon",
      "text": "从手机甩到电脑大屏的页面 · v2.1 超级终端证据"
    },
    "summary": "已在电脑大屏展示流转内容（kind=page）→ http://127.0.0.1:7439/#/handoff?kind=page&url=https%3A%2F%2Fgithub.com%2Fminzzj%2Ftenon&text=%E4%BB%8E%E6%89%8B%E6%9C%BA%E7%94%A9%E5%88%B0%E7%94%B5%E8%84%91%E5%A4%A7%E5%B1%8F%E7%9A%84%E9%A1%B5%E9%9D%A2+%C2%B7+v2.1+%E8%B6%85%E7%BA%A7%E7%BB%88%E7%AB%AF%E8%AF%81%E6%8D%AE",
    "shownUrl": "http://127.0.0.1:7439/#/handoff?kind=page&url=https%3A%2F%2Fgithub.com%2Fminzzj%2Ftenon&text=%E4%BB%8E%E6%89%8B%E6%9C%BA%E7%94%A9%E5%88%B0%E7%94%B5%E8%84%91%E5%A4%A7%E5%B1%8F%E7%9A%84%E9%A1%B5%E9%9D%A2+%C2%B7+v2.1+%E8%B6%85%E7%BA%A7%E7%BB%88%E7%AB%AF%E8%AF%81%E6%8D%AE",
    "expectedUrl": "http://127.0.0.1:7439/#/handoff?kind=page&url=https%3A%2F%2Fgithub.com%2Fminzzj%2Ftenon&text=%E4%BB%8E%E6%89%8B%E6%9C%BA%E7%94%A9%E5%88%B0%E7%94%B5%E8%84%91%E5%A4%A7%E5%B1%8F%E7%9A%84%E9%A1%B5%E9%9D%A2+%C2%B7+v2.1+%E8%B6%85%E7%BA%A7%E7%BB%88%E7%AB%AF%E8%AF%81%E6%8D%AE",
    "screenshot": {
      "name": "super-04-handoff-show.png",
      "file": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\node-agent\\__tests__\\evidence\\super-04-handoff-show.png",
      "bytes": 202826,
      "width": 2560,
      "height": 1440,
      "ok": true
    },
    "cleanup": {
      "ok": false,
      "killed": 0
    }
  },
  "urlFullscreen": {
    "summary": "已全屏打开网页：https://github.com（Chrome --start-fullscreen）",
    "error": null,
    "newBrowserProcesses": [
      {
        "title": "",
        "name": "chrome",
        "id": 2212
      },
      {
        "title": "",
        "name": "chrome",
        "id": 13280
      },
      {
        "title": "",
        "name": "chrome",
        "id": 14160
      },
      {
        "title": "",
        "name": "chrome",
        "id": 17644
      },
      {
        "title": "",
        "name": "chrome",
        "id": 18988
      },
      {
        "title": "",
        "name": "chrome",
        "id": 35444
      },
      {
        "title": "",
        "name": "chrome",
        "id": 36980
      },
      {
        "title": "",
        "name": "chrome",
        "id": 38048
      },
      {
        "title": "GitHub · 变化是永恒的。GitHub 让你保持领先。 · GitHub · GitHub - Google Chrome",
        "name": "chrome",
        "id": 43148
      },
      {
        "title": "",
        "name": "msedge",
        "id": 20608
      }
    ],
    "screenshot": {
      "name": "super-05-url-fullscreen.png",
      "file": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\node-agent\\__tests__\\evidence\\super-05-url-fullscreen.png",
      "bytes": 1063081,
      "width": 2560,
      "height": 1440,
      "ok": true
    },
    "cleanup": {
      "ok": false,
      "killed": 0
    }
  },
  "taskPull": {
    "registerCapabilities": [
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
    ],
    "appListResult": "本机可用程序 12/12 个：微信、Chrome 浏览器、Edge 浏览器、记事本、资源管理器、计算器、任务管理器、终端、系统设置、照片、画图、音乐播放器；另支持完整路径、http(s) URL 与 PATH 命令",
    "appLaunchResult": "已打开「记事本」（进程已确认运行，PID 42936）",
    "screenshot": {
      "name": "super-06-task-pull-notepad.png",
      "file": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\node-agent\\__tests__\\evidence\\super-06-task-pull-notepad.png",
      "bytes": 12087,
      "width": 1152,
      "height": 674,
      "pid": 42936,
      "title": "无标题 - 记事本",
      "ok": true,
      "kind": "window"
    },
    "logFile": "H:\\minzzj文件\\技术部\\项目\\官方\\榫卯\\node-agent\\__tests__\\evidence\\agent-pull.log",
    "exit": {
      "code": 0,
      "signal": null
    }
  },
  "realHub": {
    "node": {
      "id": "node-local",
      "name": "超级终端真实节点",
      "online": true,
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
        "app.list"
      ]
    },
    "superPrograms": {
      "ok": true,
      "sample": "{\"ok\":true,\"programs\":[{\"id\":\"wechat\",\"name\":\"微信\",\"emoji\":\"💬\",\"app\":\"微信\",\"mode\":\"program\",\"actionId\":\"app.launch\",\"keywords\":[\"微信\",\"wechat\"],\"available\":true,\"availableAs\":\"node\",\"targetDevices\":[{\"deviceId\":\"node-local\",\"name\":\"超级终端真实节点\",\"kind\":\"computer\",\"online\":true,\"capabilityId\":\"app.launch\"}"
    },
    "agentExit": {
      "code": 0,
      "signal": null
    },
    "hubStop": {
      "exitCode": 0,
      "systemStopped": true,
      "events": 4
    }
  }
}
```

日志：`node-agent/__tests__/evidence/agent-pull.log`、`agent-real-super.log`、`hub-super.log`