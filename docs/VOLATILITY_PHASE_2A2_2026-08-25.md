# Phase 2A.2 — Volatility state in the research bundle, and real coverage

**Date:** 2026-08-25
**Branch:** `volatility-phase-2a1`
**Commits:** `dda1eac` (hardening) → `24af1c2` (Phase 2A.2)
**Starting point:** `5a0d0e9` (Phase 2A.1)

---

## The short version

Your bundle reconciled cleanly — no mismatches of any kind. I made the two hardening
changes you asked for, committed them on their own, then built the two volatility
tables, bumped the bundle schema to 3.7.0, wired the Analytics importer, and measured
real coverage against live Deribit history for all 6 of your events and all 28 selected
structures.

**Headline coverage, measured — not estimated:**

| Metric | Coverage | Notes |
|---|---|---|
| Same-expiry reference IV, per structure | **28 / 28 (100%)** | causal, own legs excluded |
| Trailing realized volatility, all horizons | **30 / 30 (100%)** | 1D/3D/7D/14D/30D × 6 events |
| Event reference IV, 14D | **6 / 6 (100%)** | |
| Event reference IV, 7D | **5 / 6 (83%)** | the one miss is the Friday cycle, not missing tape |
| Event reference IV, 30D | **4 / 6 (67%)** | as the audit predicted |
| Per-leg IV on the exact contract | **16 / 56 (29%)** | genuinely sparse — see §5 |
| Causal IV percentile | **0 / 6** as shipped | cache not populated; proof run confirms the pipeline — see §6 |

The important one: **every available reference IV is a real ATM exchange print.**
14 of 15 event-level references and 25 of 28 structure-level references are
`exact_atm`; the rest are `nearest_strike_reference`. **Zero interpolation was
needed, and nothing was extrapolated.** Median observation age is 16–20 minutes
against a 60-minute limit.

Nothing here is a model number. Everything is a trade that actually printed.

---

## 1. Your bundle: reconciliation

The artifact you supplied is a **research bundle** (schema 3.6.0), not a selection
store, so I took the "inspect whether it can reconstruct an equivalent research
input" path and did **not** build a bundle→selection migration into production.

Every declared count matches actual:

| Check | Declared | Actual | |
|---|---|---|---|
| persisted events | 6 | 6 | ✓ |
| events with selected candidates | 5 | 5 | ✓ |
| selected structures | 28 | 28 | ✓ |
| execution rows | 56 | 56 | ✓ |
| generated denominator | 627 | 627 | ✓ |

`structure_economics` and `margin_scenarios` each carry exactly the same 28
candidate IDs — 0 missing, 0 extra, both directions. Structural identity
(`requested_strikes`, `actual_strikes`, `expiry_timestamp_utc`,
`target_horizon_days`, `option_type`, `instruments`) is **identical across every
maker/taker row pair — 0 mismatches.** 2 of 28 structures are width-substituted,
and that is recorded honestly on the row.

**No mismatches were found, so nothing was repaired.**

Two observations that are not mismatches but are worth stating:

- The bundle was assembled across **three different `application_commit_build_id`
  values**, all marked `-dirty`: `5a0d0e9`, `a688731`, `22df485`. All six source
  runs share one `effective_configuration_hash` (`14qrfox19ako29`), so methodology
  identity is consistent. Build provenance is deliberately excluded from that hash,
  so this is not a staleness failure — but it does mean the bundle was not produced
  from a clean tree.
- Event `1f046e00` has **0 selected structures**. It is a valid event with an
  event-level volatility state and no structure-level rows.

### What the bundle can and cannot supply

**Recoverable, and used:** full structural identity including the actual instrument
names (`BTC-17OCT25-127000-C`), which is what makes structure-level volatility work
possible at all; entry timestamps; expiries; strikes; option types.

**Not recoverable from the bundle — and this is the one field class you asked me to
name explicitly:** the **cross-sectional tape for strikes other than the structure's
own legs on the same expiry.** A same-expiry reference IV is by definition built from
contracts the structure did *not* trade, and a bundle only carries what the structure
did trade. This is expected rather than a defect — it is precisely what the Phase 2A.1
retrieval layer fetches from Deribit, and it is what the coverage run below did.

