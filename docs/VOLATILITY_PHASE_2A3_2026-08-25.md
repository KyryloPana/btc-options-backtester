# Phase 2A.3 — Causal cross-sectional IV dataset and surface-readiness audit

**Date:** 2026-08-25
**Starting branch / HEAD:** `volatility-phase-2a1` @ `41d06ee`, clean
**Commits:** `bafca8e` (typecheck fix) → `910d148` (feature)
**Nothing pushed. No SVI or SSVI fitted. No fair value, valuation path, outcome or methodology changed.**

---

## The answer, up front

**At entry, yes. Along the path, only for the first two-thirds of the trade's life — and the final day is unrecoverable by any surface method.**

| | entry | full valuation path |
|---|---|---|
| same-expiry usable (dense + sparse) | **96.4%** | **76.4%** |
| `same_expiry_dense` | 89.3% | 60.0% |
| `extrapolation_required` | 3.6% | **23.2%** |
| `surface_unidentifiable` | 0% | 0% |

Strong entry coverage does **not** mean the historical PnL path can be reconstructed. Coverage decays monotonically with time since entry — 96.4% → 90.7% → 82.6% → 70.3% → 61.1% — and collapses as expiry approaches:

| remaining DTE | rows | usable | extrapolation |
|---|---|---|---|
| 30d+ | 41 | 100.0% | 0% |
| 14–30d | 436 | 89.9% | 10.1% |
| 7–14d | 717 | 84.5% | 15.3% |
| 3–7d | 642 | 77.6% | 22.4% |
| 1–3d | 336 | 59.5% | 40.5% |
| **0–1d** | **168** | **29.8%** | **64.9%** |

And the reason is not what you would guess.

---

## 1. What was built

### `historical_option_iv_observations` — `app/lib/volatility/cross-section.ts`

A standalone, versioned, locally cached dataset of causal option-IV observations, kept entirely outside the research bundle and outside `event_volatility_state` / `structure_volatility_state`.

| identifier | value |
|---|---|
| dataset id | `deribit-btc-historical-option-iv-v1` |
| observation method | `cross-sectional-iv-observations-v1` |
| readiness method | `surface-readiness-v1` |
| holdout method | `iv-holdout-cases-v1` |
| forward convention | `forward_equals_index_rate_zero` |

Admission reuses `admitMarketIvTrade` unchanged, so every Phase 2A.1 rule still holds: no `constant-entry-IV`, no model reconstruction, no IV inverted from a model price, no `intrinsic-at-expiry`, no future observation, no contract used before its `creation_timestamp`. Nothing in this task loosened any of that.

Each observation carries full trade identity, contract identity, market data (including the mark price riding on the trade), target-relative evidence, and surface coordinates: log-moneyness, actual DTE, time to expiry in years, and **total implied variance `w = IV² × T`** — the quantity SVI and SSVI are actually parameterised in. Units are explicit (`decimal`, `decimal_squared_years`).

**Forward convention.** Research pricing currently uses forward = index and rate = 0 when a forward is unavailable. That assumption is preserved verbatim and stated on every row. No new interest-rate or forward convention was introduced; when a real forward curve arrives it must arrive as a new method version.

**A defect the tests caught.** `passes_market_state_rule` was initially measured against whatever retrieval window the caller asked for, so pulling a 240-minute diagnostic window would have marked a 120-minute-old print as passing the canonical rule. It now always measures against the canonical 60 minutes; `max_age_minutes` records the retrieval window separately. No measurement in this report was affected — the diagnostic window is used only in §4 — but that is the exact contamination the two-window design exists to prevent.

### Cache — `scripts/cross-section-cache.ts`

```
.local-cache/historical-option-iv/deribit-btc-historical-option-iv-v1/
    <YYYY-MM>.snapshots.jsonl      identity + geometry
    <YYYY-MM>.observations.jsonl   the evidence
    manifest.json                  coverage, counts, content hash
```

