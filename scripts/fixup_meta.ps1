$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$f = 'frontend\src\views\meta.js'
$c = Get-Content $f -Raw
$c = $c -replace '_championsData\.', 'getChampionsData().'
$c = $c -replace '!_championsData(?!\w)', '!getChampionsData()'
[System.IO.File]::WriteAllText((Resolve-Path $f).Path, $c, [System.Text.UTF8Encoding]::new($false))
Write-Host 'meta.js updated. Remaining _championsData refs:'
$rem = Select-String -Path $f -Pattern '_championsData'
if ($rem) { $rem | ForEach-Object { $_.Line.Trim() } } else { Write-Host '(none)' }
