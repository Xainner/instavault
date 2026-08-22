$ErrorActionPreference = "Stop"
$tracked = git ls-files --cached --others --exclude-standard
$blocked = $tracked | Where-Object {
  $_ -match '(?i)(^|/)(downloads|avatars)/' -or
  $_ -match '(?i)\.(db|db-wal|db-shm|sqlite|sqlite3|key|pem|pfx|p12)$' -or
  $_ -match '(?i)(^|/)\.env($|\.)'
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
