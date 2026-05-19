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

// ──────────────────────────────────────────────────────────────────────────
// REPLACEMENT FINDER TAB
// ──────────────────────────────────────────────────────────────────────────
async function refreshReplacements() {
  const eq = $("#repl-equation");
  const lockedWrap = $("#repl-locked-wrap");
  const summary = $("#repl-summary");
  const table = $("#repl-table");

  // Equation
  eq.innerHTML = `<div>Δ score = Score(new pool) − Score(current pool), where ${renderScoreEquation("Score")}</div>
    <div class="plain">Candidates ranked by how much they'd improve the weighted total if applied.</div>`;

  if (state.pool.length === 0) {
    lockedWrap.innerHTML = ""; summary.innerHTML = "";
    table.innerHTML = '<div class="empty-msg">Add champions to your pool to see replacement candidates.</div>';
    return;
  }

  // Locked checkboxes (replace mode only)
  if (state.replMode === "replace") {
    lockedWrap.innerHTML = `<div style="font-size:13px;color:#aaa;margin-bottom:6px;">Locked pool champs (won't be swapped out):</div>` +
      state.pool.map((ch) => {
        const checked = state.replLocked.includes(ch) ? "checked" : "";
        return `<label class="lock-item">
          <input type="checkbox" data-champ="${ch}" ${checked}>
          ${champImg(ch, 18)} ${ch}
        </label>`;
      }).join("");
    lockedWrap.querySelectorAll("input[type=checkbox]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const ch = cb.dataset.champ;
        if (cb.checked) state.replLocked = [...new Set([...state.replLocked, ch])];
        else state.replLocked = state.replLocked.filter((x) => x !== ch);
        refreshReplacements();
      })
    );
  } else {
    lockedWrap.innerHTML = "";
  }

  table.innerHTML = '<div class="empty-msg">Scoring candidates…</div>';
  // Live curves feed the Δσ table — request both base and (if add-mode)
  // new pool size in one call so we can reference both distributions.
  const basePoolSize = state.pool.length;
  const newPoolSize = state.replMode === "add" ? basePoolSize + 1 : basePoolSize;
  // σ scenario must match the curves call (basePoolSize) so the backend's
  // σ-normalized total_score lines up with the displayed primary curve.
  // Using newPoolSize would miss the cache when add-mode bumps pool_size and
  // fall back to σ=1.0, producing absurd σ values (delta_total raw / SD-of-
  // σ-normalized-curve mismatch).
  const replScenario = _sigmaScenarioKey({
    role: state.role, patch: state.patch, pool_size: basePoolSize,
    top_x: state.topX, pr_floor: state.prFloor, pr_weighted: state.prWeighted,
    shrink_alpha: state.shrinkAlpha,
  });
  // Await curves first to populate σs before issuing replacements. Cached
  // after first call so warm path stays fast; cold path pays one round-trip.
  const live = await fetchLiveStrengthCurves({
    role: state.role, patch: state.patch,
    pool_size: basePoolSize, top_x: state.topX,
    pr_floor: state.prFloor, pr_weighted: state.prWeighted,
    shrink_alpha: state.shrinkAlpha,
    weights: state.weights,
    extra_pool_size: (newPoolSize !== basePoolSize ? newPoolSize : null),
    extra_top_x: (newPoolSize !== basePoolSize ? state.topX : null),
  });
  const data = await apiFetch("/api/replacements", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role, pool: state.pool, mode: state.replMode,
      locked: state.replLocked, top_x: state.topX,
      pr_floor: state.prFloor, pr_weighted: state.prWeighted,
      patch: state.patch, shrink_alpha: state.shrinkAlpha,
      w_in_lane: state.weights.in_lane, w_out_lane: state.weights.out_lane,
      w_synergy: state.weights.synergy, w_blind: state.weights.blind,
      ..._sigmaBody(replScenario),
    }),
  }).then((r) => r.json());

  if (data.empty || !data.rows.length) {
    summary.innerHTML = "";
    table.innerHTML = '<div class="empty-msg">No replacement candidates.</div>';
    state.replRanked = null; state.replSelectedCand = null;
    Plotly.purge($("#repl-new-pool-hm")); $("#repl-new-pool-hm").innerHTML = "";
    return;
  }

  state.replRanked = data.rows;
  // Keep current selection if still valid; else default to top
  if (!state.replSelectedCand || !data.rows.find((r) => r.candidate === state.replSelectedCand)) {
    state.replSelectedCand = data.rows[0].candidate;
  }

  // Summary: SELECTED candidate (matches the strength panel and heatmap below
  // so the user can't see "Add Yuumi" up here while previewing Brand below).
  const selected = data.rows.find((r) => r.candidate === state.replSelectedCand) || data.rows[0];
  const champ = (n) => `${champImg(n, 18)} ${n}`;
  const action = state.replMode === "add"
    ? `Add ${champ(selected.candidate)}`
    : `Drop ${champ(selected.remove)} → Add ${champ(selected.candidate)}`;
  summary.innerHTML = `<div class="stat-pill">Action: <b>${action}</b></div>`;

  const showRemove = state.replMode === "replace";

  // Convert raw-score deltas into Δσ using the live reference curves.
  // Each candidate moves the pool's σ on each curve by some amount; we
  // display that shift directly so the user sees how much closer to
  // "very strong" each swap pushes them.
  const baseScores = data.base_scores || {};
  const DELTA_FIELDS = REPL_DELTA_FIELDS;
  function _refStats(mode, which) {
    const slot = _slotFromLive(live, mode, which);
    return slot ? { mean: slot[0], sd: slot[1] } : null;
  }
  // Match the strength panel's σ math exactly: OLD on primary curve
  // (= Pool Health's σ for the current pool), NEW on extra curve (= Pool
  // Health's σ after the actual add). Δσ = newSig − baseSig, mixed across
  // references but identical to the (+X.XXσ) values shown beside each
  // curve above.
  const refBase = {}, refNew = {}, baseSigma = {};
  const newWhich = (live?.extra && live.extra.pool_size === newPoolSize) ? "extra" : "primary";
  const useExtra = newWhich === "extra";
  for (const m of Object.keys(DELTA_FIELDS)) {
    refBase[m] = _refStats(m, "primary");
    refNew[m]  = _refStats(m, newWhich);
    const baseRaw = baseScores[m];                     // OLD: Pool Health's raw value
    if (refBase[m] && baseRaw != null && refBase[m].sd > 0) {
      baseSigma[m] = (baseRaw - refBase[m].mean) / refBase[m].sd;
    } else {
      baseSigma[m] = null;
    }
  }
  function _dSigmaFor(row, mode) {
    const ref = refNew[mode];
    // NEW: for total_score use the backend's re-projected base (in new σs)
    // so baseRawForNew + delta = new_total in new σs. Per-component values
    // are σ-independent so the raw base works directly.
    const baseRawForNew = (useExtra && mode === "total_score" && baseScores.total_score_new_sigma != null)
      ? baseScores.total_score_new_sigma
      : baseScores[mode];
    const delta = row[DELTA_FIELDS[mode]];
    if (!ref || baseRawForNew == null || delta == null || !(ref.sd > 0)) return null;
    const newScore = baseRawForNew + delta;
    const newSig = (newScore - ref.mean) / ref.sd;
    const baseSig = baseSigma[mode];
    if (baseSig == null) return null;
    return newSig - baseSig;
  }

  const dCell = (v, scale, suffix = "") => {
    if (v == null) return '<td class="cell-na">—</td>';
    const bg = tealOrangeBg(v, scale);
    return `<td style="background:${bg};color:#fff;font-weight:bold;text-align:right;border-radius:2px;padding:4px 8px;">${fmtSign(v, 2)}${suffix}</td>`;
  };
  const SIGMA_SCALE = 0.3;       // ±0.3σ ≈ saturated cell color
  const TOTAL_SCALE = 0.1;       // total raw delta range

  const tr = data.rows.slice(0, 100).map((r) => {
    const sel = r.candidate === state.replSelectedCand ? "selected" : "";
    const dL = _dSigmaFor(r, "in_lane_matchup");
    const dO = _dSigmaFor(r, "out_of_lane_matchup");
    const dS = _dSigmaFor(r, "overall_synergy");
    const dB = _dSigmaFor(r, "blindability");
    const dT = _dSigmaFor(r, "total_score");
    const tip = state.replMode === "add"
      ? `Click to preview pool with ${r.candidate} added`
      : `Click to preview swap: drop ${r.remove ?? "?"} → add ${r.candidate}`;
    return `<tr class="${sel}" data-cand="${r.candidate}" title="${tip}">
      <td>${champImg(r.candidate, 22)} <b>${r.candidate}</b></td>
      ${showRemove ? `<td>${r.remove ? champImg(r.remove, 22) + " " + r.remove : "—"}</td>` : ""}
      ${dCell(dL, SIGMA_SCALE, "σ")}
      ${dCell(dO, SIGMA_SCALE, "σ")}
      ${dCell(dS, SIGMA_SCALE, "σ")}
      ${dCell(dB, SIGMA_SCALE, "σ")}
      ${dCell(dT, SIGMA_SCALE, "σ")}
    </tr>`;
  }).join("");
  const sigmaHint = '<span style="color:#888;font-size:10px;">Δσ</span>';
  table.innerHTML = `<table class="std-table" style="margin-top:10px;">
    <thead><tr>
      <th>Candidate</th>
      ${showRemove ? "<th>Drop</th>" : ""}
      <th style="color:${MATCHUP_COLOR};">In-lane matchup<br>${sigmaHint}</th>
      <th style="color:${MATCHUP_COLOR};">Out-of-lane matchup<br>${sigmaHint}</th>
      <th style="color:${SYNERGY_COLOR};">Overall synergy<br>${sigmaHint}</th>
      <th style="color:${BLIND_COLOR};">Blindability<br>${sigmaHint}</th>
      <th style="color:${TOTAL_COLOR};">Δ total<br>${sigmaHint}</th>
    </tr></thead>
    <tbody>${tr}</tbody>
  </table>
  ${data.rows.length > 100 ? `<div style="color:#888;font-size:12px;margin-top:4px;">Showing top 100 of ${data.rows.length}.</div>` : ""}`;
  // Clicking a candidate row only PREVIEWS — never mutates the pool. The
  // selected candidate drives the strength panel + heatmap so the user can
  // compare candidates before committing via the sidebar pool chips.
  table.querySelectorAll("tr[data-cand]").forEach((tr) =>
    tr.addEventListener("click", () => {
      state.replSelectedCand = tr.dataset.cand;
      refreshReplacements();
    })
  );

  // Strength panel — same 4 curves as Pool Health, plus new-pool marker.
  renderReplStrengthPanel(data, live, basePoolSize, newPoolSize);

  // Render new-pool preview heatmap
  // Default to mirror matchup (vs same role) for Replacement Finder
  state.replView = populateViewSelect($("#repl-view"), state.role, state.replView, `matchup_${state.role}`);
  renderReplPreview();
}

