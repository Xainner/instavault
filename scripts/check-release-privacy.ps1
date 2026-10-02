$ErrorActionPreference = "Stop"
$tracked = git ls-files --cached --others --exclude-standard
$blocked = $tracked | Where-Object {
  $_ -match '(?i)(^|/)(downloads|avatars)/' -or
  $_ -match '(?i)(^|/)(browser-profile|backups?|dumps?|cookies?)/' -or
  $_ -match '(?i)\.(db|db-wal|db-shm|sqlite|sqlite3|key|pem|pfx|p12|p7b|crt|cer|der|cookies?)$' -or
  $_ -match '(?i)(^|/)\.env($|\.)'
}

$secretPatterns = @(
  '(?i)sessionid=[A-Za-z0-9%:_-]{16,}',
  '(?i)csrftoken=[A-Za-z0-9_-]{16,}',
  '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
)
$leaks = foreach ($file in $tracked) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
  $item = Get-Item -LiteralPath $file
  if ($item.Length -gt 5MB) { continue }
  $text = Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue
  foreach ($pattern in $secretPatterns) {
    if ($text -match $pattern) { $file; break }
  }
}
if ($leaks) {
  Write-Error "Posibles credenciales o claves privadas rastreadas:`n$($leaks -join "`n")"
}
if ($blocked) {
  Write-Error "Archivos privados rastreados:`n$($blocked -join "`n")"
}

$oversized = $tracked | ForEach-Object {
  if (Test-Path -LiteralPath $_) {
    $item = Get-Item -LiteralPath $_
    if ($item.Length -gt 25MB) { $_ }
  }
}
if ($oversized) {
  Write-Error "Archivos rastreados mayores a 25 MB:`n$($oversized -join "`n")"
}
Write-Host "Privacy gate OK: no hay bases de datos, medios administrados, credenciales ni claves rastreadas."
