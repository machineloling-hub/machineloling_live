//! Pool Designer compute engine — WASM port of `_reference_backend/`.
//!
//! Crate layout:
//!
//!   data.rs              <- data.py            (binary matrix loader + champion index)
//!   ports.rs             <- ports.py           (shared port helpers used by endpoints)
//!   curves.rs            <- live_curves.py + parts of precompute_pool_distributions.py
//!                          (Monte-Carlo strength-curve sampling, replaces the
//!                           precomputed `strength_curves_*.json` lookup)
//!   endpoints/           one submodule per FastAPI route family:
//!     compute.rs         <- compute.py         (coverage, top-X, z-scores)
//!     blind.rs                                 (blindability)
//!     comparer.rs        <- comparer.py        (champion correlation tables)
//!     bans.rs                                  (ban recommender)
//!     health.rs                                (pool health)
//!     pool.rs                                  (pool builder, replacements)
//!     redundancy.rs                            (pool redundancy)

mod curves;
mod data;
mod endpoints;
mod ports;
mod util;

use endpoints::{bans, blind, comparer, compute, health, pool};

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// One-shot panic-hook installer; called from `Engine::new` so any panic
/// in a wasm endpoint surfaces in the browser console with the real
/// message + Rust source location, instead of a bare `unreachable`.
fn install_panic_hook() {
    use std::sync::Once;
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        console_error_panic_hook::set_once();
    });
}

#[wasm_bindgen]
pub struct Engine {
    store: data::DataStore,
}

#[wasm_bindgen]
impl Engine {
    /// Build the engine from the static artifacts produced by `data_prep/`.
    /// `matrices_bin` is the binary blob; `index_json` and `champions_json`
    /// are the parsed strings.
    #[wasm_bindgen(constructor)]
    pub fn new(
        matrices_bin: &[u8],
        index_json: &str,
        champions_json: &str,
    ) -> Result<Engine, JsError> {
        install_panic_hook();
        let store = data::DataStore::load(matrices_bin, index_json, champions_json)
            .map_err(|e| JsError::new(&e))?;
        Ok(Engine { store })
    }

