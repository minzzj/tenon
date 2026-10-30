# 榫卯 V3 · 本地 TTS（Windows SAPI，zh-CN Huihui）
param(
  [Parameter(Mandatory=$true)][string]$Text,
  [string]$OutFile = "",
  [int]$Rate = 0,
  [int]$Volume = 100
)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice("Microsoft Huihui Desktop") } catch { }
$s.Rate = $Rate
$s.Volume = $Volume
if ($OutFile -and $OutFile.Trim().Length -gt 0) {
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile($OutFile, $fmt)
  $s.Speak($Text)
  $s.Dispose()
  Write-Output (ConvertTo-Json @{ ok = $true; file = $OutFile; bytes = (Get-Item $OutFile).Length } -Compress)
} else {
  $s.Speak($Text)
  $s.Dispose()
  Write-Output (ConvertTo-Json @{ ok = $true; spoke = $true } -Compress)
}