function renderReplPreview() {
  if (!state.replRanked || !state.replSelectedCand) {
    Plotly.purge($("#repl-new-pool-hm")); $("#repl-new-pool-hm").innerHTML = "";
    return;
  }
  const row = state.replRanked.find((r) => r.candidate === state.replSelectedCand);
  if (!row) return;
  // The displayed heatmap shows the actual NEW pool with the candidate
  // pinned to the bottom row. In replace mode the dropped champ is sent as
  // `extra_rows` so the backend appends them BELOW the new pool's rows
  // (still at the bottom of the heatmap) WITHOUT influencing top-X bolding,
  // bars, or column ordering — those reflect only the real new pool.
  let actualPool;            // affects scoring / bars
  let extraRows = [];        // display-only, appended after pool rows
  let highlightChamps;
  let labelSuffix = {};
  if (state.replMode === "add") {
    actualPool = [...state.pool, row.candidate];
    highlightChamps = [row.candidate];
    labelSuffix[row.candidate] = "(add)";
  } else {
    const rest = state.pool.filter((c) => c !== row.remove);
    actualPool = [...rest, row.candidate];
    if (row.remove) {
      extraRows = [row.remove];
      labelSuffix[row.remove] = "(remove)";
    }
    highlightChamps = [row.candidate, row.remove].filter(Boolean);
    labelSuffix[row.candidate] = "(add)";
  }
  renderPoolPreview("#repl-new-pool-hm", actualPool, state.replView, {
    highlightChamps, labelSuffix, extraRows,
  });
}

// Default sub-tab per (role, view). Matchup → mirror (same role). Synergy →
// botlane partner (ADC ↔ SUP) for botlane, MID ↔ JUNGLE pairing for mid/jungle,
// TOP → JUNGLE.

export { refreshReplacements, renderReplPreview };
