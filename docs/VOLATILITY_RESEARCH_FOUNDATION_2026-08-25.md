# Volatility Research Foundation — source capability and locked methodology

**Date:** 2026-08-25
**Status:** methodology only. No implementation, no schema change, no new tables.
**Branch/HEAD at inspection:** `main` @ `22df485aa40830f34d7d21dfc456d7c778bc690e`, working tree clean.
**Schema:** research bundle `3.6.0`, selection `1.8.0` (unchanged by this document).
**Gate at inspection:** 56 suites, typecheck clean.

All capability claims below were established by **live read-only probes against Deribit** on 2026-08-25, not from memory. Probe outputs are quoted inline.

---

## 0. The non-negotiable distinction

| | **A. Pricing IV** | **B. Market volatility evidence** |
|---|---|---|
| Question | what IV should the valuation model use here | what was the market's IV at this timestamp |
| Legitimate states | `local-observed-IV`, `constant-entry-IV`, `intrinsic-at-expiry`, `unavailable` | `observed`, `interpolated`, `unavailable` |
| May be reconstructed | yes — that is its job | **never** |
| Feeds | option marks, PnL path | percentile, ΔIV, term structure, IV-vs-RV |

`constant-entry-IV` is a **pricing carry-forward**. It is evidence that the model had nothing newer, not evidence that market IV was unchanged. It must never cross into B. Section 9 makes this enforceable.

---

## 1. Existing IV infrastructure (reusable, do not duplicate)

### `app/lib/research-valuation.ts`
| Symbol | Line | What it is |
|---|---|---|
| `MODEL_IV_ANCHOR_MAX_AGE_MINUTES` | 12 | `720`. Pricing anchor age cap. |
| `ModelIvSource` | 19 | `"local-observed-IV" \| "constant-entry-IV" \| "intrinsic-at-expiry" \| "unavailable"` |
| `causalAnchors` | 67 | filters `timestamp <= target`, age ≤ 720 min, `ivDecimal > 0`, `indexPrice > 0`; sorts newest-first with deterministic `tradeId` tiebreak |
| `selectIvAnchor` | 69 | newest qualifying causal anchor |
| `selectSynchronizedIvAnchors` | 71 | short/long anchor pair within `maxGapMs` (default **60 min**) |
| `modelLeg` | 75 | prices a leg from an anchor's `ivDecimal`; emits full `model` provenance block |
| `modelMark` | 130 | path marks; **when no fresh pair exists it reuses the entry anchors → this is the `constant-entry-IV` path** |
| `buildResearchExport` | 155 | states `missingPointPolicy: "constant-entry-IV after entry; …"` |

The causal discipline is already correct and reusable: strictly `<= target`, explicit age, deterministic ordering, per-leg provenance.

### `app/lib/research-tracks.ts` — `legVolatility` (line 343)
Already emits exactly the shape Phase 2A needs:

```
ivDecimal, ivApiPercent, ivUnits, ivSource, ivSourceTimestampMs,
observation: "observed" | "reconstructed" | "unavailable",
anchorIndex, targetIndex, dteDays
```

and classifies `observed` **only** where `ivSource === "local-observed-IV"` or the leg was `direct-vwap`. A `constant-entry-IV` point therefore already falls to `reconstructed`. **This classifier is the seed of the market-evidence hierarchy and should be reused, not rewritten.**

### `app/lib/research-bundle.ts`
- Exports `short_leg_volatility` / `long_leg_volatility` on valuation rows (lines 298–301).
- Validator (line 560): an `iv_decimal` without `iv_units` **and** `observation` is a hard error. The units/observation discipline is already enforced.

### `scripts/deribit-history-api.ts`
- `DeribitHistoryService.fetchDvolRange` (line 130) already calls `get_volatility_index_data`. **It is defined and never called anywhere else in the repository.** DVOL retrieval is written but unwired.
- `syncManifest` (line 105) pulls `get_instruments` for `expired: true` **and** `false`, and already persists `creation_timestamp`, `settlement_period`-adjacent metadata, `strike`, `option_type`, `price_index`, tick/amount metadata to `.local-cache/deribit-instruments.json`.
- `vite.config.ts:130` defaults the base URL to `https://history.deribit.com/api/v2/public`. **This matters enormously — see §3.**

### Tests already covering IV
`inverse-option-pricing` (7 refs), `end-to-end-research-audit` (6), `analytics-integration-audit` (5), `causal-valuation` (3), `research-valuation` (3), `final-integration-audit` (3), plus 6 more suites.

