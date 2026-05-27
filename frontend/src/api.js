import { state } from "./state.js";


// ── Engine bootstrap & API shim ───────────────────────────────────────────
// Replaces the FastAPI backend with a wasm engine + static JSON for the
// PoC slice (Coverage tab). Endpoints not yet ported throw clearly so we
// can find them while wiring the remaining tabs.
let _engineModule = null;
let _enginePromise = null;
let _championsData = null;
let _currentManifest = null;
let _currentVersion = null;   // version string for the tier we loaded from
let _currentTier = null;      // which tier the current engine was built from
// Strength curves are now per-rank (silver | gold | platinum | emerald |
// diamond | master_plus). Cache by rank so swapping rank only re-fetches the
// new file once.
const _strengthCurvesByRank = {};
const _strengthCurvesPromiseByRank = {};

// ── Data source config ───────────────────────────────────────────────────
// Phase 5: pull artifacts from S3 (versioned via manifest.json) instead of
// the bundled ./data/ dir. Override at runtime by setting
// `window.POOL_DESIGNER_DATA = { baseUrl, defaultTier }` BEFORE this module
// loads, e.g. in a <script> in index.html. If `baseUrl` is empty/missing or
// the manifest fetch fails, we fall back to the local ./data/ bundle so the
// app keeps working offline / on legacy deploys.
const _userCfg = (typeof window !== 'undefined' && window.POOL_DESIGNER_DATA) || {};
const REMOTE_BASE_URL = (_userCfg.baseUrl || '').replace(/\/+$/, '');  // no trailing slash
const DEFAULT_TIER = _userCfg.defaultTier || 'diamond';

function _localUrl(name) { return `./data/${name}`; }
function _versionedUrl(tier, version, name) {
  return `${REMOTE_BASE_URL}/${tier}/v/${version}/${name}`;
}
function _manifestUrl() {
  // Cache-bust the manifest itself so polling sees fresh values; the
  // versioned artifacts it points to are immutable and cache fine.
  return `${REMOTE_BASE_URL}/manifest.json?t=${Date.now()}`;
}

async function _fetchManifest() {
  if (!REMOTE_BASE_URL) return null;
  try {
    const r = await fetch(_manifestUrl(), { cache: 'no-store' });
    if (!r.ok) return null;
    const m = await r.json();
    if (!m || typeof m !== 'object' || !m.tiers) return null;
    return m;
  } catch {
    return null;
  }
}

function _resolveTierEntry(manifest, tier) {
  if (!manifest || !manifest.tiers) return null;
  return manifest.tiers[tier] || null;
}

// Resolve URLs for the three engine artifacts. Returns { matrices, index,
// champions, version | null }. Falls back to ./data/ if no remote manifest
// or no entry for the requested tier.
function _resolveArtifactUrls(manifest, tier) {
  const entry = _resolveTierEntry(manifest, tier);
  if (entry && entry.version) {
    return {
      matrices:  _versionedUrl(tier, entry.version, 'matrices.bin'),
      index:     _versionedUrl(tier, entry.version, 'index.json'),
      champions: _versionedUrl(tier, entry.version, 'champions.json'),
      version:   entry.version,
    };
  }
  return {
    matrices:  _localUrl('matrices.bin'),
    index:     _localUrl('index.json'),
    champions: _localUrl('champions.json'),
    version:   null,
  };
}

async function _loadEngine(tier) {
  if (_engineModule) return _engineModule;
  if (_enginePromise) return _enginePromise;
  _enginePromise = (async () => {
    const mod = await import('../pkg/pool_designer_engine.js');
    await mod.default();

    const wantTier = tier || DEFAULT_TIER;
    _currentManifest = await _fetchManifest();
    const urls = _resolveArtifactUrls(_currentManifest, wantTier);
    _currentTier = wantTier;
    _currentVersion = urls.version;

    let matBuf, idxText, chText;
    const _check = (r, label) => {
      if (!r.ok) throw new Error(`fetch ${label} failed: HTTP ${r.status} ${r.statusText} (${r.url})`);
      return r;
    };
    try {
      [matBuf, idxText, chText] = await Promise.all([
        fetch(urls.matrices).then(r => _check(r, 'matrices').arrayBuffer()),
        fetch(urls.index).then(r => _check(r, 'index').text()),
        fetch(urls.champions).then(r => _check(r, 'champions').text()),
      ]);
    } catch (e) {
      // Remote fetch failed mid-way — fall back to local bundle so the app
      // still loads. Useful for offline dev and as a safety net during
      // S3/CORS misconfiguration.
      console.warn('[api] remote artifact fetch failed, falling back to ./data/', e);
      _currentVersion = null;
      [matBuf, idxText, chText] = await Promise.all([
        fetch(_localUrl('matrices.bin')).then(r => r.arrayBuffer()),
        fetch(_localUrl('index.json')).then(r => r.text()),
        fetch(_localUrl('champions.json')).then(r => r.text()),
      ]);
    }

    _championsData = JSON.parse(chText);
    const engine = new mod.Engine(new Uint8Array(matBuf), idxText, chText);
    _engineModule = { mod, engine };
    return _engineModule;
  })();
  return _enginePromise;
}

