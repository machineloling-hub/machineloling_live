import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, ROLES, ROLE_ICON_URL, esc, fmtSign, champImg, setStatus } from "../utils.js";
import { drawPoolHeatmap } from "../widgets/heatmap.js";


// ──────────────────────────────────────────────────────────────────────────
// COVERAGE TAB (Matchup / Synergy)  —  player-friendly redesign
//
// Reframes the data around the question every League player asks:
//   "Against the champs I'll see, do I have an answer — and what are my
//    problem matchups?"
//
// We hide z-scores from the surface (translated to rank-percentile on hover)
// and present everything in winrate-edge (Δ pp) language. The matchup grid
// is kept as the diagnostic centerpiece; everything else is rewritten.
// ──────────────────────────────────────────────────────────────────────────

// A best pool pick that beats a column by ≥ this many winrate points counts
// as "answered". 1.0 pp ≈ "I have an actual counter, not a coin flip."
const ANSWERED_DELTA_PP = 0.045;


// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

// Standard normal CDF via an Abramowitz & Stegun erf approximation.
// Used to translate z-scores into "top N%" language without exposing z.
function normCdf(z) {
  if (!isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((
    1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-z * z / 2);
  return z >= 0 ? 0.5 + 0.5 * y : 0.5 - 0.5 * y;
}

// "+1.5 z" → "top 7%". Rounded to a friendly bucket so it doesn't read like
// false precision (top 6.7% feels overstated).
function zToPercentileText(z) {
  if (z == null || !isFinite(z)) return "—";
  const pct = (1 - normCdf(z)) * 100;
  // Round to nearest 5% above 10%, nearest 1% otherwise.
  const r = pct >= 10 ? Math.round(pct / 5) * 5 : Math.max(1, Math.round(pct));
  return `top ${r}%`;
}

// Plain-language verdict for the best pool pick vs a column.
function deltaVerdict(deltaPp) {
  if (deltaPp == null || !isFinite(deltaPp)) {
    return { tone: "unknown", text: "no data" };
  }
  const s = fmtSign(deltaPp, 1) + "%";
  if (deltaPp >= 2.0) return { tone: "win",  text: `strong edge (${s})` };
  if (deltaPp >= 1.0) return { tone: "win",  text: `solid edge (${s})` };
  if (deltaPp >= 0.3) return { tone: "slim", text: `slight edge (${s}) — borderline` };
  if (deltaPp >= 0)   return { tone: "even", text: `barely even (${s})` };
  return { tone: "loss", text: `losing by ${Math.abs(deltaPp).toFixed(1)}%` };
}

// Re-order all column-indexed arrays in the coverage response by descending
// top-X mean Δ pp (col_score_pp). The engine sorts by z; we want winrate
// edge so the grid reads left-to-right as "best matchups → worst".
//
// Returns a SHALLOW-COPIED cov object with reordered arrays. Original
// (engine) order is preserved on the input for any other consumer.
function reorderByDelta(cov) {
  const n = cov.cols.length;
  const order = Array.from({ length: n }, (_, j) => j);
  order.sort((a, b) => {
    const va = cov.col_score_pp[a] == null ? -Infinity : cov.col_score_pp[a];
    const vb = cov.col_score_pp[b] == null ? -Infinity : cov.col_score_pp[b];
    return vb - va;
  });
  const reorderVec  = (v) => order.map((j) => v[j]);
  const reorderRow  = (row) => order.map((j) => row[j]);
  return {
    ...cov,
    cols:           reorderVec(cov.cols),
    col_pick_rates: reorderVec(cov.col_pick_rates),
    col_max_pp:     reorderVec(cov.col_max_pp),
    col_max_z:      reorderVec(cov.col_max_z),
    col_score_pp:   reorderVec(cov.col_score_pp),
    col_score_z:    reorderVec(cov.col_score_z),
    best_row_idx:   reorderVec(cov.best_row_idx),
    mat:            cov.mat.map(reorderRow),
    mat_z:          cov.mat_z.map(reorderRow),
    top_idx_mat:    cov.top_idx_mat.map(reorderRow),
  };
}

// Compute the boundary between "answered" and "problem" columns using the
// Δ-pp rule (best pool pick ≥ +ANSWERED_DELTA_PP). Operates on the reordered
// cov so the boundary is just the first column whose max_pp dips below.
function answeredBoundary(cov) {
  for (let j = 0; j < cov.col_max_pp.length; j++) {
    const v = cov.col_max_pp[j];
    if (v == null || v < ANSWERED_DELTA_PP) return j;
  }
  return null;        // every column answered
}

// Read the current sidebar state into plain-English chip strings so the
// player can see what's driving the numbers without scrolling up.
function filterChips(cov) {
  const chips = [];
  chips.push(`Considering top ${cov.top_x} pick${cov.top_x === 1 ? "" : "s"}`);
  chips.push(`Opponents ≥ ${(state.prFloor * 100).toFixed(2)}% pickrate`);
  if (state.prWeighted) chips.push("Weighting by pickrate");
  return chips;
}


// ──────────────────────────────────────────────────────────────────────────
// Section renderers
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

// One-sentence headline answer at the top of the tab.
function renderHeadlineCard(cov) {
  const div = $("#coverage-headline");
  if (cov.empty) {
    div.innerHTML = `<div class="empty-msg">Add champions to your pool to see coverage.</div>`;
    return;
  }
  const isSyn = state.view === "synergy";
  const noun = isSyn ? "teammates" : "opponents";
  const verb = isSyn ? "synergises with" : "answers";
  const nTotal = cov.cols.length;
  const answeredFlags = cov.col_max_pp.map((v) => v != null && v >= ANSWERED_DELTA_PP);
  const nAnswered = answeredFlags.filter(Boolean).length;
  const nProblem = nTotal - nAnswered;

  // Mean winrate edge on the answered columns (best pool pick's Δ pp).
  let sum = 0, count = 0;
  for (let j = 0; j < nTotal; j++) {
    if (answeredFlags[j] && cov.col_max_pp[j] != null) {
      sum += cov.col_max_pp[j];
      count++;
    }
  }
  const avgEdge = count > 0 ? sum / count : null;

  const chips = filterChips(cov).map((c) => `<span class="cov-chip">${esc(c)}</span>`).join("");
  const avgEdgeText = avgEdge == null ? "—" : `+${avgEdge.toFixed(1)}%`;
  const problemLine = nProblem === 0
    ? `<div class="cov-headline-sub cov-ok">✓ Every common ${noun.slice(0, -1)} has an answer in your pool.</div>`
    : `<div class="cov-headline-sub"><a href="#coverage-problems" class="cov-problem-link">${nProblem} problem ${nProblem === 1 ? "matchup" : "matchups"} ↓</a></div>`;

  div.innerHTML = `
    <div class="cov-headline-card">
      <div class="cov-headline-main">
        <div class="cov-headline-big">
          Your pool ${verb} <strong>${nAnswered} / ${nTotal}</strong> common ${noun}.
        </div>
        <div class="cov-headline-mid">
          Average winning edge on the ones you handle: <strong>${avgEdgeText}</strong> winrate.
        </div>
        ${problemLine}
      </div>
      <div class="cov-headline-chips">${chips}</div>
    </div>`;
}

// Worst-first list of columns where the pool's best pick fails the Δ rule.
function renderProblemMatchups(cov) {
  const div = $("#coverage-problems");
  if (cov.empty) { div.innerHTML = ""; return; }
  const noun = state.view === "matchup" ? "opponents" : "partners";
  const pairWord = state.view === "matchup" ? "matchup" : "pairing";
  const isMatchup = state.view === "matchup";

  // Columns sorted ascending by col_max_pp (worst first).
  const rowsList = [];
  for (let j = 0; j < cov.cols.length; j++) {
    if (cov.col_max_pp[j] == null || cov.col_max_pp[j] >= ANSWERED_DELTA_PP) continue;
    rowsList.push({
      opp: cov.cols[j],
      bestPick: cov.rows[cov.best_row_idx[j]],
      deltaPp: cov.col_max_pp[j],
      maxZ: cov.col_max_z[j],
    });
  }
  rowsList.sort((a, b) => (a.deltaPp ?? -Infinity) - (b.deltaPp ?? -Infinity));

  if (rowsList.length === 0) {
    div.innerHTML = "";    // headline card already says "all covered"
    return;
  }

  const chips = rowsList.map((r) => {
    const v = deltaVerdict(r.deltaPp);
    const pctText = zToPercentileText(r.maxZ);
    const linker = isMatchup ? "vs" : "with";
    return `
      <div class="cov-problem-row tone-${v.tone}">
        <div class="cov-problem-opp">${champImg(r.opp, 28)}<b>${esc(r.opp)}</b></div>
        <div class="cov-problem-resp">
          <span class="cov-problem-label">Best ${linker}:</span>
          ${champImg(r.bestPick, 22)}<b>${esc(r.bestPick)}</b>
          <span class="cov-problem-verdict tone-${v.tone}">${esc(v.text)}</span>
          <span class="cov-problem-pct" title="Rank of your best pick across all ${state.role} champions vs ${esc(r.opp)}.">${esc(pctText)}</span>
        </div>
      </div>`;
  }).join("");

  div.innerHTML = `
    <h3 class="section-h cov-section-h">
      Problem ${pairWord}s — these need a plan
      <span class="cov-section-sub">${rowsList.length} of ${cov.cols.length} ${noun}</span>
    </h3>
    <div class="cov-problem-list">${chips}</div>`;
}

// Matchup grid (Plotly). Same widget; we just feed it Δ-pp values for the
// bar and the threshold line, so the surface stays z-free.
function renderCoverageHeatmap(cov) {
  const heat = $("#heatmap");
  if (cov.empty) {
    Plotly.purge(heat);
    heat.innerHTML = '<div class="empty-msg">Add champions to your pool to see coverage.</div>';
    return;
  }
  if (!heat.classList.contains("js-plotly-plot")) heat.innerHTML = "";

  const boundary = answeredBoundary(cov);

  drawPoolHeatmap(heat, {
    rows: cov.rows, cols: cov.cols, mat: cov.mat,
    top_idx_mat: cov.top_idx_mat, top_x: cov.top_x,
    col_pick_rates: cov.col_pick_rates,
    // Feed the bar Δ-pp (winrate edge) values instead of z. Threshold line
    // sits at the same Δ-pp value used everywhere else on the tab.
    bar_z: cov.col_score_pp, bar_pp: cov.col_score_pp,
    coveredBoundary: boundary,
    threshold: ANSWERED_DELTA_PP,
    colorRange: state.view === "matchup" ? 3.0 : 1.5,
    barLabel: `Top-${cov.top_x} edge (Δ%)`,
    barExplain:
      "<b>Top-" + cov.top_x + " edge</b> = average winrate edge of your " +
      cov.top_x + " best picks vs this opponent. Bars left = your strongest " +
      "matchups, bars right = your weakest. The dashed line is the answered/" +
      "problem threshold (+" + ANSWERED_DELTA_PP.toFixed(3) + "% winrate).",
    boundaryLabel: `${ANSWERED_DELTA_PP.toFixed(3)}%`,
    pairSep: state.view === "matchup" ? "vs" : "w/",
  });
}

// Two-column card: your MVPs (top 3 by columns where they're #1) + your
// fillers (bottom 2). Replaces the dense 6-column percentage table.
function renderMVPsCard(cov) {
  const div = $("#coverage-mvps");
  if (cov.empty) { div.innerHTML = ""; return; }
  const { rows, cols, mat, best_row_idx, top_idx_mat } = cov;
  const nCols = cols.length;
  const noun = state.view === "matchup" ? "opponents" : "partners";
  const linker = state.view === "matchup" ? "Hard-counters" : "Top synergy with";

  // Per-pool-champ stats: # columns where they're #1, mean Δ when they're #1,
  // # columns where they're in top-X at all.
  const stats = rows.map((champ, i) => {
    let top1Count = 0, top1DeltaSum = 0;
    let topXCount = 0;
    for (let j = 0; j < nCols; j++) {
      if (best_row_idx[j] === i) {
        top1Count++;
        if (mat[i][j] != null) top1DeltaSum += mat[i][j];
      }
      for (let k = 0; k < cov.top_x; k++) {
        if (top_idx_mat[k][j] === i) { topXCount++; break; }
      }
    }
    return {
      champ, top1Count, topXCount,
      top1MeanDelta: top1Count > 0 ? top1DeltaSum / top1Count : null,
    };
  });

  // MVPs: rank by top1Count desc (ties broken by top1MeanDelta desc).
  const ranked = [...stats].sort((a, b) =>
    b.top1Count - a.top1Count ||
    (b.top1MeanDelta ?? -Infinity) - (a.top1MeanDelta ?? -Infinity)
  );
  const mvps = ranked.slice(0, Math.min(3, ranked.length));
  // Fillers: bottom 2 (skip champs already in MVP list).
  const mvpSet = new Set(mvps.map((s) => s.champ));
  const fillers = ranked.filter((s) => !mvpSet.has(s.champ)).slice(-2).reverse();

  const mvpRow = (s) => {
    if (s.top1Count === 0) {
      return `<div class="cov-mvp-row">${champImg(s.champ, 28)}
        <div class="cov-mvp-text"><b>${esc(s.champ)}</b>
          <span class="cov-mvp-sub">never your best pick — ${s.topXCount}/${nCols} top-${cov.top_x} appearances</span>
        </div></div>`;
    }
    const avg = s.top1MeanDelta != null ? `+${s.top1MeanDelta.toFixed(1)}%` : "—";
    return `<div class="cov-mvp-row">${champImg(s.champ, 28)}
      <div class="cov-mvp-text"><b>${esc(s.champ)}</b>
        <span class="cov-mvp-sub">${linker} <b>${s.top1Count}</b> of ${nCols} ${noun} (avg ${avg})</span>
      </div></div>`;
  };

  const fillerRow = (s) => {
    const sub = s.top1Count === 0
      ? `never your best pick in this role`
      : `top in just <b>${s.top1Count}</b> of ${nCols} ${noun}`;
    return `<div class="cov-mvp-row cov-mvp-filler">${champImg(s.champ, 28)}
      <div class="cov-mvp-text"><b>${esc(s.champ)}</b>
        <span class="cov-mvp-sub">${sub}</span>
      </div></div>`;
  };

  div.innerHTML = `
    <div class="cov-mvp-card">
      <div class="cov-mvp-col">
        <div class="cov-mvp-title">Your MVPs in this role</div>
        ${mvps.map(mvpRow).join("")}
      </div>
      <div class="cov-mvp-col">
        <div class="cov-mvp-title">Your fillers / overlap</div>
        ${fillers.length ? fillers.map(fillerRow).join("") : `<div class="cov-mvp-sub">All ${rows.length} pool champs pull their weight.</div>`}
      </div>
    </div>`;
}

async function refreshCoverage() {
  setStatus("loading…");
  const raw = await fetchCoverage();
  // Reorder columns by Δ-pp once, then every section reads the same view.
  const cov = raw.empty ? raw : reorderByDelta(raw);
  renderHeadlineCard(cov);
  renderProblemMatchups(cov);
  renderCoverageHeatmap(cov);
  renderMVPsCard(cov);
  setStatus(cov.empty ? "" : `${cov.rows.length} pool × ${cov.cols.length} ${state.view === "matchup" ? "opponents" : "partners"}`);
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

