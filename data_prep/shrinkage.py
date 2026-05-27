"""Shrinkage stages for the refresh pipeline.

Reads the raw-count CSVs emitted by aggregate_matches.py and writes back
the same files with shrinkage columns appended:

    delta_pp_shrunk           — empirical Bayes (file-level)
    delta_pp_shrunk_mom       — method-of-moments alternative
    delta_pp_shrunk_hier      — bilateral hierarchical Bayes, tight prior
    delta_pp_shrunk_hier_wide — bilateral hierarchical Bayes, wide prior

Plus per-pair sidecar τ files (one row per champion at each role):

    tau_matchup_{ra}_vs_{rb}.csv         — tight prior τ
    tau_wide_matchup_{ra}_vs_{rb}.csv    — wide prior τ
    tau_synergy_{ra}_{rb}.csv            — same, synergy
    tau_wide_synergy_{ra}_{rb}.csv

Two priors are fit because the runtime UI exposes the wide variant by
default; the tight variant is kept for compatibility with the existing
loader / older debugging paths.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

# Half-normal scale priors on the population τ. Match the existing
# 02d_hier_shrink.py constants the legacy CSVs were built with.
TIGHT_PRIOR_SCALE = 0.3
WIDE_PRIOR_SCALE = 0.6


# ── Stage 1: empirical Bayes ─────────────────────────────────────────────
def _empirical_bayes(delta: np.ndarray, se_pp: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """File-level EB shrinkage of per-cell deltas (in percentage points).

    Two flavours:
      - shrunk      = posterior mean under N(0, σ²) prior fit by MLE
                      (variance components estimator).
      - shrunk_mom  = same idea but with method-of-moments σ²
                      (more robust under heavy tails).

    Inputs are 1-D arrays of equal length: `delta` in pp, `se_pp` in pp.
    """
    delta = np.asarray(delta, dtype=np.float64)
    se = np.asarray(se_pp, dtype=np.float64)
    var_obs = se ** 2

    # Degenerate input — ddof=1 variance is undefined for n<2 and would
    # produce NaN that silently propagates through matrices.bin. Return the
    # raw deltas (no shrinkage signal to extract from a single cell).
    if delta.size < 2:
        return delta.astype(np.float32), delta.astype(np.float32)

    # MoM: τ² = max(0, var(delta) - mean(var_obs))
    tau2_mom = max(0.0, float(np.var(delta, ddof=1) - np.mean(var_obs)))
    w_mom = tau2_mom / (tau2_mom + var_obs)
    shrunk_mom = w_mom * delta

    # MLE via fixed-point iteration on the marginal likelihood
    # δ_i ~ N(0, τ² + σ_i²). Closed-form update from Morris (1983).
    tau2 = tau2_mom + 1e-9
    for _ in range(200):
        w = 1.0 / (tau2 + var_obs)
        num = float(np.sum(w * w * (delta ** 2 - var_obs)))
        den = float(np.sum(w * w))
        new = max(num / den, 0.0) if den > 0 else 0.0
        if abs(new - tau2) < 1e-9:
            tau2 = new
            break
        tau2 = new
    w = tau2 / (tau2 + var_obs)
    shrunk = w * delta
    return shrunk.astype(np.float32), shrunk_mom.astype(np.float32)


def add_eb_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Append delta_pp_shrunk and delta_pp_shrunk_mom columns in-place."""
    delta_pp = df["delta"].to_numpy() * 100.0  # delta is fractional
    se = df["se_pp"].to_numpy()
    shrunk, shrunk_mom = _empirical_bayes(delta_pp, se)
    df["delta_pp_shrunk"] = shrunk
    df["delta_pp_shrunk_mom"] = shrunk_mom
    return df


