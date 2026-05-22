import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, ROLES, esc, champIconUrl, plotlyColorscale, colorAt } from "../utils.js";

function drawPoolHeatmap(div, opts) {
  const {
    rows, cols, mat, top_idx_mat, top_x = 0,
    col_pick_rates,
    bar_z = null, bar_pp = null, barLabel = "",
    colorRange = 3.0,
    coveredBoundary = null,    // index of first uncovered column, or null
    threshold = null,
    highlightRows = [],        // row indices to draw a thick black box around
    rowLabels = null,          // optional override for the y-axis tick text
                               // (e.g. "Nami (add)") — icons still use `rows`
    pairSep = "vs",            // "vs" for matchup, "w/" for synergy tooltips
  } = opts;
  const yLabels = rowLabels && rowLabels.length === rows.length ? rowLabels : rows;

  if (!div.classList.contains("js-plotly-plot")) div.innerHTML = "";

  // ── Split into two heatmaps if a covered/uncovered boundary is set ──
  // We do this by inserting a single "spacer" column at the boundary with
  // null values everywhere — Plotly renders that column as transparent,
  // creating a visible gap. All downstream rendering uses dCols/dMat/etc.
  const split = coveredBoundary != null && coveredBoundary > 0 && coveredBoundary < cols.length;
  let dCols, dMat, dTopIdx, dPR, dBarZ, dBarPP, gapJ;
  if (split) {
    gapJ = coveredBoundary;                       // x index of the spacer column
    dCols  = [...cols.slice(0, gapJ),  null, ...cols.slice(gapJ)];
    dMat   = mat.map((row) => [...row.slice(0, gapJ),  null, ...row.slice(gapJ)]);
    dTopIdx = top_idx_mat
      ? top_idx_mat.map((r) => [...r.slice(0, gapJ), null, ...r.slice(gapJ)])
      : null;
    dPR    = col_pick_rates ? [...col_pick_rates.slice(0, gapJ), null, ...col_pick_rates.slice(gapJ)] : null;
    dBarZ  = bar_z ? [...bar_z.slice(0, gapJ), null, ...bar_z.slice(gapJ)] : null;
    dBarPP = bar_pp ? [...bar_pp.slice(0, gapJ), null, ...bar_pp.slice(gapJ)] : null;
  } else {
    dCols = cols; dMat = mat; dTopIdx = top_idx_mat;
    dPR = col_pick_rates; dBarZ = bar_z; dBarPP = bar_pp;
    gapJ = null;
  }
  const nD = dCols.length;

  // Build the set of top-X (row, col) cell indices. ALL cells get text;
  // the annotation styling below differentiates top-X (bold, dark) vs
  // other pool members (faint grey) to reduce visual noise.
  const topXSet = new Set();
  if (dTopIdx && top_x > 0) {
    for (let j = 0; j < nD; j++) {
      for (let k = 0; k < top_x; k++) {
        const i = dTopIdx[k][j];
        if (i != null) topXSet.add(`${i},${j}`);
      }
    }
  }
  const text = dMat.map((row) =>
    row.map((v) => {
      if (v == null || !isFinite(v)) return "";        // gap or missing
      if (Math.abs(v) < 0.05) return "0.0";
      return v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
    })
  );
  // Column labels are just the champion name now — pick rate is shown as a
  // dedicated bar plot above the score bar.
  const xLabels = dCols.map((c) => (c == null ? "" : c));

  // Top-X is signalled via cell text styling (bold/faint) rather than outline
  // rects. Shapes is reserved for the bar threshold line below + any
  // highlight-row boxes (used by Replacement Finder to outline the candidate
  // and the champ being replaced).
  const shapes = [];
  for (const i of highlightRows) {
    if (i == null || i < 0 || i >= rows.length) continue;
    shapes.push({
      type: "rect", xref: "x", yref: "y",
      x0: -0.5, x1: nD - 0.5,
      y0: i - 0.5, y1: i + 0.5,
      line: { color: "#000", width: 3 },
      fillcolor: "rgba(0,0,0,0)",
      layer: "above",
    });
  }

  // ── Layout sizing ──
  // Square cells. Compute plotW/plotH from cell count + fixed margins so the
  // y-axis domain math (fraction of inner plot) keeps cells the right size.
  const CELL = 36;            // square cell size in px
  const ICON = 32;             // champion icon size in px
  const BAR_H = dBarZ ? 80 : 0;
  const BAR_GAP = dBarZ ? 10 : 0;
  const TOP_PAD = 24;
  const ROW_LABEL_W = 110;     // pixels reserved for row name text
  const ROW_ICON_PAD = 6;      // gap between row icon and cells
  const COL_LABEL_H = 160;     // pixels reserved for vertical column labels
  const COL_ICON_PAD = 6;      // gap between cells and col icon strip
  const RIGHT_PAD = 80;        // colorbar room (Δ pp ticks; title is above)

  const margin = {
    l: ROW_LABEL_W + ICON + ROW_ICON_PAD,
    r: RIGHT_PAD,
    t: TOP_PAD,
    b: ICON + COL_ICON_PAD + COL_LABEL_H,
  };
  // PR (pick-rate) bar pane sits above the top-X z bar pane.
  const PR_BAR_H = dPR ? 50 : 0;
  const PR_GAP   = dPR ? 8 : 0;

  const heatW = nD * CELL;
  const heatH = rows.length * CELL;
  const innerH = PR_BAR_H + PR_GAP + BAR_H + BAR_GAP + heatH;
  const plotW = margin.l + heatW + margin.r;
  const plotH = margin.t + innerH + margin.b;

  // Y-axis domain is a fraction of inner plot area.
  // Bottom-up: heatmap → gap → top-X z bar → gap → PR bar (top).
  const heatTopFrac = heatH / innerH;
  const barBottomFrac = (heatH + BAR_GAP) / innerH;
  const barTopFrac = (heatH + BAR_GAP + BAR_H) / innerH;
  const prBarBottomFrac = (heatH + BAR_GAP + BAR_H + PR_GAP) / innerH;

  // ── Icons via layout.images ──
  // Plotly's "paper" image coords are NOT figure-normalized (0..1 over plotW).
  // They map: x_SVG = paper_x * xaxisLen + margin.l, y_SVG = (1-paper_y) * plotInnerH + margin.t.
  // sizex is in xaxisLen units, sizey in plotInnerH units. Heatmap occupies bottom
  // of inner plot (yaxis domain [0, heatTopFrac]).
  const plotInnerW = plotW - margin.l - margin.r;
  const plotInnerH = plotH - margin.t - margin.b;
  const images = [];

  // Row icons: paper_x slightly left of cells (right edge ends ROW_ICON_PAD before margin.l).
  // paper_y for row i (autorange-reversed, Lulu=i=0 at top of cells):
  //   row i center SVG y = (plotH-margin.b-heatH) + (i+0.5)*CELL → paper_y = (heatH - (i+0.5)*CELL) / plotInnerH
  rows.forEach((ch, i) => images.push({
    source: champIconUrl(ch),
    xref: "paper", yref: "paper",
    x: -ROW_ICON_PAD / heatW,
    y: (heatH - (i + 0.5) * CELL) / plotInnerH,
    sizex: ICON / heatW, sizey: ICON / plotInnerH,
    xanchor: "right", yanchor: "middle",
    sizing: "contain", layer: "above",
  }));
  // Col icons: just below cells (paper_y negative = below inner plot).
  // paper_x = (j+0.5)/nD puts the icon center in column j.
  // Skip the gap (null) column — no icon there.
  dCols.forEach((ch, j) => {
    if (ch == null) return;
    images.push({
      source: champIconUrl(ch),
      xref: "paper", yref: "paper",
      x: (j + 0.5) / nD,
      y: -COL_ICON_PAD / plotInnerH,
      sizex: ICON / heatW, sizey: ICON / plotInnerH,
      xanchor: "center", yanchor: "top",
      sizing: "contain", layer: "above",
    });
  });

  // ── Per-cell text via annotations (so we can style top-X vs others) ──
  // texttemplate is one font per trace — annotations let us show the top-X
  // picks in bold black + larger, and everything else as faint grey.
  const annotations = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < nD; j++) {
      if (dCols[j] == null) continue;          // skip the gap column
      annotations.push({
        xref: "x", yref: "y",
        x: j, y: i,
        text: text[i][j],
        showarrow: false,
        font: topXSet.has(`${i},${j}`)
          ? { size: 10, color: "#F1F4FB", weight: 700 }
          : { size: 10, color: "rgba(230,234,242,0.45)" },
      });
    }
  }

  // "z = X.X" label centered in the gap column, in the bar pane just BELOW
  // the horizontal threshold line (so it doesn't get covered by it).
  if (split && threshold != null) {
    annotations.push({
      xref: "x", yref: "y2",                   // bar pane's y-axis (z values)
      x: gapJ, y: threshold,
      text: `z = ${threshold.toFixed(1)}`,
      showarrow: false,
      textangle: -90,
      font: { size: 11, color: "#E6C978", weight: 700 },
      yanchor: "top",
      yshift: -15,
    });
    // Vertical dashed orange line down the gap. Stops just below the bar
    // pane so it doesn't run through the "z = X.X" label sitting there.
    shapes.push({
      type: "line", xref: "x", yref: "paper",
      x0: gapJ, x1: gapJ,
      y0: 0, y1: heatTopFrac,
      line: { color: "#E6C978", width: 2, dash: "dash" },
      layer: "above",
    });
  }

  // ── Traces ──
  const heatCustomdata = rows.map((r) =>
    dCols.map((c) => (c == null ? "" : `${r} ${pairSep} ${c}`))
  );
  const traces = [
    {
      type: "heatmap",
      x: dCols.map((_, j) => j),
      y: rows.map((_, i) => i),
      z: dMat,
      colorscale: plotlyColorscale(),
      zmin: -colorRange, zmax: colorRange, zmid: 0,
      customdata: heatCustomdata,
      hovertemplate: "<b>%{customdata}</b><br>Δ: %{z:.2f} pp<extra></extra>",
      xgap: 1, ygap: 1,
      colorbar: {
        title: { text: "Δ pp", side: "top", font: { color: "#E6EAF2" } },
        tickfont: { color: "#E6EAF2" },
        len: 0.5, y: heatTopFrac / 2,
        thickness: 14, xpad: 4,
      },
      xaxis: "x", yaxis: "y",
    },
  ];
  if (dBarZ) {
    const barColors = (dBarPP || dBarZ).map((v) =>
      v == null ? "rgba(0,0,0,0)" : colorAt(v, colorRange)
    );
    traces.push({
      type: "bar",
      x: dCols.map((_, j) => j), y: dBarZ,
      marker: { color: barColors, line: { color: "rgba(255,255,255,0.10)", width: 0.5 } },
      hovertemplate: "%{customdata}<br>" + barLabel + ": <b>%{y:.2f}</b><extra></extra>",
      customdata: dCols.map((c) => c || ""),
      xaxis: "x2", yaxis: "y2", showlegend: false,
    });
    // Horizontal line on the bar at y = threshold (where applicable)
    if (threshold != null) {
      shapes.push({
        type: "line", xref: "x2", yref: "y2",
        x0: -0.5, x1: nD - 0.5,
        y0: threshold, y1: threshold,
        line: { color: "#E6C978", width: 2, dash: "dash" },
        layer: "above",
      });
    }
  }
  // PR (pick-rate) bar trace — sits above the score bar
  if (dPR) {
    const prPct = dPR.map((p) => (p == null ? null : p * 100));
    traces.push({
      type: "bar",
      x: dCols.map((_, j) => j), y: prPct,
      marker: { color: "#7FC0E8", line: { color: "rgba(255,255,255,0.10)", width: 0.5 } },
      hovertemplate: "%{customdata}<br>PR: <b>%{y:.1f}%</b><extra></extra>",
      customdata: dCols.map((c) => c || ""),
      xaxis: "x3", yaxis: "y3", showlegend: false,
    });
  }

  const layout = {
    width: plotW, height: plotH,
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Inter, sans-serif", color: "#E6EAF2" },
    margin,
    showlegend: false,
    xaxis: {
      tickvals: dCols.map((_, j) => j),
      ticktext: xLabels,
      tickangle: 90,
      tickfont: { size: 11, color: "#E6EAF2" },
      side: "bottom",
      automargin: false,
      anchor: "y",
      range: [-0.5, nD - 0.5],
      // Push column tick labels below the icon strip
      ticklen: ICON + COL_ICON_PAD + 2,
      tickcolor: "rgba(0,0,0,0)",
    },
    yaxis: {
      tickvals: rows.map((_, i) => i),
      ticktext: yLabels,
      autorange: false,
      range: [rows.length - 0.5, -0.5],
      tickfont: { size: 13, color: "#E6EAF2" },
      automargin: false,
      anchor: "x",
      domain: [0, heatTopFrac],
      // Push row tick labels left of the icon strip so they don't overlap
      ticklen: ICON + ROW_ICON_PAD + 2,
      tickcolor: "rgba(0,0,0,0)",
    },
    shapes,
    images,
    annotations,
  };
  if (dBarZ) {
    layout.xaxis2 = {
      anchor: "y2", domain: [0, 1],
      range: [-0.5, nD - 0.5],
      showticklabels: false, showgrid: false, zeroline: false,
    };
    // Default bar y-range: [-0.5, max(threshold, dataMax) + pad]. Expand
    // downward only if data dips below -0.5.
    const finiteZ = dBarZ.filter((v) => v != null && isFinite(v));
    const zMin = finiteZ.length ? Math.min(...finiteZ) : 0;
    const zMax = finiteZ.length ? Math.max(...finiteZ) : 1;
    const yMin = Math.min(-0.5, zMin - 0.05);
    const yMax = Math.max(threshold ?? 0.5, zMax) + 0.15;
    layout.yaxis2 = {
      anchor: "x2", domain: [barBottomFrac, barTopFrac],
      title: { text: barLabel, font: { size: 10, color: "#9AA3B7" } },
      tickfont: { size: 9, color: "#9AA3B7" },
      gridcolor: "rgba(255,255,255,0.06)", zerolinecolor: "rgba(255,255,255,0.12)",
      range: [yMin, yMax],
    };
  }
  if (dPR) {
    layout.xaxis3 = {
      anchor: "y3", domain: [0, 1],
      range: [-0.5, nD - 0.5],
      showticklabels: false, showgrid: false, zeroline: false,
    };
    layout.yaxis3 = {
      anchor: "x3", domain: [prBarBottomFrac, 1],
      title: { text: "PR %", font: { size: 10, color: "#9AA3B7" } },
      tickfont: { size: 9, color: "#9AA3B7" },
      gridcolor: "rgba(255,255,255,0.06)", zerolinecolor: "rgba(255,255,255,0.12)",
    };
  }

  // Layman-friendly explainers for the bar-plot y-axis labels. We use
  // Plotly annotations (hovertext) so a small '?' marker pops a tooltip
  // when hovered.
  if (!layout.annotations) layout.annotations = [];
  if (dBarZ) {
    layout.annotations.push({
      text: "(?)",
      xref: "paper", yref: "paper",
      x: 0, y: (barBottomFrac + barTopFrac) / 2,
      xanchor: "right", yanchor: "middle",
      xshift: -78, // clears the rotated y-axis label (extra padding so PR % side also clears)
      showarrow: false,
      font: { size: 11, color: "#6FE2B5" },
      bgcolor: "rgba(26,34,54,0.95)", bordercolor: "rgba(255,255,255,0.10)",
      borderpad: 3, borderwidth: 1,
      hovertext:
        "<b>Top-" + (top_x || "X") + " z</b> = how strong your pool's " +
        (top_x || "X") + " best counters are vs this opponent, scaled by " +
        "the spread of all " + (state.role || "role") + " picks against them. " +
        "+1 = one standard deviation better than the role's average matchup. " +
        "0 = average. Negative = your pool struggles into them. " +
        "(Drives the column sort + the orange threshold line.)",
      captureevents: true,
    });
  }
  if (dPR) {
    layout.annotations.push({
      text: "(?)",
      xref: "paper", yref: "paper",
      x: 0, y: (prBarBottomFrac + 1) / 2,
      xanchor: "right", yanchor: "middle",
      xshift: -78,
      showarrow: false,
      font: { size: 11, color: "#6FE2B5" },
      bgcolor: "rgba(26,34,54,0.95)", bordercolor: "rgba(255,255,255,0.10)",
      borderpad: 3, borderwidth: 1,
      hovertext:
        "<b>PR %</b> = how often this opponent is picked in this role at the " +
        "selected rank bracket. Tall bars = common opponents you face a lot; " +
        "short bars = niche picks you rarely see. Multiply by the matchup edge " +
        "below to get expected impact on your ladder games.",
      captureevents: true,
    });
  }

  Plotly.react(div, traces, layout, { responsive: false, displaylogo: false });
}
// ──────────────────────────────────────────────────────────────────────────
// SHARED: pool-preview heatmap (Pool Builder + Replacement Finder)
// ──────────────────────────────────────────────────────────────────────────