Secondary gap: the bundle's `entry_legs` IV is present only on the 5 of 56 rows that
are `execution_scenario_status: "evaluated"`. The coverage run therefore measured
per-leg IV **from the live tape instead**, independently of what the pricing model
recorded. That is the honest measurement, and it is why §5's number is low.

---

## 2. Hardening (commit `dda1eac`)

Both changes are pre-consumer: nothing in production consumed the looser behaviour
yet, which is exactly why now was the moment to lock them.

### (a) Same-expiry resolution hard-rejects mixed expiries

`resolveReferenceIv` now throws if its observations span more than one expiry.

Every branch of the hierarchy is only meaningful along one expiry, and the
interpolation branch is the dangerous one: blending a 40-vol 7-day print with a
62-vol 5-week print produces a number no listed contract ever traded at — and the
result carries a **single** `expiryTimestampMs` taken from one input, so the blend
would be labelled with an expiry it does not describe.

A multi-expiry input means the caller grouped its evidence wrongly. That is a
contract violation, not missing data, so it **throws** rather than returning
`unavailable` — the mistake cannot be absorbed as ordinary sparse coverage. An
optional `expectedExpiryTimestampMs` pin also catches a group that is internally
consistent but wholly the wrong expiry, which the observations alone cannot reveal.
`buildReferenceSeriesRows` now passes that pin.

### (b) IV percentiles are per tenor and per series

`causalIvPercentile` now ranks a subject only against prior observations of **its own
tenor**, in **its own series**.

A pooled 7D+14D+30D distribution measures the term structure, not the volatility
regime. In normal contango the 7D leg sits low in the pooled sample and the 30D leg
sits high — **at every single target, in every regime.** The percentile would encode
which tenor you asked about and nothing else.

`ReferenceObservation` now carries its tenor. Discarded rows are counted rather than
silently dropped (`other_tenor_observations_excluded`), an emptied distribution
reports `no_matching_tenor_observations` rather than borrowing another tenor's
history, and cross-series observations throw.

**Verified:** removing either guard fails exactly 3 of the new regression tests.
The regression test for (b) builds a textbook contango term structure and asserts
that a mid-regime 7D reading and a mid-regime 30D reading rank *alike* (both ≈0.5)
— pooled, they would land near 0.17 and 0.83.

Phase 2A.1 methodology is otherwise untouched.

---

## 3. What Phase 2A.2 added (commit `24af1c2`)

### The two tables

`app/lib/volatility/volatility-state.ts` builds `event_volatility_state` (one row
per event entry) and `structure_volatility_state` (one row per candidate), as pure
functions. Retrieval stays upstream; the state is **injected** into
`buildResearchBundle` as a snapshot. That keeps the bundle synchronous and
reproducible — rows embed the values actually used plus the series identity that
produced them, and years of reference history stay in the standalone cache rather
than being copied into every bundle.

Two rules run through every field:

1. **A missing metric is `null` with a reason.** Never `0`, never carried forward
   from a neighbouring tenor or horizon.
2. **A derived metric is available only when every input it derives from is
   independently available *and* passes the market-state rule.** A slope with one
   stale endpoint is not a slope. An unavailable RV must not read as RV = 0.

Term-structure slopes are reported **per actual day**, because a nominal "7D vs 14D"
pair is routinely 5.9 vs 12.9 real days — dividing by the nominal gap would misstate
the slope by whatever the Friday cycle happened to offer. Two nominal tenors that
resolve to the *same* listed expiry report `degenerate_tenor_span` rather than
dividing by zero; that happened for real, at event `5bebaf8f`.

`structure_volatility_state` carries a permanent `synthesized_spread_iv: null` with a
note. A vertical has no single implied volatility; the legs are reported separately
and differenced explicitly.

### Schema 3.7.0

