"""Aggregate match feathers into matchup/synergy raw-count CSVs.

Reads the match feathers produced by the riot-api-pull-pipeline
(https://github.com/machineloling-hub/riot-api-pull-pipeline; see its
PIPELINE_FOR_DB_AGENT.md). For one tier bucket,
emits the schema the existing _reference_backend/data.py loader expects:

    matchup_{ROLE_A}_vs_{ROLE_B}.csv
        columns: champion_{ROLE_A}, opponent_{ROLE_B},
                 games, wins, observed_wr,
                 wr_champ, wr_opp, expected_wr, delta, se_pp
    synergy_{ROLE_A}_{ROLE_B}.csv     (only ra < rb to avoid duplicates)
        columns: champion_{ROLE_A}, champion_{ROLE_B},
                 games, wins, observed_wr,
                 wr_{ROLE_A}, wr_{ROLE_B}, expected_wr, delta, se_pp
    individual_wr.csv
        columns: champion, role, games, wins, win_rate
    pr_table.parquet
        columns: champion_name, lane, games   (lane in lower-case Riot form)

Tier assignment per match: a match contributes to tier T if AT LEAST ONE of
the matchup-relevant participants is in tier T. This mirrors how lolalytics
buckets cross-skill matches and avoids dropping data when teams aren't
self-similar.

Synergy keying: each unordered role pair {ra, rb} is emitted once with
ra < rb in ROLE_ORDER. The runtime loader handles the transpose.
"""
from __future__ import annotations

import json
from collections import defaultdict
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd

from refresh_config import (RIOT_LANE_TO_ROLE, ROLES, RefreshConfig,
                            TIER_TO_BUCKET)

# Order matters for synergy file naming (matches existing _data/ filenames).
_ROLE_ORDER = {r: i for i, r in enumerate(ROLES)}

# Inverse of RIOT_LANE_TO_ROLE, lowercased — used for the lolalytics-shaped
# `lane` column in the PR table.
_ROLE_TO_LANE_LOWER = {role: lane.lower()
                       for lane, role in RIOT_LANE_TO_ROLE.items()}


def _participants_to_lookup(parts: list[dict]) -> dict[int, dict]:
    """Index a match's participants_data list by participantId."""
    return {int(p["participantId"]): p for p in parts}


# Riot teamId convention: 100 = blue side, 200 = red side. The puller writes
# `winner` as 0 for blue, 1 for red.
_BLUE_TEAM = 100
_RED_TEAM = 200


def _is_blue(part: dict) -> bool:
    """Return True iff this participant is on the blue (100) team.
    Falls back to the legacy pid<=5 heuristic only when teamId is missing,
    so non-SR queues with reshuffled IDs are handled correctly."""
    tid = part.get("teamId")
    if tid in (_BLUE_TEAM, _RED_TEAM):
        return tid == _BLUE_TEAM
    pid = int(part.get("participantId", 0) or 0)
    return pid <= 5


def _team_won(part: dict, winner: int) -> bool:
    """winner field: 0 = team 100 (blue), 1 = team 200 (red)."""
    return (winner == 0) == _is_blue(part)


def _norm_champ(name: str) -> str:
    """Normalise champion names to internal form (matches LOL_TO_OURS)."""
    fixes = {
        "Aurelion Sol": "AurelionSol", "Bel'Veth": "Belveth",
        "Cho'Gath": "Chogath", "Dr. Mundo": "DrMundo",
        "Fiddlesticks": "FiddleSticks", "Jarvan IV": "JarvanIV",
        "K'Sante": "KSante", "Kai'Sa": "Kaisa", "Kha'Zix": "Khazix",
        "Kog'Maw": "KogMaw", "LeBlanc": "Leblanc", "Lee Sin": "LeeSin",
        "Master Yi": "MasterYi", "Miss Fortune": "MissFortune",
        "Nunu & Willump": "Nunu", "Rek'Sai": "RekSai",
        "Renata Glasc": "Renata", "Tahm Kench": "TahmKench",
        "Twisted Fate": "TwistedFate", "Vel'Koz": "Velkoz",
        "Xin Zhao": "XinZhao",
    }
    return fixes.get(name, name)


