// Pool Health view — at-a-glance summary of how the user's pool performs
// across every opponent / partner role, plus a redundancy analysis showing
// which pool members cover overlapping territory.
//
// Data: /api/health  (engine.health endpoint, returns matchup_rows,
//                     synergy_rows, redundancy payload, thresholds).
//       /api/pool_strength_curves + /api/pool_summary  (via renderPoolStrengthPanel).

import { state } from "../state.js";
import { apiFetch } from "../api.js";
import {
  $, fmtSign, champImg, champIconUrl, plotlyColorscale,
  MATCHUP_COLOR, SYNERGY_COLOR, BLIND_COLOR,
  tealOrangeBg, corrBg,
} from "../utils.js";
import { renderPoolStrengthPanel } from "../widgets/strength.js";

async function refreshHealth() {
  const strengthDiv = $("#health-strength");
  const matchupDiv  = $("#health-matchup-table");
  const synergyDiv  = $("#health-synergy-table");
  const redTable    = $("#health-redundancy-table");
  const redHm       = $("#health-redundancy-heatmap");
  const summaryHead = $("#health-summary-head");

  if (state.pool.length === 0) {
    summaryHead.innerHTML = "";
    strengthDiv.innerHTML = "";
    matchupDiv.innerHTML  = '<div class="empty-msg">Add champions to your pool to see health.</div>';
    synergyDiv.innerHTML  = "";
    redTable.innerHTML    = "";
    Plotly.purge(redHm); redHm.innerHTML = "";
    return;
  }

  // Strength panel runs independently (its own data fetch + render).
  renderPoolStrengthPanel();

  const r = await apiFetch("/api/health", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role, pool: state.pool,
      top_x: state.topX, pr_floor: state.prFloor,
      pr_weighted: state.prWeighted,
      patch: state.patch, shrink_alpha: state.shrinkAlpha,
    }),
  });
  const data = await r.json();
  if (data?.empty) {
    matchupDiv.innerHTML = '<div class="empty-msg">No health data for this pool.</div>';
    synergyDiv.innerHTML = "";
    redTable.innerHTML = "";
    Plotly.purge(redHm); redHm.innerHTML = "";
    return;
  }

  // ── Headline summary ────────────────────────────────────────────────
  const mAgg = aggregateRows(data.matchup_rows);
  const sAgg = aggregateRows(data.synergy_rows);
  summaryHead.innerHTML = `
    <div class="health-headline">
      <div class="health-stat">
        <div class="health-stat-label" style="color:${MATCHUP_COLOR};">Matchup coverage</div>
        <div class="health-stat-value">${mAgg.pct.toFixed(0)}<span class="pct">%</span></div>
        <div class="health-stat-sub">${mAgg.covered}/${mAgg.total} opponents covered
          <span class="muted">(z ≥ ${data.matchup_threshold.toFixed(1)})</span></div>
      </div>
      <div class="health-stat">
        <div class="health-stat-label" style="color:${SYNERGY_COLOR};">Synergy coverage</div>
        <div class="health-stat-value">${sAgg.pct.toFixed(0)}<span class="pct">%</span></div>
        <div class="health-stat-sub">${sAgg.covered}/${sAgg.total} partners covered
          <span class="muted">(z ≥ ${data.synergy_threshold.toFixed(1)})</span></div>
      </div>
    </div>
  `;

  matchupDiv.innerHTML = renderHealthTable(data.matchup_rows, "matchup", data.top_x);
  synergyDiv.innerHTML = renderHealthTable(data.synergy_rows, "synergy", data.top_x);

  if (!data.redundancy) {
    redTable.innerHTML = '<div class="empty-msg">Need at least 2 champions in your pool for redundancy.</div>';
    Plotly.purge(redHm); redHm.innerHTML = "";
    return;
  }
  renderRedundancyTable(data.redundancy);
  renderRedundancyHeatmap(data.redundancy);
}

function aggregateRows(rows) {
  const total   = rows.reduce((s, r) => s + r.n_total, 0);
  const covered = rows.reduce((s, r) => s + r.n_covered, 0);
  return { total, covered, pct: total > 0 ? (100 * covered / total) : 0 };
}

