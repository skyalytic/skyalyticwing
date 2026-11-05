param([ValidateRange(1024,65535)][int]$Port,[Parameter(Mandatory=$true)][string]$Program,[switch]$Elevated)
$ErrorActionPreference='Stop'
$resolvedProgram=(Resolve-Path -LiteralPath $Program).Path
if(-not $Elevated){
  $scriptFile=$PSCommandPath.Replace("'","''")
  $programValue=$resolvedProgram.Replace("'","''")
  $command="& '$scriptFile' -Port $Port -Program '$programValue' -Elevated"
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $proc=Start-Process powershell.exe -ArgumentList @('-NoProfile','-EncodedCommand',$encoded) -Verb RunAs -WindowStyle Hidden -PassThru -Wait
  exit $proc.ExitCode
}
# Single managed rule, restricted to the Wing Node executable, the current WOPI port,
# private profiles and the local subnet. Never disable the firewall or open public profiles.
$ruleName='SkyalyticWing-Local-Office-WOPI'
$existing=Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if($existing){Remove-NetFirewallRule -Name $ruleName}
New-NetFirewallRule -Name $ruleName -DisplayName 'Skyalytic Wing Local Office' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Program $resolvedProgram -Profile Private -RemoteAddress LocalSubnet | Out-Null