Snapshots and observations are stored **separately**: a change to derived diagnostics never rewrites the evidence file, and the snapshot content hash covers observations only, so it answers exactly one question — *is this the same evidence?* Snapshot identity is `(target_timestamp, content_hash)`, so regenerating an unchanged target replaces its row rather than duplicating it. Monthly shards mean expanding the event sample reuses history. The cache is gitignored; **no part of this dataset enters a research bundle and no schema was bumped.**

One retrieval detail worth stating: Deribit caps `get_last_trades_by_currency_and_time` at 1000 trades. When the cap is hit the window is split in half and both halves fetched, so a busy hour is never silently truncated to its most recent 1000 prints — which would have biased every count toward the freshest end.

### Readiness classes — the exact deterministic rules

Evidence geometry only. **No threshold here was derived from strategy PnL**, and every underlying count is reported alongside the class so a later phase can re-derive thresholds from fit quality rather than from these placeholders.

Per-leg classification, in order:

| class | rule |
|---|---|
| `exact_observed` | a qualifying print on this exact contract (same instrument, same option type) in the canonical window |
| `interpolation_candidate` | ≥1 observed strike below **and** ≥1 above the leg |
| `extrapolation_required` | observed strikes exist but all lie on one side |
| `unidentifiable` | no observed strike geometry at all |

Both-sided bracketing is required deliberately: one neighbouring strike does not identify a smile, and calling that "interpolation" would launder an extrapolation.

Snapshot classification, in order — **the order is the definition**:

1. no same-expiry strikes and no usable adjacent maturity → `surface_unidentifiable`
2. a leg with no strike geometry and no adjacent support → `surface_unidentifiable`
3. **any leg `extrapolation_required` → `extrapolation_required`**
4. ≥5 same-expiry strikes **and** ≥2 observed strikes on each side of every leg → `same_expiry_dense`
5. ≥2 same-expiry strikes → `same_expiry_sparse`
6. ≥1 adjacent maturity with ≥4 strikes and ATM bracketed → `cross_expiry_supported`
7. otherwise → `surface_unidentifiable`

Extrapolation outranks density on purpose. A slice with twenty strikes that all sit below the short leg still cannot value that leg, and reporting it as dense would hide precisely the case this audit exists to count.

`DENSE_MINIMUM_STRIKES = 5` and `DENSE_MINIMUM_PER_SIDE = 2` are **conservative provisional placeholders, not optimal values.** Five is the smallest count at which a three-parameter smile through the relevant region is not trivially saturated; two-per-side demands genuine two-sided support rather than one lucky neighbour.

---

## 2. Short-vs-long asymmetry — diagnosed, and it is not a bug

Phase 2A.2 found long-leg IV usable far more often than short-leg IV (13/28 vs 3/28), which is counterintuitive because short strikes sit nearer the money. Reproduced exactly, then diagnosed rather than explained away.

**Ruled out as causes.** Exact-leg matching is correct on instrument name, option type, expiry, strike, target timestamp, creation gate and the 60-minute window. All 10 short and all 28 long instruments resolve in the 120,713-instrument manifest; none was created after entry. Both legs run through the *same* `legState` / `classifyLeg` code with no branch difference — there is no separate code path that could have favoured the long side. No duplicate or direction filter differs; deduplication removed **0** rows across all 669 snapshots.

**What it actually is — three things:**

**(a) Denominator inflation.** The 28 structures use only **10 distinct short instruments** against **28 distinct long instruments** — nine shorts are each shared by three width-family structures (same short strike, three long strikes). So "3/28 vs 13/28" compares 10 independent draws with 28. At instrument level it is 1/10 vs 13/28.

**(b) Window length versus arrival burstiness — the dominant effect.**