def _participant_tier_bucket(part: dict) -> str | None:
    t = part.get("tier")
    if not t:
        return None
    return TIER_TO_BUCKET.get(str(t).upper())


# Precomputed cross-role pair list (constant across matches — avoids
# re-building 20 tuples per match).
_CROSS_ROLE_PAIRS = [(a, b) for a in ROLES for b in ROLES if a != b]


def _new_counters() -> tuple[dict, dict, dict, dict, dict]:
    """Fresh empty counter dicts in the canonical layout.

    Five counters:
      matchup, synergy           — pairwise per cfg.tier match
      individual                 — per-(champ,role), filtered to participants
                                   whose own bucket == cfg.tier (drives the
                                   individual_wr.csv output)
      pr                         — pick-rate counts, also per-tier filtered
      individual_full            — per-(champ,role) over EVERY participant in
                                   any in-tier match. Matches the semantics of
                                   matchup/synergy counts and is what LOO
                                   subtraction reads in _finalize.
    """
    return (
        defaultdict(lambda: defaultdict(lambda: [0, 0])),  # matchup
        defaultdict(lambda: defaultdict(lambda: [0, 0])),  # synergy
        defaultdict(lambda: [0, 0]),                       # individual (tier)
        defaultdict(int),                                  # pr
        defaultdict(lambda: [0, 0]),                       # individual_full
    )


