import { state } from "./state.js";
import { $, $$, setStatus, ROLES, ROLE_ICON_URL, RANK_LABELS, RANK_COLORS, esc } from "./utils.js";
import { apiFetch, loadChampionsFor, topNChampions } from "./api.js";
import { setRefresh } from "./bus.js";
import { makeMultiSelect, makeSingleSelect } from "./widgets/multiselect.js";
import { refreshCoverage, renderRoleSubTabs } from "./views/coverage.js";
import { refreshBlindability } from "./views/blind.js";
import { refreshReplacements } from "./views/replacements.js";
import { refreshMeta } from "./views/meta.js";
import { refreshHealth } from "./views/health.js";
import { refreshBuilder, refreshComboCount, buildPools } from "./views/builder.js";

const SYNERGY_DEFAULT_PARTNER = {
  "SUP": "ADC", "ADC": "SUP",
  "MID": "JUNGLE", "JUNGLE": "MID",
  "TOP": "JUNGLE",
};
function defaultOtherRole(role, view) {
  if (view === "matchup") return role;
  return SYNERGY_DEFAULT_PARTNER[role] || ROLES.find((r) => r !== role);
}

// Friendly labels shown in the topbar crumb when each tab is active.
const VIEW_LABELS = {
  welcome:      "Welcome",
  matchup:      "Matchup Coverage",
  synergy:      "Synergy Coverage",
  replacements: "Expand Your Pool",
  blindability: "Blindability",
  meta:         "Meta summary",
  health:       "Pool Health",
  builder:      "Build From Scratch",
};


function renderRoleStrip() {
  const strip = $("#role-strip");
  if (!strip) return;
  strip.innerHTML = ROLES.map((r) => `
    <button type="button" class="role-tile${r === state.role ? " active" : ""}"
            role="radio" aria-checked="${r === state.role}"
            data-role="${r}" title="${r}" aria-label="${r}">
      <img src="${esc(ROLE_ICON_URL(r))}" alt="">
    </button>`).join("");
  strip.querySelectorAll(".role-tile").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.role;
      if (v === state.role) return;
      const sel = $("#role");
      sel.value = v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}

