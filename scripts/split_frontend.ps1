#requires -Version 5.1
# Splits frontend/app.js into ES modules under frontend/src/.
# Idempotent — re-running overwrites the modules.
# Source line numbers refer to the pre-split frontend/app.js.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
$src = Get-Content frontend\app.js  # 1-indexed via [n-1]

function Slice([int[]]$flat) {
  $out = New-Object System.Collections.Generic.List[string]
  for ($k = 0; $k -lt $flat.Length; $k += 2) {
    $a = $flat[$k]; $b = $flat[$k + 1]
    for ($i = $a - 1; $i -le $b - 1; $i++) { $out.Add([string]$src[$i]) }
  }
  return ,$out.ToArray()
}

function WriteModule([string]$path, [string]$header, [int[]]$ranges, [string]$footer) {
  $dir = Split-Path $path -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $body = Slice $ranges
  $all = New-Object System.Collections.Generic.List[string]
  if ($header) {
    foreach ($l in ($header -split "`r?`n")) { if ($l -ne $null) { $all.Add($l) } }
    $all.Add('')
  }
  foreach ($l in $body) { $all.Add($l) }
  if ($footer) {
    $all.Add('')
    foreach ($l in ($footer -split "`r?`n")) { if ($l -ne $null) { $all.Add($l) } }
  }
  $abs = Join-Path $repoRoot $path
  [System.IO.File]::WriteAllLines($abs, $all.ToArray(), [System.Text.UTF8Encoding]::new($false))
  Write-Host ("wrote {0} ({1} body lines)" -f $path, $body.Count)
}

New-Item -ItemType Directory -Force -Path frontend\src\widgets, frontend\src\views | Out-Null

WriteModule 'frontend\src\utils.js' '' (1,82, 187,209, 541,545) @'
export {
  ROLES, CDRAGON_NAME_FIX,
  esc, champSlug, champIconUrl, champImg,
  MATCHUP_COLOR, SYNERGY_COLOR, BLIND_COLOR, TOTAL_COLOR, STRENGTH_LABEL_COLORS,
  renderScoreEquation,
  HEATMAP_COLORS_9, plotlyColorscale, colorAt,
  fmtSign, tealOrangeBg, corrBg,
  RANK_LABELS, RANK_COLORS,
  $, $$, setStatus,
};
'@

WriteModule 'frontend\src\state.js' '' (84,170) @'
export {
  state,
  _sigmaScenarioKey, _sigmasFor, _sigmaBody, _updateSigmasFromCurves,
};
'@

WriteModule 'frontend\src\api.js' @'
import { state } from "./state.js";
'@ (171,186, 211,540, 546,585) @'
export function getChampionsData() { return _championsData; }
export {
  _loadEngine, _loadStrengthCurves,
  apiFetch,
  loadChampionsFor, topNChampions,
};
'@

WriteModule 'frontend\src\widgets\heatmap.js' @'
import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { ROLES, esc, champIconUrl, plotlyColorscale, colorAt } from "../utils.js";
'@ (623,997, 1893,1988) @'
export {
  drawPoolHeatmap,
  buildViewChoices, populateViewSelect,
  fetchPoolCoverageFor, renderPoolPreview,
};
'@

WriteModule 'frontend\src\widgets\strength.js' @'
import { state, _sigmaScenarioKey, _sigmasFor, _sigmaBody, _updateSigmasFromCurves } from "../state.js";
import { apiFetch } from "../api.js";
import { $, fmtSign, champImg, MATCHUP_COLOR, SYNERGY_COLOR, BLIND_COLOR, STRENGTH_LABEL_COLORS } from "../utils.js";
'@ (1136,1587) @'
export {
  STRENGTH_MODES, STRENGTH_TIERS, strengthTier, percentileFromGrid,
  fetchLiveStrengthCurves,
  _slotFromLive,
  _drawStrengthMini, _drawStrengthMiniSigma,
  _buildStrengthSkeleton, _renderStrengthCells,
  renderPoolStrengthPanel,
  REPL_DELTA_FIELDS, renderReplStrengthPanel,
};
'@

WriteModule 'frontend\src\widgets\multiselect.js' @'
import { $, champImg } from "../utils.js";
import { refresh } from "../main.js";
'@ (3312,3438) @'
export { makeMultiSelect, makeSingleSelect };
'@

WriteModule 'frontend\src\views\coverage.js' @'
import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, ROLES, esc, fmtSign, champImg, setStatus } from "../utils.js";
import { drawPoolHeatmap } from "../widgets/heatmap.js";
'@ (568,622, 999,1135) @'
export { refreshCoverage, renderRoleSubTabs };
'@