def _count_feather_rows(
    cfg: RefreshConfig,
    df: pd.DataFrame,
    matchup_counts: dict,
    synergy_counts: dict,
    ind_counts: dict,
    pr_counts: dict,
    ind_full_counts: dict,
) -> tuple[int, int, int]:
    """Walk one feather's rows and update the supplied counter dicts in
    place. Returns (n_matches, n_in_tier, n_dup_role_skipped)."""
    tier = cfg.tier
    n_matches = 0
    n_in_tier = 0
    n_dup_role_skipped = 0
    for row in df.itertuples(index=False):
        n_matches += 1
        try:
            participants = json.loads(row.participants_data)
        except Exception:
            continue
        winner = int(row.winner)
        # Tier-bucket each participant once.
        buckets = [_participant_tier_bucket(p) for p in participants]
        if tier not in buckets:
            continue
        n_in_tier += 1
        # Group by role.
        by_role: dict[str, list[dict]] = defaultdict(list)
        for p in participants:
            role = RIOT_LANE_TO_ROLE.get(p.get("teamPosition"))
            if role:
                by_role[role].append(p)
        # Skip matches where any team has two participants in the same
        # role (auto-fill bug, Arena rotations, etc.) — they would inflate
        # matchup/synergy counters with phantom pairings.
        dup = False
        for plist in by_role.values():
            blue = sum(1 for p in plist if _is_blue(p))
            if blue > 1 or (len(plist) - blue) > 1:
                dup = True
                break
        if dup:
            n_dup_role_skipped += 1
            continue
        # Individual WR + PR contributions: only count participants
        # that are actually in cfg.tier (per-participant bucketing).
        # individual_full mirrors matchup/synergy: every in-tier-match
        # participant counts, so LOO subtraction is consistent.
        for role, plist in by_role.items():
            lane_l = _ROLE_TO_LANE_LOWER[role]
            for p in plist:
                champ = _norm_champ(p.get("championName") or "")
                if not champ:
                    continue
                won = 1 if _team_won(p, winner) else 0
                ind_full_counts[(champ, role)][0] += 1
                ind_full_counts[(champ, role)][1] += won
                if _participant_tier_bucket(p) != tier:
                    continue
                ind_counts[(champ, role)][0] += 1
                ind_counts[(champ, role)][1] += won
                pr_counts[(lane_l, champ)] += 1
        # Pairwise matchup: same role across teams. Both sides counted
        # symmetrically (one row per ordered pair).
        for role, plist in by_role.items():
            team_a = [p for p in plist if _is_blue(p)]
            team_b = [p for p in plist if not _is_blue(p)]
            for a in team_a:
                for b in team_b:
                    ca = _norm_champ(a.get("championName") or "")
                    cb = _norm_champ(b.get("championName") or "")
                    if not ca or not cb:
                        continue
                    a_won = _team_won(a, winner)
                    b_won = _team_won(b, winner)
                    # (a vs b) row: a is "champion", b is "opponent".
                    matchup_counts[(role, role)][(ca, cb)][0] += 1
                    matchup_counts[(role, role)][(ca, cb)][1] += int(a_won)
                    matchup_counts[(role, role)][(cb, ca)][0] += 1
                    matchup_counts[(role, role)][(cb, ca)][1] += int(b_won)
        # Cross-role matchups: ChampA at role X (team T) vs ChampB at
        # role Y (other team). Counted asymmetrically per team-pair.
        for ra, rb in _CROSS_ROLE_PAIRS:
            for a in by_role.get(ra, []):
                a_blue = _is_blue(a)
                opp_team = [p for p in by_role.get(rb, [])
                            if _is_blue(p) != a_blue]
                for b in opp_team:
                    ca = _norm_champ(a.get("championName") or "")
                    cb = _norm_champ(b.get("championName") or "")
                    if not ca or not cb:
                        continue
                    won = _team_won(a, winner)
                    matchup_counts[(ra, rb)][(ca, cb)][0] += 1
                    matchup_counts[(ra, rb)][(ca, cb)][1] += int(won)
        # Synergy: ChampA at role X + ChampB at role Y on the SAME team.
        for ra, rb in combinations(ROLES, 2):
            for a in by_role.get(ra, []):
                a_blue = _is_blue(a)
                same_team = [p for p in by_role.get(rb, [])
                             if _is_blue(p) == a_blue]
                for b in same_team:
                    ca = _norm_champ(a.get("championName") or "")
                    cb = _norm_champ(b.get("championName") or "")
                    if not ca or not cb:
                        continue
                    won = _team_won(a, winner)
                    synergy_counts[(ra, rb)][(ca, cb)][0] += 1
                    synergy_counts[(ra, rb)][(ca, cb)][1] += int(won)
    return n_matches, n_in_tier, n_dup_role_skipped