---

## 2. Probe method

Read-only GETs against `https://www.deribit.com/api/v2/public` and `https://history.deribit.com/api/v2/public`. No credentials, no writes.

---

## 3. A. Exact-contract historical IV — **available and good**

**The two hosts are not interchangeable.** This is the single most important retrieval fact found:

| Call | `www.deribit.com` | `history.deribit.com` |
|---|---|---|
| `get_instruments(currency=BTC, kind=option, expired=true)` | **58 contracts, 1 expiry** (2026-08-25 only) | **120,578 contracts, 2,570 expiries, back to 2016-07-15** |
| `get_last_trades_by_instrument_and_time` on `BTC-21JUN25-105000-C` | **0 trades** | **10+ trades, `has_more=true`** |
| `get_volatility_index_data` | works | **HTTP 400** |

So: **options history → history mirror; DVOL → www.** The repository already defaults the option path to the history mirror, and already documents the mirrored precedent for funding ("Deribit's history mirror does not serve funding, so funding is read from the main public host"). DVOL is the same pattern and should reuse it.

**Per-trade fields returned** (history mirror):
`timestamp` (ms), `iv`, `price`, `mark_price`, `index_price`, `instrument_name`, `direction`, `amount`, `contracts`, `trade_id`, `trade_seq`, `tick_direction`.

- **IV is supplied by the exchange**, in percent. It does not need reconstruction. (`ivApiPercent` → `ivDecimal` normalization already exists.)
- `index_price` rides along on every trade — a causal underlying observation at the same instant.
- `mark_price` rides along too, but only at trade instants. **There is no historical mark-price or order-book series endpoint.** Evidence is **trade-only and event-driven**.
- Timestamp precision: milliseconds.
- `creation_timestamp` is present on **120,578 / 120,578** manifest rows.

### The listing-date trap
A first probe of the 2025-06-21 expiry at target 2025-06-16 returned **zero** trades. That was not sparsity and not a rate limit — `BTC-21JUN25-105000-C` has `settlement_period: "day"` and `creation_timestamp` of **2025-06-18**. The contract did not exist at the target time.

**Rule:** a contract is inadmissible as evidence before its `creation_timestamp`. `settlement_period ∈ {day, week, month}` must also be recorded — dailies are listed only ~3 days out and can never serve a 7D+ reference.

---

## 4. B. Same-expiry ATM / reference IV — **achievable within 60 minutes**

Sweep: 6 target timestamps spanning 2024-06 → 2026-02, different weekdays and hours. For each, the **nearest-to-7D listed expiry** (gated on `creation_timestamp`), 8 nearest strikes, calls and puts, IV-bearing trades only. `perp` = BTC-PERPETUAL close at T.

| Target (UTC) | actual DTE | listed K | window | IV trades | strikes | brackets spot | nearest strike | freshest |
|---|---|---|---|---|---|---|---|---|
| 2024-06-12 14:00 | 8.8 | 30 | 1h | 96 | 8 | ✔ | 0.00% | 5 min |
| 2024-11-07 09:00 | 8.0 | 34 | 1h | 20 | 5 | ✔ | 0.00% | 4 min |
| 2025-02-19 03:00 | 9.2 | 46 | 1h | 12 | 4 | ✔ | 0.35% | 7 min |
| 2025-07-16 00:00 | 9.3 | 54 | 1h | 32 | 7 | ✔ | 0.15% | 2 min |
| 2025-10-22 18:00 | 8.6 | 53 | 1h | 31 | 7 | ✔ | 0.02% | 2 min |
| 2026-02-11 11:00 | 8.9 | 41 | 1h | 46 | 8 | ✔ | 0.02% | 2 min |

Widening to 4h raised trade counts to 30–305 without materially improving strike coverage (6–8).

**Findings**

1. **6/6 targets bracketed spot inside a 60-minute causal window.** Interpolation inputs are usually present.
2. The nearest traded strike was **0.00%–0.35%** from the perpetual — i.e. the **ATM strike itself normally trades**.
3. Freshest observation was **2–7 minutes** old. The tape near ATM is dense, not sparse.
4. A deeper single-window check (2025-06-16, 4.3 DTE weekly) found 15 IV trades across 6 strikes in 1h, 984 across 16 strikes in 24h.