// Build choices: matchup vs each role + synergy with non-self roles
function buildViewChoices(myRole) {
  const out = [];
  for (const pos of ROLES) out.push({ value: `matchup_${pos}`, label: `Matchup vs ${pos}` });
  for (const pos of ROLES.filter((r) => r !== myRole)) out.push({ value: `synergy_${pos}`, label: `Synergy with ${pos}` });
  return out;
}

function populateViewSelect(selectEl, myRole, currentValue, preferredDefault = null) {
  const choices = buildViewChoices(myRole);
  selectEl.innerHTML = choices.map((c) =>
    `<option value="${c.value}" ${c.value === currentValue ? "selected" : ""}>${c.label}</option>`
  ).join("");
  // If currentValue isn't valid, prefer a caller-supplied default (e.g.
  // the mirror matchup) before falling back to the first choice.
  if (!choices.find((c) => c.value === currentValue)) {
    const fallback = (preferredDefault && choices.find((c) => c.value === preferredDefault))
      ? preferredDefault : choices[0].value;
    selectEl.value = fallback;
    return fallback;
  }
  return currentValue;
}

async function fetchPoolCoverageFor(pool, view, extraRows = []) {
  const [mode, pos] = view.split("_");
  const r = await apiFetch("/api/coverage", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role, other_role: pos, mode,
      pool, top_x: state.topX, pr_floor: state.prFloor,
      pr_weighted: state.prWeighted, patch: state.patch, shrink_alpha: state.shrinkAlpha,
      extra_rows: extraRows,
    }),
  });
  return await r.json();
}