def _finalize(
    cfg: RefreshConfig,
    matchup_counts: dict,
    synergy_counts: dict,
    ind_counts: dict,
    pr_counts: dict,
    ind_full_counts: dict | None = None,
) -> dict[str, pd.DataFrame]:
    """Convert summed counter dicts into the output DataFrame schema
    (matchup_*, synergy_*, individual_wr, pr_table) with min_games_cell
    filtering and derived columns (observed_wr, expected_wr, delta, se_pp)."""
    out: dict[str, pd.DataFrame] = {}

    # ── individual_wr ────────────────────────────────────────────────────
    ind_rows = [{"champion": ch, "role": role, "games": g, "wins": w,
                 "win_rate": (w / g) if g else 0.0}
                for (ch, role), (g, w) in ind_counts.items()]
    if ind_rows:
        out["individual_wr"] = pd.DataFrame(ind_rows).sort_values(
            ["role", "games"], ascending=[True, False]).reset_index(drop=True)
    else:
        out["individual_wr"] = pd.DataFrame(
            columns=["champion", "role", "games", "wins", "win_rate"])

    # Per-(champion, role) totals used for the LOO baseline. Prefer the
    # tier-agnostic ind_full counts so cell subtraction is consistent with
    # matchup/synergy semantics (those count every pair in any in-tier
    # match, not just same-tier participants). Fall back to ind_counts on
    # legacy partials that don't carry the full counter.
    src = ind_full_counts if ind_full_counts else ind_counts
    ind_g_lookup = {(ch, role): g for (ch, role), (g, w) in src.items()}
    ind_w_lookup = {(ch, role): w for (ch, role), (g, w) in src.items()}

    def _loo_wr(ch: str, role: str, ex_g: int, ex_w: int) -> tuple[float, int]:
        """Leave-opponent-out WR for (ch, role): subtract the cell's games
        and wins from the champ-role totals. Returns (wr, remaining_games).

        Defensive clamp in case of residual count drift (e.g., dropped
        rows from malformed champion names)."""
        g_tot = ind_g_lookup.get((ch, role), 0)
        w_tot = ind_w_lookup.get((ch, role), 0)
        g_rem = g_tot - ex_g
        w_rem = w_tot - ex_w
        if g_rem <= 0 or w_rem < 0 or w_rem > g_rem:
            return 0.5, 0
        return w_rem / g_rem, g_rem

    def _baseline_var_pp(wr: float, n: int) -> float:
        """Variance of a binomial WR estimate, scaled to pp². Used by the
        delta-method propagation into se_pp."""
        if n <= 0:
            return 0.0
        return 10000.0 * wr * (1 - wr) / n

    # ── matchups ────────────────────────────────────────────────────────
    # Baseline: log-5 / Bradley-Terry on LOO win rates. Matchup is a
    # head-to-head framing so the log-odds-DIFFERENCE form is the natural
    # baseline. expected_wr propagates baseline uncertainty into se_pp via
    # the delta method (sensitivity of the sigmoid to its input variance).
    for (ra, rb), cells in matchup_counts.items():
        rows = []
        for (ca, cb), (g, w) in cells.items():
            if g < cfg.min_games_cell:
                continue
            obs = w / g
            # Wins from cb's perspective in this cell = (games - ca's wins).
            # Same-role pairs are double-counted (both orderings stored), so
            # for the LOO of cb we subtract the (cb, ca) cell's count which
            # equals (g, g - w). This produces the same arithmetic as
            # subtracting (g, g - w) from cb's totals directly.
            wra, na_rem = _loo_wr(ca, ra, g, w)
            wrb, nb_rem = _loo_wr(cb, rb, g, g - w)
            num = wra * (1 - wrb)
            den = num + wrb * (1 - wra)
            expected = num / den if den > 0 else 0.5
            delta = obs - expected
            # SE: observed binomial variance + propagated baseline variance.
            # Var(logit_E) ≈ 1/(n_A·wa·(1-wa)) + 1/(n_B·wb·(1-wb))
            # Var(E)      ≈ (E·(1-E))² · Var(logit_E)            (delta method)
            var_obs_pp = _baseline_var_pp(obs, g)
            inv_a = 0.0
            inv_b = 0.0
            if na_rem > 0 and 0 < wra < 1:
                inv_a = 1.0 / (na_rem * wra * (1 - wra))
            if nb_rem > 0 and 0 < wrb < 1:
                inv_b = 1.0 / (nb_rem * wrb * (1 - wrb))
            var_logit_e = inv_a + inv_b
            var_e_pp = 10000.0 * (expected * (1 - expected)) ** 2 * var_logit_e
            se_pp = float(np.sqrt(var_obs_pp + var_e_pp))
            rows.append({
                f"champion_{ra}": ca,
                f"opponent_{rb}": cb,
                "games": g, "wins": w,
                "observed_wr": obs,
                "wr_champ": wra, "wr_opp": wrb,
                "expected_wr": expected,
                "delta": delta,
                "se_pp": se_pp,
            })
        if rows:
            out[f"matchup_{ra}_vs_{rb}"] = pd.DataFrame(rows).sort_values(
                "games", ascending=False).reset_index(drop=True)

    # ── synergies ───────────────────────────────────────────────────────
    # Baseline: percentage-point additive on LOO win rates rather than the
    # old logit-additive (a·b / (a·b + (1-a)(1-b))). The logit form
    # over-predicts when both champs are individually strong (two 55%
    # champs predict ~60%), which made the delta systematically negative
    # for popular high-WR pairings. The pp-additive baseline avoids that
    # saturation. Same delta-method variance propagation as matchups.
    for (ra, rb), cells in synergy_counts.items():
        rows = []
        for (ca, cb), (g, w) in cells.items():
            if g < cfg.min_games_cell:
                continue
            obs = w / g
            wra, na_rem = _loo_wr(ca, ra, g, w)
            wrb, nb_rem = _loo_wr(cb, rb, g, w)
            expected = 0.5 + (wra - 0.5) + (wrb - 0.5)
            expected = max(0.05, min(0.95, expected))
            delta = obs - expected
            var_obs_pp = _baseline_var_pp(obs, g)
            # pp-additive: Var(E) = Var(wra) + Var(wrb) (independent samples
            # — LOO sets disjoint in the bulk).
            var_a_pp = _baseline_var_pp(wra, na_rem)
            var_b_pp = _baseline_var_pp(wrb, nb_rem)
            se_pp = float(np.sqrt(var_obs_pp + var_a_pp + var_b_pp))
            rows.append({
                f"champion_{ra}": ca,
                f"champion_{rb}": cb,
                "games": g, "wins": w,
                "observed_wr": obs,
                f"wr_{ra}": wra, f"wr_{rb}": wrb,
                "expected_wr": expected,
                "delta": delta,
                "se_pp": se_pp,
            })
        if rows:
            out[f"synergy_{ra}_{rb}"] = pd.DataFrame(rows).sort_values(
                "games", ascending=False).reset_index(drop=True)

    # ── PR table (parquet, lolalytics-shaped) ───────────────────────────
    pr_rows = [{"champion_name": ch, "lane": lane_l, "games": g}
               for (lane_l, ch), g in pr_counts.items()]
    if pr_rows:
        out["pr_table"] = pd.DataFrame(pr_rows).sort_values(
            ["lane", "games"], ascending=[True, False]).reset_index(drop=True)
    else:
        out["pr_table"] = pd.DataFrame(
            columns=["champion_name", "lane", "games"])

    return out


