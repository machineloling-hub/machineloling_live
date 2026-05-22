import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, champImg, champIconUrl, fmtSign, tealOrangeBg, BLIND_COLOR } from "../utils.js";

// ──────────────────────────────────────────────────────────────────────────
// BLINDABILITY TAB
// ──────────────────────────────────────────────────────────────────────────
async function refreshBlindability() {
  const r = await apiFetch("/api/blindability", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role, pool: state.pool,
      pr_floor: state.prFloor, pr_weighted: state.prWeighted,
      patch: state.patch, shrink_alpha: state.shrinkAlpha,
    }),
  });
  const data = await r.json();
  const scatterDiv = $("#blind-scatter");
  const tableDiv = $("#blind-table");
  if (data.empty || !data.rows.length) {
    Plotly.purge(scatterDiv);
    scatterDiv.innerHTML = '<div class="empty-msg">No blindability data at this floor.</div>';
    tableDiv.innerHTML = "";
    return;
  }

  // Scatter: x = matchup_mean, y = synergy_mean. Use champion icons as markers.
  // Pool champs are kept even if one axis is null (defaulted to 0) so the user
  // always sees their picks. Non-pool champs need both axes populated.
  const rows = data.rows.filter((r) => r.in_pool || (r.matchup_mean != null && r.synergy_mean != null));
  rows.forEach((r) => {
    if (r.matchup_mean == null) r.matchup_mean = 0;
    if (r.synergy_mean == null) r.synergy_mean = 0;
  });
  const x = rows.map((r) => r.matchup_mean);
  const y = rows.map((r) => r.synergy_mean);
  const labels = rows.map((r) => r.champion);
  const colors = rows.map((r) => r.in_pool ? "#009E73" : "#666");
  const sizes = rows.map((r) => r.in_pool ? 14 : 9);

  // Compute axis ranges with padding
  const xr = [Math.min(...x), Math.max(...x)];
  const yr = [Math.min(...y), Math.max(...y)];
  if (xr[1] - xr[0] < 0.5) { const m = (xr[0] + xr[1]) / 2; xr[0] = m - 0.25; xr[1] = m + 0.25; }
  if (yr[1] - yr[0] < 0.5) { const m = (yr[0] + yr[1]) / 2; yr[0] = m - 0.25; yr[1] = m + 0.25; }
  const padX = (xr[1] - xr[0]) * 0.08, padY = (yr[1] - yr[0]) * 0.08;
  const xlim = [xr[0] - padX, xr[1] + padX];
  const ylim = [yr[0] - padY, yr[1] + padY];

  // Convert icon pixel size to data units for sizex/sizey.
  const PLOT_W = 760, PLOT_H = 760;
  const innerWPx = PLOT_W - 80 - 30;
  const innerHPx = PLOT_H - 60 - 80;
  const xRangeSize = xlim[1] - xlim[0];
  const yRangeSize = ylim[1] - ylim[0];
  const iconPx = state.blindIconPx;
  const iconSizeX = iconPx * xRangeSize / innerWPx;
  const iconSizeY = iconPx * yRangeSize / innerHPx;

  // Green BOX (rectangle shape) around each pool champ, drawn under the icon.
  // Slightly bigger than the icon so it forms a visible border.
  const boxPadX = iconSizeX * 0.10;
  const boxPadY = iconSizeY * 0.10;
  const shapes = rows.filter((r) => r.in_pool).map((r) => ({
    type: "circle", xref: "x", yref: "y",
    x0: r.matchup_mean - iconSizeX / 2 - boxPadX,
    x1: r.matchup_mean + iconSizeX / 2 + boxPadX,
    y0: r.synergy_mean - iconSizeY / 2 - boxPadY,
    y1: r.synergy_mean + iconSizeY / 2 + boxPadY,
    line: { color: "#3DD9A4", width: 3 },
    fillcolor: "rgba(0, 158, 115, 0.15)",
    layer: "below",
  }));

  // Champion icons via layout.images (one image per point)
  const images = rows.map((r) => ({
    source: champIconUrl(r.champion),
    xref: "x", yref: "y",
    x: r.matchup_mean, y: r.synergy_mean,
    sizex: iconSizeX, sizey: iconSizeY,
    xanchor: "center", yanchor: "middle",
    sizing: "contain", layer: "above",
  }));

  // Hover-only invisible scatter so users get tooltips on the points
  const traces = [{
    type: "scatter", mode: "markers",
    x, y, text: labels,
    marker: { size: 6, color: "rgba(0,0,0,0)" },
    hovertemplate: "<b>%{text}</b><br>matchup z: %{x:.2f}<br>synergy z: %{y:.2f}<extra></extra>",
    showlegend: false,
  }];

  Plotly.react(scatterDiv, traces, {
    width: PLOT_W, height: PLOT_H,
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Inter, sans-serif", color: "#E6EAF2" },
    margin: { l: 80, r: 30, t: 60, b: 80 },
    title: { text: `${state.role} — blindability map`, font: { size: 16, color: BLIND_COLOR } },
    xaxis: {
      range: xlim, title: { text: "Matchup blindability z (→ better vs random opponent)", font: { color: "#e6c978" } },
      zeroline: true, zerolinecolor: "#555",
      gridcolor: "rgba(255,255,255,0.06)", tickfont: { color: "#e6c978" },
    },
    yaxis: {
      range: ylim, title: { text: "Synergy blindability z (↑ better with random partner)", font: { color: "#7fc0e8" } },
      zeroline: true, zerolinecolor: "#555",
      gridcolor: "rgba(255,255,255,0.06)", tickfont: { color: "#7fc0e8" },
    },
    images, shapes,
  }, { displaylogo: false });

  _attachBlindIconHover(scatterDiv);

  renderBlindTable(data);
}

