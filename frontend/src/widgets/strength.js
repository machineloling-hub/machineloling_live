import { state, _sigmaScenarioKey, _sigmasFor, _sigmaBody, _updateSigmasFromCurves } from "../state.js";
import { apiFetch, apiPost } from "../api.js";
import { $, fmtSign, champImg, MATCHUP_COLOR, SYNERGY_COLOR, BLIND_COLOR, STRENGTH_LABEL_COLORS, setEmptyState } from "../utils.js";

// ──────────────────────────────────────────────────────────────────────────
// POOL HEALTH TAB
// ──────────────────────────────────────────────────────────────────────────
// ── Pool strength summary (top of Pool Health) ────────────────────────────
// Live-computes the 4 reference curves for the user's current state.
// Cached per (role, patch, pool_size, top_x, pr_floor, pr_weighted, extra_*)
// so repeat reads are instant.
async function fetchLiveStrengthCurves({
  role, patch, pool_size, top_x, pr_floor, pr_weighted,
  shrink_alpha = 1.0,
  weights = { in_lane: 1.0, out_lane: 1.0, synergy: 1.0, blind: 0.2 },
  extra_pool_size = null, extra_top_x = null,
}) {
  const scenarioKey = _sigmaScenarioKey({ role, patch, pool_size, top_x, pr_floor, pr_weighted, shrink_alpha });
  const sigmas = _sigmasFor(scenarioKey);
  // Cache key includes sigmas so the cached total_score curve matches the
  // σ-scaling the request was made with.
  const key = JSON.stringify([role, patch, pool_size, top_x, pr_floor, pr_weighted, shrink_alpha, weights, sigmas, extra_pool_size, extra_top_x]);
  if (state.liveCurvesCache.has(key)) {
    // Cache hits skip the .then() chain below, so refresh componentSigmas
    // here too. Otherwise toggling sliders away and back leaves σs stuck
    // on whichever scenario was visited last, which makes pool_summary +
    // total_score compute against the wrong reference σs.
    const cached = state.liveCurvesCache.get(key);
    _updateSigmasFromCurves(cached, scenarioKey);
    return cached;
  }
  if (state.liveCurvesInflight.has(key)) return state.liveCurvesInflight.get(key);
  const body = {
    my_role: role, patch, pool_size, top_x,
    pr_floor, pr_weighted, shrink_alpha,
    w_in_lane: weights.in_lane, w_out_lane: weights.out_lane,
    w_synergy: weights.synergy, w_blind: weights.blind,
    sigma_in_lane: sigmas.in_lane, sigma_out_lane: sigmas.out_lane,
    sigma_synergy: sigmas.synergy, sigma_blind:    sigmas.blind,
    extra_pool_size, extra_top_x,
  };
  const p = apiFetch("/api/pool_strength_curves", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      state.liveCurvesCache.set(key, d);
      state.liveCurvesInflight.delete(key);
      _updateSigmasFromCurves(d, scenarioKey);
      return d;
    })
    .catch(() => { state.liveCurvesInflight.delete(key); return null; });
  state.liveCurvesInflight.set(key, p);
  return p;
}

const STRENGTH_MODES = [
  { key: "in_lane_matchup",     label: "In-Lane Matchup" },
  { key: "out_of_lane_matchup", label: "Out-of-Lane Matchup" },
  { key: "overall_synergy",     label: "Overall Synergy" },
  { key: "blindability",        label: "Blindability"     },
  { key: "total_score",         label: "Total Score"      },
];

// 5-tier σ-from-mean labels + colors (deep green → red).
const STRENGTH_TIERS = [
  { min:  1.5, label: "Very strong", color: "#21a366" },
  { min:  0.5, label: "Strong",      color: "#69b06b" },
  { min: -0.5, label: "Average",     color: "#cdb04a" },
  { min: -1.5, label: "Weak",        color: "#d68a3f" },
  { min: -Infinity, label: "Very weak", color: "#cf4a3f" },
];
function strengthTier(sigma) {
  if (sigma == null || !isFinite(sigma)) return null;
  return STRENGTH_TIERS.find((t) => sigma >= t.min) || STRENGTH_TIERS[STRENGTH_TIERS.length - 1];
}

// Linear interpolation of percentile from the precomputed grid (5% steps).
function percentileFromGrid(score, grid, ps) {
  for (let i = 1; i < ps.length; i++) {
    if (score <= ps[i]) {
      const lo = ps[i - 1], hi = ps[i];
      const t = hi > lo ? (score - lo) / (hi - lo) : 0;
      return grid[i - 1] + t * (grid[i] - grid[i - 1]);
    }
  }
  return 100;
}

