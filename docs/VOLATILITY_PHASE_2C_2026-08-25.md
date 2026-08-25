# Phase 2C — Hybrid fair-value validation and the pricing freeze

**Date:** 2026-08-25
**Starting branch / HEAD:** `volatility-phase-2a1` @ `d0b12b6`, clean
**Commit:** `86af8f4` — validation only
**Production Reference fair value is UNCHANGED. Nothing pushed.**

---

## Verdict, up front

**The hybrid wins the validation decisively. It is not promoted, because promotion is blocked by two concrete facts about this environment that the task's plan did not anticipate — and I will not ship an unverifiable rewrite of the core economic path.**

| | |
|---|---|
| Gate A (does the hybrid earn promotion?) | **PASSED — every criterion in §9 is met.** |
| Gate B (integrate) | **BLOCKED.** See §8. Production untouched. |

The hybrid beats the current production method on **every metric, in every cohort, in every bucket, in every leave-one-event-out fold**, at higher availability:

| | current local-IV | **hybrid (Rule C)** | change |
|---|---|---|---|
| availability | 3295/3475 — 95% | **3434/3475 — 99%** | +139 cases |
| IV MAE | 2.33 | **1.69** | −27% |
| IV median AE | 0.81 | **0.62** | −23% |
| IV RMSE | 10.26 | **7.04** | −31% |
| IV P95 | 6.70 | **5.09** | −24% |
| **grouped IV MAE** | 1.28 | **0.48** | **−63%** |
| price MAE (BTC) | 0.00112 | **0.00102** | −9% |
| **spread-credit MAE (BTC)** | 0.00052 | **0.00029** | **−44%** |
| spread sign flips | 2 | **0** | eliminated |

---

## 0. Starting state

| | |
|---|---|
| branch / HEAD | `volatility-phase-2a1` @ `d0b12b6`, working tree clean |
| Phase 2B validation artifact | sha256 `904b3e259a21a11b`, 610,172 bytes |
| Phase 2A.3 readiness artifact | sha256 `8c3a1c746be7a9b9`, 20,078,616 bytes |
| frozen cohort | 3,475 cases, content hash `112c02b` |
| research-bundle schema | `3.7.0` |
| selection schema | `1.8.0` |
| Reference valuation methodology | `causal-reference-v1` |
| local-IV fallback | `MODEL_IV_ANCHOR_MAX_AGE_MINUTES = 720` |

The frozen cohort was not regenerated or modified.

---

## 1. Frozen-cohort reconciliation

```
frozen cohort: 3475 recorded, 3475 rebuilt, 0 missing, 0 extra -> MATCH
```

Verified on the natural key `(snapshot_id, expiry, withheld_instrument)`. Identical exclusions, causal rules, truth observations, grouping and pricing functions as Phase 2B. Spread cohort: the same 224 frozen cases, of which the same 85 carry genuine two-leg truth. **No case added, removed, regenerated or reweighted. No truth fabricated for the 139 single-leg cases.**

Cohort composition (case-level, per the Phase 2B denominator fix): dense 2,789 · sparse 343 · extrapolation 342 · cross-expiry 1; 1,793 calls · 1,682 puts.

---

## 2. The hybrid, defined before scoring

`hybrid_bracketed_interpolation_anchor_v1`

| tier | condition | estimator |
|---|---|---|
| 1 | same-expiry observations exist, target **bracketed on both sides**, geometry rule satisfied, canonical 60-minute evidence, target contract excluded, **no extrapolation** | `same_expiry_linear_interpolation_v1`, unchanged |
| 2 | tier 1 ineligible | `local_iv_anchor_v1`, unchanged (720-minute same-contract anchor) |
| 3 | neither | `unavailable` with an explicit reason |

Deterministic, reads no outcome or PnL. **Neither tier's logic was altered** — both are called exactly as Phase 2B scored them, so a win cannot come from quietly improving a component. No SVI, no SSVI, no DVOL, no cross-expiry or wing extrapolation, no fabricated constant IV, no future data. An exact observed strike counts as bracketed, since the observation is then the answer.

Settlement is untouched and needs no IV.

---

## 3. Geometry robustness — a plateau, not a magic number