| window | short | long | McNemar (28 matched pairs) |
|---|---|---|---|
| 60 min | 1/10 instruments | 13/28 instruments | **p = 0.0063** |
| 240 min | 8/10 instruments | 25/28 instruments | **p = 0.375** |

At 60 minutes the difference is statistically real in this sample. At 240 minutes it is indistinguishable from chance, and per-contract volumes are comparable — 5.2 vs 7.0 mean prints. Option prints arrive in bursts, so presence in any 60-minute window is close to a coin flip per contract; with only 10 independent short draws, 1/10 is unlikely but unremarkable.

**(c) One nearly-dead expiry.** 24OCT25 contributes three short-instrument zeros; its long legs are equally dead (0, 0, 1 prints).

**It is real tape behaviour, and the methodology is unchanged.** But the decisive point for this task:

> **No short leg requires extrapolation anywhere at entry.** All 28 are `interpolation_candidate` (25) or `exact_observed` (3). The single entry extrapolation in the whole sample is a *long* leg — the deep-OTM 52000-P.

Short-leg tape scarcity does not threaten surface reconstruction, because the short strikes sit inside a dense observed cross-section. Skew conclusions remain blocked on a larger sample, not on a defect.

---

## 3. Entry surface readiness — all 28 structures

| event | ty | short K | long K | DTE | strikes | trades | ATM | short leg | long leg | adj | mat | readiness |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 17339625 | C | 127000 | 128000 | 9.00 | 9 | 25 | Y | interp | interp | 8 | Y | dense |
| 17339625 | C | 127000 | 129000 | 9.00 | 9 | 25 | Y | interp | **exact** | 8 | Y | dense |
| 17339625 | C | 127000 | 130000 | 9.00 | 9 | 25 | Y | interp | **exact** | 8 | Y | dense |
| 17339625 | C | 127000 | 128000 | 16.00 | 6 | 9 | Y | interp | interp | 8 | Y | dense |
| 17339625 | C | 127000 | 129000 | 16.00 | 6 | 9 | Y | interp | interp | 8 | Y | dense |
| 17339625 | C | 127000 | 130000 | 16.00 | 6 | 9 | Y | interp | **exact** | 8 | Y | dense |
| 2a93d290 | C | 113000 | 114000 | 5.92 | 16 | 33 | Y | **exact** | **exact** | 7 | Y | dense |
| 2a93d290 | C | 113000 | 115000 | 5.92 | 16 | 33 | Y | **exact** | **exact** | 7 | Y | dense |
| 2a93d290 | C | 113000 | 116000 | 5.92 | 16 | 33 | Y | **exact** | interp | 7 | Y | dense |
| 2a93d290 | C | 112000 | 113000 | 12.92 | 16 | 90 | Y | interp | **exact** | 7 | Y | dense |
| 2a93d290 | C | 112000 | 114000 | 12.92 | 16 | 90 | Y | interp | **exact** | 7 | Y | dense |
| 2a93d290 | C | 112000 | 115000 | 12.92 | 16 | 90 | Y | interp | interp | 7 | Y | dense |
| 5bebaf8f | P | 89000 | 86000 | 17.33 | 21 | 66 | Y | interp | interp | 8 | Y | dense |
| 5bebaf8f | P | 89000 | 87000 | 17.33 | 21 | 66 | Y | interp | **exact** | 8 | Y | dense |
| 5bebaf8f | P | 89000 | 88000 | 17.33 | 21 | 66 | Y | interp | interp | 8 | Y | dense |
| 653f11df | C | 111000 | 112000 | 8.75 | 30 | 103 | Y | interp | **exact** | 6 | Y | dense |
| 653f11df | C | 111000 | 113000 | 8.75 | 30 | 103 | Y | interp | interp | 6 | Y | dense |
| 653f11df | C | 111000 | 114000 | 8.75 | 30 | 103 | Y | interp | interp | 6 | Y | dense |
| 653f11df | C | 110000 | 114000 | 36.75 | 17 | 31 | Y | interp | interp | 6 | Y | dense |
| d099f278 | P | 56000 | 52000 | 5.92 | 18 | 122 | Y | interp | **extrap** | 7 | Y | **extrapolation** |
| d099f278 | P | 56000 | 54000 | 5.92 | 18 | 122 | Y | interp | **exact** | 7 | Y | *sparse* |
| d099f278 | P | 56000 | 55000 | 5.92 | 18 | 122 | Y | interp | interp | 7 | Y | *sparse* |
| d099f278 | P | 56000 | 53000 | 12.92 | 16 | 30 | Y | interp | **exact** | 7 | Y | dense |
| d099f278 | P | 56000 | 54000 | 12.92 | 16 | 30 | Y | interp | **exact** | 7 | Y | dense |
| d099f278 | P | 56000 | 55000 | 12.92 | 16 | 30 | Y | interp | interp | 7 | Y | dense |
| d099f278 | P | 56000 | 53000 | 26.92 | 12 | 25 | Y | interp | interp | 7 | Y | dense |
| d099f278 | P | 56000 | 54000 | 26.92 | 12 | 25 | Y | interp | interp | 7 | Y | dense |
| d099f278 | P | 56000 | 55000 | 26.92 | 12 | 25 | Y | interp | **exact** | 7 | Y | dense |