**"Exact ATM" must be defined as a trade on the ATM *strike*** — the listed strike nearest the causal underlying — not a trade at exactly spot, which never happens. Under that definition it is usually observable.

**Honest limits of this evidence:** 6 samples, ~7D family only, 8 nearest strikes only, and the timestamps are arbitrary rather than MR-event-aligned. This is a strong indication, **not a measured coverage rate**. Coverage must be measured over the real event set during Phase 2A and reported, not assumed.

---

## 5. C. Broad BTC IV reference (DVOL) — **available, www-only, from 2021-03-24**

`get_volatility_index_data(currency=BTC)`:

| Probe | Result |
|---|---|
| Host | **www only**; history mirror returns HTTP 400 |
| 2021-01, 2021-02 | 0 rows |
| **2021-03** | **6 daily rows, first = 2021-03-24** |
| 2021-04 onward | continuous |
| `resolution=60` | 0 rows (unsupported) |
| `resolution=3600` | 169 rows / 7 days — complete hourly |
| `resolution=43200`, `86400` | supported |
| Shape | OHLC candles `[timestamp, open, high, low, close]` |

Treat as an **optional reference series**. It is a whole-surface index, not a same-expiry reference, so it can support regime context and percentile cross-checks but must **never** be the sole market-IV source or substitute for a same-expiry observation. The architecture must work with DVOL absent.

---

## 6. D. Term structure — **feasible, but nominal tenors do not exist**

Listed expiry ladder (gated on `creation_timestamp`), actual DTE:

| Target | Ladder (actual DTE / listed strikes / period) |
|---|---|
| 2024-03-15 (Fri) | 0.3w 1.3d 2.3d **7.3w** **14.3m** 21.3w 42.3m 77.3m 105.3m 196.3m 287.3m |
| 2025-01-15 (Wed) | 0.3d 1.3d 2.3w **9.3w** **16.3m** 44.3m 72.3m 163.3m 254.3m 345.3m |
| 2025-06-16 (Mon) | 0.3d 1.3d 2.3d **4.3w** **11.3m** 18.3w 39.3m 74.3m 102.3m 193.3m 284.3m |
| 2026-03-16 (Mon) | 0.3d 1.3d 2.3d 3.3d **4.3w** **11.3m** 18.3w 39.3m 74.3m 102.3m |

10–11 expiries listed at any time. Nearest-to-nominal actual DTE observed:

| Nominal | Observed actual DTE range | Verdict |
|---|---|---|
| 7D | 4.3 – 9.3 | usable |
| 14D | 11.3 – 16.3 | usable |
| **30D** | **16.3 – 39.3** | **poorly served** |

Deribit's cycle is Friday-anchored. From a **Monday** entry the nearest weeklies are 4.3d and 11.3d — there is no 7-day or 14-day expiry at all. The 30D band is worst: the nearest listed expiry ranged from 16.3d to 39.3d depending on date.

**Therefore:** always resolve **nearest listed expiry to the nominal horizon**, always store **actual expiry and actual DTE**, and apply an explicit tolerance. Recommended: 7D ±3d, 14D ±4d, 30D ±8d; outside tolerance the tenor is `unavailable` rather than silently mislabelled. This mirrors the existing DTE-family discipline already used elsewhere in the repository.

---

## 7. E. Underlying history for realized volatility — **complete, but the app currently mixes sources**

`get_tradingview_chart_data(BTC-PERPETUAL, resolution=60)` over 30-day windows:

| Window | Bars | Expected | Irregular steps |
|---|---|---|---|
| 2024-06 | 721 | 720 | **0** |
| 2025-02 | 721 | 720 | **0** |
| 2026-02 | 721 | 720 | **0** |

Complete hourly coverage, no gaps, on both hosts.

**No dense historical index series exists.** `get_tradingview_chart_data` rejects `btc_usd`, `BTC-DERIBIT-INDEX` and `BTCDVOL_USDC` with `Invalid params`. The Deribit BTC index is available historically only as the `index_price` field riding on option trades — sparse and event-driven, unusable for hourly RV.

### The source-mixing problem (must be resolved before Phase 2A)

The application currently touches **three different underlying series**:

| Series | Where | Venue / instrument |
|---|---|---|
| **Binance BTCUSDT spot 1h/4h** | `app/api/ohlc/route.ts` → `data-api.binance.vision` | Binance, spot |
| **Deribit BTC-PERPETUAL 1h** | futures baseline, `scripts/deribit-perpetual-history.ts` | Deribit, perpetual |
| **Deribit BTC index** | `index_price` on every option trade | Deribit, index |

