[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\skills'))
$destinationRoot = [IO.Path]::GetFullPath($Destination)
$skillNames = @('previzcam-previs-director', 'previzcam-preflight', 'previzcam-scene-survey', 'previzcam-blocking', 'previzcam-cinematography', 'previzcam-shot-review', 'previzcam-delivery')
foreach ($skillName in $skillNames) {
    $sourcePath = Join-Path $sourceRoot $skillName
    $targetPath = Join-Path $destinationRoot $skillName
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePath 'SKILL.md') -PathType Leaf)) { throw "Missing skill: $skillName" }
    if (Test-Path -LiteralPath $targetPath) { throw "Already exists; no files copied: $targetPath. Choose an empty destination or merge the existing skill manually." }
}
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
foreach ($skillName in $skillNames) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $skillName) -Destination (Join-Path $destinationRoot $skillName) -Recurse -ErrorAction Stop
    Write-Output "Installed $skillName"
}