def aggregate_tier(cfg: RefreshConfig, feather_paths: list[Path]) -> dict[str, pd.DataFrame]:
    """Stream all feathers, accumulate per-cell counts for cfg.tier.

    Returns a dict with keys:
        matchup_{ra}_vs_{rb}      → DataFrame with raw counts
        synergy_{ra}_{rb}         → DataFrame (ra < rb only)
        individual_wr             → DataFrame (champion, role, games, wins)
        pr_table                  → DataFrame (champion_name, lane, games)
    """
    matchup_counts, synergy_counts, ind_counts, pr_counts, ind_full_counts = _new_counters()
    n_matches = n_in_tier = n_dup = 0
    for fp in feather_paths:
        try:
            df = pd.read_feather(fp, columns=["match_id", "winner", "participants_data"])
        except Exception as e:  # pragma: no cover
            print(f"  skip {fp.name}: {e}")
            continue
        m, t, d = _count_feather_rows(
            cfg, df, matchup_counts, synergy_counts, ind_counts, pr_counts,
            ind_full_counts)
        n_matches += m; n_in_tier += t; n_dup += d

    print(f"[aggregate] {n_matches} matches scanned, {n_in_tier} contributed to tier={cfg.tier}"
          + (f", {n_dup} skipped (duplicate role on a team)" if n_dup else ""))

    return _finalize(cfg, matchup_counts, synergy_counts, ind_counts,
                     pr_counts, ind_full_counts)


