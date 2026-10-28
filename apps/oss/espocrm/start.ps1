# Starts native EspoCRM: MariaDB on 127.0.0.1:3317, then `php -S 127.0.0.1:8090` with router.php.
# Hidden windows, PIDs (of the wrapping cmd.exe) in var\oss\pids, logs in var\oss\logs. Waits until the
# login page answers. Usage: powershell -ExecutionPolicy Bypass -File apps\oss\espocrm\start.ps1 [-DbOnly]

param([switch]$DbOnly)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
New-Item -ItemType Directory -Force $LogDir, $PidDir | Out-Null

function Test-Port([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); return $true } catch { return $false } finally { $c.Dispose() }
}

# Servers start through `cmd /c` with ShellExecute so they never inherit this shell's stdout: a caller that
# pipes our output would otherwise wait on the server forever. cmd does the log redirection.
function Start-Hidden([string]$name, [string]$commandLine, [string]$cwd) {
  $log = Join-Path $LogDir "$name.log"
  $p = Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -PassThru -WorkingDirectory $cwd `
    -ArgumentList '/c', "`"$commandLine > `"$log`" 2>&1`""
  Set-Content (Join-Path $PidDir "$name.pid") $p.Id
}

$t0 = Get-Date
if (-not (Test-Port $DbPort)) {
  Start-Hidden 'mariadb' "`"$MariaServer`" --defaults-file=`"$DbIni`" --console" $Oss
  for ($i = 0; $i -lt 60 -and -not (Test-Port $DbPort); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Port $DbPort)) { throw "MariaDB did not open port $DbPort (see var\oss\logs\mariadb.log)" }
}
if ($DbOnly) { Write-Host "MariaDB on 127.0.0.1:$DbPort"; return }

if (-not (Test-Port $Port)) {
  $env:ESPO_APP = $App
  $public = Join-Path $App 'public'
  Start-Hidden 'php' "`"$PhpExe`" -S 127.0.0.1:$Port -t `"$public`" `"$PSScriptRoot\router.php`"" $public
}
for ($i = 0; $i -lt 120; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 "$SiteUrl/"
    if ($r.StatusCode -eq 200) { break }
  } catch { Start-Sleep -Milliseconds 500 }
}
Write-Host ("EspoCRM at {0} (admin user '{1}'), ready in {2:N1} s" -f $SiteUrl, $AdminUser, ((Get-Date) - $t0).TotalSeconds)
