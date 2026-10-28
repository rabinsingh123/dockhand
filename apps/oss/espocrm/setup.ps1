# Native EspoCRM (AGPLv3) for the real-software drift demo: portable PHP + portable MariaDB, no Docker, no
# installer, no admin rights. Everything lands under var\oss (git-ignored); this folder only holds scripts.
# Idempotent: each stage is skipped when its output exists. Afterwards: start.ps1, then
# `pnpm exec tsx scripts/oss/espocrm-seed.ts`.
#
# Usage: powershell -ExecutionPolicy Bypass -File apps\oss\espocrm\setup.ps1

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"

$downloads = @(
  @{ Name = 'php'; Zip = "php-$PhpVersion-nts-Win32-vs17-x64.zip"; Urls = @(
      "https://windows.php.net/downloads/releases/php-$PhpVersion-nts-Win32-vs17-x64.zip",
      "https://windows.php.net/downloads/releases/archives/php-$PhpVersion-nts-Win32-vs17-x64.zip") },
  @{ Name = 'mariadb-dist'; Zip = "mariadb-$MariaVersion-winx64.zip"; Urls = @(
      "https://downloads.mariadb.org/rest-api/mariadb/$MariaVersion/mariadb-$MariaVersion-winx64.zip",
      "https://archive.mariadb.org/mariadb-$MariaVersion/winx64-packages/mariadb-$MariaVersion-winx64.zip") },
  @{ Name = 'espocrm-dist'; Zip = "EspoCRM-$EspoVersion.zip"; Urls = @(
      "https://github.com/espocrm/espocrm/releases/download/$EspoVersion/EspoCRM-$EspoVersion.zip") }
)

$t0 = Get-Date
New-Item -ItemType Directory -Force (Join-Path $Oss 'dl'), $LogDir | Out-Null
foreach ($d in $downloads) {
  $zip = Join-Path $Oss "dl\$($d.Zip)"
  if (-not (Test-Path $zip)) {
    $ok = $false
    foreach ($u in $d.Urls) {
      Write-Host "download $u"
      & curl.exe -sSfL -o $zip $u
      if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    }
    if (-not $ok) { throw "could not download $($d.Zip)" }
  }
  $dest = Join-Path $Oss $d.Name
  if (-not (Test-Path $dest)) {
    New-Item -ItemType Directory -Force $dest | Out-Null
    & tar.exe -xf $zip -C $dest
    if ($LASTEXITCODE -ne 0) { throw "could not unpack $zip" }
  }
}

# PHP: php.ini from this folder with an absolute extension_dir.
(Get-Content "$PSScriptRoot\php.ini") -replace 'EXT_DIR', (Join-Path $PhpDir 'ext') |
  Set-Content -Encoding ascii (Join-Path $PhpDir 'php.ini')
$mods = & $PhpExe -m
foreach ($m in 'pdo_mysql', 'mbstring', 'gd', 'zip', 'curl', 'openssl', 'Zend OPcache') {
  if ($mods -notcontains $m) { throw "PHP module $m did not load (Visual C++ 2015-2022 runtime missing?)" }
}

# MariaDB: a small data directory (64 MB buffer pool), localhost only, root password from env.ps1.
if (-not (Test-Path (Join-Path $DbData 'mysql'))) {
  & $MariaInstall "--datadir=$DbData" "--password=$DbPassword" "--port=$DbPort" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'mariadb-install-db failed' }
}
@"
[mysqld]
datadir=$($DbData -replace '\\', '/')
port=$DbPort
bind-address=127.0.0.1
innodb_buffer_pool_size=64M
innodb_log_file_size=48M
key_buffer_size=8M
max_connections=30
performance_schema=OFF
skip-name-resolve
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
[client]
port=$DbPort
"@ | Set-Content -Encoding ascii $DbIni

# EspoCRM app folder: a copy of the release so `setup` can be re-run from scratch by deleting it.
if (-not (Test-Path (Join-Path $App 'bootstrap.php'))) {
  Copy-Item -Recurse (Join-Path $Oss "espocrm-dist\EspoCRM-$EspoVersion") $App
}

if (-not (Test-Path (Join-Path $App 'data\config.php'))) {
  & "$PSScriptRoot\start.ps1" -DbOnly
  & $MariaClient --user=root "--password=$DbPassword" --host=127.0.0.1 "--port=$DbPort" -e "CREATE DATABASE IF NOT EXISTS espocrm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  if ($LASTEXITCODE -ne 0) { throw 'could not create the espocrm database' }
  Push-Location (Join-Path $App 'install')
  try {
    $db = "host-name=127.0.0.1:$DbPort&db-name=espocrm&db-user-name=root&db-user-password=$DbPassword&db-platform=Mysql"
    $steps = @(
      @('step1', 'user-lang=en_US'),
      @('setupConfirmation', $db),
      @('checkPermission', ''),
      @('saveSettings', "site-url=$SiteUrl&default-permissions-user=&default-permissions-group="),
      @('buildDatabase', ''),
      @('createUser', "user-name=$AdminUser&user-pass=$AdminPassword"),
      @('savePreferences', 'dateFormat=YYYY-MM-DD&timeFormat=HH:mm&timeZone=UTC&weekStart=1&defaultCurrency=USD&thousandSeparator=,&decimalMark=.&language=en_US'),
      @('finish', '')
    )
    foreach ($s in $steps) {
      $cliArgs = @('cli.php', '-a', $s[0])
      if ($s[1]) { $cliArgs += @('-d', $s[1]) }
      $out = & $PhpExe @cliArgs 2>&1 | Out-String
      Write-Host "install $($s[0]): $($out.Trim() -replace '\s+', ' ' | Select-Object -First 1)"
    }
  } finally { Pop-Location }
  if (-not (Test-Path (Join-Path $App 'data\config.php'))) { throw 'EspoCRM install did not write data\config.php' }
}
Write-Host ("setup done in {0:N0} s" -f ((Get-Date) - $t0).TotalSeconds)