// Delegate mouseenter on the icon images: bring the hovered icon to the
// front of its SVG group so the scale-up glow isn't clipped by neighbors.
// CSS handles the circular clip + scale + drop-shadow. Idempotent: safe to
// call after every Plotly.react.
function _attachBlindIconHover(div) {
  if (div._blindHoverWired) return;
  div._blindHoverWired = true;
  div.addEventListener("mouseover", (e) => {
    const img = e.target.closest("image");
    if (!img || !div.contains(img)) return;
    const parent = img.parentNode;
    if (parent && parent.lastChild !== img) parent.appendChild(img);
  }, true);
}

function renderBlindTable(data) {
  const showLaneSyn = data.lane_synergy_pos != null;
  const fmt = (v) => v == null ? '<td class="cell-na">—</td>'
    : `<td style="background:${tealOrangeBg(v)};color:#fff;text-align:center;font-weight:bold;border-radius:3px;">${fmtSign(v)}</td>`;
  const tr = data.rows.map((r, k) => {
    const cls = r.in_pool ? "in-pool-row" : "";
    const name = r.in_pool
      ? `<b style="color:#6fe2b5;">${r.champion}</b> <span style="color:#888;font-size:10px;">(pool)</span>`
      : `<b>${r.champion}</b>`;
    return `<tr class="${cls}">
      <td>${k + 1}</td>
      <td>${champImg(r.champion, 22)} ${name}</td>
      ${fmt(r.aggregate)}
      ${fmt(r.matchup_mean)}
      ${fmt(r.lane_matchup)}
      ${fmt(r.out_of_lane_matchup)}
      ${fmt(r.synergy_mean)}
      ${showLaneSyn ? fmt(r.lane_synergy) : ""}
      ${showLaneSyn ? fmt(r.out_of_lane_synergy) : ""}
    </tr>`;
  }).join("");
  const laneM = data.lane_matchup_pos.join("+");
  const laneS = data.lane_synergy_pos;
  $("#blind-table").innerHTML = `<table class="std-table" style="margin-top:14px;">
    <thead><tr>
      <th>Rank</th><th>Champion</th><th>Overall</th>
      <th style="color:#e6c978;">Overall matchup</th>
      <th style="color:#e6c978;">Lane matchup<br><span style="font-size:10px;color:#888;">(vs ${laneM})</span></th>
      <th style="color:#e6c978;">Out-of-lane matchup</th>
      <th style="color:#7fc0e8;">Overall synergy</th>
      ${showLaneSyn ? `<th style="color:#7fc0e8;">In-lane synergy<br><span style="font-size:10px;color:#888;">(w/ ${laneS})</span></th>` : ""}
      ${showLaneSyn ? `<th style="color:#7fc0e8;">Out-of-lane synergy</th>` : ""}
    </tr></thead>
    <tbody>${tr}</tbody>
  </table>`;
}


export { refreshBlindability };
