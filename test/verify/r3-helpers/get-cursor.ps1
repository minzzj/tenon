# 读取当前鼠标位置与前台窗口标题；输出 JSON。
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TenonMouse {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  public static int[] Pos() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static string Title() { StringBuilder sb = new StringBuilder(512); GetWindowText(GetForegroundWindow(), sb, 512); return sb.ToString(); }
}
"@
try {
  Add-Type -TypeDefinition $code -Language CSharp | Out-Null
  $p = [TenonMouse]::Pos()
  [pscustomobject]@{ ok = $true; x = $p[0]; y = $p[1]; foreground = [TenonMouse]::Title() } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}