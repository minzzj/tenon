# 强制把指定进程窗口带到前台（AttachThreadInput 技巧），并轮询确认；输出 JSON。
param([string]$ProcessName = 'notepad', [string]$Match = '记事本')
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TenonForceFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  public static string Foreground() { StringBuilder sb = new StringBuilder(512); GetWindowText(GetForegroundWindow(), sb, 512); return sb.ToString(); }
  public static void Force(IntPtr h) {
    ShowWindow(h, 9);
    BringWindowToTop(h);
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint myThread = GetCurrentThreadId();
    if (fgThread != myThread) { AttachThreadInput(myThread, fgThread, true); }
    SetForegroundWindow(h);
    if (fgThread != myThread) { AttachThreadInput(myThread, fgThread, false); }
  }
}
"@
try {
  Add-Type -TypeDefinition $code -Language CSharp | Out-Null
  $p = Get-Process -Name $ProcessName -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { throw "进程 $ProcessName 无主窗口" }
  $matched = $false
  for ($i = 0; $i -lt 20; $i++) {
    $f = [TenonForceFg]::Foreground()
    if ($f -like ('*' + $Match + '*')) { $matched = $true; break }
    [TenonForceFg]::Force($p.MainWindowHandle)
    Start-Sleep -Milliseconds 250
  }
  $f2 = [TenonForceFg]::Foreground()
  [pscustomobject]@{ ok = ($f2 -like ('*' + $Match + '*')); foreground = $f2; pid = $p.Id } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}