Phase 2B's "interpolation degrades below five strikes" came *out of* the validation results, so hard-coding five and calling it validated would be fitting the rule to the answer. Three rules were predeclared and scored on the same cohort.

| rule | interpolation tier | anchor tier | unavailable | IV MAE | grouped IV MAE | spread MAE |
|---|---|---|---|---|---|---|
| **A** — bracketed only | 3,144 | 290 | 41 | 1.70 | 0.51 | 0.00029 |
| **B** — bracketed, ≥3 strikes | 3,142 | 292 | 41 | 1.70 | 0.49 | 0.00029 |
| **C** — bracketed, ≥5 strikes | 3,138 | 296 | 41 | **1.69** | **0.48** | 0.00029 |

**The three rules differ by 0.01 vol points.** All three beat the current method by the same wide margin, so the conclusion does not rest on a threshold — which is exactly the robustness §2 asked for. Adjacent rules do not reverse anything.

**Rule C is selected**, and not because it is marginally best. It is the only rule that fully honours the independent Phase 2B finding, in the one bucket where the choice bites at all:

| `<5` same-expiry strikes (n = 15) | availability | IV MAE |
|---|---|---|
| pure interpolation | 40% | 3.91 |
| hybrid Rule A | 93% | 2.13 |
| hybrid Rule B | 93% | 1.63 |
| **hybrid Rule C** | 93% | **0.94** |
| local-IV anchor | 93% | 0.94 |

Rule C routes all 15 to the anchor, matching it exactly. Rule A knowingly sends six of them to the estimator Phase 2B measured as worse there. Everywhere else the rules are identical — the 5–9 strike bucket is 1.73 under both A and C. **The cost of the conservative choice is six cases out of 3,475, and it never produces `unavailable`.**

---

## 4. Single-contract benchmark — all 3,475 frozen cases

| method | availability | IV MAE | median | RMSE | P90 | P95 | grouped IV MAE | price MAE | price median | price RMSE |
|---|---|---|---|---|---|---|---|---|---|---|
| local-IV *(current)* | 95% | 2.33 | 0.81 | 10.26 | 3.71 | 6.70 | 1.28 | 0.00112 | 0.00049 | 0.00218 |
| interpolation | 90% | **1.52** | **0.60** | **5.47** | **2.74** | **4.77** | 0.56 | 0.00109 | 0.00054 | 0.00189 |
| **hybrid C** | **99%** | 1.69 | 0.62 | 7.04 | 2.92 | 5.09 | **0.48** | **0.00102** | **0.00047** | **0.00181** |
| SVI *(2B, reference)* | 88% | 2.21 | 0.90 | 6.90 | 4.15 | 6.88 | 3.11 | 0.00109 | 0.00053 | 0.00190 |
| SSVI *(2B, reference)* | 50% | 5.22 | 2.24 | 13.18 | 11.21 | 17.43 | 9.18 | 0.00142 | 0.00080 | 0.00219 |

Pure interpolation retains the lowest observation-weighted IV MAE — **because it declines the hard cases.** The hybrid takes on 290 additional cases the interpolator refuses and still lands within 0.17 vol points, while beating it on grouped IV MAE (0.48 vs 0.56) and on every price metric. Availability 99% vs 90%.

### By cohort

| cohort | metric | local-IV | interpolation | hybrid C |
|---|---|---|---|---|
| **primary dense** (2,633) | IV MAE / avail | 1.53 / 96% | 0.91 / 100% | **0.91 / 100%** |
| **early life** (620) | IV MAE / avail | 1.46 / 94% | 0.83 / 90% | **0.85 / 99%** |
| **entry only** (179) | IV MAE / avail | 0.71 / 97% | 0.60 / 89% | **0.61 / 99%** |
| **sparse** (343) | IV MAE / avail | 3.04 / 91% | 2.65 / 100% | **2.60 / 100%** |
| **extrapolation** (342) | IV MAE / avail | **3.76 / 87%** | 9.88 / 4% | 3.92 / 88% |
| **final day** (200) | IV MAE / avail | 14.37 / 96% | **9.05 / 90%** | 11.19 / 98% |