WriteModule 'frontend\src\views\health.js' @'
import { state } from "../state.js";
import { apiFetch } from "../api.js";
import {
  $, fmtSign, champImg, champIconUrl,
  MATCHUP_COLOR, SYNERGY_COLOR, BLIND_COLOR,
  plotlyColorscale, tealOrangeBg, corrBg, renderScoreEquation,
} from "../utils.js";
import { renderPoolStrengthPanel } from "../widgets/strength.js";
'@ (1547,1892) @'
export { refreshHealth };
'@

WriteModule 'frontend\src\views\blind.js' @'
import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, champImg, champIconUrl, fmtSign, tealOrangeBg, BLIND_COLOR } from "../utils.js";
'@ (1983,2130) @'
export { refreshBlindability };
'@

WriteModule 'frontend\src\views\comparer.js' @'
import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, champImg, fmtSign, setStatus, MATCHUP_COLOR, SYNERGY_COLOR } from "../utils.js";
'@ (2131,2289) @'
export { refreshComparer, _cmpRenderTables };
'@

WriteModule 'frontend\src\views\bans.js' @'
import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, ROLES, champImg, fmtSign, tealOrangeBg } from "../utils.js";
'@ (2290,2375) @'
export { refreshBans };
'@

WriteModule 'frontend\src\views\builder.js' @'
import { state, _sigmaScenarioKey, _sigmaBody } from "../state.js";
import { apiFetch } from "../api.js";
import {
  $, champImg, champIconUrl, fmtSign, tealOrangeBg,
  MATCHUP_COLOR, SYNERGY_COLOR, BLIND_COLOR, TOTAL_COLOR, renderScoreEquation,
} from "../utils.js";
import {
  fetchLiveStrengthCurves, _slotFromLive,
  _buildStrengthSkeleton, _renderStrengthCells,
} from "../widgets/strength.js";
import { populateViewSelect, renderPoolPreview } from "../widgets/heatmap.js";
'@ (2376,2575) @'
export { refreshBuilder, refreshComboCount, buildPools, renderBuilderResults };
'@

WriteModule 'frontend\src\views\replacements.js' @'
import { state, _sigmaScenarioKey, _sigmaBody } from "../state.js";
import { apiFetch } from "../api.js";
import {
  $, champImg, fmtSign, tealOrangeBg,
  MATCHUP_COLOR, SYNERGY_COLOR, BLIND_COLOR, TOTAL_COLOR, renderScoreEquation,
} from "../utils.js";
import {
  fetchLiveStrengthCurves, _slotFromLive,
  REPL_DELTA_FIELDS, renderReplStrengthPanel,
} from "../widgets/strength.js";
import { populateViewSelect, renderPoolPreview } from "../widgets/heatmap.js";
'@ (2576,2824) @'
export { refreshReplacements, renderReplPreview };
'@

WriteModule 'frontend\src\views\meta.js' @'
import { state } from "../state.js";
import { getChampionsData } from "../api.js";
import { ROLES, RANK_LABELS, RANK_COLORS, champSlug } from "../utils.js";
'@ (2838,3311) @'
export { refreshMeta };
'@

WriteModule 'frontend\src\main.js' @'
import { state } from "./state.js";
import { $, $$, setStatus, ROLES, RANK_LABELS } from "./utils.js";
import { apiFetch, loadChampionsFor, topNChampions } from "./api.js";
import { makeMultiSelect, makeSingleSelect } from "./widgets/multiselect.js";
import { refreshCoverage, renderRoleSubTabs } from "./views/coverage.js";
import { refreshHealth } from "./views/health.js";
import { refreshBlindability } from "./views/blind.js";
import { refreshComparer, _cmpRenderTables } from "./views/comparer.js";
import { refreshBans } from "./views/bans.js";
import {
  refreshBuilder, refreshComboCount, buildPools, renderBuilderResults,
} from "./views/builder.js";
import { refreshReplacements, renderReplPreview } from "./views/replacements.js";
import { refreshMeta } from "./views/meta.js";
'@ (2825,2834, 3277,3311, 3439,3630) @'
export { refresh, setActiveView };
'@

Write-Host ''
Write-Host 'Split complete. Listing frontend/src/:'
Get-ChildItem -Recurse frontend\src\ -File | ForEach-Object {
  $rel = Resolve-Path -Relative $_.FullName
  "{0,-44} {1,8} bytes" -f $rel, $_.Length | Write-Host
}
