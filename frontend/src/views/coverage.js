import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, ROLES, ROLE_ICON_URL, esc, fmtSign, champImg, setStatus } from "../utils.js";
import { drawPoolHeatmap } from "../widgets/heatmap.js";


// ──────────────────────────────────────────────────────────────────────────
// COVERAGE TAB (Matchup / Synergy)
// ──────────────────────────────────────────────────────────────────────────
async function fetchCoverage() {
  if (state.pool.length === 0) return { empty: true };
  const r = await apiFetch("/api/coverage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role, other_role: state.otherRole,
      mode: state.view, pool: state.pool,
      top_x: state.topX, pr_floor: state.prFloor, pr_weighted: state.prWeighted,
      patch: state.patch, shrink_alpha: state.shrinkAlpha,
    }),
  });
  return await r.json();
}

function renderCoverageHeatmap(cov) {
  const heat = $("#heatmap");
  if (cov.empty) {
    Plotly.purge(heat);
    heat.innerHTML = '<div class="empty-msg">Add champions to your pool to see coverage.</div>';
    return;
  }
  if (!heat.classList.contains("js-plotly-plot")) heat.innerHTML = "";

  const { rows, cols, mat, col_score_z, col_score_pp, top_idx_mat, top_x } = cov;
  // Cells are sorted by col_score_z desc, but the covered/uncovered split uses
  // col_max_z. Find the first column whose best pool pick fails the threshold;
  // a vertical line at that boundary visually marks "covered ↔ uncovered".
  const threshold = cov.threshold;
  // Boundary uses col_score_z (top-X mean z) — same metric the bar plots —
  // so the vertical gap line up where the bars cross the horizontal z=threshold.
  let coveredBoundary = null;
  for (let j = 0; j < cov.col_score_z.length; j++) {
    if (cov.col_score_z[j] < threshold) { coveredBoundary = j; break; }
  }

  drawPoolHeatmap(heat, {
    rows, cols, mat, top_idx_mat, top_x,
    col_pick_rates: cov.col_pick_rates,
    bar_z: col_score_z, bar_pp: col_score_pp,
    coveredBoundary,
    threshold,
    colorRange: state.view === "matchup" ? 3.0 : 1.5,
    barLabel: `Top-${top_x} z`,
    pairSep: state.view === "matchup" ? "vs" : "w/",
  });
}

// Shared pool-heatmap renderer. Used by Coverage tab + Pool Builder preview +
// Replacement preview. Renders cells, top-X outlines, row+col champion icons,
// vertical column labels, and a per-column score bar above the cells.
function renderCoverageStats(cov) {
  const banner = $("#stats-banner");
  if (cov.empty) { banner.innerHTML = ""; return; }
  const s = cov.stats;
  const noun = state.view === "matchup" ? "opponents" : "partners";
  const topxLabel = s.top_x > 1 ? `Mean top-${s.top_x} z` : "Mean best z";
  banner.innerHTML = `
    <div class="stat-pill">Total ${noun}: <b>${s.n_total}</b></div>
    <div class="stat-pill cov">Covered (z ≥ ${s.threshold.toFixed(1)}): <b>${s.n_covered}</b></div>
    <div class="stat-pill unc">Uncovered: <b>${s.n_uncovered}</b></div>
    <div class="stat-pill">${topxLabel}: <b>${fmtSign(s.mean_topx_z)}</b></div>
    <div class="stat-pill">Mean best Δ: <b>${fmtSign(s.mean_best_pp)} pp</b></div>
  `;
}

function renderUncovered(cov) {
  const div = $("#uncovered");
  if (cov.empty) { div.innerHTML = ""; return; }
  const s = cov.stats;
  const noun = state.view === "matchup" ? "opponents" : "partners";
  if (s.n_uncovered === 0) {
    div.innerHTML = `<div class="cov-banner">✓ All ${s.n_total} ${noun} covered at z ≥ ${s.threshold.toFixed(1)}.</div>`;
    return;
  }
  const chips = cov.uncovered.map((u) => `
    <span class="uncov-chip">${champImg(u.champion)}<b>${esc(u.champion)}</b>
      <span class="best">${esc(u.best_pool_pick)}: z=${fmtSign(u.max_z)} (${fmtSign(u.max_pp)} pp)</span>
    </span>`).join(" ");
  div.innerHTML = `
    <p class="uncov-header">${s.n_uncovered} / ${s.n_total} ${noun} uncovered (best pool z &lt; ${s.threshold.toFixed(1)}), worst-first.</p>
    ${chips}`;
}

async function refreshCoverage() {
  setStatus("loading…");
  const cov = await fetchCoverage();
  renderCoverageStats(cov);
  renderCoverageHeatmap(cov);
  renderTopXTable(cov);
  renderUncovered(cov);
  setStatus(cov.empty ? "" : `${cov.rows.length} pool × ${cov.cols.length} ${state.view === "matchup" ? "opponents" : "partners"}`);
}