**Recommendation: RV uses Deribit `BTC-PERPETUAL` 1h from the history mirror, and nothing else.**

Rationale: it is Deribit-native (same venue as the options and the index the IV is quoted against), empirically gap-free, already retrieved and cached by the futures baseline, and consistent with the existing futures engine's provenance. Using Binance spot would mix venue, instrument type and settlement convention into a number compared directly against Deribit IV.

**Disclose the residual:** the perpetual is not the index; basis and funding pressure can move it relative to `btc_usd`. Every RV row must carry its source instrument explicitly so this stays visible and auditable, and so a future index-based RV can be compared rather than silently swapped.

---

## 8. Recommended market-IV evidence hierarchy

For "reference IV for expiry `E` at timestamp `T`":

| Rank | Class | Rule |
|---|---|---|
| 1 | `exact_atm` | ≥1 IV-bearing trade on the **ATM strike** (listed strike nearest the causal underlying at T), expiry `E`, `timestamp ≤ T`, age ≤ max, contract listed at T |
| 2 | `nearest_strike_reference` | same, on the nearest listed strike within a declared moneyness tolerance (recommend \|ln(K/S)\| ≤ 0.05) |
| 3 | `local_interpolation` | linear in **log-moneyness** between exactly two bracketing observed strikes, **both** independently passing rank-2 quality; never extrapolates |
| 4 | `unavailable` | with an explicit reason code |

**Excluded by construction:** `constant-entry-IV`, any model-reconstructed anchor, any IV implied from a model-generated price, and any interpolation touching the subject structure's own legs (see §12).

### Term definitions (fixed)

- **observed** — a real exchange trade print carrying exchange-supplied `iv`, causally at or before T, on a contract listed at T. Nothing else.
- **interpolated** — arithmetic over two or more *observed* values only; carries every input's provenance.
- **reconstructed** — any value produced by the pricing model. **Valid for pricing, never market evidence.**
- **unavailable** — no qualifying observation. Never zero, never carried forward.

Note `nearest_strike_reference` is **observed** (a real print on a nearby strike), not interpolated — the approximation is in *which strike*, recorded as moneyness distance, not in the value itself.

---

## 9. Staleness rule — separate from pricing

**720 minutes is a pricing-model parameter and is not appropriate for market-state research.** It exists so a mark can be produced at all; a market-state claim needs far tighter evidence.

The tape supports much tighter. Across all 6 sweep targets the freshest near-ATM observation was **2–7 minutes** old and a bracketing pair existed within **60 minutes**.

**Locked rule: `market_iv_max_age_minutes = 60`.**

Every market-IV observation must carry:

| Field | Meaning |
|---|---|
| `observation_timestamp_utc` | when the trade printed |
| `target_timestamp_utc` | T |
| `age_minutes` | `(T − observation) / 60000`, always ≥ 0 |
| `max_age_minutes` | the rule in force (60) |
| `passes_market_state_rule` | boolean |

Diagnostic tiers of 60 / 240 minutes may be **recorded** for coverage analysis, but rank and availability are decided by the 60-minute rule alone.

**This threshold is fixed now, before any outcome is analysed, and must not be tuned on MR results.** Changing it later requires a method-version bump and re-derivation of every dependent statistic.

---

## 10. Canonical realized-volatility methodology (locked)

The prompt's default is adopted; the data supports it with no reason to deviate.

- **Returns:** hourly close-to-close log returns, `r_t = ln(S_t / S_{t−1})`, from Deribit BTC-PERPETUAL 1h closes.
- **Annualization:** `8760` hourly periods (365 × 24, BTC trades 24/7).
- **Estimator:** `RV = sqrt(mean(r_t²) × 8760)`, stored as a **decimal** (0.62, not 62).
- **Horizons:** 1D = 24h, 3D = 72h, 7D = 168h, 14D = 336h, 30D = 720h — all strictly **before** entry.
- **No forward filling.** Ever.
- **Completeness rule: ≥ 95% of expected hourly returns, else `unavailable`.** Given the probes returned 721/720 bars with zero irregular steps across three separate windows, 95% is not a binding constraint in normal operation — it is a guard against retrieval failure or an exchange outage, which is exactly what it should be.
- **Always store:** `observation_count`, `expected_count`, `coverage_ratio`, `window_start_utc`, `window_end_utc`, `underlying_source`, `method_version`.

