const state = {
  // sidebar
  role: "SUP",
  pool: [],
  topX: 3,
  blindPenalty: 0.85,          // legacy alias = weights.blind, kept for old call sites
  weights: { in_lane: 0.7, out_lane: 0.5, synergy: 1.0, blind: 0.9 },
  prFloor: 0.005,
  shrinkAlpha: 0.80,            // 80% hier-shrunk, 20% raw — locked default
  prWeighted: true,
  // tabs
  view: "welcome",      // top-level tab
  otherRole: "ADC",     // sub-tab for matchup/synergy
  // blindability
  blindIconPx: 26,
  patch: null,                    // null → latest patch (set on init)
  patches: [],                    // populated from /api/meta
  // builder
  pbDefinite: [],
  pbMaybe: [],
  pbTarget: 6,
  pbBuiltRows: null,    // last build result
  pbSelectedId: null,
  pbView: null,                   // null → falls back to mirror matchup on first render
  // replacement
  replMode: "replace",
  replLocked: [],
  replView: null,                 // null → falls back to mirror matchup on first render
  replRanked: null,        // last /api/replacements rows
  replSelectedCand: null,  // currently-selected candidate for preview
  // comparer
  cmpChampion: null,
  cmpSort: "total",
  cmpDeltas: false,
  cmpLastPayload: null,
  // caches
  champsByRole: {},
  fetchSeq: 0,
  // Live-computed strength curves are cached per request signature so we
  // don't refetch when nothing relevant changed.
  liveCurvesCache: new Map(),
  liveCurvesInflight: new Map(),
  // Per-component reference σ from the latest matching curves response.
  // Used to rescale weight sliders so 1.0 = "1σ-equivalent contribution"
  // for that component, regardless of its underlying variance scale.
  // scenarioKey identifies what (role, patch, pool_size, ...) combo these
  // sigmas were computed for; if the current request's scenario differs,
  // we fall back to σ=1.0 (raw weighting) rather than mismatched σs.
  componentSigmas: { scenarioKey: null, in_lane: 1.0, out_lane: 1.0, synergy: 1.0, blind: 1.0 },
};

// Scenario key for σ caching — independent of weights.
function _sigmaScenarioKey({ role, patch, pool_size, top_x, pr_floor, pr_weighted, shrink_alpha }) {
  return JSON.stringify([role, patch, pool_size, top_x, pr_floor, pr_weighted, shrink_alpha]);
}

// Look up σs for this scenario; fall back to 1.0 (raw weighting) if stale.
function _sigmasFor(scenarioKey) {
  const s = state.componentSigmas;
  if (s && s.scenarioKey === scenarioKey) {
    return { in_lane: s.in_lane, out_lane: s.out_lane, synergy: s.synergy, blind: s.blind };
  }
  return { in_lane: 1.0, out_lane: 1.0, synergy: 1.0, blind: 1.0 };
}

// Body fields to send with weights so the backend can rescale by σ.
function _sigmaBody(scenarioKey) {
  const s = _sigmasFor(scenarioKey);
  return {
    sigma_in_lane: s.in_lane, sigma_out_lane: s.out_lane,
    sigma_synergy: s.synergy, sigma_blind:    s.blind,
  };
}

// Update σs from a /api/pool_strength_curves response.
function _updateSigmasFromCurves(resp, scenarioKey) {
  const d = resp?.primary?.data;
  if (!d) return;
  const safe = (v) => (typeof v === "number" && isFinite(v) && v > 1e-9) ? v : 1.0;
  state.componentSigmas = {
    scenarioKey,
    in_lane:  safe(d.in_lane_matchup?.[1]),
    out_lane: safe(d.out_of_lane_matchup?.[1]),
    synergy:  safe(d.overall_synergy?.[1]),
    blind:    safe(d.blindability?.[1]),
  };
}

export {
  state,
  _sigmaScenarioKey, _sigmasFor, _sigmaBody, _updateSigmasFromCurves,
};
