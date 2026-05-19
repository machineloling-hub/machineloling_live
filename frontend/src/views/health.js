import { state } from "../state.js";
import { apiFetch } from "../api.js";
import {
  $, fmtSign, champImg, champIconUrl,
  MATCHUP_COLOR, SYNERGY_COLOR, BLIND_COLOR,
  plotlyColorscale, tealOrangeBg, corrBg, renderScoreEquation,
} from "../utils.js";
import { renderPoolStrengthPanel } from "../widgets/strength.js";


async function refreshHealth() {
  const eqBox = $("#health-equations");
  const rt = $("#health-redundancy-table");
  const rh = $("#health-redundancy-heatmap");
  if (state.pool.length === 0) {
    $("#health-strength").innerHTML = "";
    eqBox.innerHTML = '<div class="empty-msg">Add champions to your pool to see health.</div>';
    rt.innerHTML = ""; Plotly.purge(rh); rh.innerHTML = "";
    return;
  }
  // Fire strength panel in parallel — doesn't block the other sections.
  renderPoolStrengthPanel();

  const r = await apiFetch("/api/health", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role, pool: state.pool,
      top_x: state.topX, pr_floor: state.prFloor,
      pr_weighted: state.prWeighted, blind_weight: state.blindPenalty,
      patch: state.patch, shrink_alpha: state.shrinkAlpha,
    }),
  });
  const data = await r.json();

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

function renderHealthTable(rows, mode, topX) {
  if (!rows || rows.length === 0) return '<i style="color:#aaa;">No data.</i>';
  // The whole table is mode-specific — tint the score columns with the
  // matchup gold or synergy blue so it visually mirrors the Blindability tab.
  const modeColor = mode === "matchup" ? MATCHUP_COLOR : SYNERGY_COLOR;
  const topxCol = topX > 1 ? `Mean top-${topX} z` : "Mean best z";
  const blindLabel = `Blindability (${mode})`;
  const tr = rows.map((r) => {
    const pctColor = r.pct_covered >= 80 ? "#009E73" : r.pct_covered >= 50 ? "#d4d4d4" : "#D55E00";
    const blindCell = r.blind_z == null
      ? '<td class="cell-na">—</td>'
      : `<td class="cell-pos" style="background:${tealOrangeBg(r.blind_z)};text-align:right;">${fmtSign(r.blind_z)}</td>`;
    const worstStr = r.worst ? `${r.worst.champion} (z=${fmtSign(r.worst.z)})` : "— all covered";
    return `<tr>
      <td><b>${r.position}</b></td>
      <td>${r.n_total}</td>
      <td style="color:#009E73;">${r.n_covered}</td>
      <td style="color:#D55E00;">${r.n_uncovered}</td>
      <td style="color:${pctColor};font-weight:bold;">${r.pct_covered.toFixed(0)}%</td>
      <td>${fmtSign(r.mean_topx_z)}</td>
      <td>${fmtSign(r.mean_topx_pp)} pp</td>
      <td>${fmtSign(r.mean_best_pp)} pp</td>
      ${blindCell}
      <td style="font-size:11px;color:#bbb;">${worstStr}</td>
    </tr>`;
  }).join("");
  return `<table class="std-table">
    <thead><tr>
      <th>Position</th><th>Total</th><th>Covered</th><th>Uncovered</th>
      <th>% Covered</th>
      <th style="color:${modeColor};">${topxCol}</th>
      <th style="color:${modeColor};">Mean top-${topX} pp</th>
      <th style="color:${modeColor};">Mean best pp</th>
      <th style="color:${BLIND_COLOR};">${blindLabel}</th><th>Worst uncovered</th>
    </tr></thead><tbody>${tr}</tbody></table>`;
}