Parkinson and other range estimators are explicitly **not** implemented now.

---

## 11. Causal historical percentile methodology (locked)

- **Never** computed from MR events alone — that would be a sample of ~event count, biased to event conditions.
- Computed against the broader `volatility_reference_series`.
- **Expanding causal percentile:** at event timestamp T, use every valid reference observation with `timestamp < T` (strict), and take the empirical percentile of the event's reference IV within that prior set.
- **No future observations.** No lookback-window optimization yet.
- **Minimum prior observations: 720** (≈30 days of hourly reference observations). Justification: below roughly one month the prior set is dominated by a single volatility regime, so the percentile measures recency rather than history. Below the minimum → `percentile_status: "unavailable"`, never a fabricated confidence.
- **Store:** `percentile`, `prior_observation_count`, `history_start_utc`, `history_end_utc`, `reference_series_id`, `reference_series_content_hash`, `method_version`.

---

## 12. Circularity audit — the core acceptance requirement

Every path by which a **model** IV can masquerade as **market** evidence:

| # | Path | Where | Rule |
|---|---|---|---|
| C1 | `constant-entry-IV` carry-forward | `modelMark` (research-valuation.ts:130–136) reuses entry anchors when no fresh pair exists | **Never** admissible. Any row whose `ivSource === "constant-entry-IV"` is excluded from every market-evidence consumer. |
| C2 | Model-reconstructed leg marks | `modelLeg` output; `legVolatility` → `observation: "reconstructed"` | Excluded. Only `observation === "observed"` may enter. |
| C3 | IV implied from a model-generated price | `impliedVol` bisection in `causal-valuation.ts` inverts a model price | Excluded. Inverting the model returns the model's own input. |
| C4 | `intrinsic-at-expiry` | `ModelIvSource` state at/after expiry | Excluded — a degenerate pricing state, not an IV observation. |
| C5 | Self-referential interpolation | interpolation whose bracketing inputs include the subject structure's own legs | Forbidden. Reference IV must be derived from strikes **excluding** the structure's own short and long legs, or be marked self-referential and excluded from ΔIV/skew comparisons. |
| C6 | Entry-anchor reuse across the path | the same anchor serving both entry and a later "market state" | Each market-state observation must have its **own** qualifying observation within its own 60-minute window; anchors are not reusable across timestamps. |
| C7 | DVOL as a same-expiry proxy | using the whole-surface index where a same-expiry reference is missing | Forbidden. DVOL is a distinct series with its own ID; it never fills a same-expiry gap. |
| C8 | Backfilled/repaired series rows | any cached reference row not traceable to a print | Every reference row carries `observation_class`; only `observed`/`interpolated` are usable, and interpolated rows carry their observed inputs. |

**Consumers these rules protect:** historical IV percentile, market ΔIV, term-structure slopes, IV-vs-RV (variance-risk-premium) comparisons, and any future skew work.

**Enforcement should be a validator rule, not a convention** — the same pattern already used for `iv_decimal` requiring `iv_units` and `observation` (research-bundle.ts:560). Recommended: a market-evidence row carrying `observation_class ∉ {observed, interpolated}` is a hard export error.

---

## 13. Proposed schema — `volatility_reference_series`

Market-wide, **independent of MR events**. One row per (timestamp × reference point).

| Field | Notes |
|---|---|
| `series_id` | stable ID for the series definition |
| `method_version` | e.g. `market-iv-reference-v1` |
| `timestamp_utc` | grid timestamp T |
| `underlying_instrument` | `BTC-PERPETUAL` |
| `underlying_price` | causal underlying at T |
| `reference_expiry_timestamp_utc` | **actual** expiry |
| `actual_dte_days` | **actual**, never nominal |
| `nominal_tenor` | `7d` / `14d` / `30d`, label only |
| `tenor_tolerance_passed` | boolean |
| `reference_strike` | the strike the observation came from |
| `log_moneyness` | `ln(K / underlying_price)` |
| `reference_iv_decimal` | decimal |
| `iv_units` | `"decimal"` |
| `observation_class` | `exact_atm` / `nearest_strike_reference` / `local_interpolation` / `unavailable` |
| `observation_source` | `deribit_trade_iv` / `interpolation` |
| `observation_timestamp_utc`, `age_minutes`, `max_age_minutes`, `passes_market_state_rule` | §9 |
| `source_trade_ids` | provenance to actual prints |
| `interpolation_inputs` | for interpolated rows: both observed inputs in full |
| `contract_listed_at_utc` | `creation_timestamp` gate |
| `settlement_period` | `day` / `week` / `month` |
| `quality`, `unavailable_reason_code` | explicit missingness |
| `retrieved_at_utc`, `dataset_version` | identity |

