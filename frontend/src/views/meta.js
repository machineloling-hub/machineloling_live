import { state } from "../state.js";
import { getChampionsData } from "../api.js";
import { ROLES, RANK_LABELS, RANK_COLORS, ROLE_ICON_URL, champSlug, esc } from "../utils.js";

// ──────────────────────────────────────────────────────────────────────────
// PLAYRATE BY RANK — single big chart per role with Sankey-style ribbons.
// Bars sum to exactly 100% (champ_games / total_role_games). Same-champion
// segments across consecutive ranks are connected by colored ribbons so you
// can trace a pick's popularity across brackets.

// Curated 30-color palette, hashed by champion name. More distinct than HSL
// hashing since the colors are hand-picked to be vivid + non-muddy.
const META_PALETTE = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899",
  "#06b6d4", "#84cc16", "#f97316", "#6366f1", "#14b8a6", "#d946ef",
  "#22c55e", "#eab308", "#0ea5e9", "#a855f7", "#fb923c", "#34d399",
  "#fb7185", "#7c3aed", "#fbbf24", "#2dd4bf", "#f472b6", "#60a5fa",
  "#a3e635", "#c084fc", "#ff6b6b", "#4ade80", "#fde047", "#5eead4",
];

function _champColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return META_PALETTE[h % META_PALETTE.length];
}

function _champIconURL(name) {
  return `https://cdn.communitydragon.org/latest/champion/${champSlug(name)}/square`;
}

function _slice(rank, role) {
  // by_patch[rank][role] may be present but empty (upstream data gap for
  // e.g. SUP at diamond); fall back to the per-role default in that case
  // so the chart isn't blank. `default[role]` doesn't carry a per-champ
  // games count, so we estimate one from sibling roles at the same rank
  // (solo-queue role totals are roughly equal) — otherwise tooltips show
  // "0 games".
  const d = getChampionsData();
  const per = d && d.by_patch && d.by_patch[rank] ? d.by_patch[rank][role] : null;
  if (per && per.length) return per;
  const fallback = (d && d.default && d.default[role]) || [];
  if (!fallback.length) return [];
  if (fallback[0] && fallback[0].games != null) return fallback;
  let est = 0, n = 0;
  for (const r of ROLES) {
    const slice = d && d.by_patch && d.by_patch[rank] ? d.by_patch[rank][r] : null;
    if (slice && slice.length) {
      est += slice.reduce((s, c) => s + (c.games || 0), 0);
      n += 1;
    }
  }
  const total = n > 0 ? Math.round(est / n) : 0;
  return fallback.map((c) => ({
    ...c,
    games: c.games || (total > 0 ? Math.round((c.pick_rate || 0) * total) : 0),
  }));
}

function _initMetaSelectedForRole(role, ranks) {
  // Initialize this role's selection from the sidebar pool (intersected
  // with champs that actually appear in the role's data). Only runs once
  // per role per session — subsequent role-tab visits keep whatever the
  // user has clicked. Sidebar pool changes do NOT auto-overwrite an
  // already-initialized role.
  if (!state.metaSelectedByRole) state.metaSelectedByRole = {};
  if (state.metaSelectedByRole[role] !== undefined) return;
  const inRole = new Set();
  for (const rank of ranks) {
    for (const c of _slice(rank, role)) inRole.add(c.champion);
  }
  state.metaSelectedByRole[role] = new Set(
    (state.pool || []).filter((c) => inRole.has(c))
  );
}

