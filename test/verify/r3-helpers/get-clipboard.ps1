# 读取剪贴板文本；输出 JSON。
try {
  $t = Get-Clipboard -Raw -ErrorAction Stop
  [pscustomobject]@{ ok = $true; text = [string]$t } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}