The three non-dense rows are all the 5.92-DTE `d099f278` put wing: 18 strikes but only **one** observed strike below 56000, so the downside geometry is one-sided even though the slice is busy.

### Aggregate entry coverage (n = 28)

| | | |
|---|---|---|
| exact short-leg IV observed | 3/28 | 10.7% |
| exact long-leg IV observed | 13/28 | 46.4% |
| both legs exact | 2/28 | 7.1% |
| neither leg exact | 14/28 | 50.0% |
| both strikes inside observed range | 27/28 | 96.4% |
| at least one leg needs interpolation | 26/28 | 92.9% |
| both legs need interpolation | 13/28 | 46.4% |
| requires same-expiry extrapolation | 1/28 | 3.6% |
| cross-expiry information available | 28/28 | 100% |
| maturity-bracketed (SSVI-usable) | 28/28 | 100% |
| **surface unidentifiable** | **0/28** | **0%** |

**Reconciliation with Phase 2A.2: exact.** 3 short + 13 long = the same 16 of 56 legs Phase 2A.2 reported. The richer retrieval found no additional exact-leg evidence, which is the right outcome — the canonical window and admission gate are identical, so a difference would have been a defect somewhere.

**The headline of this section:** exact-contract tape covers only **29%** of legs, but the cross-section that could reconstruct those legs is dense at **89%** of structures and unidentifiable at **none**. That is the gap surface reconstruction exists to close, and at entry it is closeable.

### Distributions

**Same-expiry strike count (entry):** min 6, p25 12, **median 16**, p75 18, max 30.

**Observation age (entry, same-expiry slices), minutes:**

| | min | median | max |
|---|---|---|---|
| freshest | 0.0 | 1.5 | 2.0 |
| median | 19.5 | 32.7 | 41.6 |
| P95 | 41.3 | 57.4 | 60.0 |

Every slice has a print within two minutes of entry. The 60-minute rule is not the binding constraint anywhere.

**Interpolation-candidate rate:** 92.9% of structures have ≥1 leg needing interpolation; 46.4% need it on both.
**Extrapolation-required rate:** 3.6%.
**Surface-unidentifiable rate:** 0%.
**Adjacent-expiry / SSVI support rate:** 100% (median 7–8 usable adjacent maturities).

---

## 4. Valuation-path surface readiness

Every canonical valuation point was measured — this is a complete cohort, not a sample. 669 target timestamps: 28 entry, 2,293 scheduled 4-hour points, 13 VPOC decision points, 6 exit points, spanning entry to each structure's own expiry. One snapshot per (event, timestamp) reused across every structure and expiry, so 669 snapshots cost 970 API requests rather than one per structure.