# ── Stage 2: bilateral hierarchical Bayes (numpyro NUTS) ─────────────────
def _hier_fit(
    df: pd.DataFrame,
    role_a: str,
    role_b: str,
    a_col: str,
    b_col: str,
    prior_scale: float,
    n_warmup: int,
    n_draws: int,
    n_chains: int,
    seed: int = 0,
) -> tuple[np.ndarray, dict[str, float], dict[str, float]]:
    """Fit the bilateral hier model on one (role_a, role_b) slice.

    Model:
        δ_obs[k] ~ N(true_δ[k], se[k]²)
        true_δ[k] = α_a[i_k] + β_b[j_k] + cell_sd[k] · z[k]
        cell_sd[k] = sqrt(τ_a[i_k]² + τ_b[j_k]²)
        α_a[i] ~ N(0, σ_α_a²)
        β_b[j] ~ N(0, σ_α_b²)            (= -α_a if mirror — antisymmetric)
        σ_α_a, σ_α_b ~ HalfNormal(prior_scale)
        τ_a[i] ~ HalfNormal(σ_τ_a)
        τ_b[j] ~ HalfNormal(σ_τ_b)       (same population if mirror)
        σ_τ_a, σ_τ_b ~ HalfNormal(prior_scale)

    The mean-effect (α, β) terms let champions surface as systematically
    over- or under-performing vs the field; the τ terms capture remaining
    cell-level variability after the means are accounted for. Mirror
    matchups (role_a == role_b) impose β = -α so the model respects
    P(A beats B) = 1 - P(B beats A) at the population level.

    Returns:
        shrunk_pp:   posterior mean of true_δ for each row of df (length N)
        tau_a_means: {champ_a: τ_a posterior mean}
        tau_b_means: {champ_b: τ_b posterior mean}    (= tau_a_means if mirror)
    """
    import jax  # type: ignore
    import jax.numpy as jnp  # type: ignore
    import numpyro  # type: ignore
    import numpyro.distributions as dist  # type: ignore
    from numpyro.infer import MCMC, NUTS  # type: ignore

    numpyro.set_host_device_count(n_chains)

    champs_a = sorted(df[a_col].unique())
    champs_b = sorted(df[b_col].unique())
    a_idx = {c: i for i, c in enumerate(champs_a)}
    b_idx = {c: i for i, c in enumerate(champs_b)}
    mirror = (role_a == role_b)

    i_arr = jnp.array(df[a_col].map(a_idx).to_numpy(), dtype=jnp.int32)
    j_arr = jnp.array(df[b_col].map(b_idx).to_numpy(), dtype=jnp.int32)
    delta_obs = jnp.array((df["delta"].to_numpy() * 100.0), dtype=jnp.float32)
    se = jnp.array(df["se_pp"].to_numpy(), dtype=jnp.float32)
    n_a = len(champs_a)
    n_b = len(champs_b)
    n_cells = int(delta_obs.shape[0])

    def model():
        # Per-champion mean effect (α). Non-centered for NUTS stability.
        sigma_alpha_a = numpyro.sample("sigma_alpha_a",
                                       dist.HalfNormal(prior_scale))
        alpha_a_raw = numpyro.sample(
            "alpha_a_raw",
            dist.Normal(jnp.zeros(n_a), jnp.ones(n_a)).to_event(1))
        alpha_a = numpyro.deterministic("alpha_a", sigma_alpha_a * alpha_a_raw)
        if mirror:
            # Same-role matchups are antisymmetric: A beats B ⇒ B loses to A,
            # so β_b = -α_a holds the (i,j) and (j,i) cells in agreement.
            beta_b = -alpha_a
        else:
            sigma_alpha_b = numpyro.sample("sigma_alpha_b",
                                           dist.HalfNormal(prior_scale))
            beta_b_raw = numpyro.sample(
                "beta_b_raw",
                dist.Normal(jnp.zeros(n_b), jnp.ones(n_b)).to_event(1))
            beta_b = numpyro.deterministic("beta_b", sigma_alpha_b * beta_b_raw)

        # Per-champion variance scale (τ). Same non-centered HalfNormal as
        # before — captures residual cell variability around α + β.
        sigma_a = numpyro.sample("sigma_a", dist.HalfNormal(prior_scale))
        tau_a_raw = numpyro.sample("tau_a_raw",
                                   dist.HalfNormal(jnp.ones(n_a)).to_event(1))
        tau_a = numpyro.deterministic("tau_a", sigma_a * tau_a_raw)
        if mirror:
            tau_b = tau_a
        else:
            sigma_b = numpyro.sample("sigma_b", dist.HalfNormal(prior_scale))
            tau_b_raw = numpyro.sample("tau_b_raw",
                                       dist.HalfNormal(jnp.ones(n_b)).to_event(1))
            tau_b = numpyro.deterministic("tau_b", sigma_b * tau_b_raw)

        cell_mean = alpha_a[i_arr] + beta_b[j_arr]
        cell_sd = jnp.sqrt(tau_a[i_arr] ** 2 + tau_b[j_arr] ** 2 + 1e-8)
        # Non-centered cell effect.
        z = numpyro.sample("z", dist.Normal(jnp.zeros(n_cells),
                                            jnp.ones(n_cells)).to_event(1))
        true_delta = numpyro.deterministic("true_delta",
                                           cell_mean + cell_sd * z)
        numpyro.sample("obs", dist.Normal(true_delta, se), obs=delta_obs)

    rng = jax.random.PRNGKey(seed)
    nuts = NUTS(model, target_accept_prob=0.9)
    mcmc = MCMC(nuts, num_warmup=n_warmup, num_samples=n_draws,
                num_chains=n_chains, progress_bar=False, chain_method="sequential")
    mcmc.run(rng)
    samples = mcmc.get_samples()

    # Posterior means.
    shrunk_pp = np.asarray(samples["true_delta"].mean(axis=0))
    tau_a_post = np.asarray(samples["tau_a"].mean(axis=0))
    tau_a_means = {c: float(tau_a_post[i]) for c, i in a_idx.items()}
    if mirror:
        tau_b_means = dict(tau_a_means)
    else:
        tau_b_post = np.asarray(samples["tau_b"].mean(axis=0))
        tau_b_means = {c: float(tau_b_post[j]) for c, j in b_idx.items()}
    return shrunk_pp.astype(np.float32), tau_a_means, tau_b_means


