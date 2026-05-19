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

// ──────────────────────────────────────────────────────────────────────────
// POOL BUILDER TAB
// ──────────────────────────────────────────────────────────────────────────
async function refreshBuilder() {
  // Equation
  const wmark = state.prWeighted ? ' <sub style="color:#e0a07a;">(PR-weighted)</sub>' : "";
  $("#pb-equation").innerHTML = `<div>${renderScoreEquation("Score(pool)")}</div>
    <div class="plain">Each pool is ranked on top-${state.topX} weighted total z. Adjust the Score weights in the sidebar to re-rank.</div>`;

  // Update combo count + button enable
  await refreshComboCount();

  // If we already have built results, re-run the build so scoring picks up
  // changes to PR-weighted / top-X / blind-penalty / pr-floor without the
  // user having to click "Build pools" again.
  if (state.pbBuiltRows) {
    await buildPools();
  } else {
    renderBuilderResults();
  }
}

async function refreshComboCount() {
  const definite = state.pbDefinite.join(",");
  const maybe = state.pbMaybe.join(",");
  const r = await apiFetch(`/api/combo_count?definite=${encodeURIComponent(definite)}&maybe=${encodeURIComponent(maybe)}&target=${state.pbTarget}`);
  const data = await r.json();
  const div = $("#pb-combo-count");
  const btn = $("#pb-build");
  if (data.count == null) {
    div.classList.remove("over");
    div.innerHTML = "Possible pools: — (need more Maybes or fewer Definites)";
    btn.disabled = true;
  } else if (data.over_cap) {
    div.classList.add("over");
    div.innerHTML = `Possible pools: <b>${data.count.toLocaleString()}</b> — over the ${data.cap.toLocaleString()} cap. <i>Reduce Maybes, add Definites, or change target size.</i>`;
    btn.disabled = true;
  } else {
    div.classList.remove("over");
    div.innerHTML = `Possible pools: <b>${data.count.toLocaleString()}</b> (cap ${data.cap.toLocaleString()})`;
    btn.disabled = false;
  }
}

async function buildPools() {
  $("#pb-build").disabled = true;
  $("#pb-result-table").innerHTML = '<div class="empty-msg">Scoring combinations…</div>';
  $("#pb-selected-summary").innerHTML = "";
  const buildScenario = _sigmaScenarioKey({
    role: state.role, patch: state.patch, pool_size: state.pbTarget,
    top_x: state.topX, pr_floor: state.prFloor, pr_weighted: state.prWeighted,
    shrink_alpha: state.shrinkAlpha,
  });
  const r = await apiFetch("/api/build", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role,
      definite: state.pbDefinite, maybe: state.pbMaybe, target: state.pbTarget,
      top_x: state.topX,
      w_in_lane: state.weights.in_lane, w_out_lane: state.weights.out_lane,
      w_synergy: state.weights.synergy, w_blind: state.weights.blind,
      ..._sigmaBody(buildScenario),
      pr_floor: state.prFloor, pr_weighted: state.prWeighted,
      patch: state.patch, shrink_alpha: state.shrinkAlpha,
    }),
  });
  const data = await r.json();
  $("#pb-build").disabled = false;
  if (data.error) {
    $("#pb-result-table").innerHTML = `<div style="color:#D55E00;">${data.error}</div>`;
    return;
  }
  state.pbBuiltRows = data.rows;
  state.pbSelectedId = data.rows.length ? data.rows[0].id : null;
  renderBuilderResults();
}