**2,340 structure-timestamp rows. 390,305 admitted observations. 0 duplicates. 0 targets without a causal underlying.**

| readiness | rows | share |
|---|---|---|
| `same_expiry_dense` | 1,403 | 60.0% |
| `same_expiry_sparse` | 384 | 16.4% |
| `extrapolation_required` | 543 | 23.2% |
| `cross_expiry_supported` | 10 | 0.4% |
| `surface_unidentifiable` | 0 | **0%** |

### Entry versus path — the comparison that matters

| | entry | path |
|---|---|---|
| same-expiry usable | 27/28 — **96.4%** | 1,787/2,340 — **76.4%** |
| dense | 89.3% | 60.0% |
| extrapolation required | 3.6% | 23.2% |
| any exact leg observed | 50.0% | 55.1% |

**Do not read entry coverage as path coverage.** A 96.4% entry figure sits alongside a 23.2% path extrapolation rate, and the gap is concentrated exactly where the economics are decided.

**By hours since entry:**

| | rows | usable | extrapolation |
|---|---|---|---|
| entry | 28 | 96.4% | 3.6% |
| <24h | 140 | 90.7% | 9.3% |
| 1–3d | 345 | 90.7% | 9.3% |
| 3–7d | 639 | 82.6% | 17.4% |
| 7–14d | 715 | 70.3% | 29.2% |
| 14d+ | 473 | 61.1% | 37.4% |

**By event:**

| event | rows | dense | sparse | cross-expiry | extrapolation |
|---|---|---|---|---|---|
| 17339625 | 465 | 223 | 85 | 6 | 151 |
| 2a93d290 | 342 | 256 | 49 | 0 | 37 |
| 5bebaf8f | 321 | 275 | 17 | 3 | 26 |
| 653f11df | 381 | 305 | 41 | 1 | 34 |
| d099f278 | 831 | 344 | 192 | 0 | 295 |

### Why coverage decays — not the reason you would guess

The tape does **not** thin out near expiry. Median same-expiry strike count by remaining DTE: 16.5 at 0–1d, 20 at 1–3d, 18 at 3–7d, 18 at 7–14d, 15 at 14–30d. It is essentially flat.

What changes is that **the strikes drift out of the traded region.** Mean |log-moneyness| of the short leg:

| hours since entry | 0h | <24h | 1–3d | 3–7d | 7–14d | 14d+ |
|---|---|---|---|---|---|---|
| mean \|ln(K/S)\| | 0.072 | 0.074 | 0.083 | 0.097 | 0.121 | **0.174** |

The structures were selected near the money. The underlying then moves, and the fixed strikes end up far from where trading concentrates. On extrapolation rows the median same-expiry strike count is still **14** — there is plenty of data, just not *at the leg*. Median distance from the nearest observed strike when extrapolating is **$4,000** (P90 $10,000, max $23,000).

Of the 543 extrapolation rows, 367 have **both** legs outside the observed range and 176 the long leg only. Never the short leg alone — consistent with the short sitting nearer the money throughout. Direction splits both ways: 525 legs below the observed minimum, 385 above the maximum.

### The finding that settles the recommendation

**At <1 DTE, maturity bracketing is 0%.**

| remaining DTE | maturity-bracketed | median adjacent usable expiries |
|---|---|---|
| 30d+ | 95.1% | 7 |
| 14–30d | 97.2% | 7 |
| 7–14d | 100% | 8 |
| 3–7d | 100% | 8 |
| 1–3d | 97.3% | 7 |
| **0–1d** | **0%** | 9 |

By definition there is no listed expiry *shorter* than the one about to expire, so a term-structure model has nothing on the near side to interpolate from — it can only extrapolate in maturity, into the steepest part of the surface. Of the 109 extrapolation rows at <1 DTE, **none** is maturity-bracketed.

