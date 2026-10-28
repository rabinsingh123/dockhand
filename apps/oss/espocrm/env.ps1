# Shared paths and versions for the native EspoCRM scripts (dot-sourced by setup.ps1, start.ps1, stop.ps1).
# Local-only instance on 127.0.0.1 with fictional data; the passwords below guard nothing else.

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
$AdminPassword = if ($env:ESPO_ADMIN_PASSWORD) { $env:ESPO_ADMIN_PASSWORD } else { 'espo-local-admin' }