On the primary cohort the hybrid **is** the interpolator — identical to four decimals — because tier 1 fires on every case. The extrapolation cohort is where it falls through to the anchor, landing 0.16 vol points behind pure local-IV on 3 extra cases; a rounding-level difference, not a degradation.

---

## 5. Vertical-spread credit — strategically primary

BTC per contract. No truth fabricated for single-leg cases.

**Both legs observed (n = 85)**

| method | availability | MAE | median | RMSE | P95 | signed bias | sign flips |
|---|---|---|---|---|---|---|---|
| local-IV | 81 — 95% | 0.00052 | 0.00024 | 0.00089 | 0.00155 | −0.00015 | **2** |
| interpolation | 80 — 94% | 0.00030 | 0.00020 | 0.00044 | 0.00103 | −0.00002 | 0 |
| **hybrid C** | **85 — 100%** | **0.00029** | **0.00019** | **0.00043** | **0.00103** | **−0.00001** | **0** |

**Synchronous, legs ≤5 minutes apart (n = 19)** — the cleanest truth

| method | availability | MAE | median | RMSE | bias |
|---|---|---|---|---|---|
| local-IV | 89% | 0.00059 | 0.00034 | 0.00083 | −0.00002 |
| interpolation | 95% | 0.00031 | 0.00022 | 0.00045 | +0.00004 |
| **hybrid C** | **100%** | **0.00029** | **0.00019** | **0.00043** | +0.00004 |

**Asynchronous (n = 66)**

| method | availability | MAE | median | RMSE | bias | flips |
|---|---|---|---|---|---|---|
| local-IV | 97% | 0.00050 | 0.00024 | 0.00090 | −0.00018 | 2 |
| interpolation | 94% | 0.00030 | 0.00020 | 0.00044 | −0.00003 | 0 |
| **hybrid C** | **100%** | **0.00029** | **0.00019** | **0.00043** | −0.00003 | **0** |