async function renderBuilderResults() {
  const div = $("#pb-result-table");
  state.pbView = populateViewSelect($("#pb-view"), state.role, state.pbView, `matchup_${state.role}`);

  if (!state.pbBuiltRows) {
    div.innerHTML = '<div class="empty-msg">Configure Definite + Maybe and click Build pools.</div>';
    $("#pb-selected-summary").innerHTML = "";
    $("#pb-strength").innerHTML = "";
    Plotly.purge($("#pb-selected-hm"));
    $("#pb-selected-hm").innerHTML = '<div class="empty-msg">Build pools first to preview a coverage heatmap.</div>';
    return;
  }
  if (state.pbBuiltRows.length === 0) {
    div.innerHTML = '<div class="empty-msg">No valid pools.</div>';
    $("#pb-strength").innerHTML = "";
    return;
  }

  // Fetch live reference curves once for the target pool size + current
  // weights. All ranked pools have the same size, so a single fetch is
  // enough to derive every per-pool σ.
  const targetPoolSize = state.pbBuiltRows[0]?.pool.length ?? state.pbTarget;
  const live = await fetchLiveStrengthCurves({
    role: state.role, patch: state.patch,
    pool_size: targetPoolSize, top_x: state.topX,
    pr_floor: state.prFloor, pr_weighted: state.prWeighted,
    shrink_alpha: state.shrinkAlpha,
    weights: state.weights,
  });

  // Build a (rowMetric → sigma) function once.
  const refStat = (key) => {
    const slot = _slotFromLive(live, key, "primary");
    return slot && slot[1] > 0 ? { mean: slot[0], sd: slot[1] } : null;
  };
  const refs = {
    in_lane_matchup:     refStat("in_lane_matchup"),
    out_of_lane_matchup: refStat("out_of_lane_matchup"),
    overall_synergy:     refStat("overall_synergy"),
    blindability:        refStat("blindability"),
    total_score:         refStat("total_score"),
  };
  const sigmaOf = (val, ref) =>
    (val == null || ref == null) ? null : (val - ref.mean) / ref.sd;

  const SIGMA_SCALE = 0.5;
  const dCell = (v, suffix = "σ") => {
    if (v == null || !isFinite(v)) return '<td class="cell-na">—</td>';
    const bg = tealOrangeBg(v, SIGMA_SCALE);
    return `<td style="background:${bg};color:#fff;font-weight:bold;text-align:right;border-radius:2px;padding:4px 8px;">${fmtSign(v, 2)}${suffix}</td>`;
  };

  const top = state.pbBuiltRows.slice(0, 200);
  const tr = top.map((row, idx) => {
    const sel = row.id === state.pbSelectedId ? "selected" : "";
    const poolHtml = row.pool.map((c) =>
      `<img src="${champIconUrl(c)}" title="${c}" alt="${c}" style="width:18px;height:18px;border-radius:2px;vertical-align:middle;margin:0 1px;">`
    ).join("");
    const σTotal = sigmaOf(row.score, refs.total_score);
    const σIn    = sigmaOf(row.matchup_in_lane,     refs.in_lane_matchup);
    const σOut   = sigmaOf(row.matchup_out_of_lane, refs.out_of_lane_matchup);
    const σSyn   = sigmaOf(row.synergy_z,           refs.overall_synergy);
    const σBlind = sigmaOf(row.blind_z,             refs.blindability);
    return `<tr class="${sel}" data-id="${row.id}" title="Click to preview this pool">
      <td>${idx + 1}</td>
      <td style="line-height:1.0;white-space:nowrap;">${poolHtml}</td>
      ${dCell(σTotal)}
      ${dCell(σIn)}
      ${dCell(σOut)}
      ${dCell(σSyn)}
      ${dCell(σBlind)}
    </tr>`;
  }).join("");
  const sigmaHint = '<span style="color:#888;font-size:10px;">σ vs random</span>';
  div.innerHTML = `
  <table class="std-table compact-table">
    <thead><tr>
      <th>#</th>
      <th>Pool</th>
      <th style="color:${TOTAL_COLOR};">Total<br>${sigmaHint}</th>
      <th style="color:${MATCHUP_COLOR};">In-lane MU<br>${sigmaHint}</th>
      <th style="color:${MATCHUP_COLOR};">Out-lane MU<br>${sigmaHint}</th>
      <th style="color:${SYNERGY_COLOR};">Synergy<br>${sigmaHint}</th>
      <th style="color:${BLIND_COLOR};">Blind<br>${sigmaHint}</th>
    </tr></thead>
    <tbody>${tr}</tbody>
  </table>
  ${state.pbBuiltRows.length > 200 ? `<div style="color:#888;font-size:12px;margin-top:4px;">Showing top 200 of ${state.pbBuiltRows.length}.</div>` : ""}`;
  div.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => {
      state.pbSelectedId = parseInt(tr.dataset.id);
      renderBuilderResults();
    })
  );

  // Selected pool: 5-panel strength view + preview heatmap.
  const selRow = state.pbBuiltRows.find((r) => r.id === state.pbSelectedId);
  if (selRow) {
    $("#pb-selected-summary").innerHTML = `<div class="eq-box" style="margin-top:8px;">
      <b>Selected pool:</b> ${selRow.pool.map((c) => champImg(c, 18) + " " + c).join(" &nbsp; ")}
    </div>`;
    const scores = {
      in_lane_matchup:     selRow.matchup_in_lane,
      out_of_lane_matchup: selRow.matchup_out_of_lane,
      overall_synergy:     selRow.synergy_z,
      blindability:        selRow.blind_z,
      total_score:         selRow.score,
    };
    const strengthWrap = $("#pb-strength");
    _buildStrengthSkeleton(strengthWrap,
      `Pool strength · ${state.role} · pool ${selRow.pool.length} · top-${state.topX}`);
    _renderStrengthCells(strengthWrap, scores, live, "primary");
    renderPoolPreview("#pb-selected-hm", selRow.pool, state.pbView);
  } else {
    $("#pb-selected-summary").innerHTML = `<div class="eq-box" style="margin-top:8px;color:#aaa;">
      ↓ Click a row in the ranked-pools table to see its coverage on the heatmap.
    </div>`;
    $("#pb-strength").innerHTML = "";
    Plotly.purge($("#pb-selected-hm"));
    $("#pb-selected-hm").innerHTML = '<div class="empty-msg">Click a pool row below to display its heatmap.</div>';
  }
}


export { refreshBuilder, refreshComboCount, buildPools, renderBuilderResults };
