# 设置/取消静音：-Mute 1 静音，-Mute 0 取消静音；输出 JSON。
param([int]$Mute = 0)
$code = @"
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator { int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume volume); }
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr n); int UnregisterControlChangeNotify(IntPtr n);
  int GetChannelCount(out uint c); int SetMasterVolumeLevel(float level, Guid ctx); int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float level); int GetMasterVolumeLevelScalar(out float level);
  int GetChannelVolumeLevel(uint ch, out float level); int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetChannelVolumeLevel(uint ch, float level, Guid ctx); int SetChannelVolumeLevelScalar(uint ch, float level, Guid ctx);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
public static class TenonMuteSet {
  static IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
  static IAudioEndpointVolume Vol() { IMMDevice dev; enumerator.GetDefaultAudioEndpoint(0, 1, out dev); Guid iid = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume vol; dev.Activate(ref iid, 23, IntPtr.Zero, out vol); return vol; }
  public static bool Get() { IAudioEndpointVolume v = Vol(); bool m; v.GetMute(out m); return m; }
  public static void Set(bool m) { IAudioEndpointVolume v = Vol(); Guid g = Guid.Empty; v.SetMute(m, g); }
}
"@
try {
  Add-Type -TypeDefinition $code -Language CSharp | Out-Null
  [TenonMuteSet]::Set([bool]($Mute -ne 0))
  [pscustomobject]@{ ok = $true; muted = [TenonMuteSet]::Get() } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}