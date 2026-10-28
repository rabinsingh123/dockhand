# Stops native EspoCRM: php -S first, then a clean MariaDB shutdown (falls back to killing the process tree).
# Usage: powershell -ExecutionPolicy Bypass -File apps\oss\espocrm\stop.ps1

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\env.ps1"

foreach ($name in 'php', 'mariadb') {
  $pidFile = Join-Path $PidDir "$name.pid"
  if ($name -eq 'mariadb') { & $MariaAdmin --user=root "--password=$DbPassword" --host=127.0.0.1 "--port=$DbPort" shutdown 2>$null; Start-Sleep -Seconds 2 }
  if (Test-Path $pidFile) {
    & taskkill.exe /T /F /PID ([int](Get-Content $pidFile)) 2>$null | Out-Null
    Remove-Item $pidFile
  }
}
Write-Host 'EspoCRM stopped'
