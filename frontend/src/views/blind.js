import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, champImg, champIconUrl, fmtSign, tealOrangeBg, BLIND_COLOR } from "../utils.js";

const _ROLE_DISPLAY = {
  TOP: "Toplane",
  JUNGLE: "Jungle",
  MID: "Midlane",
  ADC: "ADC",
  SUP: "Support",
};
const _roleTitle = (r) => _ROLE_DISPLAY[r] || r;

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
  // Fill the available container width; pick a height that uses most of
  // the viewport so the map is no longer a small square.
  const PLOT_W = Math.max(480, Math.floor(scatterDiv.clientWidth || scatterDiv.parentElement.clientWidth || 760));
  const PLOT_H = Math.max(520, Math.floor(window.innerHeight * 0.78));
  const innerWPx = PLOT_W - 80 - 30;
  const innerHPx = PLOT_H - 60 - 80;
  const xRangeSize = xlim[1] - xlim[0];
  const yRangeSize = ylim[1] - ylim[0];
  const iconPx = state.blindIconPx + 3;
  const iconSizeX = iconPx * xRangeSize / innerWPx;
  const iconSizeY = iconPx * yRangeSize / innerHPx;

  // Green CIRCLE outline around each pool champ. Layered "above" so the
  // outline stays visible over neighbouring non-pool icons; the fill is kept
  // near-transparent so the pool icon underneath isn't dimmed.
  const boxPadX = iconSizeX * 0.10;
  const boxPadY = iconSizeY * 0.10;
  const shapes = rows.filter((r) => r.in_pool).map((r) => ({
    type: "circle", xref: "x", yref: "y",
    x0: r.matchup_mean - iconSizeX / 2 - boxPadX,
    x1: r.matchup_mean + iconSizeX / 2 + boxPadX,
    y0: r.synergy_mean - iconSizeY / 2 - boxPadY,
    y1: r.synergy_mean + iconSizeY / 2 + boxPadY,
    line: { color: "#3DD9A4", width: 3 },
    fillcolor: "rgba(0, 158, 115, 0.08)",
    layer: "above",
  }));

  // Champion icons via layout.images (one image per point). Pool champs
  // are pushed last so Plotly renders them on top of non-pool icons —
  // they're the user's actual picks and should never be obscured by a
  // neighbouring sea of grey icons.
  const imgRows = [
    ...rows.filter((r) => !r.in_pool),
    ...rows.filter((r) => r.in_pool),
  ];
  const images = imgRows.map((r) => ({
    source: champIconUrl(r.champion),
    xref: "x", yref: "y",
    x: r.matchup_mean, y: r.synergy_mean,
    sizex: iconSizeX, sizey: iconSizeY,
    xanchor: "center", yanchor: "middle",
    sizing: "contain", layer: "above",
  }));

  // Hover-only invisible scatter so users get tooltips on the points.
  // Marker size is set to the *hovered* icon footprint (icon px × the
  // 1.8 hover scale in CSS) so Plotly places the hover label outside
  // the scaled-up icon instead of on top of it.
  const HOVER_SCALE = 1.8;
  const traces = [{
    type: "scatter", mode: "markers",
    x, y, text: labels,
    marker: { size: Math.round(iconPx * HOVER_SCALE), color: "rgba(0,0,0,0)" },
    hovertemplate: "<b>%{text}</b><br>matchup z: %{x:.2f}<br>synergy z: %{y:.2f}<extra></extra>",
    hoverlabel: { align: "left" },
    showlegend: false,
  }];

  Plotly.react(scatterDiv, traces, {
    width: PLOT_W, height: PLOT_H,
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Inter, sans-serif", color: "#E6EAF2" },
    margin: { l: 80, r: 30, t: 60, b: 80 },
    title: { text: `${_roleTitle(state.role)} Blindability Map`, font: { size: 16, color: BLIND_COLOR } },
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

  // Tag each rendered <image> with its champion name so hover/unhover can
  // find the right element even after we reorder DOM for z-order. Plotly
  // emits images in layout.images order, which == imgRows order here
  // (non-pool first, pool last).
  const imgEls = scatterDiv.querySelectorAll(".imagelayer image");
  imgEls.forEach((el, i) => {
    if (imgRows[i]) {
      el.setAttribute("data-champ", imgRows[i].champion);
      el.setAttribute("data-in-pool", imgRows[i].in_pool ? "1" : "0");
    }
  });

  _attachBlindIconHover(scatterDiv);
  _attachBlindResize(scatterDiv);

  renderBlindTable(data);
}

// Re-render the blindability scatter on window resize so it keeps filling
// the available width/height.
function _attachBlindResize(div) {
  if (div._blindResizeWired) return;
  div._blindResizeWired = true;
  let t = null;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => { refreshBlindability().catch(() => {}); }, 150);
  });
}

// Plotly's hover overlay sits above the imagelayer and swallows mouse
// events, so CSS :hover on the <image> elements never fires. Instead we
// listen to Plotly's plotly_hover / plotly_unhover on the invisible
// scatter trace and toggle a class on the matching <image>, also
// re-appending it to its parent group so it draws on top.
//
// We look up the target <image> by champion name (data-champ) because
// re-appending shifts DOM order, so indexing by position would point at
// the wrong element after the first hover.
function _raisePoolIcons(div) {
  // Pool icons must always render above non-pool icons. After any hover
  // reorder, re-append them to the imagelayer so they stay on top.
  const layer = div.querySelector(".imagelayer");
  if (!layer) return;
  layer.querySelectorAll('image[data-in-pool="1"]').forEach((el) => {
    layer.appendChild(el);
  });
}
function _attachBlindIconHover(div) {
  if (div._blindHoverWired) return;
  div._blindHoverWired = true;
  div.on("plotly_hover", (ev) => {
    const pt = ev && ev.points && ev.points[0];
    if (!pt || !pt.text) return;
    const sel = `image[data-champ="${CSS.escape(pt.text)}"]`;
    const img = div.querySelector(`.imagelayer ${sel}`);
    if (!img) return;
    if (div._blindHovered && div._blindHovered !== img) {
      div._blindHovered.classList.remove("hovered");
    }
    img.classList.add("hovered");
    div._blindHovered = img;
    if (img.parentNode && img.parentNode.lastChild !== img) {
      img.parentNode.appendChild(img);
    }
    // Hovering a non-pool icon would otherwise leave it above pool icons
    // even after unhover; re-raise pool icons so they remain on top.
    if (img.getAttribute("data-in-pool") !== "1") {
      _raisePoolIcons(div);
      // ...then re-raise the hovered non-pool icon above the pool icons
      // (only while actively hovered).
      img.parentNode.appendChild(img);
    }
  });
  div.on("plotly_unhover", () => {
    if (div._blindHovered) {
      div._blindHovered.classList.remove("hovered");
      div._blindHovered = null;
    }
    _raisePoolIcons(div);
  });
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