A parallel, simpler DVOL series (`series_id: btc_dvol_hourly`) carries `timestamp_utc`, OHLC, `resolution_seconds`, `source: deribit_volatility_index`, and its own `method_version`. Kept **separate** — never merged into the same-expiry series (C7).

---

## 14. Proposed schema — `event_volatility_state`

One row per `event_id × entry_timestamp`.

- **Identity:** `event_id`, `entry_timestamp_utc`, `underlying_instrument`, `entry_underlying_price`, `method_version`, `reference_series_id` + `reference_series_content_hash`.
- **Reference IV by tenor** — for each of broad / 7D / 14D / 30D: `iv_decimal`, `actual_expiry_timestamp_utc`, `actual_dte_days`, `observation_class`, `observation_timestamp_utc`, `age_minutes`, `passes_market_state_rule`, `quality`, `unavailable_reason_code`.
- **Term structure:** `slope_7d_14d`, `slope_14d_30d`, `slope_7d_30d`, each with a `status` that is `available` **only** when both endpoints are independently available and both pass the staleness rule — plus the actual DTE pair the slope was computed across, since the nominal labels are approximations (§6).
- **Trailing RV:** for 1D/3D/7D/14D/30D — `rv_decimal`, `observation_count`, `expected_count`, `coverage_ratio`, `window_start_utc`, `window_end_utc`, `underlying_source`, `status`.
- **Percentile:** `reference_iv_percentile`, `prior_observation_count`, `history_start_utc`, `history_end_utc`, `percentile_status`, `method_version`.
- **Derived comparisons:** `iv_minus_rv_7d` etc., available only when both sides are available.

Every metric carries value, units, source, source timestamp, age, observation class, method version, quality. No metric is ever `0` for "missing".

---

## 15. Proposed schema — `structure_volatility_state`

One row per `candidate_id`.

- **Identity:** `event_id`, `candidate_id`, `entry_timestamp_utc`, `actual_expiry_timestamp_utc`, `actual_dte_days`, `short_strike`, `long_strike`, `option_type`.
- **Per-leg IV:** `short_leg_iv_decimal`, `long_leg_iv_decimal` — **reuse `legVolatility`** (research-tracks.ts:343) and its existing `observation` classification. Each leg keeps `iv_source`, `iv_source_timestamp_utc`, `age_minutes`, `observation`, `quality`.
- **Same-expiry reference:** `reference_iv_decimal`, `reference_iv_method` (`exact_atm` / `nearest_strike_reference` / `local_interpolation` / `unavailable`), `reference_strike`, `reference_log_moneyness`, `reference_age_minutes`, `reference_excluded_own_legs` (boolean, C5).
- **Differentials:** `short_minus_reference_iv`, `long_minus_reference_iv`, `short_minus_long_iv` — each `available` only when both inputs are observed-class and pass staleness.
- **Provenance:** `evidence_ages`, `observation_class` per component, `quality`, `unavailable_reason_code`.

**No synthesized "spread IV".** A vertical does not have a single implied volatility; the two legs are reported separately and differenced explicitly.

---

## 16. Persistence / export architecture

**Recommendation: a standalone versioned cached dataset, referenced by identity from the bundle.**

```
.local-cache/volatility-reference/
   <series_id>/<YYYY-MM>.jsonl        append-only monthly shards
   <series_id>/manifest.json          coverage, content hash, method version
```

| Requirement | How it is met |
|---|---|
| Sample expansion must not redownload years of history | Shards are append-only and content-addressed; a new event set reuses existing shards and fetches only uncovered spans. |
| Bundles stay reproducible | The bundle embeds **per-event and per-structure snapshots** (the actual values used) plus `reference_series_id` + `content_hash` + `method_version`. |
| No silent dependence on mutable external data | The embedded snapshot is the authority for the numbers; the hash proves which series produced them. A changed series produces a different hash. |
| Analytics knows which dataset produced each state | `reference_series_id` + `content_hash` travel on every state row. |
| Methodology mismatch is detectable | `method_version` on every row; the validator rejects mixed method versions in one bundle, exactly as the existing configuration-hash rule does. |

