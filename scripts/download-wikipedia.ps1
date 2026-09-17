<##
.SYNOPSIS
  Download the current English Wikipedia article dump to an external drive.

.DESCRIPTION
  This intentionally downloads only the source dump.  It never writes into
  the repository, and refuses a C: destination unless -AllowSystemDrive is
  explicitly supplied.  The dump is large (many gigabytes), so leave enough
  free space for both the compressed source and the extracted/indexed data.
#>
[CmdletBinding()]
param(
  [string]$DataRoot = $(if ($env:WIKIGRAPH_DATA_DIR) { $env:WIKIGRAPH_DATA_DIR } else { 'D:\WikiGraphData' }),
  [switch]$AllowSystemDrive
)

$ErrorActionPreference = 'Stop'
$dumpName = 'enwiki-latest-pages-articles-multistream.xml.bz2'
$uri = "https://dumps.wikimedia.org/enwiki/latest/$dumpName"
$root = [IO.Path]::GetFullPath($DataRoot)
$drive = [IO.Path]::GetPathRoot($root)
if ($drive -eq 'C:\' -and -not $AllowSystemDrive) {
  throw "Refusing to store a Wikipedia dump on C:. Choose a D: (or other external) path with -DataRoot."
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
$destination = Join-Path $root $dumpName
if (Test-Path -LiteralPath $destination) {
  throw "Destination already exists: $destination. Remove it or choose another -DataRoot."
}

Write-Host "Downloading $uri"
Write-Host "Destination: $destination"
Start-BitsTransfer -Source $uri -Destination $destination -DisplayName 'WikiGraph Wikipedia dump'
Write-Host "Download complete. Keep the dump outside Git and use an external index for the app."
