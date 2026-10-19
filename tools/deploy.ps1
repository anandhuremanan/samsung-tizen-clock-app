# Build, sign, install and launch TV Clock on a Samsung TV in developer mode.
#
#   .\tools\deploy.ps1 -TvIp 192.168.1.33
#   .\tools\deploy.ps1 -TvIp 192.168.1.33 -TizenStudio D:\tizen\studio -SigningProfile TVClock
param(
    [Parameter(Mandatory = $true)] [string] $TvIp,
    [string] $TizenStudio = "$env:USERPROFILE\tizen-studio",
    [string] $SigningProfile = 'TVClock'
)
$ErrorActionPreference = 'Stop'
# The Tizen tools ask for admin rights they don't need when installed in a user folder
$env:__COMPAT_LAYER = 'RunAsInvoker'

$tv = "${TvIp}:26101"
$sdb = Join-Path $TizenStudio 'tools\sdb.exe'
$tizen = Join-Path $TizenStudio 'tools\ide\bin\tizen.bat'
$app = Join-Path (Split-Path $PSScriptRoot -Parent) 'app'
$appId = 'TvClock001.TvClock'
$remote = '/home/owner/share/tmp/sdk_tools/tmp/TvClock.wgt'

function Clear-Build {
    Remove-Item "$app\*.wgt", "$app\author-signature.xml", "$app\signature1.xml", "$app\.manifest.tmp" -ErrorAction SilentlyContinue
}

Clear-Build
cmd /c "`"$tizen`" package -t wgt -s $SigningProfile -- `"$app`""
$wgt = Get-ChildItem "$app\*.wgt" | Select-Object -First 1
if (-not $wgt) { throw 'Packaging failed; check the signing profile name and certificate password.' }

& $sdb connect $tv
# The TV installer fails on the space in "TV Clock.wgt", so push it under a plain name
& $sdb -s $tv push $wgt.FullName $remote
& $sdb -s $tv shell 0 vd_appinstall $appId $remote
& $sdb -s $tv shell 0 was_execute $appId
Clear-Build
