import { state } from "./state.js";
import { $, $$, setStatus, ROLES, RANK_LABELS } from "./utils.js";
import { apiFetch, loadChampionsFor, topNChampions } from "./api.js";
import { makeMultiSelect, makeSingleSelect } from "./widgets/multiselect.js";
import { refreshCoverage, renderRoleSubTabs } from "./views/coverage.js";
import { refreshHealth } from "./views/health.js";
import { refreshBlindability } from "./views/blind.js";
import { refreshComparer, _cmpRenderTables } from "./views/comparer.js";
import { refreshBans } from "./views/bans.js";
import {
  refreshBuilder, refreshComboCount, buildPools, renderBuilderResults,
} from "./views/builder.js";
import { refreshReplacements, renderReplPreview } from "./views/replacements.js";
import { refreshMeta } from "./views/meta.js";

const SYNERGY_DEFAULT_PARTNER = {
  "SUP": "ADC", "ADC": "SUP",
  "MID": "JUNGLE", "JUNGLE": "MID",
  "TOP": "JUNGLE",
};
function defaultOtherRole(role, view) {
  if (view === "matchup") return role;
  return SYNERGY_DEFAULT_PARTNER[role] || ROLES.find((r) => r !== role);
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

// ──────────────────────────────────────────────────────────────────────────
async function init() {
  // Top tabs
  $$(".tabs-top .tab-btn").forEach((b) =>
    b.addEventListener("click", () => { setActiveView(b.dataset.view); refresh(); })
  );

  // Welcome-tab tile buttons → navigate to the named view
  $$("#view-welcome .welcome-tile").forEach((b) =>
    b.addEventListener("click", () => { setActiveView(b.dataset.go); refresh(); })
  );

  // Role
  $("#role").addEventListener("change", async (e) => {
    state.role = e.target.value;
    state.replLocked = [];
    state.replView = null;          // reset → mirror matchup of new role
    state.pbView = null;            // same for Pool Builder preview
    state.pbDefinite = []; state.pbMaybe = []; state.pbBuiltRows = null; state.pbSelectedId = null;
    await loadChampionsFor(state.role);
    state.pool = topNChampions(state.role, 6);   // default to top-6 most played
    poolMS.renderChips(); pbDefMS.renderChips(); pbMayMS.renderChips();
    state.otherRole = defaultOtherRole(state.role, state.view);
    renderRoleSubTabs();
    refresh();
  });

  $("#clear-pool").addEventListener("click", () => {
    state.pool = []; state.replLocked = []; poolMS.renderChips(); refresh();
  });

  $("#top-x").addEventListener("input", (e) => {
    state.topX = parseInt(e.target.value);
    $("#top-x-val").textContent = state.topX;
    refresh();
  });

  // 4-weight Score weights box. Sliding any weight updates state, syncs the
  // legacy `blindPenalty` (used by Replacement / Pool Builder fetches), and
  // debounces a refresh so curves redraw smoothly.
  let weightDebounce = null;
  function _bindWeight(id, key, decimals = 1) {
    const slider = document.getElementById(id);
    const label  = document.getElementById(id + "-val");
    if (!slider || !label) return;
    slider.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      state.weights[key] = v;
      if (key === "blind") state.blindPenalty = v;
      label.textContent = v.toFixed(decimals);
      clearTimeout(weightDebounce);
      weightDebounce = setTimeout(refresh, 120);
    });
  }
  _bindWeight("w-in-lane", "in_lane");
  _bindWeight("w-out-lane", "out_lane");
  _bindWeight("w-synergy", "synergy");
  _bindWeight("w-blind", "blind");

  $("#pr-weighted").addEventListener("change", (e) => {
    state.prWeighted = e.target.checked; refresh();
  });

  // PR floor slider snaps to 0.1-step values from 0.1–1.0%, then 0.25-step
  // values from 1.0–2.0% — coarse stops only. The slider's HTML step is
  // 0.1 so the natural stops in the lower band are exact; for the upper
  // band we round to the nearest 0.25.
  $("#pr-floor").addEventListener("input", (e) => {
    let pct = parseFloat(e.target.value);
    pct = pct <= 1.0 ? Math.round(pct * 10) / 10 : Math.round(pct * 4) / 4;
    if (pct < 0.1) pct = 0.1;
    if (pct > 2.0) pct = 2.0;
    e.target.value = pct;
    state.prFloor = pct / 100;
    const decimals = (pct * 10) % 1 === 0 ? 1 : 2;
    $("#pr-floor-val").textContent = pct.toFixed(decimals) + "%";
    refresh();
  });

  // Comparer in-tab controls — sort + show-deltas re-render the cached
  // payload (no refetch); champion change refetches.
  window.cmpSS = makeSingleSelect({
    chipId: "#cmp-champ-chip",
    searchId: "#cmp-champ-search",
    suggestionsId: "#cmp-champ-suggestions",
    getList: () => state.champsByRole[state.role] || [],
    getSelected: () => state.cmpChampion,
    setSelected: (v) => { state.cmpChampion = v; },
  });
  $("#cmp-sort").addEventListener("change", (e) => {
    state.cmpSort = e.target.value;
    if (state.cmpLastPayload) _cmpRenderTables(state.cmpLastPayload);
  });
  $("#cmp-deltas").addEventListener("change", (e) => {
    state.cmpDeltas = e.target.checked;
    if (state.cmpLastPayload) _cmpRenderTables(state.cmpLastPayload);
  });


  // Pool multi-select (sidebar)
  window.poolMS = makeMultiSelect({
    chipsId: "#pool-chips", searchId: "#pool-search", suggestionsId: "#pool-suggestions",
    getList: () => state.champsByRole[state.role] || [],
    getSelected: () => state.pool,
    setSelected: (v) => { state.pool = v; },
    max: 8,
  });

  // Pool builder definite + maybe
  window.pbDefMS = makeMultiSelect({
    chipsId: "#pb-definite-chips", searchId: "#pb-definite-search", suggestionsId: "#pb-definite-suggestions",
    getList: () => state.champsByRole[state.role] || [],
    getSelected: () => state.pbDefinite,
    setSelected: (v) => { state.pbDefinite = v; refreshComboCount(); },
    max: 8,
  });
  window.pbMayMS = makeMultiSelect({
    chipsId: "#pb-maybe-chips", searchId: "#pb-maybe-search", suggestionsId: "#pb-maybe-suggestions",
    getList: () => (state.champsByRole[state.role] || []).filter((c) => !state.pbDefinite.includes(c.champion)),
    getSelected: () => state.pbMaybe,
    setSelected: (v) => { state.pbMaybe = v; refreshComboCount(); },
    max: 40,
  });

  $("#pb-target").addEventListener("input", (e) => {
    state.pbTarget = parseInt(e.target.value);
    $("#pb-target-val").textContent = state.pbTarget;
    refreshComboCount();
  });
  $("#pb-build").addEventListener("click", () => buildPools());

  // Blindability icon-size
  $("#blind-icon-size").addEventListener("input", (e) => {
    state.blindIconPx = parseInt(e.target.value);
    $("#blind-icon-val").textContent = state.blindIconPx + " px";
    if (state.view === "blindability") refresh();
  });

  // Replacement mode
  $("#repl-mode").addEventListener("change", (e) => {
    state.replMode = e.target.value;
    // Mode switch invalidates the previous selection — different candidate
    // sets and rankings, so default back to the top of the new list.
    state.replSelectedCand = null;
    if (state.view === "replacements") refresh();
  });

  // View selectors (Pool Builder + Replacement Finder)
  $("#pb-view").addEventListener("change", (e) => {
    state.pbView = e.target.value;
    renderBuilderResults();
  });
  $("#repl-view").addEventListener("change", (e) => {
    state.replView = e.target.value;
    renderReplPreview();
  });

  // Rank-bracket selector — populated from /api/meta. The "patches" field
  // now carries rank labels (silver | gold | ... | master_plus); kept under
  // the "patch" field name in state/payload so the engine wiring stays
  // unchanged. Defaults to "diamond" so PR-weighted scoring reflects
  // tournament-feel pick rates out of the box.
  const meta = await (await apiFetch("/api/meta")).json();
  state.patches = meta.patches || [];
  state.patch = meta.latest_patch || null;
  const patchSel = $("#patch");
  // RANK_LABELS is defined at module scope (see top of file).
  if (state.patches.length) {
    patchSel.innerHTML = state.patches.map((p) =>
      `<option value="${p}" ${p === state.patch ? "selected" : ""}>${RANK_LABELS[p] || p}</option>`
    ).join("");
  } else {
    patchSel.innerHTML = `<option value="">No rank data available</option>`;
    patchSel.disabled = true;
  }
  patchSel.addEventListener("change", async (e) => {
    state.patch = e.target.value || null;
    // PRs changed → invalidate champ cache for current role at minimum;
    // simplest: clear the entire cache.
    state.champsByRole = {};
    await loadChampionsFor(state.role);
    refresh();
  });

  await loadChampionsFor(state.role);
  state.pool = topNChampions(state.role, 6);    // initial default pool
  poolMS.renderChips();
  setActiveView("welcome");
  refresh();
}

init();

export { refresh, setActiveView };