function renderHealthTable(rows, mode, topX) {
  if (!rows || rows.length === 0) return '<div class="empty-msg">No data.</div>';
  const modeColor = mode === "matchup" ? MATCHUP_COLOR : SYNERGY_COLOR;
  const noun = mode === "matchup" ? "opponents" : "partners";
  const tr = rows.map((r) => {
    // Coverage bar: green for covered, red for uncovered.
    const pctGood = r.n_total > 0 ? (r.n_covered / r.n_total) : 0;
    const barColor = pctGood >= 0.8 ? "#3fb37f" : pctGood >= 0.5 ? "#d4c45c" : "#d97a4a";
    // blind_z follows the blog convention: low z = blindable. Negate so
    // the teal end of the gradient still reads as "blindable = good".
    const blindCell = r.blind_z == null
      ? '<td class="cell-na">—</td>'
      : `<td style="background:${tealOrangeBg(-r.blind_z)};color:#fff;text-align:right;font-weight:600;border-radius:3px;">${fmtSign(r.blind_z)}</td>`;
    const worstStr = r.worst
      ? `${champImg(r.worst.champion, 16)} ${r.worst.champion} <span class="muted">(z=${fmtSign(r.worst.z)})</span>`
      : '<span class="muted">— all covered —</span>';
    return `<tr>
      <td><b>${r.position}</b></td>
      <td>
        <div class="health-cov-cell">
          <div class="health-cov-bar"><div style="width:${(pctGood * 100).toFixed(1)}%;background:${barColor};"></div></div>
          <span class="health-cov-text"><b>${(pctGood * 100).toFixed(0)}%</b> <span class="muted">(${r.n_covered}/${r.n_total})</span></span>
        </div>
      </td>
      <td style="text-align:right;">${fmtSign(r.mean_topx_z)}</td>
      <td style="text-align:right;">${fmtSign(r.mean_topx_pp)} pp</td>
      <td style="text-align:right;">${fmtSign(r.mean_best_pp)} pp</td>
      ${blindCell}
      <td class="muted" style="font-size:11px;">${worstStr}</td>
    </tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="std-table">
    <thead><tr>
      <th>Role</th>
      <th>Coverage <span class="th-desc">% of ${noun} where top-${topX} z ≥ threshold</span></th>
      <th style="color:${modeColor};text-align:right;">Mean top-${topX} z</th>
      <th style="color:${modeColor};text-align:right;">Mean top-${topX} pp</th>
      <th style="color:${modeColor};text-align:right;">Mean best pp</th>
      <th style="color:${BLIND_COLOR};text-align:right;">Blindability z</th>
      <th>Worst uncovered</th>
    </tr></thead>
    <tbody>${tr}</tbody>
  </table></div>`;
}

function renderRedundancyTable(rd) {
  // Rank champions: best mix at top, most redundant at bottom.
  // Score = -blind_z - closest_other_r. blind_z follows the blog
  // convention (low z = blindable = good for the pool), so negate.
  const score = rd.rows.map((_, i) =>
    -(rd.blind_z[i] || 0) - (rd.closest_cor[i] || 0)
  );
  const order = score.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).map((p) => p[1]);

  const laneHeader = rd.lane_roles?.length ? `Lane (${rd.lane_roles.join("+")})` : "Lane";

  const corrCell = (v) => v == null
    ? '<td class="cell-na">—</td>'
    : `<td style="background:${corrBg(v)};color:#fff;text-align:center;font-weight:600;border-radius:3px;">${fmtSign(v)}</td>`;

  const closestCell = (i) => {
    const v = rd.closest_cor[i];
    if (v == null) return '<td class="cell-na">—</td>';
    const closest = rd.rows[rd.closest_idx[i]];
    return `<td style="background:${corrBg(v)};color:#fff;text-align:center;font-weight:600;border-radius:3px;">
      ${fmtSign(v)}
      <div style="font-size:10px;font-weight:400;margin-top:2px;display:flex;align-items:center;justify-content:center;gap:3px;">
        ${champImg(closest, 14)} ${closest}
      </div>
    </td>`;
  };

  const blindCell = (v) => v == null
    ? '<td class="cell-na">—</td>'
    : `<td style="background:${tealOrangeBg(-v)};color:#fff;text-align:center;font-weight:600;border-radius:3px;">${fmtSign(v)}</td>`;

  const tr = order.map((i, k) => {
    const ch = rd.rows[i];
    const label = k === 0
      ? '<span style="color:#3fb37f;">★ Best mix</span>'
      : k === order.length - 1
        ? '<span style="color:#d97a4a;">Most redundant</span>'
        : '';
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
      <td>${label}</td>
    </tr>`;
  }).join("");

  $("#health-redundancy-table").innerHTML = `
    <div class="table-wrap"><table class="std-table redundancy-table">
      <thead><tr>
        <th>Rank</th>
        <th>Champion</th>
        <th>Unique best <span class="th-desc">cols where this champ is sole top pick</span></th>
        <th>Closest other (max r) <span class="th-desc">peak similarity to another pool member</span></th>
        <th style="color:${MATCHUP_COLOR};">Matchup r (top-${state.topX})</th>
        <th style="color:${MATCHUP_COLOR};">${laneHeader} r</th>
        <th style="color:${SYNERGY_COLOR};">Synergy r (top-${state.topX})</th>
        <th>Avg r vs others</th>
        <th style="color:${BLIND_COLOR};">Blindability z</th>
        <th></th>
      </tr></thead>
      <tbody>${tr}</tbody>
    </table></div>`;
}

function renderRedundancyHeatmap(rd) {
  const div = $("#health-redundancy-heatmap");
  if (rd.rows.length < 2) {
    Plotly.purge(div); div.innerHTML = ""; return;
  }
  const order = rd.order || rd.rows.map((_, i) => i);
  const labels = order.map((i) => rd.rows[i]);
  const cor = rd.cor;
  const z = order.map((i) => order.map((j) => cor[i][j]));
  const text = z.map((row) => row.map((v) => v == null ? "" : fmtSign(v, 2)));

  if (!div.classList.contains("js-plotly-plot")) div.innerHTML = "";
  const n = labels.length;
  const CELL = 70;

  // Champion icons along the left + bottom edges via data-coord images.
  const ICON = 36;
  const ICON_DATA = ICON / CELL;
  const PAD_DATA = 6 / CELL;
  const images = [];
  labels.forEach((ch, i) => images.push({
    source: champIconUrl(ch), xref: "x", yref: "y",
    x: -0.5 - PAD_DATA, y: i, sizex: ICON_DATA, sizey: ICON_DATA,
    xanchor: "right", yanchor: "middle", sizing: "contain", layer: "above",
  }));
  labels.forEach((ch, j) => images.push({
    source: champIconUrl(ch), xref: "x", yref: "y",
    x: j, y: (n - 0.5) + PAD_DATA, sizex: ICON_DATA, sizey: ICON_DATA,
    xanchor: "center", yanchor: "top", sizing: "contain", layer: "above",
  }));

  const trace = {
    type: "heatmap",
    x: labels.map((_, i) => i),
    y: labels.map((_, i) => i),
    z, text, texttemplate: "%{text}",
    textfont: { size: 12, color: "#111" },
    colorscale: plotlyColorscale(),
    zmin: -1, zmax: 1, zmid: 0,
    customdata: labels.map((r) => labels.map((c) => `${r} ↔ ${c}`)),
    hovertemplate: "<b>%{customdata}</b><br>r: %{z:.3f}<extra></extra>",
    xgap: 2, ygap: 2,
    colorbar: { title: { text: "Pearson r" }, tickfont: { color: "#d4d4d4" }, len: 0.75, thickness: 12 },
  };

  const LEFT_PAD_PX = ICON + 24;
  const BOTTOM_PAD_PX = ICON + 80;
  const margin = { l: LEFT_PAD_PX, r: 80, t: 16, b: BOTTOM_PAD_PX };
  const plotW = margin.l + n * CELL + margin.r + 40;
  const plotH = margin.t + (n + 0.5) * CELL + margin.b;

  const layout = {
    width: plotW, height: plotH,
    paper_bgcolor: "#1e1e1e", plot_bgcolor: "#1e1e1e",
    font: { color: "#d4d4d4" },
    margin, showlegend: false,
    xaxis: {
      tickvals: labels.map((_, i) => i), ticktext: labels,
      tickangle: 45, side: "bottom",
      tickfont: { size: 12, color: "#d4d4d4" },
      range: [-0.5 - ICON_DATA - PAD_DATA, n - 0.5],
      ticklen: ICON + PAD_DATA * CELL + 4,
      tickcolor: "rgba(0,0,0,0)",
    },
    yaxis: {
      tickvals: labels.map((_, i) => i), ticktext: labels,
      autorange: false, range: [(n - 0.5) + ICON_DATA + PAD_DATA, -0.5],
      tickfont: { size: 12, color: "#d4d4d4" },
      ticklen: 4, tickcolor: "rgba(0,0,0,0)",
    },
    images,
    title: {
      text: "Pool profile correlation — green = redundant, orange = complementary",
      font: { color: "#e0e0e0", size: 13 }, x: 0.5, y: 0.995,
    },
  };
  Plotly.react(div, [trace], layout, { displaylogo: false, responsive: true });
}

export { refreshHealth };