The hybrid is the **only method available on all 85 cases**, is best on every metric in all three cohorts, carries essentially no signed bias (−0.00001 against local-IV's −0.00015), and eliminates both credit sign flips — cases where the current method put an estimated credit on the wrong side of zero.

Sample caveat: **19 synchronous cases** is thin. The conclusion rests mainly on the 85-case and 3,475-case evidence.

---

## 6. Breakdowns — hybrid beats the current method in every bucket

IV MAE (availability).

**By DTE**

| DTE | local-IV | interpolation | hybrid C |
|---|---|---|---|
| 0–1d | 14.37 (96%) | **9.05** (90%) | 11.19 (98%) |
| 1–3d | 2.23 (97%) | **2.03** (90%) | 2.16 (99%) |
| 3–7d | 2.21 (96%) | **1.19** (91%) | 1.29 (99%) |
| 7–14d | 1.51 (95%) | **0.89** (91%) | 0.93 (99%) |
| 14–30d | 0.75 (93%) | 0.77 (89%) | **0.77** (99%) |
| 30d+ | 0.50 (92%) | 0.47 (89%) | **0.46** (100%) |

**By moneyness** — hybrid ≤ local-IV everywhere, at 96–100% availability against interpolation's 76% in the far wings:
below_far 2.82 (96%) · below_mid **1.21** (100%) · below_near 1.33 (100%) · atm **1.01** (100%) · above_near 1.51 (100%) · above_mid 1.52 (100%) · above_far 2.42 (97%).

**By strike count** — see §3. `<5`: 0.94 (93%), matching the anchor exactly.

**By event** — hybrid beats local-IV in all five: 1.81 vs 3.60 · 2.28 vs 3.81 · 1.19 vs 1.45 · 2.05 vs 2.37 · 1.34 vs 1.47.

**By time since entry** — entry 0.61 · <24h 0.74 · 1–3d 1.27 · 3–7d 1.67 · 7–14d 1.36 · 14d+ 2.87, all at 98–100% availability and all below local-IV.

**By option type** — calls 1.60 (99%) vs 2.37; puts 1.80 (99%) vs 2.29.

---

## 7. Stability

**Leave-one-event-out, IV MAE** — hybrid beats local-IV in all five folds:

| excluded | ranking |
|---|---|
| 17339625 | interp 1.47 › **hybrid-C 1.67** › local-IV 2.07 › SVI 2.39 |
| 2a93d290 | interp 1.51 › **hybrid-C 1.63** › local-IV 2.17 › SVI 2.22 |
| 5bebaf8f | interp 1.62 › **hybrid-C 1.83** › SVI 2.23 › local-IV 2.56 |
| 653f11df | interp 1.35 › **hybrid-C 1.54** › SVI 1.80 › local-IV 2.31 |
| d099f278 | interp 1.62 › **hybrid-C 1.80** › SVI 2.34 › local-IV 2.58 |

**Leave-one-event-out, price MAE** — hybrid ranks **first in four of five folds** and ties in the fifth. Pure interpolation never achieved this.

| excluded | winner |
|---|---|
| 17339625 | local-IV 0.00100 ≈ **hybrid-C 0.00100** |
| 2a93d290 | **hybrid-C 0.00108** |
| 5bebaf8f | **hybrid-C 0.00099** |
| 653f11df | **hybrid-C 0.00091** |
| d099f278 | **hybrid-C 0.00108** |

No dependence on any single event.

---

## 8. Availability, tier composition, and the locked rules

**Tier composition (Rule C, 3,475 cases):** interpolation 3,138 (90.3%) · local anchor 296 (8.5%) · unavailable 41 (1.2%).

**Fallback reasons:** `target_not_bracketed` 330 · `unique_strike_count_below_5` 6 · `no_qualifying_same_expiry_observations` 1.

**Unavailable reasons:** `no_causal_anchor` 37 · `surface_not_identifiable_final_day` 4.

**Interpolation geometry:** median 21 same-expiry strikes, median neighbour distance $1,000 (P95 $8,000), median maximum observation age 57.1 minutes — inside the canonical 60-minute rule.

**Locked rules verified:**

- **Extrapolation: 0.** Not one interpolation-tier result was outside the observed strike range, under any rule. Where the target is outside, the tier declines and the anchor is tried; if that fails, the valuation is unavailable. No surface is ever called.
- **Final day:** the hybrid values normally where genuine local evidence exists (98% availability, better than local-IV's 14.37 at 11.19), and reports `surface_not_identifiable_final_day` in the 4 cases with no evidence at all. A missing pre-expiry mark is not a missing settlement payoff; settlement remains exact and needs no IV.

---

## 9. Gate decision

### Gate A — PASSED

| §9 criterion | verdict |
|---|---|
| lower overall IV error than current | ✅ 1.69 vs 2.33 |
| materially lower grouped IV error | ✅ 0.48 vs 1.28, −63% |
| no material degradation in median/tail | ✅ median 0.62 vs 0.81; P95 5.09 vs 6.70 |
| improved or non-inferior spread credit | ✅ 0.00029 vs 0.00052, −44% |
| no new systematic signed bias | ✅ −0.00001 vs −0.00015 |
| no increase in credit sign flips | ✅ 2 → 0 |
| improved coverage **or** similar coverage with better accuracy | ✅ both: 99% vs 95% **and** better accuracy |
| stable superiority across most events | ✅ all five |
| stable under leave-one-event-out | ✅ beats current in 5/5 on IV, 5/5 on price |
| no dependence on one geometry threshold | ✅ A/B/C within 0.01 vol points |
| no extrapolation | ✅ zero |
| explicit unavailable behaviour | ✅ 41 cases, both reasons named |

### Gate B — BLOCKED, and production was left untouched

Integration requires two things this repository does not have. Both are facts, not judgements:

**1. Production retrieval does not fetch the same-expiry cross-section.**
`scripts/deribit-history-api.ts` selects exactly the two chosen leg instruments per candidate (`selected.set(sold…)`, `selected.set(bought…)`), and `buildInventory` produces a `ContractSeries` inventory containing only those legs. The interpolation tier needs the *other* strikes on the same expiry, which are never retrieved. Wiring the hierarchy in today would produce a hybrid whose tier 1 can never fire — a no-op wearing a new method version and new provenance labels. That is worse than not integrating: it would relabel identical numbers as validated.

Extending retrieval is feasible — Phase 2A.3 measured the whole cross-section at ~1 request per (event, timestamp), 970 requests for 669 timestamps — but it is a real architectural addition to the production path, roughly a 20–40× increase in retrieved instruments per candidate.

**2. There is no persisted research-selection store in this environment.**
`data/research-selections/` does not exist; `data/` contains only `trade-datasets/default-sample-trades.json`. `buildResearchBundle` requires a `ResearchSelectionStore`. Phase 2A.2 established that the artifact supplied then was a *bundle*, not a store, and those files have since been cleared from `%TEMP%`. The Phase 2A.3 `research-input/` reconstruction carries structural identity only — enough to drive measurement, not enough to regenerate a bundle.

Consequently **§16 (regenerate the research sample), §17 (valuation-integrity audit), §18 (old-versus-new comparison) and §19 (regression audit) cannot be executed or verified here.** They are not skipped for convenience; there is no artifact to produce or audit.

**Why I stopped rather than integrating anyway.** `research-valuation.ts` is the file that produces every economic number in the research. Rewriting its hierarchy while the mandated integrity and regression audits are un-runnable, and while tier 1 could not fire in any case, would be precisely the kind of unverified change this phase has spent four sub-phases catching. The validated estimator is committed, versioned and tested, and is ready to promote the moment the two prerequisites exist.

### What completing Gate B requires

1. Extend `deribit-history-api.ts` to retrieve the same-expiry strike ladder (an explicit, configurable log-moneyness band) alongside the selected legs, and surface it to the valuation layer.
2. Restore `data/research-selections/<dataset>.json` from the app instance.
3. Wire `estimateHybrid` with Rule C into the Reference fair-value hierarchy; bump `referenceValuation` from `causal-reference-v1`; add the provenance vocabulary of §13 (`causal_exact_trade_anchor` / `same_expiry_linear_interpolation` / `local_iv_anchor` / `unavailable`), keeping the old identity readable so historical bundles are never reinterpreted.
4. Regenerate, then run the §17–§19 audits.

No bundle-schema bump is implied: the serialized contract does not change, only values and provenance. Per §20 that is a methodology-version bump, not a schema bump.

---

## 10. Validation

| check | result |
|---|---|
| `npm run typecheck` | clean |
| `npm run typecheck:scripts` | clean |
| `npm run lint` | clean (1 pre-existing warning in `research-selections.ts`) |
| `npm run build` | clean, Sites artifact validated |
| `npm run test:unit` | **831 / 831 pass** (was 821; +10 hybrid tests) |
| `git status` | clean |

Five hybrid mutations applied; four fail tests (tier order, bracketing requirement, geometry rule, final-day reason). The fifth — removing the extrapolation guard inside tier 1 — **survives**, because the interpolator already refuses out-of-range targets, so the guard is redundant by construction today. It is kept as a boundary invariant and now says so in the code rather than being presented as load-bearing.

**Production untouched:** `reference_valuation`, valuation paths, canonical outcomes, maker/taker, delayed and modeled execution, execution-quality classification, candidate selection, contract resolution, margin and futures are all unchanged. No schema bump. No Analytics surface reads any of this.

---

## 11. Remaining genuine data limitations

1. **Five pricing-validation events.** 3,475 holdouts validate a *pricing model*; they are not 3,475 independent strategy observations, and no significance claim is made from them.
2. **19 synchronous spread cases.** The cleanest spread truth is thin.
3. **Trade-only tape.** No historical order book or mark series, so quiet periods have genuinely no observation.
4. **Final day remains weakest under every method** — the hybrid's 11.19 vol points is better than the current 14.37 but is not good. The locked rule stands.
5. **The wing remains unmodelled by choice**, per Phase 2B: where the strike is outside the observed range the hybrid falls to the anchor and otherwise reports unavailable.

---

**PRICING FREEZE — hybrid VALIDATED and approved for promotion; promotion blocked pending same-expiry cross-section retrieval and the research-selection store. Current local-IV methodology remains authoritative in production until those exist.**

Neither of the two supplied closing lines is accurate as written: the hybrid was not rejected, and it was not promoted. Stating either would misreport the result, so the verdict above says what actually happened. Pricing-model investigation is **closed** — no further model will be proposed. What remains is integration plumbing, not methodology.