// Lazy-load the precomputed strength curve grid for a given rank. Each
// strength_curves_<rank>.json is ~10 MB raw / ~1.5 MB gzipped, so we cache
// per rank — switching rank fetches once, switching back is cache-warm.
async function _loadStrengthCurves(rank) {
  // Default to the bootstrap rank from /api/meta if none was passed.
  const r = rank || (_championsData && _championsData.latest_patch) || 'diamond';
  if (_strengthCurvesByRank[r]) return _strengthCurvesByRank[r];
  if (_strengthCurvesPromiseByRank[r]) return _strengthCurvesPromiseByRank[r];

  // Phase 5: prefer the versioned remote artifact when the manifest knows
  // about this rank's tier; fall back to ./data/ otherwise. Strength curves
  // are tier-keyed the same way as matrices.bin.
  const entry = _resolveTierEntry(_currentManifest, r);
  const remoteUrl = entry && entry.version
    ? _versionedUrl(r, entry.version, `strength_curves_${r}.json`)
    : null;
  const localUrl = _localUrl(`strength_curves_${r}.json`);

  _strengthCurvesPromiseByRank[r] = (async () => {
    if (remoteUrl) {
      try {
        const res = await fetch(remoteUrl);
        if (res.ok) {
          const d = await res.json();
          _strengthCurvesByRank[r] = d;
          return d;
        }
      } catch { /* fall through to local */ }
    }
    try {
      const res = await fetch(localUrl);
      const d = res.ok ? await res.json() : null;
      _strengthCurvesByRank[r] = d;
      return d;
    } catch {
      return null;
    }
  })();
  return _strengthCurvesPromiseByRank[r];
}

// Snap a value to the nearest entry in a sorted grid array.
function _snapToGrid(v, grid) {
  let best = grid[0];
  let bestDiff = Math.abs(v - grid[0]);
  for (const g of grid) {
    const diff = Math.abs(v - g);
    if (diff < bestDiff) { best = g; bestDiff = diff; }
  }
  return best;
}

function _curveKey(pool_size, top_x, pr_floor, pr_weighted, shrink_alpha, gridAxes) {
  const ps = _snapToGrid(pool_size, gridAxes.pool_size);
  const tx = _snapToGrid(top_x, gridAxes.top_x);
  const pf = _snapToGrid(pr_floor, gridAxes.pr_floor);
  const al = _snapToGrid(shrink_alpha, gridAxes.shrink_alpha);
  const w = pr_weighted ? 1 : 0;
  return {
    key: `p${ps}_t${tx}_pf${Math.round(pf * 10000)}_w${w}_a${Math.round(al * 100)}`,
    pool_size: ps,
    top_x: tx,
  };
}

const STRENGTH_PERCENTILE_GRID = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
const STRENGTH_N_HIST_BINS = 30;

