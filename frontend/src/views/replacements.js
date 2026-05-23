import { state, _sigmaScenarioKey, _sigmaBody } from "../state.js";
import { apiFetch } from "../api.js";
import {
  $, champImg, esc,
} from "../utils.js";

// ──────────────────────────────────────────────────────────────────────────
// EXPAND YOUR POOL TAB (add-only — was Replacement Finder)
// ──────────────────────────────────────────────────────────────────────────
//
// Surfaces every candidate as a player-friendly card: per-pillar arrows + a
// single "Overall fit" headline expressed as a winrate-equivalent percent.
// Pillars are the same four score weights, surfaced in plain language:
//   Lane matchups       — delta_matchup_in_lane     (Δ pp directly)
//   Vs other lanes      — delta_matchup_out_of_lane (Δ pp directly)
//   Team synergy        — delta_synergy             (Δ pp directly)
//   Safe to first-pick  — delta_blind               (Δ z; ▲/▬/▼ only)

// Per-pillar ▲/▬/▼ thresholds (in raw delta units — pp for matchup/synergy,
// z for blindability). Anything inside ±SMALL is neutral, ≥BIG is strong.
const ARROW_SMALL = 0.30;
const ARROW_BIG   = 1.00;
function arrow(v) {
  if (v == null || !isFinite(v)) return { glyph: "·", tone: "neutral" };
  if (v >=  ARROW_BIG)   return { glyph: "▲▲", tone: "win" };
  if (v >=  ARROW_SMALL) return { glyph: "▲",  tone: "win" };
  if (v <= -ARROW_BIG)   return { glyph: "▼▼", tone: "loss" };
  if (v <= -ARROW_SMALL) return { glyph: "▼",  tone: "loss" };
  return { glyph: "▬", tone: "neutral" };
}

// "Overall fit" = winrate-equivalent change, derived from the three
// winrate-pp components weighted by the user's score weights. Blindability
// is excluded from the headline number (it isn't in pp) but still shows as
// an arrow and is reflected in the engine's sort order via delta_total.
function overallPp(row, weights) {
  const w = {
    in:  Math.max(0, weights.in_lane),
    out: Math.max(0, weights.out_lane),
    syn: Math.max(0, weights.synergy),
  };
  const wSum = w.in + w.out + w.syn;
  if (wSum <= 0) return 0;
  const dIn  = row.delta_matchup_in_lane     ?? 0;
  const dOut = row.delta_matchup_out_of_lane ?? 0;
  const dSyn = row.delta_synergy             ?? 0;
  return (w.in * dIn + w.out * dOut + w.syn * dSyn) / wSum;
}

// Auto-generated "why pick" phrase based on which pillar's contribution
// dominates. Uses weight-scaled magnitudes so a +0.5pp lane gain at w=1.0
// beats a +0.4pp synergy gain at w=0.5.
function whyPick(row, weights) {
  const contribs = [
    { key: "in_lane", w: weights.in_lane, d: row.delta_matchup_in_lane,     label: "lane matchups" },
    { key: "out",     w: weights.out_lane, d: row.delta_matchup_out_of_lane, label: "matchups vs other lanes" },
    { key: "syn",     w: weights.synergy,  d: row.delta_synergy,             label: "team synergy" },
    { key: "blind",   w: weights.blind,    d: row.delta_blind,               label: "safe-blind cover" },
  ].filter((c) => c.d != null && isFinite(c.d));
  if (!contribs.length) return "Small, balanced improvement across the board.";
  contribs.forEach((c) => { c.score = Math.abs(c.w * c.d); });
  contribs.sort((a, b) => b.score - a.score);
  const top = contribs[0];
  const second = contribs[1];
  const direction = top.d >= 0 ? "Boosts" : "Drops";
  const sign = top.d >= 0 ? "+" : "";
  const valTxt = top.key === "blind"
    ? `${sign}${top.d.toFixed(2)}z`
    : `${sign}${top.d.toFixed(2)}% winrate`;
  let txt = `${direction} ${top.label} (${valTxt})`;
  if (second && second.score > 0.15 && (top.d >= 0) === (second.d >= 0)) {
    txt += ` and ${second.label}`;
  }
  return txt + ".";
}

async function refreshReplacements() {
  const topPicks = $("#repl-top-picks");
  const table = $("#repl-table");

  if (state.pool.length === 0) {
    if (topPicks) topPicks.innerHTML = "";
    table.innerHTML = '<div class="empty-msg">Add champions to your pool to see candidates.</div>';
    return;
  }

  if (topPicks) topPicks.innerHTML = '<div class="empty-msg">Scoring candidates…</div>';
  table.innerHTML = "";

  const basePoolSize = state.pool.length;
  const replScenario = _sigmaScenarioKey({
    role: state.role, patch: state.patch, pool_size: basePoolSize,
    top_x: state.topX, pr_floor: state.prFloor, pr_weighted: state.prWeighted,
    shrink_alpha: state.shrinkAlpha,
  });
  const data = await apiFetch("/api/replacements", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role, pool: state.pool, mode: "add",
      locked: [], top_x: state.topX,
      pr_floor: state.prFloor, pr_weighted: state.prWeighted,
      patch: state.patch, shrink_alpha: state.shrinkAlpha,
      w_in_lane: state.weights.in_lane, w_out_lane: state.weights.out_lane,
      w_synergy: state.weights.synergy, w_blind: state.weights.blind,
      ..._sigmaBody(replScenario),
    }),
  }).then((r) => r.json());

  if (data.empty || !data.rows.length) {
    if (topPicks) topPicks.innerHTML = "";
    table.innerHTML = '<div class="empty-msg">No candidates available.</div>';
    state.replRanked = null; state.replSelectedCand = null;
    return;
  }

  state.replRanked = data.rows;
  if (!state.replSelectedCand || !data.rows.find((r) => r.candidate === state.replSelectedCand)) {
    state.replSelectedCand = data.rows[0].candidate;
  }

  renderTopPicks(data.rows, state.weights);
  renderCandidatesTable(data.rows, state.weights);
}