So on the final day, same-expiry evidence cannot reach the strikes and cross-expiry evidence cannot substitute. **Neither SVI nor SSVI rescues the last day.** That is a structural property of the listed-expiry cycle, not a data-collection shortfall, and no amount of extra retrieval changes it.

---

## 5. Holdout dataset

Built before any model exists, so no cohort can be chosen after seeing a result. Cases are persisted by reference to their snapshot — the evidence already lives in the shard cache — and `assertHoldoutIsClean` re-verifies the exclusion on every case rather than trusting the filter that built it.

**Single-contract holdouts: 3,475**, across 121 snapshots and 5 events, built at entry, every named decision point, and every 6th scheduled 4-hour point.

| dimension | composition |
|---|---|
| option type (truths) | 8,594 calls / 7,377 puts |
| DTE | 0–3d 580 · 3–7d 918 · 7–14d 1,113 · 14–30d 736 · 30d+ 128 |
| moneyness | ATM 4,403 · near 3,535 · mid 4,522 · far 3,511 |
| remaining readiness | dense 2,789 · sparse 343 · extrapolation 342 · cross-expiry 1 |

Each case supports removal of the exact target contract; the spread builder additionally supports short-leg, long-leg and both-leg removal. Withheld instruments are removed from **every** maturity, not just their own, so a model cannot recover the answer through the term structure. Truth carries true IV, true trade price, mark price where present, strike, underlying, expiry and the surrounding geometry after holdout.

**Vertical-spread holdouts: 224**, covering all 28 candidates.

| paired truth class | count |
|---|---|
| both legs observed — `synchronous` (≤5 min) | 19 |
| both legs observed — `asynchronous_within_window` | 66 |
| `single_leg_only` | 139 |

**85 cases carry a genuine observed spread credit** from two real prints. No observed fill is invented: a one-sided pair reports `null` credit and is classified `single_leg_only`. Synchronization gaps run 0.0 / **13.4** / 58.3 minutes (min/median/max); only 19 of 85 are within five minutes, which is itself worth knowing — leg prints in this market are rarely simultaneous, so spread-credit truth mostly carries a real timing gap that any scoring must account for.

The next phase can therefore compare current local-IV reconstruction, a simple interpolation baseline, SVI, and SSVI on leg IV error, leg price error **and** spread-credit error, without altering the validation set after seeing results.

---

## 6. Validation

| check | result |
|---|---|
| `npm run typecheck` | clean |
| `npm run typecheck:scripts` | clean (**new**) |
| `npm run lint` | clean (1 pre-existing warning in `research-selections.ts`) |
| `npm run build` | clean, Sites artifact validated |
| `npm run test:unit` | **786 / 786 pass** (was 736; +50 new) |
| `git status` | clean at both commits |

New suites: `tests/volatility-cross-section.unit.test.ts` (36), `tests/volatility-holdout.unit.test.ts` (14). No existing assertion was weakened.

**Mutation-tested** — each of these fails tests when applied:

| mutation | tests failed |
|---|---|
| canonical staleness measured against the retrieval window | 1 |
| deduplication disabled | 1 |
| interpolation accepts one-sided support | 3 |
| density outranks extrapolation | 2 |
| holdout withholds only within its own expiry | 1 |
| spread credit synthesized from one leg | 1 |

**A validation gap found and fixed (`bafca8e`).** `tsconfig.json` excludes `scripts/` and `tests/` entirely, so `npm run typecheck` has never checked either — which is how a measurement script with an undefined variable passed every gate and failed only at runtime after a fifteen-minute retrieval run. Added `tsconfig.scripts.json` and `typecheck:scripts` scoped to the volatility research layer; it immediately surfaced two real latent defects in my earlier Phase 2A scripts (an `any[]` inference, and cache-root parameters typed from an `as const` literal so no caller could legitimately pass a different root — which the tests do at runtime). Widening the check repo-wide currently surfaces **128 pre-existing errors** across older tests and scripts; that is a separate job and was not attempted.