// Convert a sample array into the [mean, sd, min, max, *21 percentiles, *30 density bins]
// slot shape the frontend renderer expects. Mirrors _aggregate_stats_kde from
// _reference_backend/live_curves.py — same numbers, just done in JS.
function _slotFromSamples(samples) {
  // Single-pass collection: filter + sum + sumSq, plus track min/max so we
  // can skip a second sort scan when computing the KDE bin grid below.
  const n0 = samples.length;
  const valid = new Array(n0);
  let vlen = 0;
  let sum = 0;
  let sumSq = 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < n0; i++) {
    const v = samples[i];
    if (v != null && Number.isFinite(v)) {
      valid[vlen++] = v;
      sum += v;
      sumSq += v * v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (vlen === 0) return null;
  valid.length = vlen;
  const mean = sum / vlen;
  // Sample variance via E[X²] - E[X]²; clamp tiny negatives from FP rounding.
  const sd = vlen > 1
    ? Math.sqrt(Math.max(0, (sumSq - vlen * mean * mean) / (vlen - 1)))
    : 0;
  const sorted = valid.slice().sort((a, b) => a - b);

  // Linear-interp percentiles, matching numpy's default.
  const pct = (p) => {
    if (sorted.length === 1) return sorted[0];
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const percentiles = STRENGTH_PERCENTILE_GRID.map(pct);

  // Gaussian KDE evaluated at 30 evenly-spaced points across [min, max], then
  // normalized to sum to 1. Mirrors scipy.stats.gaussian_kde with the same
  // bandwidth factor (~0.35) the FastAPI version uses, so curves look the
  // same as the live backend produced.
  let density;
  if (mx > mn && valid.length >= 8) {
    const KDE_BW_FACTOR = 0.35;
    const h = KDE_BW_FACTOR * sd;
    if (h > 1e-9) {
      const xs = new Array(STRENGTH_N_HIST_BINS);
      const w = (mx - mn) / STRENGTH_N_HIST_BINS;
      for (let i = 0; i < STRENGTH_N_HIST_BINS; i++) xs[i] = mn + (i + 0.5) * w;
      const out = new Array(STRENGTH_N_HIST_BINS).fill(0);
      const invH = 1 / h;
      for (const xi of valid) {
        for (let i = 0; i < STRENGTH_N_HIST_BINS; i++) {
          const u = (xs[i] - xi) * invH;
          out[i] += Math.exp(-0.5 * u * u);
        }
      }
      const total = out.reduce((a, b) => a + b, 0) || 1;
      density = out.map(d => d / total);
    } else {
      density = new Array(STRENGTH_N_HIST_BINS).fill(0);
      density[0] = 1;
    }
  } else {
    density = new Array(STRENGTH_N_HIST_BINS).fill(0);
    density[0] = 1;
  }

  return [mean, sd, mn, mx, ...percentiles, ...density];
}

// Compute slots for all metrics in the scenario, plus total_score from the
// user's exact weights. Mirrors compute_live_curves but driven by precomputed
// joint samples instead of running Monte Carlo at request time.
function _scenarioToCurveData(scenario, weights) {
  const data = {};
  const sigmas = {};
  for (const metric of ["in_lane_matchup", "out_of_lane_matchup", "overall_synergy", "blindability"]) {
    const samples = scenario[metric];
    if (!samples || samples.length === 0) continue;
    const slot = _slotFromSamples(samples);
    if (!slot) continue;
    data[metric] = slot;
    // σ for total computation = each component's empirical sd over random pools.
    sigmas[metric] = slot[1] > 1e-9 ? slot[1] : 1;
  }

  // total_score = sum(w_k * component_k / σ_k), per-sample
  const inLane = scenario.in_lane_matchup || [];
  const outLane = scenario.out_of_lane_matchup || [];
  const synergy = scenario.overall_synergy || [];
  const blind = scenario.blindability || [];
  const n = Math.max(inLane.length, outLane.length, synergy.length, blind.length);
  if (n > 0) {
    const totals = [];
    for (let i = 0; i < n; i++) {
      let t = 0;
      const il = inLane[i], ol = outLane[i], sy = synergy[i], bl = blind[i];
      if (il != null && Number.isFinite(il)) t += weights.in_lane * il / (sigmas.in_lane_matchup || 1);
      if (ol != null && Number.isFinite(ol)) t += weights.out_lane * ol / (sigmas.out_of_lane_matchup || 1);
      if (sy != null && Number.isFinite(sy)) t += weights.synergy  * sy / (sigmas.overall_synergy || 1);
      if (bl != null && Number.isFinite(bl)) t += weights.blind    * bl / (sigmas.blindability || 1);
      totals.push(t);
    }
    const totalSlot = _slotFromSamples(totals);
    if (totalSlot) data.total_score = totalSlot;
  }

  return data;
}

// Live Monte-Carlo path. Calls the wasm engine to sample fresh curves for the
// user's exact (role, patch, pool_size, top_x, pr_floor, pr_weighted) instead
// of looking up grid-snapped slots in the precomputed JSON. Output shape
// matches `_strengthCurvesLookup`.
async function _strengthCurvesViaEngine(body, engine) {
  const resp = engine.strength_curves({
    my_role:       body.my_role,
    patch:         body.patch,
    pool_size:     body.pool_size,
    top_x:         body.top_x,
    pr_floor:      body.pr_floor      ?? 0.0075,
    pr_weighted:   !!body.pr_weighted,
    shrink_alpha:  body.shrink_alpha  ?? 1.0,
    extra_pool_size: body.extra_pool_size,
    extra_top_x:     body.extra_top_x,
  });
  if (!resp) return null;

  const weights = {
    in_lane:  body.w_in_lane  ?? 1,
    out_lane: body.w_out_lane ?? 1,
    synergy:  body.w_synergy  ?? 1,
    blind:    body.w_blind    ?? 0.2,
  };

  const buildBlock = (b) => {
    if (!b) return null;
    const data = _scenarioToCurveData(b.samples, weights);
    if (Object.keys(data).length === 0) return null;
    return { pool_size: b.pool_size, top_x: b.top_x, data };
  };

  const primary = buildBlock(resp.primary);
  if (!primary) return null;
  const out = { config: resp.config, primary };
  const extra = buildBlock(resp.extra);
  if (extra) out.extra = extra;
  return out;
}

// Build the response shape the frontend expects from /api/pool_strength_curves
// using the precomputed static joint samples.
async function _strengthCurvesLookup(body) {
  // body.patch is the active rank label (silver/gold/.../master_plus).
  const curves = await _loadStrengthCurves(body.patch);
  if (!curves) return null;
  const grid = curves.config.grid;
  const role = body.my_role;
  const roleData = curves.data[role];
  if (!roleData) return null;

  const weights = {
    in_lane:  body.w_in_lane  ?? 1,
    out_lane: body.w_out_lane ?? 1,
    synergy:  body.w_synergy  ?? 1,
    blind:    body.w_blind    ?? 0.2,
  };

  const slot = (pool_size, top_x) => {
    const { key, pool_size: ps, top_x: tx } =
      _curveKey(pool_size, top_x, body.pr_floor ?? 0.0075, !!body.pr_weighted,
                body.shrink_alpha ?? 1.0, grid);
    const scenario = roleData[key];
    if (!scenario) return null;
    const data = _scenarioToCurveData(scenario, weights);
    if (Object.keys(data).length === 0) return null;
    return { pool_size: ps, top_x: tx, data };
  };

  const primary = slot(body.pool_size, body.top_x);
  if (!primary) return null;
  const out = {
    config: {
      percentile_grid: STRENGTH_PERCENTILE_GRID,
      n_hist_bins:     STRENGTH_N_HIST_BINS,
      n_samples:       curves.config.n_samples,
    },
    primary,
  };
  if (body.extra_pool_size != null) {
    const extra = slot(body.extra_pool_size, body.extra_top_x ?? body.top_x);
    if (extra) out.extra = extra;
  }
  return out;
}

// Drop-in `fetch()` replacement — same call signature, returns a
// Response-like object with `.json()` so existing call sites work
// unchanged. Routes /api/* to the wasm engine or static JSON.
async function apiFetch(input, init) {
  const { engine } = await _loadEngine();
  const urlStr = typeof input === 'string' ? input : input.url;
  const u = new URL(urlStr, 'http://localhost');
  const path = u.pathname;
  const params = u.searchParams;
  const body = init && init.body ? JSON.parse(init.body) : null;

  let data;
  if (path === '/api/meta') {
    data = {
      roles: ["TOP", "JUNGLE", "MID", "ADC", "SUP"],
      matchup_threshold: 0.75,
      synergy_threshold: 0.5,
      pool_builder_cap: 10000,
      patches: _championsData.patches,
      latest_patch: _championsData.latest_patch,
      // Actual game-patch version of the source data (e.g. "16.10"). Used
      // by main.js to populate the otherwise-hardcoded "Patch X" UI spans.
      data_patch: _championsData.data_patch,
      data_regions: _championsData.data_regions,
      refreshed_at: _championsData.refreshed_at,
    };
  } else if (path.startsWith('/api/champions/')) {
    const role = path.slice('/api/champions/'.length);
    const pr_floor = parseFloat(params.get('pr_floor') || '0.001');
    const patch = params.get('patch');
    // NB: by_patch[patch][role] may be present but empty (upstream data
    // gap); empty arrays are truthy in JS, so check length explicitly
    // and fall back to the default snapshot when the per-patch slice is
    // missing or empty.
    const perPatch = patch && _championsData.by_patch && _championsData.by_patch[patch]
      ? _championsData.by_patch[patch][role]
      : null;
    const source = (perPatch && perPatch.length)
      ? perPatch
      : (_championsData.default[role] || []);
    // Sort by pick_rate desc and filter by floor — matches FastAPI behavior.
    data = source
      .filter(c => c.pick_rate >= pr_floor)
      .slice()
      .sort((a, b) => b.pick_rate - a.pick_rate);
  } else if (path === '/api/coverage') {
    const result = engine.coverage(body);
    data = result === null ? { empty: true } : result;
  } else if (path === '/api/blindability') {
    const result = engine.blindability(body);
    data = result === null ? { empty: true } : result;
  } else if (path === '/api/comparer') {
    const result = engine.comparer(body);
    data = result === null ? { empty: true } : result;
  } else if (path === '/api/bans') {
    const result = engine.bans(body);
    data = result === null ? { empty: true } : result;
  } else if (path === '/api/health') {
    const result = engine.health(body);
    data = result === null ? { empty: true } : result;
  } else if (path === '/api/pool_summary') {
    const result = engine.pool_summary(body);
    data = result === null ? { empty: true } : result;
  } else if (path === '/api/pool_strength_curves') {
    // Wasm Monte-Carlo is the default; ?live_mc=0 falls back to the legacy
    // precomputed grid lookup (kept one release for emergency revert).
    const liveMc = new URLSearchParams(window.location.search).get('live_mc') !== '0';
    data = liveMc
      ? await _strengthCurvesViaEngine(body, engine)
      : await _strengthCurvesLookup(body);
  } else if (path === '/api/replacements') {
    const result = engine.replacements(body);
    data = result === null ? { empty: true } : result;
  } else if (path === '/api/build') {
    data = engine.build(body);
  } else if (path === '/api/combo_count') {
    const def = params.get('definite') || '';
    const may = params.get('maybe') || '';
    const target = parseInt(params.get('target') || '6', 10);
    data = engine.combo_count(def, may, target);
  } else {
    throw new Error(`apiFetch: ${path} is not ported to wasm yet.`);
  }
  return { ok: true, status: 200, json: async () => data };
}

// ── Champion data ─────────────────────────────────────────────────────────
// Cache key includes the active patch so switching patches reloads PRs.
async function loadChampionsFor(role) {
  const key = `${role}|${state.patch || ""}`;
  if (state.champsByRole[key]) return state.champsByRole[key];
  const url = state.patch
    ? `/api/champions/${role}?pr_floor=0.001&patch=${encodeURIComponent(state.patch)}`
    : `/api/champions/${role}?pr_floor=0.001`;
  const r = await apiFetch(url);
  state.champsByRole[key] = await r.json();
  // Keep a role-only fallback for any old callers.
  state.champsByRole[role] = state.champsByRole[key];
  return state.champsByRole[key];
}

// /api/champions/{role} returns champs sorted by pick_rate desc, so the first
// N entries are the top-N most played. We use this to seed the default pool.
function topNChampions(role, n) {
  const list = state.champsByRole[role] || [];
  return list.slice(0, n).map((c) => c.champion);
}

// ──────────────────────────────────────────────────────────────────────────
// COVERAGE TAB (Matchup / Synergy)
// ──────────────────────────────────────────────────────────────────────────
async function fetchCoverage() {
  if (state.pool.length === 0) return { empty: true };
  const r = await apiFetch("/api/coverage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      my_role: state.role, other_role: state.otherRole,
      mode: state.view, pool: state.pool,
      top_x: state.topX, pr_floor: state.prFloor, pr_weighted: state.prWeighted,
      patch: state.patch, shrink_alpha: state.shrinkAlpha,
    }),
  });
  return await r.json();
}

export function getChampionsData() { return _championsData; }
export function getDataSourceInfo() {
  return {
    baseUrl: REMOTE_BASE_URL || null,
    tier: _currentTier,
    version: _currentVersion,
    generatedAt: _currentManifest && _currentManifest.generated_at || null,
    source: _currentVersion ? 'remote' : 'local',
  };
}
export {
  _loadEngine, _loadStrengthCurves,
  apiFetch,
  loadChampionsFor, topNChampions,
};
