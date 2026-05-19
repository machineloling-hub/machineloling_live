import { state } from "../state.js";
import { apiFetch } from "../api.js";
import { $, champImg, fmtSign, setStatus, MATCHUP_COLOR, SYNERGY_COLOR } from "../utils.js";

// ──────────────────────────────────────────────────────────────────────────
// COMPARER TAB (champion-vs-champion correlation)
// ──────────────────────────────────────────────────────────────────────────
const CMP_ROLE_ICON = (role, size = 18) => {
  const slug = { TOP: "top", JUNGLE: "jungle", MID: "middle", ADC: "bottom", SUP: "utility" }[role];
  if (!slug) return role;
  return `<img src="https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${slug}.png" width="${size}" height="${size}" style="vertical-align:middle;filter:brightness(2);" onerror="this.outerHTML='${role}'">`;
};
// Correlation cell colour: positive = teal (similar), negative = orange.
function _cmpCorrBg(v) {
  if (v == null || !isFinite(v)) return "transparent";
  const a = Math.min(1, Math.abs(v) / 0.5);
  return v >= 0
    ? `rgba(0,158,115,${(a * 0.7).toFixed(2)})`
    : `rgba(213,94,0,${(a * 0.7).toFixed(2)})`;
}
function _cmpCorrFg(v) {
  if (v == null || !isFinite(v)) return "#888";
  return Math.abs(v) / 0.5 > 0.5 ? "#fff" : "#d4d4d4";
}
// Blindability z: positive = blindable (good), negative = polarized.
function _cmpBlindBg(v) {
  if (v == null || !isFinite(v)) return "transparent";
  const a = Math.min(1, Math.abs(v) / 1.5);
  return v >= 0
    ? `rgba(201,164,216,${(a * 0.55).toFixed(2)})`   // pale purple
    : `rgba(213,94,0,${(a * 0.55).toFixed(2)})`;
}
function _cmpDetailCell(a, cls, showDeltas, selChamp, partnerChamp) {
  if (!a) return `<td style="text-align:center;color:#555;">—</td>`;
  const m = a.block.split(" ");
  const type = m[0];
  const rc = m[1] || "";
  const ui = rc.indexOf("_");
  const role = ui >= 0 ? rc.substring(0, ui) : "";
  const champ = ui >= 0 ? rc.substring(ui + 1) : rc;
  const typeLbl = type === "vs" ? "vs" : "w/";
  const borderColor = cls === "strong" ? "#009E73" : cls === "weak" ? "#D55E00" : "#006D9E";
  const bg = cls === "strong" ? "rgba(0,158,115,0.08)"
           : cls === "weak"   ? "rgba(213,94,0,0.08)"
           :                    "rgba(0,109,158,0.08)";
  let html = `<td style="text-align:center;border:2px solid ${borderColor};background:${bg};border-radius:4px;padding:3px 2px;">`;
  if (showDeltas) {
    html += `<div style="display:flex;align-items:center;justify-content:center;gap:2px;">${CMP_ROLE_ICON(role, 18)}${champImg(champ, 24)}</div>`;
    html += `<div style="font-size:9px;font-weight:bold;opacity:0.85;">${typeLbl}</div>`;
    html += `<div style="display:flex;align-items:center;justify-content:center;gap:2px;font-size:10px;">`
          + `${champImg(selChamp, 14)}<span>${fmtSign(a.ch_delta, 1)}</span>`
          + `<span style="color:#666;">/</span>`
          + `${champImg(partnerChamp, 14)}<span>${fmtSign(a.partner_delta, 1)}</span></div>`;
  } else {
    html += `<div style="display:flex;align-items:center;justify-content:center;gap:3px;">`
          + `<span style="font-size:10px;font-weight:bold;opacity:0.7;">${typeLbl}</span>`
          + `${CMP_ROLE_ICON(role, 18)}${champImg(champ, 24)}</div>`;
  }
  html += "</td>";
  return html;
}
function _cmpRow(e, selChamp, selBlindZ) {
  const sortBy = state.cmpSort;
  const showDeltas = state.cmpDeltas;
  const cells = [e.total, e.matchup, e.synergy].map((v) =>
    `<td style="text-align:center;background:${_cmpCorrBg(v)};color:${_cmpCorrFg(v)};font-weight:bold;border-radius:3px;">${v == null ? "—" : v.toFixed(2)}</td>`
  ).join("");
  // Blind Δz = row champ's blindability − selected champion's. Positive
  // means the comparison champ is MORE blindable than the selected.
  const blindDelta = (e.blind_z == null || selBlindZ == null) ? null : (e.blind_z - selBlindZ);
  const blindCell = `<td style="text-align:center;background:${_cmpBlindBg(blindDelta)};color:${_cmpCorrFg(blindDelta)};font-weight:bold;border-radius:3px;">${blindDelta == null ? "—" : fmtSign(blindDelta, 2)}</td>`;
  const pad = (arr, n) => { const out = arr.slice(0, n); while (out.length < n) out.push(null); return out; };
  const strong = pad(e.strong || [], 3).map((a) => _cmpDetailCell(a, "strong", showDeltas, selChamp, e.champion)).join("");
  const weak   = pad(e.weak   || [], 3).map((a) => _cmpDetailCell(a, "weak",   showDeltas, selChamp, e.champion)).join("");
  const dis    = pad(e.disagree || [], 3).map((a) => _cmpDetailCell(a, "disagree", showDeltas, selChamp, e.champion)).join("");
  return `<tr>
    <td><div style="display:flex;align-items:center;gap:4px;">${champImg(e.champion, 24)}<span style="font-weight:bold;">${e.champion}</span></div></td>
    ${cells}
    ${blindCell}
    ${strong}${weak}${dis}
  </tr>`;
}
function _cmpRenderTables(payload) {
  const sortBy = state.cmpSort;
  const sortFn = (a, b) => {
    const av = a[sortBy], bv = b[sortBy];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  };
  const all = (payload.rows || []).slice().filter((r) => r[sortBy] != null);
  const similar = all.slice().sort(sortFn).slice(0, 10);
  const opposite = all.slice().sort((a, b) => -sortFn(a, b)).slice(0, 10);

  const selBlindZ = (payload.info && payload.info.blind_z != null) ? payload.info.blind_z : null;
  const hdr = `<thead><tr>
    <th style="width:11%;">Champion</th>
    <th style="text-align:center;">Total</th>
    <th style="text-align:center;color:${MATCHUP_COLOR};">Matchup</th>
    <th style="text-align:center;color:${SYNERGY_COLOR};">Synergy</th>
    <th style="text-align:center;color:#c9a4d8;">Blind Δz</th>
    <th colspan="3" style="color:#009E73;text-align:center;">Both Strong</th>
    <th colspan="3" style="color:#D55E00;text-align:center;">Both Weak</th>
    <th colspan="3" style="color:#006D9E;text-align:center;">Most Different</th>
  </tr></thead>`;
  const renderTable = (rows) => `<table class="cmp-table" style="width:100%;border-collapse:separate;border-spacing:2px;font-size:13px;">
    ${hdr}
    <tbody>${rows.map((r) => _cmpRow(r, payload.champion, selBlindZ)).join("")}</tbody>
  </table>`;
  $("#cmp-similar").innerHTML = renderTable(similar);
  $("#cmp-opposite").innerHTML = renderTable(opposite);

  const i = payload.info || {};
  const bz = i.blind_z == null ? "—" : fmtSign(i.blind_z, 2);
  $("#cmp-info").innerHTML =
    `${champImg(payload.champion, 24)} <b>${payload.champion}</b> (${payload.role}) `
    + `| WR: ${i.win_rate ?? "?"}% `
    + `| PR: ${i.pick_rate ?? "?"}% `
    + `| Blind z: <span style="color:#c9a4d8;font-weight:bold;">${bz}</span>`;
}
// Reset the comparer's selection when role changes.
function _cmpRefreshDropdown() {
  const list = state.champsByRole[state.role] || [];
  const prev = state.cmpChampion;
  // Default to highest-PR champ if previous selection isn't available at the
  // new role (or this is the first render).
  if (!list.find((c) => c.champion === prev)) {
    state.cmpChampion = list.length ? list[0].champion : null;
  }
  if (window.cmpSS) window.cmpSS.renderChip();
}
async function refreshComparer() {
  _cmpRefreshDropdown();
  if (!state.cmpChampion) {
    $("#cmp-info").textContent = "No eligible champions at this PR floor.";
    $("#cmp-similar").innerHTML = "";
    $("#cmp-opposite").innerHTML = "";
    return;
  }
  setStatus("computing comparer…");
  const r = await apiFetch("/api/comparer", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role, champion: state.cmpChampion,
      pr_floor: state.prFloor, pr_weighted: state.prWeighted,
      patch: state.patch, shrink_alpha: state.shrinkAlpha,
    }),
  });
  const data = await r.json();
  setStatus("");
  if (data.empty) {
    $("#cmp-info").textContent = "No data for this champion at this PR floor.";
    $("#cmp-similar").innerHTML = "";
    $("#cmp-opposite").innerHTML = "";
    return;
  }
  // Cache the last payload so sort/show-deltas toggles can re-render without
  // a refetch — none of the underlying numbers change.
  state.cmpLastPayload = data;
  _cmpRenderTables(data);
}


export { refreshComparer, _cmpRenderTables };
