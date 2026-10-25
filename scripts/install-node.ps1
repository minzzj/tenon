<#
  榫卯 Tenon · Windows 节点一键安装脚本（Round 1）
  用法：
    安装（普通用户即可）：
      powershell -ExecutionPolicy Bypass -File .\install-node.ps1 -HubUrl http://192.168.1.10:7410
    安装但不创建登录自启（测试用）：
      powershell -ExecutionPolicy Bypass -File .\install-node.ps1 -NoStartup -InstallDir D:\Tenon\node
    一键卸载：
      powershell -ExecutionPolicy Bypass -File .\install-node.ps1 -Uninstall
  参数：
    -HubUrl      中枢地址（http/https）；缺省读同目录 install-meta.json 的 hubUrl
    -InstallDir  安装目录；缺省 %LOCALAPPDATA%\Tenon\node
    -NoStartup   不创建计划任务（安装后仍会启动一次节点，便于测试）
    -Uninstall   停止节点、删除计划任务与安装目录
  输出：最后一行是 JSON 结果，供本页面/验收脚本程序化解析。
#>
[CmdletBinding()]
param(
  [string]$HubUrl = '',
  [string]$InstallDir = '',
  [switch]$NoStartup,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = 'TenonNode'
$DefaultInstallDir = Join-Path $env:LOCALAPPDATA 'Tenon\node'
$MetaFile = Join-Path $ScriptDir 'install-meta.json'
$LaunchCmdName = [string]([char]0x542F) + [string]([char]0x52A8) + [string]([char]0x8282) + [string]([char]0x70B9) + '.cmd'
$UninstallCmdName = [string]([char]0x5378) + [string]([char]0x8F7D) + [string]([char]0x8282) + [string]([char]0x70B9) + '.cmd'

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 8
  Write-Output $json
}

function Fail-Result($message, $extra) {
  $result = @{ ok = $false; action = 'error'; error = [string]$message; at = (Get-Date).ToString('o') }
  if ($extra) { foreach ($k in $extra.Keys) { $result[$k] = $extra[$k] } }
  Write-Host ('[榫卯] 错误：' + $message) -ForegroundColor Red
  Write-Result $result
  exit 1
}