    /// Coverage endpoint — port of FastAPI's `POST /api/coverage`.
    /// Returns null when the request has an empty pool / no valid pairing.
    #[wasm_bindgen]
    pub fn coverage(&self, request: JsValue) -> Result<JsValue, JsError> {
        let req: compute::CoverageRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsError::new(&format!("parse coverage request: {e}")))?;
        let resp = compute::coverage(&self.store, &req);
        match resp {
            None => Ok(JsValue::null()),
            Some(r) => serde_wasm_bindgen::to_value(&r)
                .map_err(|e| JsError::new(&format!("serialize coverage response: {e}"))),
        }
    }

    /// Replacement Finder — port of `POST /api/replacements`.
    #[wasm_bindgen]
    pub fn replacements(&self, request: JsValue) -> Result<JsValue, JsError> {
        let req: pool::ReplacementsRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsError::new(&format!("parse replacements request: {e}")))?;
        match pool::replacements(&self.store, &req) {
            None => Ok(JsValue::null()),
            Some(r) => serde_wasm_bindgen::to_value(&r)
                .map_err(|e| JsError::new(&format!("serialize replacements response: {e}"))),
        }
    }

    /// Pool Builder — port of `POST /api/build`.
    #[wasm_bindgen]
    pub fn build(&self, request: JsValue) -> Result<JsValue, JsError> {
        let req: pool::BuildRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsError::new(&format!("parse build request: {e}")))?;
        let resp = pool::build(&self.store, &req);
        serde_wasm_bindgen::to_value(&resp)
            .map_err(|e| JsError::new(&format!("serialize build response: {e}")))
    }

    /// Pool Builder combination count — port of `GET /api/combo_count`.
    #[wasm_bindgen]
    pub fn combo_count(&self, definite: &str, maybe: &str, target: usize) -> Result<JsValue, JsError> {
        let keeps: Vec<&str> = definite.split(',').filter(|s| !s.is_empty()).collect();
        let keep_set: std::collections::HashSet<&str> = keeps.iter().copied().collect();
        let maybes: Vec<&str> = maybe
            .split(',')
            .filter(|s| !s.is_empty() && !keep_set.contains(*s))
            .collect();
        let count = if keeps.len() > target || keeps.len() + maybes.len() < target {
            None
        } else {
            let remaining = target - keeps.len();
            Some(pool::combo_count(maybes.len(), remaining))
        };
        let cap = crate::util::consts::COMBO_COUNT_CAP;
        #[derive(serde::Serialize)]
        struct Resp {
            count: Option<u64>,
            cap: u64,
            over_cap: bool,
        }
        let r = Resp {
            count,
            cap,
            over_cap: count.map(|c| c > cap).unwrap_or(false),
        };
        serde_wasm_bindgen::to_value(&r).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Pool Health — port of `POST /api/health`.
    #[wasm_bindgen]
    pub fn health(&self, request: JsValue) -> Result<JsValue, JsError> {
        let req: health::HealthRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsError::new(&format!("parse health request: {e}")))?;
        match health::health(&self.store, &req) {
            None => Ok(JsValue::null()),
            Some(r) => serde_wasm_bindgen::to_value(&r)
                .map_err(|e| JsError::new(&format!("serialize health response: {e}"))),
        }
    }

    /// Pool summary — port of `POST /api/pool_summary`.
    #[wasm_bindgen]
    pub fn pool_summary(&self, request: JsValue) -> Result<JsValue, JsError> {
        let req: health::PoolSummaryRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsError::new(&format!("parse pool_summary request: {e}")))?;
        match health::pool_summary(&self.store, &req) {
            None => Ok(JsValue::null()),
            Some(r) => serde_wasm_bindgen::to_value(&r)
                .map_err(|e| JsError::new(&format!("serialize pool_summary response: {e}"))),
        }
    }

    /// Ban Recommender — port of `POST /api/bans`.
    #[wasm_bindgen]
    pub fn bans(&self, request: JsValue) -> Result<JsValue, JsError> {
        let req: bans::BansRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsError::new(&format!("parse bans request: {e}")))?;
        match bans::ban_candidates(&self.store, &req) {
            None => Ok(JsValue::null()),
            Some(r) => serde_wasm_bindgen::to_value(&r)
                .map_err(|e| JsError::new(&format!("serialize bans response: {e}"))),
        }
    }

    /// Champion-vs-champion correlation comparer — port of `POST /api/comparer`.
    #[wasm_bindgen]
    pub fn comparer(&self, request: JsValue) -> Result<JsValue, JsError> {
        let req: comparer::ComparerRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsError::new(&format!("parse comparer request: {e}")))?;
        match comparer::champion_correlation(&self.store, &req) {
            None => Ok(JsValue::null()),
            Some(r) => serde_wasm_bindgen::to_value(&r)
                .map_err(|e| JsError::new(&format!("serialize comparer response: {e}"))),
        }
    }

    /// Blindability endpoint — port of `POST /api/blindability`.
    #[wasm_bindgen]
    pub fn blindability(&self, request: JsValue) -> Result<JsValue, JsError> {
        let req: blind::BlindabilityRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsError::new(&format!("parse blindability request: {e}")))?;
        match blind::blindability(&self.store, &req) {
            None => Ok(JsValue::null()),
            Some(r) => serde_wasm_bindgen::to_value(&r)
                .map_err(|e| JsError::new(&format!("serialize blindability response: {e}"))),
        }
    }

    /// Pool strength curves — live Monte-Carlo replacement for the
    /// precomputed `strength_curves_*.json` static lookup. Port of
    /// `_reference_backend/live_curves.py`.
    #[wasm_bindgen]
    pub fn strength_curves(&self, request: JsValue) -> Result<JsValue, JsError> {
        let req: curves::StrengthCurvesRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsError::new(&format!("parse strength_curves request: {e}")))?;
        match curves::strength_curves(&self.store, &req) {
            None => Ok(JsValue::null()),
            Some(r) => serde_wasm_bindgen::to_value(&r)
                .map_err(|e| JsError::new(&format!("serialize strength_curves response: {e}"))),
        }
    }

    /// Available patches and the latest one (port of `GET /api/patches`).
    #[wasm_bindgen]
    pub fn patches(&self) -> Result<JsValue, JsError> {
        #[derive(serde::Serialize)]
        struct PatchesResp<'a> {
            patches: &'a [String],
            latest: Option<&'a str>,
        }
        let r = PatchesResp {
            patches: &self.store.patches,
            latest: self.store.latest_patch.as_deref(),
        };
        serde_wasm_bindgen::to_value(&r).map_err(|e| JsError::new(&e.to_string()))
    }
}
