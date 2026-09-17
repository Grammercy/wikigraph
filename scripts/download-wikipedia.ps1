<##
.SYNOPSIS
  Download the current English Wikipedia article dump to an external drive.

.DESCRIPTION
  This intentionally downloads only the source dump.  It never writes into
  the repository, and refuses a C: destination unless -AllowSystemDrive is
  explicitly supplied.  The dump is large (many gigabytes), so leave enough
  free space for both the compressed source and the extracted/indexed data.
  The Node helper owns the download/resume logic so this PowerShell wrapper
  behaves the same as `npm run wiki:download`.
#>
[CmdletBinding()]
param(
  [string]$DataRoot = $(if ($env:WIKIGRAPH_DATA_DIR) { $env:WIKIGRAPH_DATA_DIR } else { 'D:\WikiGraphData' }),
  [switch]$AllowSystemDrive,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($DataRoot)
$drive = [IO.Path]::GetPathRoot($root)
if ($drive -eq 'C:\' -and -not $AllowSystemDrive) {
  throw "Refusing to store a Wikipedia dump on C:. Choose a D: (or other external) path with -DataRoot."
}
$oldDataRoot = $env:WIKIGRAPH_DATA_DIR
$oldAllow = $env:WIKIGRAPH_ALLOW_SYSTEM_DRIVE
$env:WIKIGRAPH_DATA_DIR = $root
if ($AllowSystemDrive) { $env:WIKIGRAPH_ALLOW_SYSTEM_DRIVE = '1' }
try {
  $downloadArgs = @('download')
  if ($DryRun) { $downloadArgs += '--dry-run' }
  & node (Join-Path $PSScriptRoot 'wiki-data.mjs') @downloadArgs
  if ($LASTEXITCODE -ne 0) { throw "Wikipedia download failed (exit code $LASTEXITCODE)." }
}
finally {
  if ($null -eq $oldDataRoot) { Remove-Item Env:WIKIGRAPH_DATA_DIR -ErrorAction SilentlyContinue } else { $env:WIKIGRAPH_DATA_DIR = $oldDataRoot }
  if ($null -eq $oldAllow) { Remove-Item Env:WIKIGRAPH_ALLOW_SYSTEM_DRIVE -ErrorAction SilentlyContinue } else { $env:WIKIGRAPH_ALLOW_SYSTEM_DRIVE = $oldAllow }
}