// Live curves return shape: {primary: {pool_size, top_x, data: {metric: slot}}, extra?: {...}}.
// Pass `which` = "primary" or "extra" to pick the bucket.
function _slotFromLive(live, modeKey, which = "primary") {
  return live?.[which]?.data?.[modeKey] || null;
}

// Variant that accepts σ values directly (already computed against whichever
// reference curve is appropriate per side). Lets the Replacement Finder
// strength panel mark OLD σ on the primary (size-N) curve and NEW σ on the
// extra (size-N+1) curve, both shown on a single σ-axis density plot. The
// curve drawn is `slot` (typically extra) — purely for visual context.
function _drawStrengthMiniSigma(div, slot, baseSig, baseColor, newSig, newColor) {
  const mean = slot[0], sd = slot[1], mn = slot[2], mx = slot[3];
  if (!(sd > 0)) {
    Plotly.purge(div);
    div.innerHTML = '<div style="color:#6B7390;font-size:10px;text-align:center;padding:30px 0;">no data</div>';
    return;
  }
  const HIST_OFFSET = 4 + 21;
  const hist = slot.slice(HIST_OFFSET, HIST_OFFSET + 30);
  const binW = (mx - mn) / hist.length;
  const xs = hist.map((_, i) => (mn + (i + 0.5) * binW - mean) / sd);
  const ys = hist.map((v, i) => {
    const a = hist[i - 1] ?? 0, b = v, c = hist[i + 1] ?? 0;
    return (a + 2 * b + c) / 4;
  });
  const traces = [{
    type: "scatter", mode: "lines", x: xs, y: ys,
    fill: "tozeroy", fillcolor: (newColor || baseColor) + "33",
    line: { color: newColor || baseColor, width: 1.5 }, hoverinfo: "skip",
  }];
  const yMax = Math.max(...ys) * 1.15 || 0.1;
  const shapes = [
    { type: "line", x0: 0, x1: 0, y0: 0, y1: yMax,
      line: { color: "#6B7390", width: 1, dash: "dot" } },
  ];
  if (baseSig != null && isFinite(baseSig)) {
    shapes.push({
      type: "line", x0: baseSig, x1: baseSig, y0: 0, y1: yMax,
      line: { color: "#E6EAF2", width: 2, dash: "dash" },
    });
  }
  if (newSig != null && isFinite(newSig)) {
    shapes.push({
      type: "line", x0: newSig, x1: newSig, y0: 0, y1: yMax,
      line: { color: newColor, width: 2.5 },
    });
  }
  const allXs = [Math.min(...xs), Math.max(...xs)];
  if (baseSig != null) allXs.push(baseSig);
  if (newSig  != null) allXs.push(newSig);
  const xLo = Math.min(...allXs), xHi = Math.max(...allXs);
  const xPad = (xHi - xLo) * 0.05 || 0.2;
  Plotly.react(div, traces, {
    width: 250, height: 110,
    margin: { l: 8, r: 8, t: 8, b: 18 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: {
      range: [xLo - xPad, xHi + xPad],
      tickfont: { size: 9, color: "#9AA3B7" }, gridcolor: "rgba(255,255,255,0.06)",
      zeroline: false, showline: false, ticks: "outside", nticks: 5,
      ticksuffix: "σ",
    },
    yaxis: {
      range: [0, yMax], showticklabels: false, showgrid: false,
      zeroline: false,
    },
    shapes, showlegend: false,
  }, { displayModeBar: false, staticPlot: true });
}

function _drawStrengthMini(div, slot, userScore, color, newScore = null, newColor = "#6fe2b5") {
  // slot layout: [mean, sd, min, max, p0..p100 (21), h0..h29 (30)]
  // Plot in σ-units (x = (raw - mean) / sd) so old/new markers always sit
  // on a comparable scale regardless of the underlying score's natural
  // range. Mean = 0σ, SDs are directly readable from the axis.
  const mean = slot[0], sd = slot[1], mn = slot[2], mx = slot[3];
  if (!(sd > 0)) {
    Plotly.purge(div);
    div.innerHTML = '<div style="color:#6B7390;font-size:10px;text-align:center;padding:30px 0;">no data</div>';
    return;
  }
  const HIST_OFFSET = 4 + 21;
  const hist = slot.slice(HIST_OFFSET, HIST_OFFSET + 30);
  const binW = (mx - mn) / hist.length;
  const xs = hist.map((_, i) => (mn + (i + 0.5) * binW - mean) / sd);

  const ys = hist.map((v, i) => {
    const a = hist[i - 1] ?? 0, b = v, c = hist[i + 1] ?? 0;
    return (a + 2 * b + c) / 4;
  });

  const traces = [{
    type: "scatter", mode: "lines", x: xs, y: ys,
    fill: "tozeroy", fillcolor: color + "33",
    line: { color, width: 1.5 }, hoverinfo: "skip",
  }];
  const yMax = Math.max(...ys) * 1.15 || 0.1;
  // Mean line at 0σ.
  const shapes = [
    { type: "line", x0: 0, x1: 0, y0: 0, y1: yMax,
      line: { color: "#6B7390", width: 1, dash: "dot" } },
  ];
  const userSig = (userScore != null && isFinite(userScore)) ? (userScore - mean) / sd : null;
  const newSig  = (newScore  != null && isFinite(newScore))  ? (newScore  - mean) / sd : null;
  if (userSig != null) {
    const dashed = newSig != null;
    shapes.push({
      type: "line", x0: userSig, x1: userSig, y0: 0, y1: yMax,
      line: { color: "#E6EAF2", width: 2, dash: dashed ? "dash" : undefined },
    });
  }
  if (newSig != null) {
    shapes.push({
      type: "line", x0: newSig, x1: newSig, y0: 0, y1: yMax,
      line: { color: newColor, width: 2.5 },
    });
  }
  const allXs = [Math.min(...xs), Math.max(...xs)];
  if (userSig != null) allXs.push(userSig);
  if (newSig  != null) allXs.push(newSig);
  const xLo = Math.min(...allXs), xHi = Math.max(...allXs);
  const xPad = (xHi - xLo) * 0.05 || 0.2;
  Plotly.react(div, traces, {
    width: 250, height: 110,
    margin: { l: 8, r: 8, t: 8, b: 18 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: {
      range: [xLo - xPad, xHi + xPad],
      tickfont: { size: 9, color: "#9AA3B7" }, gridcolor: "rgba(255,255,255,0.06)",
      zeroline: false, showline: false, ticks: "outside", nticks: 5,
      ticksuffix: "σ",
    },
    yaxis: {
      range: [0, yMax], showticklabels: false, showgrid: false,
      zeroline: false,
    },
    shapes, showlegend: false,
  }, { displayModeBar: false, staticPlot: true });
}

async function renderPoolStrengthPanel() {
  const wrap = $("#health-strength");
  if (state.pool.length === 0) { wrap.innerHTML = ""; return; }

  const summaryScenario = _sigmaScenarioKey({
    role: state.role, patch: state.patch, pool_size: state.pool.length,
    top_x: state.topX, pr_floor: state.prFloor, pr_weighted: state.prWeighted,
    shrink_alpha: state.shrinkAlpha,
  });
  // Await curves first to populate σs, then issue summary with correct σs.
  // Cached after first call → warm path is instant; cold path pays one
  // extra round-trip but avoids σ-mismatch between summary and curves.
  const live = await fetchLiveStrengthCurves({
    role: state.role, patch: state.patch,
    pool_size: state.pool.length, top_x: state.topX,
    pr_floor: state.prFloor, pr_weighted: state.prWeighted,
    shrink_alpha: state.shrinkAlpha,
    weights: state.weights,
  });
  const summary = await apiPost("/api/pool_summary", {
    my_role: state.role, pool: state.pool,
    top_x: state.topX, pr_floor: state.prFloor,
    pr_weighted: state.prWeighted, patch: state.patch, shrink_alpha: state.shrinkAlpha,
    w_in_lane: state.weights.in_lane, w_out_lane: state.weights.out_lane,
    w_synergy: state.weights.synergy, w_blind: state.weights.blind,
    ..._sigmaBody(summaryScenario),
  });
  if (summary?.empty || !live) { wrap.innerHTML = ""; return; }

  _buildStrengthSkeleton(wrap,
    `Pool strength · ${state.role} · pool ${summary.pool_size} · top-${summary.top_x}`);
  _renderStrengthCells(wrap, summary.scores, live, "primary");
}

// Shared strength-grid renderer. `wrap` already has 5 .strength-cell DOM
// elements (one per STRENGTH_MODES entry); this fills tier/plot/meta from
// scores + live curves. `which` selects "primary" or "extra" curve bucket.
function _renderStrengthCells(wrap, scores, live, which = "primary") {
  const grid = live.config.percentile_grid;
  for (const m of STRENGTH_MODES) {
    const cell = wrap.querySelector(`.strength-cell[data-mode="${m.key}"]`);
    if (!cell) continue;
    const slot = _slotFromLive(live, m.key, which);
    const score = scores?.[m.key];
    if (!slot || score == null) {
      cell.querySelector(".strength-tier").textContent = "—";
      cell.querySelector(".strength-meta").textContent = "no data";
      continue;
    }
    const [mean, sd] = slot;
    const sigma = sd > 0 ? (score - mean) / sd : 0;
    const tier = strengthTier(sigma) || STRENGTH_TIERS[2];
    const ps = slot.slice(4, 4 + 21);
    const pct = percentileFromGrid(score, grid, ps);

    const tierEl = cell.querySelector(".strength-tier");
    tierEl.textContent = tier.label;
    tierEl.style.color = tier.color;
    cell.querySelector(".strength-meta").innerHTML =
      `score ${score >= 0 ? "+" : ""}${score.toFixed(2)} ·
       <b>${sigma >= 0 ? "+" : ""}${sigma.toFixed(2)}σ</b> ·
       p${pct.toFixed(0)}`;
    _drawStrengthMini(cell.querySelector(".strength-plot"), slot, score, tier.color);
  }
}

// Build the 5-cell .strength-grid skeleton inside `wrap` with the given
// section title.
function _buildStrengthSkeleton(wrap, titleHtml) {
  wrap.innerHTML = `
    <h3 class="section-h" style="margin-top:0;">${titleHtml}</h3>
    <div class="strength-grid">
      ${STRENGTH_MODES.map((m) => `
        <div class="strength-cell" data-mode="${m.key}">
          <div class="strength-label" style="color:${STRENGTH_LABEL_COLORS[m.key] || ""};">${m.label}</div>
          <div class="strength-tier">…</div>
          <div class="strength-plot"></div>
          <div class="strength-meta"></div>
        </div>
      `).join("")}
    </div>
  `;
}

// Replacement-tab variant of the strength panel: shows old (white dashed)
// and new (tier-colored solid) markers on each curve. Driven by
// state.replSelectedCand so clicking a row updates the lines.
const REPL_DELTA_FIELDS = {
  overall_matchup:     "delta_matchup",
  overall_synergy:     "delta_synergy",
  in_lane_matchup:     "delta_matchup_in_lane",
  out_of_lane_matchup: "delta_matchup_out_of_lane",
  blindability:        "delta_blind",
  total_score:         "delta_total",
};
function renderReplStrengthPanel(data, live, basePoolSize, newPoolSize) {
  const wrap = $("#repl-strength");
  if (!wrap) return;
  const selectedRow = data?.rows?.find?.((r) => r.candidate === state.replSelectedCand);
  if (!live || !data?.base_scores || !selectedRow) { wrap.innerHTML = ""; return; }

  const baseScores = data.base_scores;
  const action = `Add ${selectedRow.candidate}`;

  wrap.innerHTML = `
    <h3 class="section-h" style="margin:8px 0 4px;">Pool strength · ${action}</h3>
    <div class="strength-grid">
      ${STRENGTH_MODES.map((m) => `
        <div class="strength-cell" data-mode="${m.key}">
          <div class="strength-label" style="color:${STRENGTH_LABEL_COLORS[m.key] || ""};">${m.label}</div>
          <div class="strength-tier">…</div>
          <div class="strength-plot"></div>
          <div class="strength-meta"></div>
        </div>
      `).join("")}
    </div>
  `;

  // In add mode the σ values are read against TWO curves:
  //   • OLD position → primary (size-N) curve, so the dashed line matches
  //     what Pool Health shows for the user's current pool right now.
  //   • NEW position → extra (size-N+1) curve, so the solid line matches
  //     what Pool Health WILL show after the user actually performs the add.
  // We display the extra curve's density (since that's the reference the
  // user is "moving toward"), but each σ value is computed against the
  // curve it actually represents. The Δ in the meta line is purely visual
  // (different references) — the per-side numbers are the load-bearing ones.
  const useExtra = (live?.extra && live.extra.pool_size === newPoolSize && newPoolSize !== basePoolSize);
  for (const m of STRENGTH_MODES) {
    const cell = wrap.querySelector(`.strength-cell[data-mode="${m.key}"]`);
    const baseSlot = _slotFromLive(live, m.key, "primary");
    const newSlot  = _slotFromLive(live, m.key, useExtra ? "extra" : "primary");
    // OLD: always the user's actual current pool stats — backend gives us
    // these in base σs (or raw component values, σ-independent).
    const baseScoreForOld = baseScores[m.key];
    // NEW: project onto the new curve. For total_score the backend sends
    // a re-scored value (base_total in new σs); for per-component the raw
    // value works directly because components don't depend on σs.
    const baseScoreForNew = (useExtra && m.key === "total_score" && baseScores.total_score_new_sigma != null)
      ? baseScores.total_score_new_sigma
      : baseScores[m.key];
    const delta = selectedRow[REPL_DELTA_FIELDS[m.key]];
    const newScore = (baseScoreForNew != null && delta != null) ? baseScoreForNew + delta : null;
    if (!baseSlot || !newSlot || baseScoreForOld == null || newScore == null) {
      cell.querySelector(".strength-tier").textContent = "—";
      cell.querySelector(".strength-meta").textContent = "no data";
      continue;
    }
    const baseSd = baseSlot[1], newSd = newSlot[1];
    const baseSigma = baseSd > 0 ? (baseScoreForOld - baseSlot[0]) / baseSd : 0;
    const newSigma  = newSd  > 0 ? (newScore        - newSlot[0])  / newSd  : 0;
    const dSigma = newSigma - baseSigma;
    const baseTier = strengthTier(baseSigma) || STRENGTH_TIERS[2];
    const newTier  = strengthTier(newSigma)  || STRENGTH_TIERS[2];

    cell.querySelector(".strength-tier").innerHTML =
      `<span style="color:${baseTier.color};opacity:0.55;font-size:12px;">${baseTier.label}</span>` +
      ` <span style="color:#888;">→</span> ` +
      `<span style="color:${newTier.color};">${newTier.label}</span>`;
    const dColor = dSigma >= 0 ? "#6fe2b5" : "#e0a07a";
    cell.querySelector(".strength-meta").innerHTML =
      `<b>${baseSigma >= 0 ? "+" : ""}${baseSigma.toFixed(2)}σ</b>` +
      ` → <b>${newSigma >= 0 ? "+" : ""}${newSigma.toFixed(2)}σ</b>` +
      ` <span style="color:${dColor};">(${dSigma >= 0 ? "+" : ""}${dSigma.toFixed(2)}σ)</span>`;

    // Plot the new (extra) curve as the visual context; mark the old σ
    // (computed on primary) and new σ (computed on extra) at their
    // respective σ values on the shared σ-axis.
    _drawStrengthMiniSigma(
      cell.querySelector(".strength-plot"),
      newSlot, baseSigma, baseTier.color, newSigma, newTier.color,
    );
  }
}

async function refreshHealth() {
  const eqBox = $("#health-equations");
  const rt = $("#health-redundancy-table");
  const rh = $("#health-redundancy-heatmap");

  if (state.pool.length === 0) {
    $("#health-strength").innerHTML = "";
    setEmptyState(eqBox, "Add champions to your pool to see health.");
    rt.innerHTML = ""; Plotly.purge(rh); rh.innerHTML = "";
    return;
  }
  // Fire strength panel in parallel — doesn't block the other sections.
  renderPoolStrengthPanel();

  const data = await apiPost("/api/health", {
    my_role: state.role, pool: state.pool,
    top_x: state.topX, pr_floor: state.prFloor,
    pr_weighted: state.prWeighted, blind_weight: state.blindPenalty,
    patch: state.patch, shrink_alpha: state.shrinkAlpha,
  });

  // Equations
  eqBox.innerHTML = `
    <div>${renderScoreEquation("Total Score")}</div>
    <div class="plain">
      Per opponent/partner column: <b>Column score</b> = mean of the pool's
      <b>${state.topX}</b> highest z-scores in that column.
      Matchup <b>Covered</b> = z ≥ <b style="color:#e0a07a;">${data.matchup_threshold.toFixed(1)}</b>;
      Synergy <b>Covered</b> = z ≥ <b style="color:#e0a07a;">${data.synergy_threshold.toFixed(1)}</b>.
    </div>
    <div class="plain"><b style="color:${BLIND_COLOR};">Blindability z</b>: high = consistent across opponents (safe blind pick), low = polarized.</div>
  `;

  if (!data.redundancy) {
    rt.innerHTML = '<i style="color:#aaa;">Need at least 2 champions in the pool for redundancy.</i>';
    Plotly.purge(rh); rh.innerHTML = "";
    return;
  }
  renderRedundancyTable(data.redundancy);
  renderRedundancyHeatmap(data.redundancy);
}

export {
  STRENGTH_MODES, STRENGTH_TIERS, strengthTier, percentileFromGrid,
  fetchLiveStrengthCurves,
  _slotFromLive,
  _drawStrengthMini, _drawStrengthMiniSigma,
  _buildStrengthSkeleton, _renderStrengthCells,
  renderPoolStrengthPanel,
  REPL_DELTA_FIELDS, renderReplStrengthPanel,
};