// Per-pool-champ summary of top-X performance for the current heatmap view.
// Shows: % of opponents/partners where this champ is in the top-X *and*
// covered (z ≥ threshold) vs in top-X but below threshold; plus the average
// Δ in pp over the next-best pool pick when this champ is the #1 best.
function renderTopXTable(cov) {
  const div = $("#topx-table");
  if (cov.empty) { div.innerHTML = ""; return; }
  const { rows, cols, mat, mat_z, top_idx_mat, top_x, threshold } = cov;
  const nCols = cols.length;
  const noun = state.view === "matchup" ? "opponents" : "partners";

  // Per-row counters
  const stats = rows.map((champ, i) => {
    let coveredCount = 0;
    let uncoveredCount = 0;
    let nBest = 0;
    let sumDeltaOverSecond = 0;
    for (let j = 0; j < nCols; j++) {
      // Build top-X row indices for column j once per (i,j)? Could optimize
      // but n is small (8 × 50 max).
      let inTopX = false;
      for (let k = 0; k < top_x; k++) {
        if (top_idx_mat[k][j] === i) { inTopX = true; break; }
      }
      if (inTopX) {
        if (mat_z[i][j] >= threshold) coveredCount++;
        else uncoveredCount++;
      }
      // Best pick in column → compare to 2nd-best pool pick
      if (top_idx_mat[0][j] === i && top_x >= 2) {
        const second = top_idx_mat[1][j];
        sumDeltaOverSecond += mat[i][j] - mat[second][j];
        nBest++;
      }
    }
    return {
      champ,
      pctCovered:   100 * coveredCount   / nCols,
      pctUncovered: 100 * uncoveredCount / nCols,
      pctTotal:     100 * (coveredCount + uncoveredCount) / nCols,
      pctBest:      100 * nBest / nCols,
      avgDelta:     nBest > 0 ? sumDeltaOverSecond / nBest : null,
      nBest,
    };
  });

  // Sort by total top-X share desc
  stats.sort((a, b) => b.pctTotal - a.pctTotal);

  const tr = stats.map((s) => `
    <tr>
      <td>${champImg(s.champ, 22)} <b>${esc(s.champ)}</b></td>
      <td style="text-align:right;">${s.pctCovered.toFixed(0)}%</td>
      <td style="text-align:right;">${s.pctUncovered.toFixed(0)}%</td>
      <td style="text-align:right;">${s.pctTotal.toFixed(0)}%</td>
      <td style="text-align:right;">${s.pctBest.toFixed(0)}%</td>
      <td style="text-align:right;">${s.avgDelta != null ? fmtSign(s.avgDelta, 2) + " pp" : "—"}
        <span style="color:#888;font-size:11px;">(n=${s.nBest})</span></td>
    </tr>
  `).join("");

  div.innerHTML = `
    <h3 class="section-h">Per-pool-champ top-${top_x} share (${noun})</h3>
    <table class="std-table">
      <thead><tr>
        <th>Pool champ</th>
        <th style="text-align:right;">% in top-${top_x} when covered<br><span style="color:#888;font-weight:normal;font-size:10px;">z ≥ ${threshold.toFixed(1)}</span></th>
        <th style="text-align:right;">% in top-${top_x} when below threshold<br><span style="color:#888;font-weight:normal;font-size:10px;">z &lt; ${threshold.toFixed(1)}</span></th>
        <th style="text-align:right;">% in top-${top_x} total</th>
        <th style="text-align:right;">% where #1<br><span style="color:#888;font-weight:normal;font-size:10px;">best pool pick</span></th>
        <th style="text-align:right;">Avg Δ over 2nd best<br><span style="color:#888;font-weight:normal;font-size:10px;">when this champ is #1</span></th>
      </tr></thead>
      <tbody>${tr}</tbody>
    </table>`;
}

function renderRoleSubTabs() {
  const opts = state.view === "matchup"
    ? ROLES
    : ROLES.filter((r) => r !== state.role);
  if (!opts.includes(state.otherRole)) state.otherRole = opts[0];
  const cont = $("#role-tabs");
  cont.classList.add("role-strip");
  cont.setAttribute("role", "radiogroup");
  cont.setAttribute("aria-label", state.view === "matchup" ? "Opponent role" : "Partner role");
  cont.innerHTML = opts.map((r) => `
    <button type="button" class="role-tile${r === state.otherRole ? " active" : ""}"
            role="radio" aria-checked="${r === state.otherRole}"
            data-role="${r}" title="${r}" aria-label="${r}">
      <img src="${esc(ROLE_ICON_URL(r))}" alt="">
    </button>
  `).join("");
  cont.querySelectorAll(".role-tile").forEach((b) =>
    b.addEventListener("click", () => {
      state.otherRole = b.dataset.role;
      renderRoleSubTabs();
      refreshCoverage();
    })
  );
}


export { refreshCoverage, renderRoleSubTabs };