**Years of reference rows are never copied into every bundle.** Only the snapshots actually used, plus identity. This is the same split the bundle already uses for source runs and configuration identity.

---

## 17. Schema-version implication

Adding `event_volatility_state` and `structure_volatility_state` as canonical bundle tables **changes the serialized contract**: `RESEARCH_BUNDLE_FILES` grows, `table_availability` gains entries, and the validator gains rules. That is a **minor bump to `3.7.0`** with `3.6.0` added to `LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS`.

`volatility_reference_series` should **not** become a bundle table — it is the standalone cached dataset of §16, referenced by ID and hash.

Selection schema `1.8.0` is unaffected.

**No bump is performed in this task.**

---

## 18. Expected coverage limitations (state these before implementing)

1. **Not yet measured on the real event set.** §4 is 6 arbitrary timestamps, not MR-aligned. Phase 2A must measure and publish real coverage.
2. **30D tenor is structurally weak** — nearest listed expiry ranged 16.3–39.3 days. Expect frequent `tenor_tolerance_passed: false`.
3. **Trade-only evidence.** No historical order book or mark series; quiet hours genuinely have no observation, and that is a real `unavailable`, not a defect.
4. **DVOL starts 2021-03-24.** Events before that have no broad reference.
5. **Percentile needs ≥720 prior hourly observations**, so the earliest ~30 days of any newly built series yield `unavailable`.
6. **Perpetual ≠ index.** RV carries basis; disclosed, not corrected.
7. **Deribit weekly cycle is Friday-anchored**, so actual DTE varies systematically with entry weekday — a confound to control for, not to average away.
8. **Sparse-tape events are exactly the interesting ones.** Expect market-IV availability to correlate with liquidity, and therefore with regime. Report availability as a first-class result.

---

## 19. Phase 2A implementation sequence (proposed, not started)

1. Wire the existing `fetchDvolRange` to `www` (mirroring the funding precedent) and add BTC-PERPETUAL 1h retrieval reuse for RV — retrieval only, cached, no analytics.
2. Build `volatility-reference-series.ts`: the §8 hierarchy + §9 staleness, producing the §13 rows into the §16 cache. Pure and deterministic given inputs.
3. Add the circularity validator rules of §12 **before** any consumer exists.
4. Implement RV (§10) and expanding percentile (§11) as pure functions with explicit coverage outputs.
5. Build `event_volatility_state` (§14) and `structure_volatility_state` (§15) reusing `legVolatility`.
6. Bump schema to `3.7.0`, add the two tables, extend `table_availability` and the validator.
7. Measure and publish **real coverage** on the actual event set.
8. Only then consider Analytics surfacing.

Steps 1–4 are independently testable and land no schema change.

---

## 20. Phase 2B — Greeks (design only, not implemented)

Delta, vega and theta would be exposed as **explicitly MODEL quantities**, never exchange observations:

| Field | Notes |
|---|---|
| `model_delta`, `model_vega`, `model_theta` | per leg |
| `net_spread_vega` | short + long, signed; the only aggregate that is meaningful for a vertical |
| `pricing_model` | reuse `INVERSE_OPTION_MODEL` |
| `pricing_model_version` | explicit |
| `iv_input_source` | which IV drove them, with its `observation_class` — a Greek from a `constant-entry-IV` mark is a model artifact and must say so |
| `iv_input_age_minutes` | staleness of the driving IV |
| `forward_price`, `rate`, `forward_rate_assumption` | reuse the existing `FORWARD_ASSUMPTION` already recorded in `modelLeg` |
| `quantity_convention` | per contract vs per position |

They inherit the observation class of their IV input: a Greek can never be better-evidenced than the volatility that produced it. They must be labelled `model_` in both the schema and the UI, and must never enter the market-evidence hierarchy.

---

## Summary

The data supports the research programme. The exchange supplies IV directly, near-ATM tape is dense enough for a 60-minute market-state rule, the underlying series is gap-free, and DVOL is available as an optional broad reference from 2021-03-24. The three real risks are **host asymmetry** (options must use the history mirror, DVOL must use www), **nominal-versus-actual DTE** (Deribit's Friday cycle means 7/14/30D expiries frequently do not exist), and **circularity** (the pricing model's `constant-entry-IV` fallback must never become market evidence). All three are addressed above and are enforceable in the validator before any consumer is written.