async function renderPoolPreview(divId, pool, view, extra = {}) {
  const div = $(divId);
  if (!pool || pool.length === 0) {
    Plotly.purge(div);
    div.innerHTML = '<div class="empty-msg">No pool selected.</div>';
    return;
  }
  const cov = await fetchPoolCoverageFor(pool, view, extra.extraRows || []);
  if (cov.empty) {
    Plotly.purge(div);
    div.innerHTML = '<div class="empty-msg">No data for this view.</div>';
    return;
  }
  const isMatchup = view.startsWith("matchup_");
  // Compute the covered/uncovered boundary so the preview heatmap also gets
  // the split + threshold line + "z = X.X" gap label.
  const threshold = cov.threshold;
  // Boundary uses col_score_z (top-X mean z) — same metric the bar plots —
  // so the vertical gap line up where the bars cross the horizontal z=threshold.
  let coveredBoundary = null;
  for (let j = 0; j < cov.col_score_z.length; j++) {
    if (cov.col_score_z[j] < threshold) { coveredBoundary = j; break; }
  }
  // The server may filter or reorder the pool (mirror matchups drop self-cells,
  // empty rows are dropped). Translate caller-supplied highlight champion
  // names to actual row indices in cov.rows.
  const highlightRows = (extra.highlightChamps || [])
    .map((c) => cov.rows.indexOf(c))
    .filter((i) => i >= 0);
  // Optional row-label suffix map (e.g. {"Pyke": "(add)"}). Falls back to
  // the bare champ name when the champ isn't in the map.
  const labelSuffix = extra.labelSuffix || {};
  const rowLabels = cov.rows.map((c) =>
    labelSuffix[c] ? `${c} ${labelSuffix[c]}` : c,
  );
  drawPoolHeatmap(div, {
    rows: cov.rows, cols: cov.cols, mat: cov.mat,
    top_idx_mat: cov.top_idx_mat, top_x: cov.top_x,
    col_pick_rates: cov.col_pick_rates,
    bar_z: cov.col_score_z, bar_pp: cov.col_score_pp,
    colorRange: isMatchup ? 3.0 : 1.5,
    barLabel: `Top-${cov.top_x} z`,
    coveredBoundary, threshold,
    highlightRows, rowLabels,
    pairSep: isMatchup ? "vs" : "w/",
  });
}

export {
  drawPoolHeatmap,
  buildViewChoices, populateViewSelect,
  fetchPoolCoverageFor, renderPoolPreview,
};
