# 按进程名查主窗口矩形；输出 JSON。用法：-ProcessName notepad
param([string]$ProcessName = 'notepad')
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TenonWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static bool Focus(IntPtr h) { ShowWindow(h, 9); return SetForegroundWindow(h); }
}
"@
try {
  Add-Type -TypeDefinition $code -Language CSharp | Out-Null
  $p = Get-Process -Name $ProcessName -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { throw "进程 $ProcessName 没有主窗口" }
  [TenonWin]::Focus($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 300
  $r = New-Object TenonWin+RECT
  [TenonWin]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  [pscustomobject]@{ ok = $true; process = $ProcessName; pid = $p.Id; title = $p.MainWindowTitle; left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom; cx = [int](($r.Left + $r.Right) / 2); cy = [int](($r.Top + $r.Bottom) / 2) } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}