`RESEARCH_BUNDLE_FILES` grows by two, `3.6.0` moves to the legacy list,
`table_availability` gains both entries. The validator makes three things
**unserializable**:

- a metric reporting a value while its status is unavailable;
- a derived quantity standing on an unavailable endpoint (a slope whose tenor is
  missing; a leg differential against a reference that did *not* exclude that
  structure's own legs);
- a model-produced volatility presented as market evidence (a leg reported
  `available` on observation `reconstructed` or `constant-entry-IV`).

Partial coverage is also rejected: a half-populated table reads as a full sample
downstream, so either the pipeline ran for every event or the table is absent.
A bundle built without the volatility pipeline exports both tables **empty** and marks
them `unavailable` — which is honest, and still valid.

### Importer wiring

`research-analysis.ts` gains two capabilities, `event-volatility` and
`structure-volatility`, which report **`unavailable`** rather than `degraded` when the
tables are genuinely absent, and require at least one *genuinely available* market
observation — a table full of unavailable rows is not a capability. Pre-3.7.0 bundles
backfill empty tables so legacy import still works.

`research-analytics-model.ts` exposes `model.volatility`, a typed projection that
carries coverage. A consumer that forgets to check availability reads zeroes in the
**denominator**, not a fabricated volatility.

---

## 4. Real coverage, measured on your events

`scripts/measure-volatility-coverage.ts` — read-only; it reads the bundle purely to
learn *which* events and structures to ask Deribit about, and never reconstructs a
selection store.

Method: 120,713-instrument manifest with `creation_timestamp` gating; all BTC option
prints in the 60 minutes before each entry via
`get_last_trades_by_currency_and_time` on `history.deribit.com`; the causal underlying
taken from Deribit's own `index_price` on the freshest print; 761 hourly
BTC-PERPETUAL bars per event for RV.

| event | entry | spot | 7D | 14D | 30D | RV 7D | RV 30D | IV−RV 7D |
|---|---|---|---|---|---|---|---|---|
| `17339625` | 2025-10-08 08:00 | 121,625 | 36.4% @ 9.0d | 36.3% @ 16.0d | 36.8% @ 23.0d | 32.7% | 27.1% | **+3.7pp** |
| `1f046e00` | 2026-06-08 00:00 | 63,313 | 65.2% @ 4.3d | 54.3% @ 11.3d | — @ 18.3d | 71.5% | 43.7% | −6.3pp |
| `2a93d290` | 2025-05-24 10:00 | 108,210 | 42.1% @ 5.9d | 45.2% @ 12.9d | 47.5% @ 33.9d | 50.3% | 38.0% | −8.2pp |
| `5bebaf8f` | 2025-01-14 00:00 | 94,503 | — @ 10.3d | 58.5% @ 17.3d | — @ 17.3d | 51.1% | 50.3% | n/a |
| `653f11df` | 2025-01-22 14:00 | 104,043 | 59.5% @ 8.8d | 58.9% @ 15.8d | 58.1% @ 36.8d | 78.4% | 55.2% | **−18.9pp** |
| `d099f278` | 2024-05-04 10:00 | 63,185 | 50.6% @ 5.9d | 52.9% @ 12.9d | 54.0% @ 26.9d | 67.8% | 62.2% | **−17.2pp** |

Trades in the 60-minute window ranged from 334 to 692 per event; admission accepted
409–679 of them. The only rejections anywhere were 13 `expiry_not_after_target` at
`17339625` — an expiry that had already passed, correctly refused.

### The three tenor misses are all the Friday cycle

Not one is missing tape:

- `5bebaf8f` **7D**: nearest listed expiry was **10.3 days** out. Nothing existed
  within 7 ± 3.
- `5bebaf8f` **30D**: nearest was **17.3 days** — the *same expiry* its 14D resolved
  to. Its 14D and 30D references are literally the same contract, which is why the
  slope reports a degenerate span.
- `1f046e00` **30D**: nearest was **18.3 days**, outside 30 ± 8.

This is the confound §18.7 of the methodology report predicted, now visible in your
own data: **actual DTE varies systematically with entry weekday.** Actual DTE by
nominal tenor across the 6 events:

- 7D → 4.3, 5.9, 5.9, 8.8, 9.0, 10.3
- 14D → 11.3, 12.9, 12.9, 15.8, 16.0, 17.3
- 30D → 17.3, 18.3, 23.0, 26.9, 33.9, 36.8

The "30D" family spans 17 to 37 real days. It must be controlled for, not averaged away.

---

## 5. Findings worth your attention

**a. Reference IV is essentially always a real ATM print.** 14/15 event-level and
25/28 structure-level references are `exact_atm`, the remainder
`nearest_strike_reference`. Zero interpolation, zero extrapolation. Median age 16–20
minutes against a 60-minute limit; worst case 52 minutes. The 60-minute market-state
rule is comfortably satisfied and is not the binding constraint.

**b. IV sat *below* trailing realized volatility at 4 of the 5 measurable events** —
by as much as 18.9 points at `653f11df` and 17.2 at `d099f278`. Only `17339625` sold
IV above trailing RV.

I want to be careful about this one. IV is forward-looking and RV is backward-looking,
so a negative IV−RV is the *normal* shape after a volatility spike, when realized has
already jumped and implied is already normalizing. It is **not** by itself evidence
the spreads were sold cheap. But it is a real, measured, causal fact about the entry
conditions, and it means the premium-selling framing cannot be assumed — it has to be
tested. That is a Phase 2B question, and this table is what makes it answerable.

**c. Per-leg IV on the exact contract is sparse: 16 of 56 legs (29%).** By event:
`2a93d290` 7/12, `d099f278` 4/18, `17339625` 3/12, `5bebaf8f` 1/6, `653f11df` 1/8.
The specific 127000-strike contract simply did not print in that hour, even though
the expiry as a whole traded hundreds of times.

This validates the architectural choice: the **same-expiry reference**, not the leg
itself, has to be the primary instrument. It is available 100% of the time; the leg
is available 29% of the time. Gating volatility analysis on per-leg IV would silently
discard 71% of the sample, and would discard it non-randomly — toward the more liquid,
quieter structures.

**d. An asymmetry I did not expect and am not going to explain away.** Long legs had
usable prints far more often than short legs: `long_minus_reference` is available
13/28 but `short_minus_reference` only 3/28. For credit spreads the short leg is
nearer the money and would ordinarily trade *more*. I do not have an explanation I
trust, and it is worth checking before any skew work.

**e. The only skew measurement the tape currently supports** is 3 structures, all at
`2a93d290`, all showing the short strike within 0.3 points of the ATM reference.
That is a sample of one event. It is not yet a finding.

**f. A real defect the coverage run surfaced.** My first implementation pushed each
structure's own expiry through nominal-tenor resolution, so a perfectly good 27-day
reference was marked unavailable for failing to be a 7-day one — structure-level
coverage read **12/28**. A selected structure's expiry is *exact*, not an
approximation of a label. Added `buildExpiryReferenceRow` for the known-expiry path:
coverage went to **28/28**. This is exactly the kind of thing measuring against real
data catches and unit tests do not.

---

## 6. What is still unavailable, and why

**Causal IV percentile: 0 / 6.** Reason code `no_prior_observations` — not a
methodology failure. The expanding percentile requires ≥720 prior *hourly* reference
observations per tenor, and the standalone reference-series cache built in Phase 2A.1
has not been populated. Populating it costs roughly 720 API calls per event-month of
history; the shard cache exists precisely so that cost is paid once and reused.

A single-event end-to-end proof run has now completed — 761 hourly windows of real
Deribit tape against `17339625`. It produced a real percentile for 14D and, more
usefully, established **how much history each tenor actually needs**. See the appendix.

**DVOL: 0 / 6.** Not fetched in this run. DVOL is optional broad context by design,
starts only 2021-03-24, and — enforced in code and in the validator — may never
substitute for a same-expiry reference. Every row carries
`substitution_permitted: false` permanently.

**Percentile and DVOL are the only two gaps.** Everything else the audit specified is
measured and real.

---

## 7. Validation

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm run lint` | clean (1 pre-existing warning in `research-selections.ts`) |
| `npm run build` | clean |
| `npm run test:unit` | **736 / 736 pass** (was 702; +34 new) |

New suites: `tests/volatility-state.unit.test.ts` (22),
`tests/volatility-bundle-contract.unit.test.ts` (12), plus 7 new regression tests in
the two existing volatility suites.

**Mutation-tested**, because a passing test that would also pass with the guard
removed is worth nothing. Each of these fails tests when applied:

| Mutation | Tests failed |
|---|---|
| restore pooled 7D+14D+30D percentile | 3 |
| remove the mixed-expiry guard | 3 |
| validator allows a value while unavailable | 1 |
| validator allows a leg available on a model observation | 1 |
| builder treats reconstructed legs as market evidence | 3 |
| builder ignores slope endpoint availability | 1 |
| builder ignores own-leg exclusion in differentials | 1 |

---

## 8. Scope

Committed separately, as instructed: `dda1eac` (hardening) then `24af1c2`
(Phase 2A.2). **Phase 2A.3 was not touched** — no cross-sectional IV dataset, no
surface-readiness audit, no SVI/SSVI, no Greeks, no charts, no Analytics UI. No
execution, pricing, margin, futures or option-selection methodology was changed.
Canonical terminology preserved: *maximum structural loss*.

Nothing has been pushed.

---

## Appendix — percentile proof run

`scripts/measure-percentile-proof.ts`, event `17339625`, entry 2025-10-08 08:00 UTC.
761 hourly targets, each resolved from live Deribit tape; 2,283 reference rows built
(3 tenors x 761); series content hash `12br90z`.

| tenor | prior observations | of 761 possible | yield | subject IV | percentile |
|---|---|---|---|---|---|
| 7D | 645 | 761 | 84.8% | 36.41% | **unavailable** - `insufficient_prior_history` |
| 14D | 750 | 761 | 98.6% | 36.26% | **0.865** |
| 30D | 359 | 761 | 47.2% | 36.84% | **unavailable** - `insufficient_prior_history` |

**The pipeline works.** 14D cleared the 720-observation minimum and returned a real
causal percentile of **0.865** - implied volatility sat in the top 14% of the prior
month for that tenor. That is directionally consistent with the other measurement for
this event: `17339625` is the one event where IV exceeded trailing RV (+3.7pp). Two
independent methods agree that this entry happened into relatively rich volatility.

One caveat on that number: the prior history here is only ~31 days, which is the bare
minimum. It measures "high versus the last month", not "high versus history". A
properly populated multi-year cache will give a different and more meaningful reading.

**The more valuable result is the yield rates**, which turn SS18.2 of the methodology
report from a prediction into a measurement. The hourly reference series does not
resolve every hour - the tenor tolerance fails at a rate that differs sharply by
tenor:

- 14D resolves 98.6% of hours. It is the robust tenor.
- 7D resolves 84.8%.
- **30D resolves only 47.2%** - barely half the time. The Friday cycle simply does not
  offer an expiry within 30 +/- 8 days for most hours.

The operational consequence, which the cache job needs: **a 720-hour lookback is not
enough.** To accumulate 720 valid prior observations each tenor needs roughly

| tenor | required lookback |
|---|---|
| 14D | ~730 hours (~30 days) |
| 7D | ~849 hours (~35 days) |
| **30D** | **~1,526 hours (~64 days)** |

So the reference-series cache must reach back **at least ~64 days before the earliest
event** for the 30D percentile to be computable at all, versus ~30 days for 14D. That
is a concrete, measured requirement rather than an assumption, and it is exactly the
kind of thing the monthly shard cache built in Phase 2A.1 exists to amortise.

Cost of the run: 761 API calls, roughly 12 minutes, for one event-month of one event.
Shards make that a one-time cost shared across every event whose window overlaps.