# ────────────────────────────────────────────────────────────────────────
# Phase-2 incremental support
# ────────────────────────────────────────────────────────────────────────
#
# Per-feather raw counters serialized as long-format DataFrames. These are
# the unit of caching for `incremental.py`: deterministic per (feather, tier),
# so a re-run with the same inputs produces byte-identical partial files.
# The merge step (`merge_partials`) sums them and applies min_games_cell +
# derived columns to produce the same output as `aggregate_tier`.
#
# Schema of the four partial DataFrames:
#   matchup:  role_a, role_b, champion, opponent, games, wins
#   synergy:  role_a, role_b, champion_a, champion_b, games, wins
#   individual: champion, role, games, wins
#   pr:       lane, champion, games

_PARTIAL_KINDS = ("matchup", "synergy", "individual", "pr", "individual_full")


def _counters_to_partial_dfs(
    matchup_counts: dict, synergy_counts: dict,
    ind_counts: dict, pr_counts: dict,
    ind_full_counts: dict,
) -> dict[str, pd.DataFrame]:
    matchup_rows = [
        {"role_a": ra, "role_b": rb, "champion": ca, "opponent": cb,
         "games": g, "wins": w}
        for (ra, rb), cells in matchup_counts.items()
        for (ca, cb), (g, w) in cells.items()
    ]
    synergy_rows = [
        {"role_a": ra, "role_b": rb, "champion_a": ca, "champion_b": cb,
         "games": g, "wins": w}
        for (ra, rb), cells in synergy_counts.items()
        for (ca, cb), (g, w) in cells.items()
    ]
    ind_rows = [
        {"champion": ch, "role": role, "games": g, "wins": w}
        for (ch, role), (g, w) in ind_counts.items()
    ]
    pr_rows = [
        {"lane": lane_l, "champion": ch, "games": g}
        for (lane_l, ch), g in pr_counts.items()
    ]
    ind_full_rows = [
        {"champion": ch, "role": role, "games": g, "wins": w}
        for (ch, role), (g, w) in ind_full_counts.items()
    ]
    return {
        "matchup": pd.DataFrame(matchup_rows,
            columns=["role_a", "role_b", "champion", "opponent", "games", "wins"]),
        "synergy": pd.DataFrame(synergy_rows,
            columns=["role_a", "role_b", "champion_a", "champion_b", "games", "wins"]),
        "individual": pd.DataFrame(ind_rows,
            columns=["champion", "role", "games", "wins"]),
        "pr": pd.DataFrame(pr_rows, columns=["lane", "champion", "games"]),
        "individual_full": pd.DataFrame(ind_full_rows,
            columns=["champion", "role", "games", "wins"]),
    }


def count_one_feather(cfg: RefreshConfig, feather_path: Path) -> dict[str, pd.DataFrame]:
    """Process ONE feather for cfg.tier and return the four long-format
    counter DataFrames (no min_games_cell filter, no derived columns).

    Used by the incremental cache layer: result is stable per
    (feather_content, cfg.tier) so it's safe to memoize on disk.
    """
    df = pd.read_feather(
        feather_path, columns=["match_id", "winner", "participants_data"])
    matchup_counts, synergy_counts, ind_counts, pr_counts, ind_full_counts = _new_counters()
    _count_feather_rows(
        cfg, df, matchup_counts, synergy_counts, ind_counts, pr_counts,
        ind_full_counts)
    return _counters_to_partial_dfs(
        matchup_counts, synergy_counts, ind_counts, pr_counts,
        ind_full_counts)


