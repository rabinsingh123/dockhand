# Shared paths and versions for the native EspoCRM scripts (dot-sourced by setup.ps1, start.ps1, stop.ps1).
# Local-only instance on 127.0.0.1 with fictional data; the database password below guards nothing else.

$PhpVersion = '8.4.27'
$MariaVersion = '11.4.13'
$EspoVersion = '10.0.11'

$Root = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$Oss = Join-Path $Root 'var\oss'
$PhpDir = Join-Path $Oss 'php'
$PhpExe = Join-Path $PhpDir 'php.exe'
$MariaBin = Join-Path $Oss "mariadb-dist\mariadb-$MariaVersion-winx64\bin"
$MariaInstall = Join-Path $MariaBin 'mariadb-install-db.exe'
$MariaServer = Join-Path $MariaBin 'mariadbd.exe'
$MariaClient = Join-Path $MariaBin 'mariadb.exe'
$MariaAdmin = Join-Path $MariaBin 'mariadb-admin.exe'
$DbData = Join-Path $Oss 'espocrm-db'
$DbIni = Join-Path $Oss 'espocrm-db.ini'
$App = Join-Path $Oss 'espocrm'
$LogDir = Join-Path $Oss 'logs'
$PidDir = Join-Path $Oss 'pids'

$Port = if ($env:ESPO_PORT) { [int]$env:ESPO_PORT } else { 8090 }
$DbPort = if ($env:ESPO_DB_PORT) { [int]$env:ESPO_DB_PORT } else { 3317 }
$SiteUrl = "http://127.0.0.1:$Port"
$DbPassword = if ($env:ESPO_DB_PASSWORD) { $env:ESPO_DB_PASSWORD } else { 'espo-local-db' }
$AdminUser = if ($env:ESPO_ADMIN_USER) { $env:ESPO_ADMIN_USER } else { 'admin' }
# The admin password is random per install, kept in var\oss\espo-admin-password.txt (git-ignored) where the
# TypeScript side reads it too (packages/orchestrator/src/espocrm.ts). ESPO_ADMIN_PASSWORD overrides it.
$AdminPasswordFile = Join-Path $Oss 'espo-admin-password.txt'
if ($env:ESPO_ADMIN_PASSWORD) {
  $AdminPassword = $env:ESPO_ADMIN_PASSWORD
} elseif (Test-Path $AdminPasswordFile) {
  $AdminPassword = (Get-Content -Raw $AdminPasswordFile).Trim()
} else {
  if (Test-Path (Join-Path $App 'data\config.php')) {
    # An instance installed before passwords were generated: its admin still has the old fixed password.
    # Record it once; delete var\oss\espocrm and re-run setup.ps1 for a random one.
    $AdminPassword = 'espo-local-admin'
  } else {
    $bytes = New-Object byte[] 36
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    # Letters and digits only: the installer takes it inside a form-encoded string.
    $AdminPassword = ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '').Substring(0, 24)
  }
  New-Item -ItemType Directory -Force $Oss | Out-Null
  Set-Content -NoNewline -Encoding ascii -Path $AdminPasswordFile -Value $AdminPassword
}