function refreshMeta() {
  const container = document.getElementById("meta-charts");
  if (!container) return;
  if (!getChampionsData() || !getChampionsData().by_patch) {
    container.innerHTML = `<div style="color:#bbb;">No champion data loaded yet.</div>`;
    return;
  }

  const ranks = getChampionsData().patches || [];
  const roles = ["TOP", "JUNGLE", "MID", "ADC", "SUP"];
  if (!state.metaRole) state.metaRole = state.role || "SUP";
  if (state.metaShowAll === undefined) state.metaShowAll = false;
  const role = state.metaRole;
  _initMetaSelectedForRole(role, ranks);

  // Build per-rank rows from the (already gap-filled) champions.json. Each
  // entry uses pick_rate as both the bar layout share and the displayed %,
  // so the same champ shows the same number across ranks even after the
  // pick_rates are renormalized for visual stacking.
  const rows = ranks.map((rank) => {
    const all = _slice(rank, role);
    const totalGames = all.reduce((s, c) => s + (c.games || 0), 0) || 1;
    const list = all
      .map((c) => ({
        champion: c.champion,
        games: c.games || 0,
        share: c.pick_rate || 0,
        rawShare: c.pick_rate || 0,
        _interpolated: !!c.interpolated,
      }))
      .filter((c) => c.share > 0)
      .sort((a, b) => b.share - a.share);
    return { rank, list, totalGames };
  });

  // Renormalize each rank's `share` so the bar visually sums to 100%.
  // (Sum of lolalytics pick_rates can drift slightly off 1 and adding
  // interpolated rows nudges it further.) `rawShare` stays untouched.
  for (const r of rows) {
    const total = r.list.reduce((s, c) => s + c.share, 0);
    if (total > 0 && Math.abs(total - 1) > 1e-6) {
      const scale = 1 / total;
      for (const c of r.list) c.share *= scale;
    }
  }

  // Per-(role) scrape-gap log lives at the top of champions.json — pulled
  // by the footer below. No JS-side interpolation work here anymore.
  const interpolations = (getChampionsData().interpolations || [])
    .filter((it) => it.role === role)
    .map((it) => ({
      champ: it.champion,
      rank: it.rank,
      share: it.pick_rate,
      neighbors: it.neighbors.map((n) => ({ rank: n.rank, share: n.pick_rate })),
    }));

  // Aggregate champ list across all ranks (peak share for sorting).
  const champPeak = new Map();
  for (const r of rows) {
    for (const c of r.list) {
      const cur = champPeak.get(c.champion) || 0;
      if (c.share > cur) champPeak.set(c.champion, c.share);
    }
  }
  const champList = [...champPeak.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([champ, peak]) => ({ champ, peak }));

  // Stack from TOP: yacc grows downward. Largest segment at top of bar.
  rows.forEach((r) => {
    let yacc = 0;
    r.positions = new Map();
    for (const c of r.list) {
      r.positions.set(c.champion, { yTopFrac: yacc, yBotFrac: yacc + c.share });
      yacc += c.share;
    }
  });

  // Layout. padT is enlarged so each bar can carry its rank name + total
  // games above the chart as well as below. padR carries a leader-line
  // icon column for selected champs whose rightmost-bar segment is too
  // thin to fit an inline icon.
  const W = 1200;
  const H = 1440;
  const padL = 56, padR = 110, padT = 60, padB = 60;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const colW = chartW / ranks.length;
  const barW = colW * 0.42;
  // Pixel mapping: frac=0 is top of chart, frac=1 is bottom. So largest
  // segment (yTopFrac=0) sits at the very top.
  const yPx = (frac) => padT + chartH * frac;

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="meta-svg-large" preserveAspectRatio="xMidYMid meet">`;

  // Y-axis ticks (label = how much of a bar is "above" this line, measured
  // from the top). Top reads 0%, bottom reads 100%.
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const y = yPx(t);
    svg += `<line x1="${padL - 4}" y1="${y}" x2="${padL + chartW}" y2="${y}" stroke="${t === 0 || t === 1 ? "#444" : "#2a2a2a"}" stroke-width="0.5"/>`;
    svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="#888" font-size="14">${(t * 100).toFixed(0)}%</text>`;
  }

  // Sankey ribbons — drawn first so segment rects sit on top of ribbon edges.
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    const xA = padL + i * colW + (colW - barW) / 2 + barW;
    const xB = padL + (i + 1) * colW + (colW - barW) / 2;
    for (const [champ, posA] of a.positions) {
      const posB = b.positions.get(champ);
      if (!posB) continue;
      const yA0 = yPx(posA.yTopFrac); // top of segment A
      const yA1 = yPx(posA.yBotFrac); // bottom
      const yB0 = yPx(posB.yTopFrac);
      const yB1 = yPx(posB.yBotFrac);
      const cx = (xA + xB) / 2;
      const path = `M${xA},${yA0} C${cx},${yA0} ${cx},${yB0} ${xB},${yB0}` +
                   ` L${xB},${yB1} C${cx},${yB1} ${cx},${yA1} ${xA},${yA1} Z`;
      svg += `<path class="ribbon" data-champ="${esc(champ)}" d="${path}" fill="${_champColor(champ)}"/>`;
    }
  }

  // Bars + segments + icons
  rows.forEach((r, i) => {
    const x0 = padL + i * colW + (colW - barW) / 2;
    for (const c of r.list) {
      const pos = r.positions.get(c.champion);
      const yA = yPx(pos.yTopFrac);
      const yB = yPx(pos.yBotFrac);
      const segH = yB - yA;
      if (segH < 0.4) continue;
      const color = _champColor(c.champion);
      // Display the raw (pre-normalization) share so values stay consistent
      // across ranks. Bar layout still uses `share` (renormalized to 100%).
      const pct = ((c.rawShare ?? c.share) * 100).toFixed(2);

      const interp = c._interpolated ? ' data-interpolated="1"' : '';
      svg += `<g class="seg" data-champ="${esc(c.champion)}" data-pct="${pct}" data-games="${c.games}" data-rank="${RANK_LABELS[r.rank] || r.rank}"${interp}>`;
      svg += `<rect x="${x0}" y="${yA}" width="${barW}" height="${segH}" fill="${color}" stroke="rgba(0,0,0,0.18)" stroke-width="0.4"/>`;
      if (segH >= 14) {
        const iconSize = Math.min(segH - 2, 30);
        const iconX = x0 + (barW - iconSize) / 2;
        const iconY = yA + (segH - iconSize) / 2;
        svg += `<image x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" href="${_champIconURL(c.champion)}" preserveAspectRatio="xMidYMid slice" pointer-events="none"/>`;
      }
      svg += `</g>`;
    }
    const cx = x0 + barW / 2;
    const rankColor = RANK_COLORS[r.rank] || "#d4d4d4";
    const rankName = RANK_LABELS[r.rank] || r.rank;
    const gamesStr = r.totalGames.toLocaleString();
    // Top header (rank name colored to in-game tier color, games count below)
    svg += `<text x="${cx}" y="24" text-anchor="middle" fill="${rankColor}" font-size="20" font-weight="700">${rankName}</text>`;
    svg += `<text x="${cx}" y="46" text-anchor="middle" fill="#888" font-size="13">${gamesStr} games</text>`;
    // Bottom footer (mirror of header)
    svg += `<text x="${cx}" y="${padT + chartH + 22}" text-anchor="middle" fill="${rankColor}" font-size="20" font-weight="700">${rankName}</text>`;
    svg += `<text x="${cx}" y="${padT + chartH + 44}" text-anchor="middle" fill="#888" font-size="13">${gamesStr} games</text>`;
  });

  // Leader-line callouts for SELECTED champs whose rightmost-bar segment is
  // too thin to fit an inline icon. Connect a small icon in the right margin
  // to the segment center via a smooth curve, colored with the champ's color.
  const selSet = state.metaSelectedByRole[role];
  const leaderItems = [];
  for (const champ of selSet) {
    // Rightmost bar where the champion has a segment.
    let rightIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].positions.has(champ)) { rightIdx = i; break; }
    }
    if (rightIdx === -1) continue; // not in any bar (e.g., 0-game champ)
    const pos = rows[rightIdx].positions.get(champ);
    const segH = (pos.yBotFrac - pos.yTopFrac) * chartH;
    if (segH >= 14) continue; // already has inline icon, no callout needed
    const segMidY = yPx((pos.yTopFrac + pos.yBotFrac) / 2);
    const segRightX = padL + rightIdx * colW + (colW - barW) / 2 + barW;
    leaderItems.push({ champ, segRightX, segMidY });
  }
  // Non-overlapping layout (Wilkinson-style two-pass): each icon prefers
  // its segment-midpoint Y, but icons "repel" each other to maintain
  // minSep spacing and stay within [lo, hi]. Overflows past the bottom
  // get redistributed upward by the backward pass.
  const iconSize = 22;
  const minSep = iconSize + 4;
  const iconX = padL + chartW + 14;
  const yLo = padT;
  const yHi = padT + chartH - iconSize;
  leaderItems.sort((a, b) => a.segMidY - b.segMidY);
  // Forward pass: place at ideal Y, push down to respect minSep + top bound
  let prevY = yLo - minSep;
  for (const item of leaderItems) {
    let y = item.segMidY - iconSize / 2;
    if (y < prevY + minSep) y = prevY + minSep;
    if (y < yLo) y = yLo;
    item.iconY = y;
    prevY = y;
  }
  // Backward pass: if anything overflowed past yHi, pull preceding icons
  // up so the column ends at yHi.
  if (leaderItems.length && leaderItems[leaderItems.length - 1].iconY > yHi) {
    let nextY = yHi + minSep;
    for (let i = leaderItems.length - 1; i >= 0; i--) {
      let y = leaderItems[i].iconY;
      if (y > nextY - minSep) y = nextY - minSep;
      leaderItems[i].iconY = y;
      nextY = y;
    }
    // First icon may have been pushed above yLo by the back-pass; clamp
    // and re-forward to keep spacing tight.
    prevY = yLo - minSep;
    for (const item of leaderItems) {
      let y = item.iconY;
      if (y < prevY + minSep) y = prevY + minSep;
      item.iconY = y;
      prevY = y;
    }
  }
  for (const item of leaderItems) {
    const color = _champColor(item.champ);
    const iconMidY = item.iconY + iconSize / 2;
    const cx = (item.segRightX + iconX) / 2;
    const path = `M${item.segRightX},${item.segMidY} C${cx},${item.segMidY} ${cx},${iconMidY} ${iconX},${iconMidY}`;
    svg += `<g class="leader" data-champ="${esc(item.champ)}">`;
    svg += `<path d="${path}" stroke="${color}" stroke-width="1.6" fill="none" opacity="0.9"/>`;
    svg += `<image x="${iconX}" y="${item.iconY}" width="${iconSize}" height="${iconSize}" href="${_champIconURL(item.champ)}" preserveAspectRatio="xMidYMid slice"/>`;
    svg += `<rect x="${iconX}" y="${item.iconY}" width="${iconSize}" height="${iconSize}" fill="none" stroke="${color}" stroke-width="1.5" rx="3"/>`;
    svg += `</g>`;
  }

  svg += "</svg>";

  // Top: role sub-tab bar + Show-all toggle.
  let tabs = `<div class="meta-controls-row">
    <div class="role-strip meta-role-tabs" role="tablist" aria-label="Role">`;
  for (const r of roles) {
    tabs += `<button class="role-tile meta-role-tab ${r === role ? "active" : ""}" data-role="${r}" role="tab" aria-selected="${r === role}" title="${r}">`;
    tabs += `<img src="${ROLE_ICON_URL(r)}" alt="${r}">`;
    tabs += `</button>`;
  }
  tabs += `</div>
    <label class="meta-show-all-label"><input type="checkbox" id="meta-show-all" ${state.metaShowAll ? "checked" : ""}> <span>Show all (overrides selection)</span></label>
  </div>`;

  // Champion picker grid — click to toggle highlight. Defaults to the
  // sidebar pool (filtered to this role) on first visit; persists per role.
  const sel = state.metaSelectedByRole[role];
  let grid = `<div class="meta-champ-grid-wrap">
    <div class="meta-champ-grid-label">
      Click champions to highlight (default: your pool from the sidebar).
      <button class="meta-champ-clear" type="button">Clear</button>
      <button class="meta-champ-resync" type="button">Reset to pool</button>
    </div>
    <div class="meta-champ-grid">`;
  for (const { champ, peak } of champList) {
    const isSel = sel.has(champ);
    grid += `<div class="meta-champ-tile ${isSel ? "selected" : ""}" data-tile-champ="${esc(champ)}" title="${esc(champ)} — peak ${(peak * 100).toFixed(2)}%">`;
    grid += `<img src="${_champIconURL(champ)}" alt="${esc(champ)}" onerror="this.style.opacity='0';">`;
    grid += `</div>`;
  }
  grid += `</div></div>`;

  // Footer: list of scrape-gap interpolations (champs missing from a rank
  // whose share we filled from neighboring ranks). Dashed white border on
  // the chart segment marks the same entries.
  let interpFooter = "";
  if (interpolations.length > 0) {
    const items = interpolations
      .slice()
      .sort((a, b) => a.champ.localeCompare(b.champ) || ranks.indexOf(a.rank) - ranks.indexOf(b.rank))
      .map((i) => {
        const rl = RANK_LABELS[i.rank] || i.rank;
        const nbrs = i.neighbors.map(n => `${RANK_LABELS[n.rank] || n.rank} ${(n.share * 100).toFixed(2)}%`).join(", ");
        return `<li><b>${esc(i.champ)}</b> in ${rl}: filled ${(i.share * 100).toFixed(2)}% (avg of ${nbrs})</li>`;
      })
      .join("");
    interpFooter = `<details class="meta-interp-footer" style="margin:14px 0 4px 0;color:#aaa;font-size:13px;">
      <summary style="cursor:pointer;">${interpolations.length} scrape-gap value${interpolations.length === 1 ? "" : "s"} interpolated for ${role} from neighboring ranks. Click to expand.</summary>
      <ul style="margin:6px 0 0 22px;padding:0;line-height:1.5;">${items}</ul>
    </details>`;
  }

  container.innerHTML = tabs + grid + `<div class="meta-panel-large">${svg}</div>${interpFooter}<div id="meta-tooltip" class="meta-tooltip"></div>`;

  // Role sub-tab clicks
  for (const btn of container.querySelectorAll(".meta-role-tab")) {
    btn.addEventListener("click", () => {
      state.metaRole = btn.dataset.role;
      refreshMeta();
    });
  }
  // Show-all toggle
  const showAllChk = container.querySelector("#meta-show-all");
  if (showAllChk) {
    showAllChk.addEventListener("change", (e) => {
      state.metaShowAll = e.target.checked;
      _applyMetaDimming();
    });
  }

  // Champion-grid clicks: toggle selection for the active role. We rebuild
  // the chart so leader-line callouts can appear/disappear with selection.
  for (const tile of container.querySelectorAll(".meta-champ-tile")) {
    tile.addEventListener("click", (e) => {
      const c = e.currentTarget.dataset.tileChamp;
      const set = state.metaSelectedByRole[role];
      if (set.has(c)) set.delete(c);
      else set.add(c);
      refreshMeta();
    });
  }
  // Clear / Reset-to-pool buttons.
  container.querySelector(".meta-champ-clear")?.addEventListener("click", () => {
    state.metaSelectedByRole[role] = new Set();
    refreshMeta();
  });
  container.querySelector(".meta-champ-resync")?.addEventListener("click", () => {
    delete state.metaSelectedByRole[role];
    refreshMeta();
  });

  // Hover handlers (segment OR ribbon highlights champion across all bars)
  const svgEl = container.querySelector(".meta-svg-large");
  const tooltip = container.querySelector("#meta-tooltip");
  svgEl.addEventListener("mousemove", (e) => {
    const target = e.target.closest("[data-champ]");
    if (!target) {
      tooltip.style.display = "none";
      if (state.metaHoverChamp) { state.metaHoverChamp = null; _applyMetaDimming(); }
      return;
    }
    const champ = target.dataset.champ;
    const isSeg = target.classList.contains("seg");
    if (isSeg) {
      const pct = target.dataset.pct;
      const games = parseInt(target.dataset.games).toLocaleString();
      const rank = target.dataset.rank;
      tooltip.innerHTML =
        `<img src="${_champIconURL(champ)}" alt="" onerror="this.style.display='none'">` +
        `<div><div class="name">${esc(champ)}</div>` +
        `<div class="meta">${pct}% · ${games} games · ${rank}</div></div>`;
    } else {
      // ribbon — show just champ icon + name (segments on either side carry detail)
      tooltip.innerHTML =
        `<img src="${_champIconURL(champ)}" alt="" onerror="this.style.display='none'">` +
        `<div><div class="name">${esc(champ)}</div></div>`;
    }
    tooltip.style.display = "flex";
    _positionMetaTooltip(e, tooltip);
    if (state.metaHoverChamp !== champ) {
      state.metaHoverChamp = champ;
      _applyMetaDimming();
    }
  });
  svgEl.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    if (state.metaHoverChamp) { state.metaHoverChamp = null; _applyMetaDimming(); }
  });

  // Apply initial dimming based on pool selection.
  _applyMetaDimming();
}