function renderTopPicks(rows, weights) {
  const wrap = $("#repl-top-picks");
  if (!wrap) return;
  const top3 = rows.slice(0, 3);
  const card = (r, rank) => {
    const pp = overallPp(r, weights);
    const ppTxt = `${pp >= 0 ? "+" : ""}${pp.toFixed(2)}% winrate`;
    const tone = pp >= 0.5 ? "win" : pp >= 0 ? "slim" : "loss";
    return `
      <button type="button" class="repl-top-card tone-${tone}" data-cand="${esc(r.candidate)}">
        <div class="repl-top-rank">#${rank}</div>
        <div class="repl-top-icon">${champImg(r.candidate, 44)}</div>
        <div class="repl-top-body">
          <div class="repl-top-name">${esc(r.candidate)}</div>
          <div class="repl-top-pp">${ppTxt}</div>
          <div class="repl-top-why">${esc(whyPick(r, weights))}</div>
        </div>
      </button>`;
  };
  wrap.innerHTML = `
    <h3 class="section-h">Top picks to add</h3>
    <div class="repl-top-grid">${top3.map((r, i) => card(r, i + 1)).join("")}</div>`;
  wrap.querySelectorAll(".repl-top-card").forEach((el) =>
    el.addEventListener("click", () => selectCandidate(el.dataset.cand))
  );
}

function renderCandidatesTable(rows, weights) {
  const table = $("#repl-table");
  const cellPp = (v) => {
    if (v == null) return '<td class="cell-na">—</td>';
    const a = arrow(v);
    const sign = v >= 0 ? "+" : "";
    return `<td class="repl-pill tone-${a.tone}"><span class="repl-arrow">${a.glyph}</span> ${sign}${v.toFixed(2)}%</td>`;
  };
  const cellBlind = (v) => {
    if (v == null) return '<td class="cell-na">—</td>';
    const a = arrow(v);
    return `<td class="repl-pill tone-${a.tone}"><span class="repl-arrow">${a.glyph}</span></td>`;
  };
  const cellOverall = (pp) => {
    const sign = pp >= 0 ? "+" : "";
    const tone = pp >= 0.5 ? "win" : pp >= 0 ? "slim" : "loss";
    return `<td class="repl-overall tone-${tone}"><b>${sign}${pp.toFixed(2)}%</b><div class="repl-overall-sub">winrate</div></td>`;
  };

  const tr = rows.slice(0, 100).map((r) => {
    const sel = r.candidate === state.replSelectedCand ? "selected" : "";
    const pp = overallPp(r, weights);
    return `<tr class="${sel}" data-cand="${esc(r.candidate)}" title="Click to preview pool with ${esc(r.candidate)} added">
      <td class="repl-cand">${champImg(r.candidate, 22)} <b>${esc(r.candidate)}</b></td>
      ${cellOverall(pp)}
      ${cellPp(r.delta_matchup_in_lane)}
      ${cellPp(r.delta_matchup_out_of_lane)}
      ${cellPp(r.delta_synergy)}
      ${cellBlind(r.delta_blind)}
    </tr>`;
  }).join("");

  table.innerHTML = `<table class="std-table repl-table">
    <thead><tr>
      <th>Champion</th>
      <th>Overall fit</th>
      <th>Lane matchups</th>
      <th>Teamcomp Matchup</th>
      <th>Team synergy</th>
      <th>Blindability</th>
    </tr></thead>
    <tbody>${tr}</tbody>
  </table>
  ${rows.length > 100 ? `<div style="color:#888;font-size:12px;margin-top:4px;">Showing top 100 of ${rows.length}.</div>` : ""}`;

  table.querySelectorAll("tr[data-cand]").forEach((tr) =>
    tr.addEventListener("click", () => selectCandidate(tr.dataset.cand))
  );
}

// Local-only selection: just toggle the .selected highlight; no preview to update.
function selectCandidate(cand) {
  if (!cand || cand === state.replSelectedCand) return;
  state.replSelectedCand = cand;
  document.querySelectorAll("#repl-table tr[data-cand]").forEach((tr) => {
    tr.classList.toggle("selected", tr.dataset.cand === cand);
  });
  document.querySelectorAll("#repl-top-picks .repl-top-card").forEach((el) => {
    el.classList.toggle("selected", el.dataset.cand === cand);
  });
}

export { refreshReplacements };

