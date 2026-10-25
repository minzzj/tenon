# 聚焦指定进程主窗口，并轮询前台窗口标题直到匹配记事本/Notepad；输出 JSON。
param([string]$ProcessName = 'notepad', [string]$Match = '记事本')
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TenonFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static string Foreground() { StringBuilder sb = new StringBuilder(512); GetWindowText(GetForegroundWindow(), sb, 512); return sb.ToString(); }
  public static void Force(IntPtr h) { ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h); SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040); }
}
"@
try {
  Add-Type -TypeDefinition $code -Language CSharp | Out-Null
  $p = Get-Process -Name $ProcessName -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { throw "进程 $ProcessName 无主窗口" }
  $ws = New-Object -ComObject WScript.Shell
  $matched = $false
  for ($i = 0; $i -lt 25; $i++) {
    $fg = [TenonFocus]::Foreground()
    if ($fg -like ('*' + $Match + '*')) { $matched = $true; break }
    try { [TenonFocus]::Force($p.MainWindowHandle) } catch {}
    try { $ws.AppActivate($p.Id) | Out-Null } catch {}
    Start-Sleep -Milliseconds 250
  }
  $fg2 = [TenonFocus]::Foreground()
  [pscustomobject]@{ ok = ($fg2 -like ('*' + $Match + '*')); foreground = $fg2; pid = $p.Id; title = $p.MainWindowTitle } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}