def add_hier_columns(
    df: pd.DataFrame,
    role_a: str,
    role_b: str,
    a_col: str,
    b_col: str,
    n_warmup: int,
    n_draws: int,
    n_chains: int,
) -> tuple[pd.DataFrame, dict[str, dict[str, float]]]:
    """Run both prior variants and append the four hier outputs.

    Returns (df_with_columns, {"tight": tau_dict, "wide": tau_dict_wide})
    where each tau_dict has keys "a" and "b" mapping champion → τ posterior
    mean, ready to be flattened into the tau sidecar CSVs.
    """
    shrunk_t, tau_a_t, tau_b_t = _hier_fit(
        df, role_a, role_b, a_col, b_col, TIGHT_PRIOR_SCALE,
        n_warmup, n_draws, n_chains, seed=11)
    shrunk_w, tau_a_w, tau_b_w = _hier_fit(
        df, role_a, role_b, a_col, b_col, WIDE_PRIOR_SCALE,
        n_warmup, n_draws, n_chains, seed=22)
    df["delta_pp_shrunk_hier"] = shrunk_t
    df["delta_pp_shrunk_hier_wide"] = shrunk_w
    return df, {
        "tight": {"a": tau_a_t, "b": tau_b_t},
        "wide":  {"a": tau_a_w, "b": tau_b_w},
    }


def tau_sidecar_rows(role_a: str, role_b: str,
                     tau_dict: dict[str, dict[str, float]]) -> pd.DataFrame:
    """Flatten a tau dict from add_hier_columns into a sidecar DataFrame.

    Mirror matchups (role_a == role_b) emit only role_a rows; the loader
    mirrors them to role_b at read time.
    """
    rows = [{"champion": c, "role": role_a, "tau": v}
            for c, v in tau_dict["a"].items()]
    if role_a != role_b:
        rows += [{"champion": c, "role": role_b, "tau": v}
                 for c, v in tau_dict["b"].items()]
    return pd.DataFrame(rows)
