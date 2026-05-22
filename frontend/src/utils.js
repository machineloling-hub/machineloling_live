// Champion Pool Designer — frontend.
// One global `state`; one render() per tab. Sidebar control changes call refresh()
// which fans out to the active tab's renderer.
import { state } from "./state.js";

const ROLES = ["TOP", "JUNGLE", "MID", "ADC", "SUP"];
const CDRAGON_NAME_FIX = { "Wukong": "monkeyking" };
// Lane position icon (Community Dragon static asset). ADC → "bottom",
// SUP → "utility" — matches LoL's internal lane slugs.
const ROLE_ICON_SLUG = { TOP: "top", JUNGLE: "jungle", MID: "middle", ADC: "bottom", SUP: "utility" };
const ROLE_ICON_URL = (role) =>
  `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${ROLE_ICON_SLUG[role]}.png`;
// Escape any string before splicing it into innerHTML. Champion names
// today come from our pipeline and are constrained to [A-Za-z0-9'.& ],
// but treat all dynamic values as untrusted to keep this resilient if a
// future data source is ever swapped in.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]
));
const champSlug = (n) =>
  CDRAGON_NAME_FIX[n] || n.toLowerCase().replace(/[^a-z0-9]/g, "");
const champIconUrl = (n) =>
  `https://cdn.communitydragon.org/latest/champion/${champSlug(n)}/square`;
const champImg = (n, size = 18) =>
  `<img src="${esc(champIconUrl(n))}" alt="" width="${size}" height="${size}" class="champ-icon" style="vertical-align:middle;">`;

// Hide broken champion icons without using inline event handlers (CSP-safe).
// `error` events don't bubble, so we listen in the capture phase.
if (typeof document !== "undefined") {
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.classList && t.classList.contains("champ-icon")) {
      t.style.display = "none";
    }
  }, true);
}

// Theme colors used in tables and the blindability axes
const MATCHUP_COLOR = "#e6c978";  // gold (matchup)
const SYNERGY_COLOR = "#7fc0e8";  // blue (synergy)
const BLIND_COLOR   = "#c9a4d8";  // pale purple (blindability)
const TOTAL_COLOR   = "#6fe2b5";  // teal (weighted total)
const STRENGTH_LABEL_COLORS = {
  overall_matchup:     MATCHUP_COLOR,
  in_lane_matchup:     MATCHUP_COLOR,
  out_of_lane_matchup: MATCHUP_COLOR,
  overall_synergy:     SYNERGY_COLOR,
  blindability:        BLIND_COLOR,
  total_score:         TOTAL_COLOR,
};

// Shared "Score = w·In + w·Out + w·Syn + w·Blind" equation used by Pool
// Health, Pool Builder, and Replacement Finder. Pass `prefix` for the LHS
// label (e.g. "Score(pool)" or "Δ score = Score(new) − Score(old), where
// Score").
function renderScoreEquation(prefix = "Score") {
  const wmark = state.prWeighted ? ' <sub style="color:#e0a07a;">(PR-weighted)</sub>' : "";
  const w = state.weights;
  const f = v => v.toFixed(2);
  return `<b style="color:${TOTAL_COLOR};">${prefix}</b>${wmark} =
    <b>${f(w.in_lane)}</b> × <span style="color:${MATCHUP_COLOR};">In-Lane</span>
    + <b>${f(w.out_lane)}</b> × <span style="color:${MATCHUP_COLOR};">Out-of-Lane</span>
    + <b>${f(w.synergy)}</b> × <span style="color:${SYNERGY_COLOR};">Synergy</span>
    + <b>${f(w.blind)}</b> × <span style="color:${BLIND_COLOR};">Blindability</span>`;
}