def merge_partials(
    cfg: RefreshConfig,
    partials: list[dict[str, pd.DataFrame]],
) -> dict[str, pd.DataFrame]:
    """Sum a list of per-feather partial DataFrames and produce the same
    output schema as `aggregate_tier`."""
    if not partials:
        return _finalize(cfg, *_new_counters())

    def _concat(kind: str) -> pd.DataFrame:
        frames = [p[kind] for p in partials if not p[kind].empty]
        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, ignore_index=True, copy=False)

    m = _concat("matchup")
    s = _concat("synergy")
    i = _concat("individual")
    pr = _concat("pr")
    # individual_full may be absent on legacy cached partials. For those
    # entries fall back to their `individual` frame so the LOO baseline
    # still has something sane (matches pre-fix behavior for that partial,
    # while freshly computed partials contribute proper cross-tier counts).
    full_frames = []
    for p in partials:
        f = p.get("individual_full")
        if f is not None and not f.empty:
            full_frames.append(f)
        elif not p["individual"].empty:
            full_frames.append(p["individual"])
    i_full = (pd.concat(full_frames, ignore_index=True, copy=False)
              if full_frames else pd.DataFrame())

    matchup_counts: dict = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    synergy_counts: dict = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    ind_counts: dict = defaultdict(lambda: [0, 0])
    pr_counts: dict = defaultdict(int)
    ind_full_counts: dict = defaultdict(lambda: [0, 0])

    if not m.empty:
        agg = m.groupby(["role_a", "role_b", "champion", "opponent"],
                        as_index=False).agg(games=("games", "sum"),
                                            wins=("wins", "sum"))
        for ra, rb, ca, cb, g, w in agg.itertuples(index=False, name=None):
            matchup_counts[(ra, rb)][(ca, cb)] = [int(g), int(w)]
    if not s.empty:
        agg = s.groupby(["role_a", "role_b", "champion_a", "champion_b"],
                        as_index=False).agg(games=("games", "sum"),
                                            wins=("wins", "sum"))
        for ra, rb, ca, cb, g, w in agg.itertuples(index=False, name=None):
            synergy_counts[(ra, rb)][(ca, cb)] = [int(g), int(w)]
    if not i.empty:
        agg = i.groupby(["champion", "role"], as_index=False).agg(
            games=("games", "sum"), wins=("wins", "sum"))
        for ch, role, g, w in agg.itertuples(index=False, name=None):
            ind_counts[(ch, role)] = [int(g), int(w)]
    if not pr.empty:
        agg = pr.groupby(["lane", "champion"], as_index=False).agg(
            games=("games", "sum"))
        for lane_l, ch, g in agg.itertuples(index=False, name=None):
            pr_counts[(lane_l, ch)] = int(g)
    if not i_full.empty:
        agg = i_full.groupby(["champion", "role"], as_index=False).agg(
            games=("games", "sum"), wins=("wins", "sum"))
        for ch, role, g, w in agg.itertuples(index=False, name=None):
            ind_full_counts[(ch, role)] = [int(g), int(w)]

    return _finalize(cfg, matchup_counts, synergy_counts, ind_counts,
                     pr_counts, ind_full_counts)


def write_partial(out_dir: Path, partial: dict[str, pd.DataFrame]) -> None:
    """Persist a per-feather partial as four parquet files in `out_dir`."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for kind in _PARTIAL_KINDS:
        partial[kind].to_parquet(out_dir / f"{kind}.parquet", index=False)


def read_partial(in_dir: Path) -> dict[str, pd.DataFrame]:
    """Load a per-feather partial previously written by `write_partial`.

    Legacy partials (pre-individual_full) omit that file; we substitute an
    empty DataFrame so merge_partials falls back to ind_counts for the
    LOO baseline. Once the cache is rebuilt the proper counter is used.
    """
    out: dict[str, pd.DataFrame] = {}
    for k in _PARTIAL_KINDS:
        p = in_dir / f"{k}.parquet"
        if p.exists():
            out[k] = pd.read_parquet(p)
        else:
            if k == "individual_full":
                out[k] = pd.DataFrame(
                    columns=["champion", "role", "games", "wins"])
            else:
                raise FileNotFoundError(p)
    return out


def write_aggregates(out_dir: Path, dfs: dict[str, pd.DataFrame]) -> None:
    """Write the dict from aggregate_tier() to disk in the schema the
    runtime loader expects (CSVs for matchups/synergies/ind_wr, parquet
    for the PR table)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, df in dfs.items():
        if name == "pr_table":
            df.to_parquet(out_dir / f"{name}.parquet", index=False)
        else:
            df.to_csv(out_dir / f"{name}.csv", index=False)