function renderRedundancyTable(rd) {
  const wt = state.blindPenalty;
  const score = rd.rows.map((_, i) =>
    wt * (rd.blind_z[i] || 0) - (rd.closest_cor[i] || 0)
  );
  const order = score
    .map((s, i) => [s, i])
    .sort((a, b) => b[0] - a[0])
    .map((p) => p[1]);

  const laneHeader = rd.lane_roles && rd.lane_roles.length
    ? `Lane (${rd.lane_roles.join("+")})` : "Lane";

  const corrCell = (v) => v == null
    ? '<td class="cell-na">—</td>'
    : `<td style="background:${corrBg(v)};color:#fff;font-weight:bold;text-align:center;border-radius:3px;">${fmtSign(v)}</td>`;

  const closestCell = (i) => {
    const v = rd.closest_cor[i];
    if (v == null) return '<td class="cell-na">—</td>';
    const closest = rd.rows[rd.closest_idx[i]];
    return `<td style="background:${corrBg(v)};color:#fff;text-align:center;font-weight:bold;border-radius:3px;">
      ${fmtSign(v)}
      <div style="font-size:10px;font-weight:normal;margin-top:2px;display:flex;align-items:center;justify-content:center;gap:3px;">
        ${champImg(closest, 14)} ${closest}
      </div>
    </td>`;
  };

  const blindCell = (v) => v == null
    ? '<td class="cell-na">—</td>'
    : `<td style="background:${tealOrangeBg(v)};color:#fff;text-align:center;font-weight:bold;border-radius:3px;">${fmtSign(v)}</td>`;

  const tr = order.map((i, k) => {
    const ch = rd.rows[i];
    const label = k === 0 ? "Best mix" : k === order.length - 1 ? "Most redundant" : "";
    return `<tr>
      <td>${k + 1}</td>
      <td>${champImg(ch, 22)} <b>${ch}</b></td>
      <td style="text-align:center;">${rd.unique_best[i]}</td>
      ${closestCell(i)}
      ${corrCell(rd.matchup_topx ? rd.matchup_topx[i] : null)}
      ${corrCell(rd.lane_topx ? rd.lane_topx[i] : null)}
      ${corrCell(rd.synergy_topx ? rd.synergy_topx[i] : null)}
      ${corrCell(rd.avg_cor[i])}
      ${blindCell(rd.blind_z[i])}
      <td style="color:#bbb;font-size:11px;">${label}</td>
    </tr>`;
  }).join("");

  $("#health-redundancy-table").innerHTML = `
    <div class="eq-box">
      Rank score = <b>${wt.toFixed(2)}</b> × <b style="color:${BLIND_COLOR};">Blindability z</b>
      − <b style="color:#e0a07a;">Closest other r</b>
      <span style="color:#888;font-size:11px;margin-left:12px;">
        Adjust the <i>Blindability weight</i> slider to re-weight.
      </span>
    </div>
    <table class="std-table redundancy-table">
      <thead><tr>
        <th>Rank<br><span class="th-desc">best mix → most redundant</span></th>
        <th>Champion</th>
        <th>Unique best<br><span class="th-desc"># cols where this champ is sole best</span></th>
        <th>Closest other (max r)<br><span class="th-desc">peak similarity to another pool member</span></th>
        <th style="color:${MATCHUP_COLOR};">Matchup r (top-${state.topX})<br><span class="th-desc">mean of top-${state.topX} matchup overlaps</span></th>
        <th style="color:${MATCHUP_COLOR};">${laneHeader} r (top-${state.topX})<br><span class="th-desc">same, your lane only</span></th>
        <th style="color:${SYNERGY_COLOR};">Synergy r (top-${state.topX})<br><span class="th-desc">mean of top-${state.topX} synergy overlaps</span></th>
        <th>Avg r w/ others<br><span class="th-desc">mean correlation vs all others</span></th>
        <th style="color:${BLIND_COLOR};">Blindability z<br><span class="th-desc">consistency across opponents</span></th>
        <th></th>
      </tr></thead>
      <tbody>${tr}</tbody>
    </table>`;
}