**Input provenance.** The supplied bundle JSONL files had been cleared from `%TEMP%` before this task began. The 6-event / 28-structure sample was reconstructed from the Phase 2A.2 measurement output, which carries full structural identity including instrument names, plus the event timing read from the supplied `events.jsonl` earlier in this session. It is committed as `research-input/` so the measurement is reproducible. Nothing was invented, re-ranked or reselected.

---

## 7. Scope

Not implemented, as instructed: no SVI, no SSVI, no smile fitting, no Greeks, no volatility forecasting, no strategy rules, no new valuation source. `reference_valuation`, valuation paths, outcomes, maker/taker, delayed execution, modeled conservative execution, option selection, contract resolution, margin and futures are all untouched. The 60-minute canonical market-state rule and the pricing model's independent 720-minute fallback both stand. No bundle schema bump; the cross-sectional dataset is deliberately outside the bundle. Canonical terminology preserved: *maximum structural loss*.

**The current local-IV fair-value methodology remains authoritative.** Nothing here promotes a replacement.

---

## Recommendation

**A combination by cohort — and one cohort that surface reconstruction cannot fix.**

**1. SVI on the exact expiry is justified as the primary candidate for entry and early life.**
At entry: 89.3% dense, 96.4% usable, 0% unidentifiable, 96.4% of structures with both strikes inside the observed range, median 16 same-expiry strikes with a print within two minutes. For the cohort "first 3 days after entry **and** ≥7 days to expiry" (n = 382): **93.5% usable, 77.0% dense.** This is the cohort where reconstruction would repair the 71% of legs that have no exact-contract print, and the evidence supports fitting a same-expiry smile there.

**2. Through mid-life, SVI remains primary but with a growing cohort it cannot serve.**
Extrapolation rises from 3.6% at entry to 17.4% by day 3–7 and 29.2% by day 7–14. Those rows are not sparse — median 14 strikes — they are rows where the leg has left the traded ladder by a median of $4,000. A smile fitted to the observed strikes will be *extrapolating into the wing* for them, which is where SVI is least reliable and where a fit unconstrained by no-arbitrage conditions can produce nonsense.

**3. SSVI is NOT justified by same-expiry sparsity — that case barely exists.**
Only 0.4% of path rows are `cross_expiry_supported`, and 0% are unidentifiable. There is essentially never a moment when the same expiry is too thin and a neighbouring maturity must fill in. SSVI's real potential value here is different: arbitrage-consistent **wing** behaviour and calendar consistency for the 23.2% extrapolation cohort. That is a legitimate reason to evaluate it, but it must be justified on holdout wing error, not on sparsity — and it is not a prerequisite for phase 1.

**4. Surface reconstruction cannot cover the final day, and no method will change that.**
At 0–1 DTE: 29.8% usable, 64.9% extrapolation, and **0% maturity-bracketed**. Same-expiry evidence cannot reach the strikes; cross-expiry evidence does not exist on the near side because nothing expires sooner. This is a structural property of the listed-expiry cycle. The honest consequence: **the final-day segment of the historical PnL path is not reconstructible from the option cross-section**, and any future surface valuation must mark it unavailable rather than extrapolate into it — which is exactly the discipline the rest of this architecture already applies.

**Concretely, for Phase 2B:** fit and validate SVI on the same-expiry dense cohort first, scored on the 3,475 single-contract holdouts and the 85 both-legs-observed spread holdouts, measuring leg IV error, leg price error and spread-credit error separately since correlated leg errors may cancel or amplify. Treat the extrapolation cohort as an explicit second question and let SSVI compete there on wing error. Do not attempt the final day; make it an honest `unavailable`.

**Do not promote any reconstruction into fair value until it wins that holdout comparison.**
