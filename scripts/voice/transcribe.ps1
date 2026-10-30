# 榫卯 V3 · Windows 系统语音识别兜底（WAV → 文本）
param([Parameter(Mandatory=$true)][string]$Wav, [string]$Language = "zh-CN")
Add-Type -AssemblyName System.Speech
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine([System.Globalization.CultureInfo]::GetCultureInfo($Language))
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToWaveFile($Wav)
  $result = $engine.Recognize()
  $engine.Dispose()
  if ($result) {
    Write-Output (ConvertTo-Json @{ ok = $true; text = $result.Text; confidence = [math]::Round($result.Confidence, 3); provider = "windows-sr" } -Compress)
  } else {
    Write-Output (ConvertTo-Json @{ ok = $true; text = ""; confidence = 0; provider = "windows-sr" } -Compress)
  }
} catch {
  Write-Output (ConvertTo-Json @{ ok = $false; error = $_.Exception.Message; provider = "windows-sr" } -Compress)
  exit 1
}
