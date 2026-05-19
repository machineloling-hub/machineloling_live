//! HTTP-endpoint ports — one submodule per `_reference_backend/` route family.
//! Each module owns its request/response types plus the pure compute it needs.
//! Shared infrastructure (data store, port helpers, MC curves) lives one
//! level up at the crate root.

pub mod bans;
pub mod blind;
pub mod comparer;
pub mod compute;
pub mod health;
pub mod pool;
pub mod redundancy;