// Rank crest icon (Community Dragon static asset). master_plus → master crest.
// Uses .svg because the emerald .png is missing upstream; .svg is the
// authoritative source and renders identically for every other tier.
const RANK_CREST_URL = (rank) => {
  const tier = rank === "master_plus" ? "master" : rank;
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${tier}.svg`;
};

// --- Slider value bubbles: position the value pill above the thumb ---
// Each sidebar slider has a paired <span id="<sliderId>-val"> that displays
// the current value. We upgrade it to a floating bubble whose `left` is
// kept in sync with the thumb position on input / resize.
const _SLIDER_BUBBLES = [];
function _positionBubble(sl, bubble) {
  const min = parseFloat(sl.min) || 0;
  const max = parseFloat(sl.max);
  const v = parseFloat(sl.value);
  if (!isFinite(max) || max <= min) return;
  const pct = Math.min(1, Math.max(0, (v - min) / (max - min)));
  const w = sl.clientWidth;
  if (!w) return;
  const thumb = 14; // matches CSS thumb width
  const px = (thumb / 2) + pct * (w - thumb);
  bubble.style.left = px + "px";
}
function _repositionSliderBubbles() {
  for (const [sl, bubble] of _SLIDER_BUBBLES) _positionBubble(sl, bubble);
}
// Info-tip floater: a single body-level bubble repositioned on hover/focus
// of any `.info-tip` glyph. Lets tooltips escape clipping containers like
// the sidebar (which has overflow-y:auto, implicitly clipping overflow-x).
function _initInfoTips() {
  if (document.getElementById("tip-floater")) return;
  const floater = document.createElement("div");
  floater.id = "tip-floater";
  floater.className = "tip-floater";
  document.body.appendChild(floater);
  let cur = null;
  const place = (el) => {
    const r = el.getBoundingClientRect();
    const fr = floater.getBoundingClientRect();
    let left = r.left + r.width / 2 - fr.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - fr.width - 8, left));
    let top = r.bottom + 8;
    if (top + fr.height > window.innerHeight - 8) top = r.top - fr.height - 8;
    floater.style.left = left + "px";
    floater.style.top = top + "px";
  };
  const show = (el) => {
    if (cur === el) return;
    cur = el;
    floater.textContent = el.getAttribute("data-tip") || "";
    floater.classList.add("visible");
    place(el);
  };
  const hide = (el) => {
    if (el && cur !== el) return;
    cur = null;
    floater.classList.remove("visible");
  };
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest && e.target.closest(".info-tip");
    if (el) show(el);
  });
  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest && e.target.closest(".info-tip");
    if (el) hide(el);
  });
  document.addEventListener("focusin", (e) => {
    if (e.target.classList && e.target.classList.contains("info-tip")) show(e.target);
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.classList && e.target.classList.contains("info-tip")) hide(e.target);
  });
  window.addEventListener("scroll", () => { if (cur) place(cur); }, true);
  window.addEventListener("resize", () => { if (cur) place(cur); });
}

function _initSliderBubbles() {
  const sliders = document.querySelectorAll('#sidebar input[type="range"]');
  sliders.forEach((sl) => {
    const bubble = document.getElementById(sl.id + "-val");
    if (!bubble) return;
    bubble.classList.add("slider-bubble");
    _SLIDER_BUBBLES.push([sl, bubble]);
    const update = () => _positionBubble(sl, bubble);
    sl.addEventListener("input", update);
    sl.addEventListener("change", update);
    // Position once layout has settled (fonts/icons may shift width).
    requestAnimationFrame(() => requestAnimationFrame(update));
  });
  window.addEventListener("resize", _repositionSliderBubbles);
}

function renderRankList() {
  const sel = $("#patch");
  const trigger = $("#rank-trigger");
  const menu = $("#rank-menu");
  const wrap = $("#rank-dropdown");
  if (!sel || !trigger || !menu || !wrap) return;

  if (!state.patches || !state.patches.length) {
    trigger.disabled = true;
    trigger.querySelector(".rank-trigger-label").textContent = "No rank data available";
    trigger.querySelector(".rank-trigger-icon").src = "";
    menu.innerHTML = "";
    return;
  }
  trigger.disabled = false;

  // Highest tier on top — preserves the previous radio-list order.
  const ORDER = ["master_plus", "diamond", "emerald", "platinum", "gold", "silver"];
  const sorted = [...state.patches].sort(
    (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)
  );

  // Sync the hidden <select> options so listeners reading sel.value stay in sync.
  sel.innerHTML = sorted.map((p) =>
    `<option value="${esc(p)}"${p === state.patch ? " selected" : ""}>${esc(RANK_LABELS[p] || p)}</option>`
  ).join("");

  // Trigger reflects the currently selected rank.
  const cur = state.patch;
  const curLabel = RANK_LABELS[cur] || cur || "—";
  const curColor = RANK_COLORS[cur] || "var(--text)";
  trigger.querySelector(".rank-trigger-icon").src = cur ? RANK_CREST_URL(cur) : "";
  const labelEl = trigger.querySelector(".rank-trigger-label");
  labelEl.textContent = curLabel;
  labelEl.style.color = curColor;

  // Menu rows reuse the existing .rank-row styling.
  menu.innerHTML = sorted.map((p) => {
    const label = RANK_LABELS[p] || p;
    const color = RANK_COLORS[p] || "#d4d4d4";
    return `
      <button type="button" class="rank-row${p === cur ? " active" : ""}"
              role="option" aria-selected="${p === cur}"
              data-patch="${esc(p)}">
        <img src="${esc(RANK_CREST_URL(p))}" alt="">
        <span class="rank-name" style="color:${color};">${esc(label)}</span>
      </button>`;
  }).join("");
}

// One-time wiring for the rank dropdown (open/close + selection). The
// trigger and menu elements are static in index.html; only their inner
// markup re-renders via renderRankList, so the document-level click
// handler keeps working across re-renders.
function _initRankDropdown() {
  const wrap = $("#rank-dropdown");
  const trigger = $("#rank-trigger");
  const menu = $("#rank-menu");
  if (!wrap || !trigger || !menu) return;
  const close = () => {
    wrap.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    menu.hidden = true;
  };
  const open = () => {
    wrap.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    menu.hidden = false;
  };
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) open(); else close();
  });
  // Delegated click: any .rank-row inside the menu sets the patch.
  menu.addEventListener("click", (e) => {
    const btn = e.target.closest(".rank-row[data-patch]");
    if (!btn) return;
    const v = btn.dataset.patch;
    close();
    if (v === state.patch) return;
    const sel = $("#patch");
    sel.value = v;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) { close(); trigger.focus(); }
  });
}


function setActiveView(view) {
  state.view = view;
  $$(".tabs-top .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$("#app-nav .nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  // matchup + synergy share #view-coverage; everything else has its own section
  const isCov = view === "matchup" || view === "synergy";
  const sectionId = isCov ? "view-coverage" : `view-${view}`;
  $$(".view").forEach((s) => s.classList.toggle("active", s.id === sectionId));
  // Mirror the active view label into the sticky topbar (aria-live=polite).
  const titleEl = document.getElementById("topbar-title-text");
  if (titleEl) titleEl.textContent = VIEW_LABELS[view] || view;
  if (isCov) {
    state.otherRole = defaultOtherRole(state.role, view);
    renderRoleSubTabs();
  }
}

let refreshPending = false;

// ── Sidebar prefs persistence ────────────────────────────────────────────
// Cache the fields the user actively tunes in the sidebar so reloads keep
// their setup (role, rank bracket, top-X, score weights, PR floor / weighting,
// and their pool). Patch + pool are best-effort: if a stored value isn't
// in the current data set the live default takes over.
const SIDEBAR_PREFS_KEY = "sidebarPrefs.v1";
// In-memory mirror of per-role pools so role switches restore the user's
// last selection for that role. Seeded from localStorage on load.
const _poolsByRole = {};
function _loadSidebarPrefs() {
  try {
    const raw = localStorage.getItem(SIDEBAR_PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.role === "string" && ROLES.includes(p.role)) state.role = p.role;
    if (Number.isFinite(p.topX)) state.topX = Math.min(8, Math.max(1, p.topX | 0));
    if (p.weights && typeof p.weights === "object") {
      for (const k of ["in_lane", "out_lane", "synergy", "blind"]) {
        const v = p.weights[k];
        if (Number.isFinite(v)) state.weights[k] = Math.min(1, Math.max(0, v));
      }
      state.blindPenalty = state.weights.blind;
    }
    if (Number.isFinite(p.prFloor)) state.prFloor = Math.min(0.02, Math.max(0.001, p.prFloor));
    if (typeof p.prWeighted === "boolean") state.prWeighted = p.prWeighted;
    if (typeof p.patch === "string") state.patch = p.patch;
    if (p.pools && typeof p.pools === "object") {
      for (const r of ROLES) {
        const arr = p.pools[r];
        if (Array.isArray(arr)) {
          _poolsByRole[r] = arr.filter((c) => typeof c === "string").slice(0, 8);
        }
      }
    }
    // Migration: older schema stored a single `pool` for the active role.
    if (Array.isArray(p.pool) && !_poolsByRole[state.role]) {
      _poolsByRole[state.role] = p.pool.filter((c) => typeof c === "string").slice(0, 8);
    }
    if (_poolsByRole[state.role]) state.pool = _poolsByRole[state.role].slice();
  } catch (_) { /* corrupt prefs — ignore */ }
}
function _saveSidebarPrefs() {
  try {
    _poolsByRole[state.role] = state.pool.slice();
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify({
      role: state.role,
      topX: state.topX,
      weights: state.weights,
      prFloor: state.prFloor,
      prWeighted: state.prWeighted,
      patch: state.patch,
      pools: _poolsByRole,
    }));
  } catch (_) { /* private mode / quota — ignore */ }
}

async function _refreshImpl() {
  if (refreshPending) return;
  refreshPending = true;
  await new Promise((r) => setTimeout(r, 0));
  refreshPending = false;
  try {
    if (state.view === "matchup" || state.view === "synergy") await refreshCoverage();
    else if (state.view === "blindability") await refreshBlindability();
    else if (state.view === "replacements") await refreshReplacements();
    else if (state.view === "meta") refreshMeta();
    else if (state.view === "health") await refreshHealth();
    else if (state.view === "builder") await refreshBuilder();
  } catch (e) {
    console.error(e);
    setStatus("error: " + e.message);
  }
}
async function refresh() {
  _saveSidebarPrefs();
  return _refreshImpl();
}

// ──────────────────────────────────────────────────────────────────────────
async function init() {  // Restore cached sidebar settings (role/weights/etc.) into state BEFORE
  // we wire DOM controls so their initial values reflect the user's last
  // session instead of the hardcoded HTML defaults.
  _loadSidebarPrefs();
  const _poolRestored = state.pool.length > 0;  // Restore persisted sidebar collapse state (set before any tabs render so
  // the shell doesn't visually jump on first paint).
  //
  // Persistence rule: only an explicit toggle-button click on a WIDE viewport
  // writes the preference. Mobile auto-collapse and tap-outside-to-dismiss
  // never persist — otherwise a brief visit on a narrow viewport would
  // leave the desktop sidebar permanently collapsed to a 64px strip on
  // return visits.
  const shell = document.getElementById("app");
  const _isNarrow = () => typeof window !== "undefined"
    && window.matchMedia
    && (window.matchMedia("(max-width: 1100px)").matches
        || window.matchMedia("(pointer: coarse) and (max-width: 1200px)").matches);
  if (shell) {
    if (_isNarrow()) {
      // On narrow viewports the sidebar is a sliding overlay; always start
      // closed so the welcome content is visible on first paint.
      shell.dataset.sidebar = "collapsed";
    } else {
      const savedRaw = (typeof localStorage !== "undefined" && localStorage.getItem("sidebar")) || null;
      shell.dataset.sidebar = savedRaw === "collapsed" ? "collapsed" : "expanded";
    }
  }
  const sidebarToggle = document.getElementById("sidebar-toggle");
  if (sidebarToggle && shell) {
    sidebarToggle.addEventListener("click", () => {
      const next = shell.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
      shell.dataset.sidebar = next;
      // Only persist explicit toggles made on a wide viewport. Narrow-viewport
      // toggles are treated as transient (the overlay is opened/closed by
      // the user repeatedly during one session).
      if (!_isNarrow()) {
        try { localStorage.setItem("sidebar", next); } catch (_) { /* private mode */ }
      }
      // Sidebar width change → reposition slider bubbles after the
      // layout settles.
      requestAnimationFrame(() => requestAnimationFrame(_repositionSliderBubbles));
    });
  }
  // Mobile: tapping the dimmed backdrop closes the sidebar. The backdrop
  // is the ::after pseudo-element on the shell, so a click on it reports
  // e.target === shell. Restricting the check to that exact case avoids
  // ever swallowing clicks on the toggle button or main content.
  if (shell) {
    shell.addEventListener("click", (e) => {
      if (e.target !== shell) return;
      if (shell.dataset.sidebar !== "expanded") return;
      if (!_isNarrow()) return;
      // Dismissal — do not persist.
      shell.dataset.sidebar = "collapsed";
    });
  }

  _initSliderBubbles();
  _initInfoTips();
  _initRankDropdown();

  // Sync sidebar DOM controls with restored state so the UI matches the
  // cached values immediately on load.
  const _roleSel = $("#role");
  if (_roleSel) _roleSel.value = state.role;
  const _topX = $("#top-x");
  if (_topX) { _topX.value = state.topX; $("#top-x-val").textContent = state.topX; }
  const _wMap = { in_lane: "w-in-lane", out_lane: "w-out-lane", synergy: "w-synergy", blind: "w-blind" };
  for (const [k, id] of Object.entries(_wMap)) {
    const sl = document.getElementById(id);
    const lb = document.getElementById(id + "-val");
    if (sl) sl.value = state.weights[k];
    if (lb) lb.textContent = Number(state.weights[k]).toFixed(1);
  }
  const _prw = $("#pr-weighted");
  if (_prw) _prw.checked = state.prWeighted;
  const _prf = $("#pr-floor");
  if (_prf) {
    const pct = state.prFloor * 100;
    _prf.value = pct;
    const decimals = (pct * 10) % 1 === 0 ? 1 : 2;
    $("#pr-floor-val").textContent = pct.toFixed(decimals) + "%";
  }

  // Top tabs
  $$(".tabs-top .tab-btn").forEach((b) =>
    b.addEventListener("click", () => { setActiveView(b.dataset.view); refresh(); })
  );

  // Sidebar app nav
  $$("#app-nav .nav-item").forEach((b) =>
    b.addEventListener("click", () => { setActiveView(b.dataset.view); refresh(); })
  );
  // Collapsible app group
  $$("#app-nav .nav-group-trigger").forEach((b) => {
    b.addEventListener("click", () => {
      const group = b.closest(".nav-group");
      const expanded = group.dataset.expanded !== "false";
      group.dataset.expanded = String(!expanded);
      b.setAttribute("aria-expanded", String(!expanded));
    });
  });

  // Welcome-tab tile buttons → navigate to the named view
  $$("#view-welcome .welcome-tile").forEach((b) =>
    b.addEventListener("click", () => { setActiveView(b.dataset.go); refresh(); })
  );

  // Role
  $("#role").addEventListener("change", async (e) => {
    state.role = e.target.value;
    state.replView = null;          // reset → mirror matchup of new role
    await loadChampionsFor(state.role);
    // Restore this role's cached pool if we have one; otherwise default to
    // the role's top-6 most-played. Drop any cached entries no longer present
    // in the current champ list.
    const allowed = new Set((state.champsByRole[state.role] || []).map((c) => c.champion));
    const cached = (_poolsByRole[state.role] || []).filter((c) => allowed.has(c));
    state.pool = cached.length ? cached : topNChampions(state.role, 6);
    poolMS.renderChips();
    state.otherRole = defaultOtherRole(state.role, state.view);
    renderRoleSubTabs();
    renderRoleStrip();
    refresh();
  });

  $("#clear-pool").addEventListener("click", () => {
    state.pool = []; poolMS.renderChips(); refresh();
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
  // (Comparer tab removed.)


  // Pool multi-select (sidebar)
  window.poolMS = makeMultiSelect({
    chipsId: "#pool-chips", searchId: "#pool-search", suggestionsId: "#pool-suggestions",
    getList: () => state.champsByRole[state.role] || [],
    getSelected: () => state.pool,
    setSelected: (v) => { state.pool = v; },
    max: 8,
  });
  // Clicking anywhere on the dotted add-slot focuses the input.
  $("#pool-add-slot")?.addEventListener("click", (e) => {
    if (e.target.id !== "pool-search") $("#pool-search").focus();
  });

  // (Pool Builder tab removed — pbDefMS/pbMayMS and pb-* controls dropped.)
  // Pool Builder definite/maybe multi-selects + target slider + build button.
  window.pbDefMS = makeMultiSelect({
    chipsId: "#pb-definite-chips", searchId: "#pb-definite-search",
    suggestionsId: "#pb-definite-suggestions",
    getList: () => state.champsByRole[state.role] || [],
    getSelected: () => state.pbDefinite,
    setSelected: (v) => {
      state.pbDefinite = v;
      // Promote-to-definite removes the same champ from "maybe".
      state.pbMaybe = state.pbMaybe.filter((c) => !v.includes(c));
      state.pbBuiltRows = null; state.pbSelectedId = null;
    },
    max: 8,
  });
  window.pbMayMS = makeMultiSelect({
    chipsId: "#pb-maybe-chips", searchId: "#pb-maybe-search",
    suggestionsId: "#pb-maybe-suggestions",
    getList: () => state.champsByRole[state.role] || [],
    getSelected: () => state.pbMaybe,
    setSelected: (v) => {
      state.pbMaybe = v.filter((c) => !state.pbDefinite.includes(c));
      state.pbBuiltRows = null; state.pbSelectedId = null;
    },
    max: 20,
  });
  $("#pb-definite-add")?.addEventListener("click", (e) => {
    if (e.target.id !== "pb-definite-search") $("#pb-definite-search").focus();
  });
  $("#pb-maybe-add")?.addEventListener("click", (e) => {
    if (e.target.id !== "pb-maybe-search") $("#pb-maybe-search").focus();
  });
  const pbTarget = $("#pb-target");
  if (pbTarget) {
    pbTarget.value = state.pbTarget;
    $("#pb-target-val").textContent = state.pbTarget;
    pbTarget.addEventListener("input", (e) => {
      state.pbTarget = parseInt(e.target.value, 10);
      $("#pb-target-val").textContent = state.pbTarget;
      state.pbBuiltRows = null; state.pbSelectedId = null;
      if (state.view === "builder") refresh();
    });
  }
  $("#pb-build")?.addEventListener("click", () => buildPools());

  // Rank-bracket selector — populated from /api/meta. The "patches" field
  // now carries rank labels (silver | gold | ... | master_plus); kept under
  // the "patch" field name in state/payload so the engine wiring stays
  // unchanged. Defaults to "diamond" so PR-weighted scoring reflects
  // tournament-feel pick rates out of the box.
  const meta = await (await apiFetch("/api/meta")).json();
  state.patches = meta.patches || [];
  // Populate the three "current data patch" UI labels from the packed
  // data_meta.json (stamped by data_prep/refresh.py from REFRESH_PATCH_RANGE).
  // Falls back to a neutral placeholder if the field is missing so the UI
  // never shows a stale hard-coded patch number.
  const _patchLabel = meta.data_patch ? `Patch ${meta.data_patch}` : "Patch —";
  const _brandSub = document.getElementById("brand-sub-patch");
  if (_brandSub) _brandSub.textContent = _patchLabel;
  const _sidePatch = document.getElementById("sidebar-patch-label");
  if (_sidePatch) _sidePatch.textContent = _patchLabel;
  const _metaPatch = document.getElementById("meta-view-patch-label");
  if (_metaPatch) _metaPatch.textContent = meta.data_patch ? `patch ${meta.data_patch}` : "patch —";
  // Honour the cached patch if it's still in the available bracket list;
  // otherwise fall back to the server's latest default.
  const _cachedPatch = state.patch;
  if (!(_cachedPatch && state.patches.includes(_cachedPatch))) {
    state.patch = meta.latest_patch || null;
  }
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
    renderRankList();
    refresh();
  });

  renderRoleStrip();
  renderRankList();

  await loadChampionsFor(state.role);
  // Keep the restored pool if present; otherwise default to the role's top-6
  // most-played champions. Trim any cached entries that no longer exist for
  // this role's champ list (e.g. data refresh dropped a name).
  if (_poolRestored) {
    const allowed = new Set((state.champsByRole[state.role] || []).map((c) => c.champion));
    state.pool = state.pool.filter((c) => allowed.has(c));
  }
  if (!state.pool.length) state.pool = topNChampions(state.role, 6);
  poolMS.renderChips();
  setActiveView("welcome");
  refresh();
}

setRefresh(refresh);
init();

export { refresh, setActiveView };