// Diverging palette — orange (bad / anti-synergy) → muted dark neutral
// (neutral) → teal (good / synergy). The midpoint and adjacent pales
// are tuned for a dark UI so the centre of the gradient blends into
// the surface instead of flashing pure white.
const HEATMAP_COLORS_9 = [
  "#D55E00", "#C46A2B", "#8C5A3C", "#3E3A40",
  "#1A2236",
  "#2C4A47", "#3A8F73", "#1E9E73", "#006D50",
];
function plotlyColorscale() {
  const n = HEATMAP_COLORS_9.length;
  return HEATMAP_COLORS_9.map((c, i) => [i / (n - 1), c]);
}
function colorAt(v, range) {  // v in [-range, +range] → palette
  const t = Math.max(-1, Math.min(1, v / range));
  const idx = Math.round((t + 1) / 2 * (HEATMAP_COLORS_9.length - 1));
  return HEATMAP_COLORS_9[idx];
}
function fmtSign(v, places = 2) {
  if (v == null || !isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(places);
}
function tealOrangeBg(v, scale = 1.5, alpha = 0.55) {
  if (v == null || !isFinite(v)) return "transparent";
  const c = Math.max(-scale, Math.min(scale, v));
  if (c >= 0) return `rgba(61,217,164,${(c / scale * alpha).toFixed(2)})`;
  return `rgba(224,123,74,${(Math.abs(c) / scale * alpha).toFixed(2)})`;
}
// orange = high (redundant), teal = low (complementary)
function corrBg(v) {
  if (v == null || !isFinite(v)) return "transparent";
  const c = Math.max(-1, Math.min(1, v));
  if (c >= 0) return `rgba(213,94,0,${(c * 0.85).toFixed(2)})`;
  return `rgba(0,158,115,${(Math.abs(c) * 0.85).toFixed(2)})`;
}

// Plotly theme — spread into every chart's `layout` so axes/fonts/bgs match
// the CSS design tokens. Backgrounds are transparent so charts inherit the
// surface of whatever .card / container they're placed in.
const PLOTLY_THEME = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor:  "rgba(0,0,0,0)",
  font:    { family: "Inter, -apple-system, BlinkMacSystemFont, sans-serif", color: "#9AA3B7", size: 11 },
  hoverlabel: {
    bgcolor: "#1A2236",
    bordercolor: "rgba(255,255,255,0.10)",
    font: { family: "Inter, sans-serif", color: "#E6EAF2", size: 11 },
  },
};
const PLOTLY_AXIS = {
  gridcolor:     "rgba(255,255,255,0.06)",
  zerolinecolor: "rgba(255,255,255,0.10)",
  linecolor:     "rgba(255,255,255,0.10)",
  tickcolor:     "rgba(255,255,255,0.10)",
  tickfont:      { color: "#9AA3B7", size: 10 },
};

const RANK_LABELS = {
  silver: "Silver",
  gold: "Gold",
  platinum: "Platinum",
  emerald: "Emerald",
  diamond: "Diamond",
  master_plus: "Master+",
};

// In-game rank tinting — keys match RANK_LABELS.
const RANK_COLORS = {
  silver: "#c4cbd0",
  gold: "#f3c769",
  platinum: "#4ec9b0",
  emerald: "#2bd57d",
  diamond: "#7eb8f5",
  master_plus: "#c787ff",
};

// ── DOM helpers ───────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const setStatus = (m) => { $("#status").textContent = m || ""; };

export {
  ROLES, CDRAGON_NAME_FIX, ROLE_ICON_URL,
  esc, champSlug, champIconUrl, champImg,
  MATCHUP_COLOR, SYNERGY_COLOR, BLIND_COLOR, TOTAL_COLOR, STRENGTH_LABEL_COLORS,
  renderScoreEquation,
  HEATMAP_COLORS_9, plotlyColorscale, colorAt,
  fmtSign, tealOrangeBg, corrBg,
  RANK_LABELS, RANK_COLORS,
  PLOTLY_THEME, PLOTLY_AXIS,
  $, $$, setStatus,
};
