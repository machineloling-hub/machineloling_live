import { state } from "../state.js";
import { apiPost } from "../api.js";
import { $, ROLES, champImg, fmtSign, tealOrangeBg, setEmptyState } from "../utils.js";

// ──────────────────────────────────────────────────────────────────────────
// BAN RECOMMENDER TAB
// ──────────────────────────────────────────────────────────────────────────
async function refreshBans() {
  const eq = $("#ban-equation");
  const top = $("#ban-top-card");
  const grid = $("#ban-tables-grid");

  if (state.pool.length === 0) {
    eq.innerHTML = ""; top.innerHTML = "";
    grid.innerHTML = ""; setEmptyState(grid, "Add champions to your pool to see ban recommendations.");
    return;
  }

  // Equation
  const wmark = state.prWeighted
    ? `Ban score(X) = <b style="color:#e0a07a;">w(X) / (W − w(X))</b> × (<b style="color:#6fe2b5;">μ</b> − <b style="color:#6fe2b5;">r(X)</b>)`
    : `Ban score(X) = <b style="color:#6fe2b5;">μ</b> − <b style="color:#6fe2b5;">r(X)</b>`;
  const plain = state.prWeighted
    ? `Lift to your expected matchup quality if X is banned. High score = X is common AND bad for you.`
    : `How much worse than typical X is at this position. If every opponent at a position is similar, scores are near zero (banning doesn't help).`;
  // Column legend — kept above the tables so users don't have to hover headers.
  const legend = `<div class="ban-legend">
    <span><b>Opp</b> — opponent champion at that position</span>
    <span><b>PR</b> — pick rate (this patch / role)</span>
    <span><b>Resp</b> — best win-rate delta in pp your pool achieves vs Opp; positive = you have a counter</span>
    <span><b>via</b> — which pool member delivers that best response</span>
    ${state.prWeighted ? "<span><b>Ban</b> — ban score: how much your expected matchup quality improves if Opp is banned</span>" : ""}
  </div>`;
  eq.innerHTML = `<div>${wmark}</div><div class="plain">${plain}</div>${legend}`;

  const data = await apiPost("/api/bans", {
    my_role: state.role, pool: state.pool,
    pr_floor: state.prFloor, pr_weighted: state.prWeighted,
    patch: state.patch, shrink_alpha: state.shrinkAlpha,
  });
  if (data.empty) {
    top.innerHTML = ""; setEmptyState(grid, "No ban candidates.");
    return;
  }

  // Top card
  const t = data.rows[0];
  const respColor = t.best_response >= 0 ? "#009E73" : "#D55E00";
  const scoreColor = t.ban_score >= 0 ? "#009E73" : "#D55E00";
  top.innerHTML = `<div class="ban-top-card">
    ${champImg(t.opponent, 40)}
    <div style="flex:1;">
      <div class="label">Top ban suggestion (across all positions)</div>
      <div class="name">${t.opponent} <span style="color:#aaa;font-size:13px;font-weight:normal;">· vs ${t.position} · PR ${(t.pr * 100).toFixed(1)}%</span></div>
      <div class="meta">Best response: <b style="color:${respColor};">${fmtSign(t.best_response)} pp</b> via ${t.best_champ}
        &nbsp;·&nbsp; Ban score: <b style="color:${scoreColor};">${fmtSign(t.ban_score, 3)}</b></div>
    </div>
  </div>`;

  // 5 per-position tables in a grid
  grid.innerHTML = ROLES.map((pos) => {
    const rows = data.rows.filter((r) => r.position === pos);
    if (!rows.length) return `<div class="ban-table-wrap"><h4>vs ${pos}</h4><i style="color:#666;font-size:11px;">no candidates</i></div>`;
    const showBan = state.prWeighted;
    const tr = rows.map((r) => {
      const respBg = tealOrangeBg(r.best_response, 3);
      const respColor = r.best_response >= 0 ? "#009E73" : "#D55E00";
      const banBg = tealOrangeBg(-r.ban_score, 2);  // high score = orange (bad)
      return `<tr>
        <td style="vertical-align:middle;">${champImg(r.opponent, 32)}</td>
        <td style="text-align:right;color:#ccc;font-size:12px;">${(r.pr * 100).toFixed(1)}%</td>
        <td style="background:${respBg};color:#fff;font-weight:bold;text-align:right;border-radius:2px;">${fmtSign(r.best_response)}</td>
        <td style="text-align:center;">${champImg(r.best_champ, 22)}</td>
        ${showBan ? `<td style="background:${banBg};color:#fff;font-weight:bold;text-align:right;border-radius:2px;">${fmtSign(r.ban_score)}</td>` : ""}
      </tr>`;
    }).join("");
    return `<div class="ban-table-wrap">
      <h4>vs ${pos}</h4>
      <table class="ban-table">
        <thead><tr><th>Opp</th><th>PR</th><th>Resp</th><th>via</th>${showBan ? "<th>Ban</th>" : ""}</tr></thead>
        <tbody>${tr}</tbody>
      </table>
    </div>`;
  }).join("");
}


export { refreshBans };