function Read-Meta {
  if (Test-Path -LiteralPath $MetaFile) {
    try { return Get-Content -LiteralPath $MetaFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  }
  return $null
}

function Resolve-InstallDir {
  if ($InstallDir -and $InstallDir.Trim().Length -gt 0) {
    return [System.IO.Path]::GetFullPath($InstallDir)
  }
  if (Test-Path -LiteralPath (Join-Path $ScriptDir 'config.json')) {
    try {
      $cfg = Get-Content -LiteralPath (Join-Path $ScriptDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.installDir) { return [System.IO.Path]::GetFullPath([string]$cfg.installDir) }
    } catch {
      # 忽略损坏的 config，退回默认目录
    }
  }
  return [System.IO.Path]::GetFullPath($DefaultInstallDir)
}

function Stop-InstalledAgents($dir) {
  $stopped = @()
  $needle = [System.IO.Path]::GetFullPath($dir).TrimEnd('\')
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
  foreach ($proc in $procs) {
    $cmd = ([string]$proc.CommandLine).Replace('/', '\')
    if (-not $cmd) { continue }
    # P3 修复：只按「当前安装目录」精确匹配，绝不泛匹配 node-agent\agent.js，避免误杀其它目录/仓库里的 agent
    if ($cmd.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        $stopped += [int]$proc.ProcessId
      } catch {
        # 可能已被别的进程回收
      }
    }
  }
  return $stopped
}

function Remove-StartupTask {
  $removed = $false
  try {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
      $removed = $true
    }
  } catch {
    # 计划任务不存在或无权限时不影响卸载主体
  }
  return $removed
}

function Write-InstallLog($dir, $lines) {
  try {
    $logFile = Join-Path $dir 'install.log'
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $payload = ($lines | ForEach-Object { '[' + $stamp + '] ' + $_ }) -join "`r`n"
    Add-Content -LiteralPath $logFile -Value ($payload + "`r`n") -Encoding UTF8
    return $logFile
  } catch {
    return ''
  }
}

function Write-Config($dir, $hub, $nodeToken, $nodeId, $version, $installDir) {
  $configFile = Join-Path $dir 'config.json'
  $old = $null
  if (Test-Path -LiteralPath $configFile) {
    try { $old = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $old = $null }
  }
  $resolvedNodeId = [string]$nodeId
  if ($old -and $old.nodeId) { $resolvedNodeId = [string]$old.nodeId }
  $config = [ordered]@{
    version = [string]$version
    hubUrl = [string]$hub
    nodeToken = [string]$nodeToken
    nodeId = $resolvedNodeId
    dataDir = (Join-Path $dir 'data')
    installDir = [System.IO.Path]::GetFullPath($dir)
    installedAt = (Get-Date).ToString('o')
    updatedAt = (Get-Date).ToString('o')
  }
  $config.installDir = [System.IO.Path]::GetFullPath($dir)
  ($config | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $configFile -Encoding UTF8
  return $config
}

# ---------------- 卸载 ----------------
if ($Uninstall) {
  $dir = Resolve-InstallDir
  Write-Host '[榫卯] 开始卸载 Windows 节点…'
  $stopped = @()
  $removedTask = $false
  if (Test-Path -LiteralPath $dir) {
    $stopped = @(Stop-InstalledAgents $dir)
  }
  $removedTask = Remove-StartupTask
  $removedDir = $false
  if (Test-Path -LiteralPath $dir) {
    try {
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
      $removedDir = $true
    } catch {
      Fail-Result ('卸载失败，无法删除目录：' + $dir + '；' + $_.Exception.Message) @{ installDir = $dir; stoppedProcesses = @($stopped); stoppedCount = @($stopped).Count; removedTask = $removedTask }
    }
  }
  if ($removedTask -or $stopped.Count -gt 0 -or $removedDir -or -not (Test-Path -LiteralPath $dir)) {
    Write-Host ('[榫卯] 已卸载：停止进程 ' + $stopped.Count + ' 个，计划任务已删除=' + $removedTask + '，目录已删除=' + $removedDir)
    $stoppedList = @($stopped | ForEach-Object { [int]$_ })
    Write-Result @{ ok = $true; action = 'uninstall'; installDir = $dir; stoppedProcesses = @($stoppedList); stoppedCount = $stoppedList.Count; removedTask = $removedTask; removedDir = $removedDir; at = (Get-Date).ToString('o') }
    exit 0
  }
  Fail-Result '卸载未完成' @{ installDir = $dir }
}

# ---------------- 安装 ----------------
try {
  Write-Host '[榫卯] 开始安装 Windows 节点…'
  $meta = Read-Meta
  $version = '0.0.0'
  $metaToken = ''
  if ($meta) {
    if ($null -ne $meta.version) { $version = [string]$meta.version }
    if ($null -ne $meta.nodeToken) { $metaToken = [string]$meta.nodeToken }
    if (-not $HubUrl -and $meta.hubUrl) { $HubUrl = [string]$meta.hubUrl }
  }
  if (-not $HubUrl -or $HubUrl.Trim().Length -eq 0) {
    Fail-Result '缺少 -HubUrl（示例：-HubUrl http://192.168.1.10:7410），安装包 install-meta.json 里也没有默认地址'
  }
  $HubUrl = $HubUrl.Trim()
  if ($HubUrl -notmatch '^https?://') {
    Fail-Result ('-HubUrl 不合法（必须以 http:// 或 https:// 开头）：' + $HubUrl)
  }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Fail-Result '未找到 Node.js：请先安装 Node.js 22 及以上版本（https://nodejs.org/），再重新运行本脚本'
  }
  $nodeExe = $nodeCmd.Source
  $nodeVersion = (& $nodeExe --version).Trim()
  $major = 0
  if ($nodeVersion -match '^v(\d+)') { $major = [int]$Matches[1] }
  if ($major -lt 22) {
    Fail-Result ('Node.js 版本过低（当前 ' + $nodeVersion + '，需要 v22 及以上）')
  }
  $dir = Resolve-InstallDir
  if (-not $dir -or $dir.TrimEnd('\').Length -le 2) {
    Fail-Result ('-InstallDir 不合法：' + $dir)
  }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  # 已安装过：先停掉旧进程，避免端口/身份冲突（nodeId 会保留）
  $stopped = @(Stop-InstalledAgents $dir)
  Write-Host ('[榫卯] 安装目录：' + $dir)
  Write-Host ('[榫卯] 中枢地址：' + $HubUrl)
  $sourceAgent = Join-Path $ScriptDir 'node-agent'
  if (-not (Test-Path -LiteralPath $sourceAgent)) {
    Fail-Result ('安装包缺少 node-agent 目录：' + $sourceAgent)
  }
  Copy-Item -LiteralPath $sourceAgent -Destination $dir -Recurse -Force
  foreach ($fileName in @('README.txt', 'install-meta.json', $LaunchCmdName, $UninstallCmdName)) {
    $src = Join-Path $ScriptDir $fileName
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dir -Force }
  }
  $nodeId = 'node-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
  $config = Write-Config $dir $HubUrl $metaToken $nodeId $version $dir
  $logFile = Write-InstallLog $dir @(
    ('榫卯 Windows 节点安装 v' + $version),
    ('中枢地址：' + $HubUrl),
    ('安装目录：' + $dir),
    ('Node.js：' + $nodeVersion + ' @ ' + $nodeExe),
    ('节点 ID：' + $config.nodeId),
    ('测试模式（-NoStartup）：' + [bool]$NoStartup)
  )
  # 创建登录自启计划任务
  $startupTask = $false
  $startupError = ''
  if (-not $NoStartup) {
    try {
      Remove-StartupTask | Out-Null
      $launchCmd = Join-Path $dir $LaunchCmdName
      $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\cmd.exe') -Argument ('/c start "" /b "' + $launchCmd + '"')
      $trigger = New-ScheduledTaskTrigger -AtLogOn
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description '榫卯 Tenon 节点（登录自启）' -Force | Out-Null
      $startupTask = $true
      Write-Host '[榫卯] 已创建登录自启计划任务 TenonNode'
    } catch {
      $startupError = $_.Exception.Message
      Write-Host ('[榫卯] 创建计划任务失败（不影响本次安装）：' + $startupError) -ForegroundColor Yellow
    }
  }
  # 启动节点（隐藏窗口，继承环境变量；-NoStartup 也启动一次便于验证）
  $env:TENON_HUB_URL = $HubUrl
  $env:TENON_NODE_TOKEN = $metaToken
  $env:TENON_NODE_ID = [string]$config.nodeId
  $env:TENON_DATA_DIR = [string]$config.dataDir
  $agentScript = Join-Path $dir 'node-agent\agent.js'
  $nodeProcess = Start-Process -FilePath $nodeExe -ArgumentList ('"' + $agentScript + '"') -WorkingDirectory $dir -WindowStyle Hidden -PassThru
  $started = $false
  try {
    Start-Sleep -Milliseconds 600
    $nodeProcess.Refresh()
    $started = -not $nodeProcess.HasExited
  } catch {
    $started = $false
  }
  Write-InstallLog $dir @('启动节点：pid=' + $nodeProcess.Id + ' started=' + $started) | Out-Null
  Write-Host ('[榫卯] 节点已启动（pid=' + $nodeProcess.Id + '，隐藏窗口）')
  $result = @{
    ok = $true
    action = 'install'
    version = $version
    hubUrl = $HubUrl
    installDir = $dir
    nodeId = [string]$config.nodeId
    nodeVersion = $nodeVersion
    nodeExe = $nodeExe
    started = $started
    processId = [int]$nodeProcess.Id
    startupTask = $startupTask
    noStartup = [bool]$NoStartup
    startupError = $startupError
    stoppedOldProcesses = @($stopped)
    stoppedOldCount = @($stopped).Count
    logFile = $logFile
    at = (Get-Date).ToString('o')
  }
  Write-Host '[榫卯] 安装完成。回到榫卯网页，在「我的设备」里点一键绑定即可。'
  Write-Result $result
  exit 0
} catch {
  Fail-Result ('安装异常：' + $_.Exception.Message) @{ hubUrl = $HubUrl; installDir = $InstallDir }
}