function _positionMetaTooltip(e, tooltip) {
  const offset = 16;
  const rect = tooltip.getBoundingClientRect();
  let x = e.clientX + offset;
  let y = e.clientY + offset;
  if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - offset;
  if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - offset;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}

function _applyMetaDimming() {
  const view = document.querySelector("#view-meta");
  if (!view) return;
  const role = state.metaRole;
  const sel = (state.metaSelectedByRole && state.metaSelectedByRole[role]) || new Set();
  const hover = state.metaHoverChamp;
  const showAll = state.metaShowAll;

  // Chart segments + ribbons — both carry data-champ.
  for (const el of view.querySelectorAll("[data-champ]")) {
    const ch = el.dataset.champ;
    let bright;
    if (hover) bright = (ch === hover);
    else if (showAll) bright = true;
    else bright = sel.has(ch);
    el.classList.toggle("meta-dim", !bright);
  }
}

function setActiveView(view) {
  state.view = view;
  $$(".tabs-top .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  // matchup + synergy share #view-coverage; everything else has its own section
  const isCov = view === "matchup" || view === "synergy";
  const sectionId = isCov ? "view-coverage" : `view-${view}`;
  $$(".view").forEach((s) => s.classList.toggle("active", s.id === sectionId));
  if (isCov) {
    state.otherRole = defaultOtherRole(state.role, view);
    renderRoleSubTabs();
  }
}

let refreshPending = false;
async function refresh() {
  if (refreshPending) return;
  refreshPending = true;
  await new Promise((r) => setTimeout(r, 0));
  refreshPending = false;
  try {
    if (state.view === "matchup" || state.view === "synergy") await refreshCoverage();
    else if (state.view === "health") await refreshHealth();
    else if (state.view === "blindability") await refreshBlindability();
    else if (state.view === "bans") await refreshBans();
    else if (state.view === "builder") await refreshBuilder();
    else if (state.view === "replacements") await refreshReplacements();
    else if (state.view === "comparer") await refreshComparer();
    else if (state.view === "meta") refreshMeta();
  } catch (e) {
    console.error(e);
    setStatus("error: " + e.message);
  }
}


export { refreshMeta };