function renderRedundancyHeatmap(rd) {
  const div = $("#health-redundancy-heatmap");
  if (rd.rows.length < 2) {
    Plotly.purge(div); div.innerHTML = ""; return;
  }
  const order = rd.order;                     // dendrogram leaf order
  const labels = order.map((i) => rd.rows[i]);
  const cor = rd.cor;
  const z = order.map((i) => order.map((j) => cor[i][j]));
  const text = z.map((row) => row.map((v) => fmtSign(v, 2)));

  if (!div.classList.contains("js-plotly-plot")) div.innerHTML = "";

  const n = labels.length;
  const CELL = 80;
  const ICON = 44;
  const TOP_PAD = 10;
  const TOP_DENDRO_H = 100;
  const LEFT_DENDRO_PX = 100;
  const DENDRO_GAP = 6;
  const ROW_LABEL_W = 110;
  const ROW_ICON_PAD = 6;
  const COL_ICON_PAD = 6;
  const COL_LABEL_H = 130;
  const COLORBAR_W = 110;

  // Extra data-x range on the LEFT for: icon strip + dendrogram pane.
  // Layout L→R: [margin.l = row labels] [dendrogram] [gap] [icons] [cells]
  const ICON_DATA = ICON / CELL;                   // icon width in cell units
  const ICON_PAD_DATA = ROW_ICON_PAD / CELL;       // gap between icon and cells
  const DENDRO_DATA = LEFT_DENDRO_PX / CELL;       // dendrogram width in cell units
  const DENDRO_GAP_DATA = DENDRO_GAP / CELL;       // gap between dendro and icons
  const LEFT_EXTRA = ICON_DATA + ICON_PAD_DATA + DENDRO_GAP_DATA + DENDRO_DATA;

  // Extra Y range below cells for col icons (data coords).
  const COL_ICON_DATA = (ICON + COL_ICON_PAD) / CELL;

  const margin = {
    l: ROW_LABEL_W,
    r: COLORBAR_W,
    t: TOP_PAD,
    b: COL_LABEL_H,                              // col icons now inside axis range
  };
  const heatW = n * CELL;
  const heatH = n * CELL;
  const yaxisData = (n + COL_ICON_DATA) * CELL;  // axis area incl. col icon strip
  const innerW = (n + LEFT_EXTRA + 0.5) * CELL;
  const innerH = TOP_DENDRO_H + DENDRO_GAP + yaxisData;
  const plotW = margin.l + innerW + margin.r;
  const plotH = margin.t + innerH + margin.b;

  const yaxisFrac = yaxisData / innerH;
  const colDendroBotFrac = (yaxisData + DENDRO_GAP) / innerH;

  // X-axis range: extend left to include dendrogram + icon area in negative x
  const xRangeMin = -(0.5 + ICON_DATA + ICON_PAD_DATA + DENDRO_GAP_DATA + DENDRO_DATA);
  const iconRightX = -0.5;
  const iconLeftX = iconRightX - ICON_DATA;
  const dendroRightX = iconLeftX - DENDRO_GAP_DATA;
  const dendroLeftX = dendroRightX - DENDRO_DATA;
  // Y-axis range extends past cells to include col icon strip below
  const yRangeMax = (n - 0.5) + COL_ICON_DATA;

  // ── Icons via DATA coords on the heatmap's xaxis ──
  // Data x = -0.5 is the LEFT edge of cell column 0. We place icons just left
  // of that (xanchor="right" → icon's right edge at iconRightX = -0.5).
  // Col icons go just below cells (data y = n-0.5 + small pad with autorange reversed).
  const images = [];
  labels.forEach((ch, i) => images.push({
    source: champIconUrl(ch),
    xref: "x", yref: "y",
    x: iconRightX, y: i,
    sizex: ICON_DATA, sizey: ICON / CELL,
    xanchor: "right", yanchor: "middle",
    sizing: "contain", layer: "above",
  }));
  // Col icons: data y just below the bottom row (display-bottom with autorange reversed)
  const colIconY = (n - 0.5) + COL_ICON_PAD / CELL;     // top of icon
  labels.forEach((ch, j) => images.push({
    source: champIconUrl(ch),
    xref: "x", yref: "y",
    x: j, y: colIconY,
    sizex: ICON / CELL, sizey: ICON / CELL,
    xanchor: "center", yanchor: "top",
    sizing: "contain", layer: "above",
  }));

  // ── Dendrogram lines (col on top, row on left — both on the SAME axes) ──
  // Server returns segments in the heatmap's column coord space:
  // {x: [a,a,b,b], y: [0,h,h,0]} where a,b are leaf positions.
  const segs = rd.dendro_segments || [];
  let maxH = 0;
  for (const s of segs) {
    for (const yy of s.y) if (yy > maxH) maxH = yy;
  }

  // Col dendrogram on yaxis2 (top strip); leaves at y=0 → up to y=h
  const colDendroX = [], colDendroY = [];
  for (const s of segs) {
    colDendroX.push(...s.x, null);
    colDendroY.push(...s.y, null);
  }

  // Row dendrogram drawn on the SAME xaxis/yaxis as the heatmap, but in the
  // negative-x area we extended the range for. Heights are scaled to fit
  // [dendroLeftX, dendroRightX]. Rotated: heights → x, positions → y.
  const heightToX = (h) => dendroRightX - (h / Math.max(maxH, 1e-9)) * DENDRO_DATA;
  const rowDendroX = [], rowDendroY = [];
  for (const s of segs) {
    rowDendroX.push(heightToX(s.y[0]), heightToX(s.y[1]), heightToX(s.y[2]), heightToX(s.y[3]), null);
    rowDendroY.push(s.x[0], s.x[1], s.x[2], s.x[3], null);
  }

  const traces = [
    {
      type: "heatmap",
      x: labels.map((_, i) => i), y: labels.map((_, i) => i),
      z, text, texttemplate: "%{text}",
      textfont: { size: 14, color: "#111" },
      colorscale: plotlyColorscale(),
      zmin: -1, zmax: 1, zmid: 0,
      customdata: labels.map((r) => labels.map((c) => `${r} ↔ ${c}`)),
      hovertemplate: "<b>%{customdata}</b><br>r: %{z:.3f}<extra></extra>",
      xgap: 2, ygap: 2,
      colorbar: { title: { text: "Pearson r" }, tickfont: { color: "#d4d4d4" }, len: 0.6 },
      xaxis: "x", yaxis: "y",
    },
  ];
  if (segs.length) {
    // Row dendrogram on the heatmap's xaxis (negative-x area)
    traces.push({
      type: "scatter", mode: "lines",
      x: rowDendroX, y: rowDendroY,
      line: { color: "#aaa", width: 1.5 },
      hoverinfo: "skip", showlegend: false,
      xaxis: "x", yaxis: "y",
    });
    // Col dendrogram strip on top (yaxis2)
    traces.push({
      type: "scatter", mode: "lines",
      x: colDendroX, y: colDendroY,
      line: { color: "#aaa", width: 1.5 },
      hoverinfo: "skip", showlegend: false,
      xaxis: "x2", yaxis: "y2",
    });
  }

  const layout = {
    width: plotW, height: plotH,
    paper_bgcolor: "#1e1e1e", plot_bgcolor: "#1e1e1e",
    font: { color: "#d4d4d4" },
    margin,
    showlegend: false,
    xaxis: {
      tickvals: labels.map((_, i) => i), ticktext: labels,
      tickangle: 90, side: "bottom",
      tickfont: { size: 13, color: "#d4d4d4" },
      automargin: false, anchor: "y",
      range: [xRangeMin, n - 0.5],
      ticklen: ICON + COL_ICON_PAD + 2,
      tickcolor: "rgba(0,0,0,0)",
    },
    yaxis: {
      tickvals: labels.map((_, i) => i), ticktext: labels,
      autorange: false, range: [yRangeMax, -0.5],
      tickfont: { size: 14, color: "#d4d4d4" },
      automargin: false, anchor: "x",
      domain: [0, yaxisFrac],
      ticklen: 4,
      tickcolor: "rgba(0,0,0,0)",
    },
    images,
    title: { text: "Pool profile correlation — dendrogram-ordered (green = redundant, orange = complementary)",
             font: { color: "#e0e0e0", size: 13 }, x: 0.5, y: 0.995 },
  };
  if (segs.length) {
    // Top column dendrogram strip
    layout.xaxis2 = {
      anchor: "y2", domain: [0, 1],
      range: [xRangeMin, n - 0.5],
      showticklabels: false, showgrid: false, zeroline: false,
    };
    layout.yaxis2 = {
      anchor: "x2", domain: [colDendroBotFrac, 1],
      range: [0, maxH * 1.05],
      showticklabels: false, showgrid: false, zeroline: false,
    };
  }

  Plotly.react(div, traces, layout, { displaylogo: false });
}


export { refreshHealth };
