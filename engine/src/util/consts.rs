//! Named numeric constants shared across endpoints.
//!
//! Centralising the pick-rate thresholds and coverage cut-offs avoids the
//! "change one of five copies" pattern.

/// Default pick-rate floor used by most endpoints (compute/curves/bans/health/pool).
pub const PR_FLOOR_DEFAULT: f32 = 0.0075;

/// Lower pick-rate floor used by blind and the pool-summary path.
pub const PR_FLOOR_BLIND: f32 = 0.005;

/// Replacement-candidate pick-rate floor used by `pool::replacements`.
pub const PR_FLOOR_REPLACEMENTS: f32 = 0.005;

/// Comparer endpoint uses a more lenient floor.
pub const PR_FLOOR_COMPARER: f32 = 0.01;

/// Default shrink-blend `alpha` — 1.0 means "fully shrunk".
pub const ALPHA_DEFAULT: f32 = 1.0;

/// Default top-X (best-rows-per-column) for coverage / health.
pub const TOP_X_DEFAULT: usize = 1;

/// Coverage thresholds (in z-score units) — see `compute.rs::coverage`.
pub const MATCHUP_THRESHOLD: f32 = 0.75;
pub const SYNERGY_THRESHOLD: f32 = 0.5;
