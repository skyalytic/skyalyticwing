$ErrorActionPreference = 'Stop'
# Called only by the local administrator's explicit setup button; never restarts Windows.
$wslSetup = Join-Path $env:SystemRoot 'System32\wsl.exe'
$setupProcess = Start-Process -FilePath $wslSetup -ArgumentList @('--install','--no-distribution','--no-launch') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
exit $setupProcess.ExitCode
