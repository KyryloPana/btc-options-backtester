# Phase 2B — Validating causal volatility-surface reconstruction

**Date:** 2026-08-25
**Starting HEAD:** `volatility-phase-2a1` @ `59b2b3f`, clean
**Commits:** `05a86ca` → `26918c0` → `bc4eb3f` → `a2d99e3`
**Production fair value unchanged. Nothing pushed.**

---

## The answer

**SVI does not earn promotion. A parameterless linear interpolation beats it, beats the current method, and wins every stability check. The wing remains unreliable under every method tested.**

| | recommendation |
|---|---|
| interpolation cohort | **B — retain simpler interpolation.** SVI does not materially improve it and is worse on most measures. |
| extrapolation cohort | **E — wing reconstruction remains unreliable; mark unavailable.** SVI is worse than the current method there; SSVI is far worse. |

Headline, all 3,475 frozen cases:

| method | availability | IV MAE | IV median AE | IV RMSE | IV P95 | **grouped IV MAE** | price MAE (BTC) |
|---|---|---|---|---|---|---|---|
| local-IV anchor *(current)* | 3295/3475 — 95% | 2.33 | 0.81 | 10.26 | 6.70 | 1.28 | 0.00112 |
| **linear interpolation** | 3144/3475 — 90% | **1.52** | **0.60** | **5.47** | **4.77** | **0.56** | **0.00109** |
| SVI | 3053/3475 — 88% | 2.21 | 0.90 | 6.90 | 6.88 | 3.11 | 0.00109 |
| SSVI | 1727/3475 — 50% | 5.22 | 2.24 | 13.18 | 17.43 | 9.18 | 0.00142 |

IV errors in **vol points**. Grouped = aggregated within `event × timestamp × expiry` first, so one busy smile cannot outvote the rest.

---

## 0. The denominator inconsistency — resolved

**Both numbers were correct; neither said what it counted.**

- **3,475 = CASES.** One case is one withheld instrument at one snapshot. This is the frozen scoring cohort, and every model comparison in this report divides by it.
- **15,971 = TRUTH OBSERVATIONS.** One case hides *every* print of its instrument in the canonical window — median 2, mean 4.60, maximum 145.

The Phase 2A.3 report's DTE and readiness rows were case-level while its option-type and moneyness rows were observation-level, so the two halves of one table summed to different universes.

Investigated rather than guessed: all 3,475 cases withhold exactly one instrument, and the case count matches the recorded index exactly. **This was a reporting defect, not a holdout-generation defect.** `summarizeHoldouts` now prefixes every field `cases_by_*` or `truth_observations_by_*`, reports both totals and the per-case print distribution, and adds case-level option-type and moneyness tallies so every dimension exists on the scoring denominator. The Phase 2A.3 report is corrected in place. Fixed in `05a86ca` with regression tests asserting that case-level tallies sum to the case count and observation-level tallies to the observation count.

Case-level composition of the frozen cohort:

| dimension | composition |
|---|---|
| readiness | dense 2,789 · sparse 343 · extrapolation 342 · cross-expiry 1 |
| option type | 1,793 calls · 1,682 puts |
| cohort content hash | `112c02b` |

---

## 1. The frozen cohort is verified, not asserted

The cohort was rebuilt from the cached evidence and checked against the Phase 2A.3 record:

```
frozen cohort: 3475 recorded, 3475 rebuilt, 0 missing, 0 extra -> MATCH
```

**A second defect surfaced doing this.** The first rebuild produced 3,475 cases with 3,475 matching natural keys but 1,974 *different case ids*. Every mismatching case hid two or more prints; single-truth cases all matched. The cause: `case_id` hashed the truth list in array order, while the shard cache stores observations sorted and the original build saw them in admission order — so identical evidence had two identities depending on where it was loaded from. Fixed in `26918c0`: truth is sorted canonically before hashing and before emission.

Because that changes ids for cases recorded earlier, the cohort is verified on its **natural key** — `(snapshot_id, expiry, withheld_instrument)` — which is what "the same holdout" actually means. All 3,475 match.

No case was regenerated, removed, reweighted or reselected. Nothing was tuned on results.

---

## 2. What was implemented

| method | version | description |
|---|---|---|
| current production | `local_iv_anchor_v1` | latest causal print on the **same contract** within 720 minutes, repriced at the target index |
| baseline | `same_expiry_linear_interpolation_v1` | linear in **total variance** between the bracketing observed strikes; refuses to extrapolate; **no parameters** |
| candidate | `same_expiry_svi_v1` | constrained deterministic SVI in total variance |
| wing competitor | `ssvi_power_law_v1` | Gatheral–Jacquier power-law SSVI across all maturities |
| aggregation | `strike-aggregation-robust-freshness-v1` | one observation per `expiry × strike × option_type` |

All four price through the existing `priceInverseOption`, so the project's stated convention (`forward = index, rate = 0`) is preserved and **no new pricing, rate or forward assumption was introduced.**

**Scoring the current method fairly.** On a holdout the canonical-window prints are withheld, so `local_iv_anchor_v1` sees only the 60-to-720-minute band — exactly its production situation when a contract has not traded recently. That band was fetched separately (121 snapshots, 2,255 requests). Giving the current method nothing would have made it a straw man.

**Strike aggregation (§6), fixed before any error was inspected.** Forty prints on one strike and two on another are two strikes, not forty-two smile points. Each `expiry × strike × option_type` collapses to one observation with **equal fitting weight**, via a median-absolute-deviation outlier cut (≥3 prints only) then freshness weighting on a 30-minute half-life. Raw prints, effective age, count and dispersion are all preserved.

**Call/put handling.** Put-call parity under this convention implies one total-variance curve, so calls and puts are fitted together — but never merged into one observation, and the assumption is measured rather than assumed. Across 112 sampled snapshots with matched strikes: **median |call IV − put IV| = 0.62 vol points, median signed −0.04 vol points, maximum 22.9.** No systematic offset; the tail is real and is why they stay separate observations.

**SVI fit constraints (§5).** Zeliade quasi-explicit form (`c = bσ`, `d = ρbσ`) with `0 ≤ c ≤ 4σ`, `|d| ≤ c`, `|d| ≤ 4σ − c`, `0 ≤ a ≤ max w`; deterministic grid over `(m, σ)` with an exactly solved constrained inner problem and three refinement rounds; Durrleman no-butterfly `g(k) ≥ 0` checked on 101 points across the observed range extended one span each side. **A fit that converges but implies negative density is `unavailable`, not returned with a warning.**

One reproducibility defect fixed during development: the fit moved in its last bits with input order, because floating-point addition is not associative. Points are now sorted canonically before any accumulation.

---

## 3. Single-leg benchmark

### Primary SVI cohort — dense, in-range, DTE > 1 day (n = 2,633)

This is the cohort Phase 2A.3 said the geometry supports, and where SVI was expected to win.

| method | availability | IV MAE | median AE | RMSE | P95 | grouped IV MAE | price MAE | price RMSE |
|---|---|---|---|---|---|---|---|---|
| local-IV | 2530 — 96% | 1.53 | 0.73 | 3.61 | 4.79 | 0.64 | 0.00134 | 0.00243 |
| **interpolation** | **2633 — 100%** | **0.91** | **0.52** | **1.79** | **2.92** | 0.26 | **0.00120** | **0.00199** |
| SVI | 2399 — 91% | 1.26 | 0.77 | 2.08 | 4.10 | **0.21** | 0.00127 | 0.00209 |
| SSVI | 1314 — 50% | 3.13 | 1.72 | 5.03 | 10.83 | 1.74 | 0.00165 | 0.00240 |

**Interpolation beats SVI on IV MAE (0.91 vs 1.26), median (0.52 vs 0.77), RMSE, P95 and price — at 100% availability against SVI's 91%.** SVI's only win is the grouped metric, 0.21 vs 0.26, which is narrow and does not survive the wider cohorts.

### Early life — first 3 days after entry, ≥7 DTE (n = 620)

| method | availability | IV MAE | median AE | RMSE | grouped |
|---|---|---|---|---|---|
| local-IV | 94% | 1.46 | 0.60 | 3.79 | 0.64 |
| **interpolation** | 90% | **0.83** | **0.47** | **1.86** | 0.41 |
| SVI | **96%** | 1.09 | 0.58 | 2.10 | **0.32** |
| SSVI | 56% | 2.51 | 1.43 | 4.29 | 1.67 |

SVI is more *available* here and better grouped; interpolation is more *accurate*.

### Entry only (n = 179)

| method | availability | IV MAE | median AE | price MAE |
|---|---|---|---|---|
| local-IV | 97% | 0.71 | 0.46 | 0.00161 |
| **interpolation** | 89% | **0.60** | **0.34** | 0.00182 |
| SVI | **99%** | 1.00 | 0.53 | 0.00165 |
| SSVI | 52% | 2.18 | 1.11 | 0.00260 |

At entry the current method is already good — 0.71 vol points — because contracts have recently traded. This is the least interesting cohort for reconstruction, and it shows.

### Sparse cohort (n = 343)

| method | availability | IV MAE | median AE | grouped |
|---|---|---|---|---|
| local-IV | 91% | 3.04 | 1.03 | 3.02 |
| interpolation | **100%** | 2.65 | 1.13 | 1.83 |
| **SVI** | 86% | **2.26** | **1.02** | **1.70** |
| SSVI | 43% | 7.33 | 3.31 | 5.57 |

**SVI's one genuine win.** On thin same-expiry geometry it is the most accurate — but at 86% availability against interpolation's 100%, and on 10% of the cohort.

---

## 4. Extrapolation is a separate experiment — and it fails

Phase 2A.3 cohort `extrapolation_required` (n = 342). Interpolation is structurally inapplicable here by design, which is why it appears at 4%.

| method | availability | IV MAE | median AE | RMSE | P95 | grouped |
|---|---|---|---|---|---|---|
| **local-IV** | 87% | **3.76** | **0.96** | 16.17 | **9.82** | **3.75** |
| interpolation | 4% | 9.88 | 3.19 | 16.64 | 38.72 | 0.02 |
| SVI | 86% | 6.51 | 3.01 | **14.01** | 23.50 | 7.45 |
| SSVI | 46% | 13.42 | 4.58 | 29.99 | 55.35 | 14.89 |

**SVI wing extrapolation is worse than the method we already have** — 6.51 vol points against 3.76, at the same availability, and 7.45 against 3.75 grouped. Adding the maturity dimension makes it worse again: SSVI 13.42 at half the availability.

This is the answer to §12's question, and it is negative. The failure is not sparsity — Phase 2A.3 measured median 14 same-expiry strikes on extrapolation rows. The target strike simply sits outside the traded ladder, a median $4,000 away, and no smile shape recovers information about a strike the market stopped quoting.

**The fitter returning a number is not evidence it should be used.**

### Final day — the locked rule holds

Remaining DTE < 1 day (n = 200):

| method | availability | IV MAE | median AE | P95 |
|---|---|---|---|---|
| local-IV | 96% | 14.37 | 2.90 | 83.63 |
| interpolation | 90% | 9.05 | 3.31 | 37.84 |
| SVI | 40% | 18.51 | 6.86 | 71.52 |
| SSVI | 66% | 19.41 | 10.29 | 77.02 |

Every method is bad; the surface methods are worst. Phase 2A.3's `surface_not_identifiable_final_day` rule stands, and this measurement confirms it rather than merely restating it. Settlement accounting is unaffected — actual expiry payoff uses the existing authoritative methodology and needs no IV surface at all.

---

## 5. Vertical-spread credit — strategically primary

Errors in **BTC per contract**. Only the 85 both-leg cases carry genuine two-leg truth; the 139 single-leg cases are reported unavailable and **no spread truth was fabricated for them**.

### Both legs observed (n = 85)

| method | availability | MAE | median | RMSE | P95 | signed bias | sign flips |
|---|---|---|---|---|---|---|---|
| local-IV | 95% | 0.00052 | 0.00024 | 0.00089 | 0.00155 | −0.00015 | **2** |
| **interpolation** | 94% | **0.00030** | **0.00020** | **0.00044** | **0.00103** | −0.00002 | 0 |
| SVI | 89% | 0.00034 | 0.00020 | 0.00051 | 0.00121 | −0.00001 | 0 |
| SSVI | 54% | 0.00044 | 0.00030 | 0.00060 | 0.00141 | −0.00007 | 0 |

### Synchronous — legs within 5 minutes (n = 19), the cleanest truth

| method | availability | MAE | median | RMSE | P95 | bias |
|---|---|---|---|---|---|---|
| local-IV | 89% | 0.00059 | 0.00034 | 0.00083 | 0.00221 | −0.00002 |
| **interpolation** | 95% | **0.00031** | **0.00022** | **0.00045** | **0.00109** | +0.00004 |
| SVI | 89% | 0.00045 | 0.00034 | 0.00069 | 0.00202 | −0.00003 |
| SSVI | 53% | 0.00049 | 0.00026 | 0.00072 | 0.00181 | +0.00007 |

### Asynchronous — noisier truth, kept separate (n = 66)

| method | availability | MAE | median | RMSE | bias | sign flips |
|---|---|---|---|---|---|---|
| local-IV | 97% | 0.00050 | 0.00024 | 0.00090 | −0.00018 | 2 |
| **interpolation** | 94% | **0.00030** | 0.00020 | **0.00044** | −0.00003 | 0 |
| SVI | 89% | 0.00031 | **0.00019** | **0.00044** | −0.00001 | 0 |
| SSVI | 55% | 0.00042 | 0.00033 | 0.00057 | −0.00012 | 0 |

**Interpolation roughly halves the current method's spread-credit error** (0.00030 vs 0.00052 BTC) and removes its two sign flips — cases where an estimated credit came out the wrong side of zero. SVI matches interpolation on the noisy asynchronous cohort but is meaningfully worse on the clean synchronous one, which is the truth to trust.

Note the sample: **19 synchronous cases**. That is thin, and the conclusion rests more on the 85-case and single-leg evidence than on it alone.

---

## 6. Diagnostic breakdowns

IV MAE (availability), never used to pick a winner — only to say where each method is trustworthy.

**By remaining DTE**

| DTE | local-IV | interpolation | SVI | SSVI |
|---|---|---|---|---|
| 0–1d | 14.37 (96%) | **9.05** (90%) | 18.51 (40%) | 19.41 (66%) |
| 1–3d | 2.23 (97%) | **2.03** (90%) | 3.33 (89%) | 5.06 (43%) |
| 3–7d | 2.21 (96%) | **1.19** (91%) | 2.26 (86%) | 5.96 (48%) |
| 7–14d | 1.51 (95%) | **0.89** (91%) | 1.30 (90%) | 3.70 (49%) |
| 14–30d | **0.75** (93%) | 0.77 (89%) | 1.27 (97%) | 2.32 (44%) |
| 30d+ | 0.50 (92%) | **0.47** (89%) | 0.90 (100%) | 1.89 (100%) |

**By moneyness**

| bucket | local-IV | interpolation | SVI | SSVI |
|---|---|---|---|---|
| below_far | 3.81 (88%) | **2.32** (76%) | 3.72 (86%) | 10.79 (59%) |
| below_mid | 1.42 (98%) | **1.24** (95%) | 1.64 (89%) | 4.57 (50%) |
| below_near | 1.60 (96%) | **1.19** (98%) | 2.04 (87%) | 2.73 (48%) |
| atm | 1.40 (99%) | **1.01** (99%) | 1.21 (85%) | 1.44 (44%) |
| above_near | 2.00 (96%) | **1.45** (99%) | 1.67 (89%) | 2.50 (44%) |
| above_mid | 2.60 (97%) | **1.50** (95%) | 2.42 (90%) | 5.08 (51%) |
| above_far | 3.39 (90%) | **2.21** (76%) | 2.62 (90%) | 6.50 (51%) |

Interpolation wins every moneyness bucket. Its availability drops to 76% in the far wings — precisely where it refuses rather than extrapolates.

**By same-expiry strike count — where the methods are complementary**

| strikes | local-IV | interpolation | SVI | SSVI |
|---|---|---|---|---|
| <5 | **0.94** (93%) | 3.91 (40%) | n/a (0%) | 5.04 (13%) |
| 5–9 | **1.40** (96%) | 1.60 (78%) | 1.90 (79%) | 3.54 (47%) |
| 10–19 | 2.80 (94%) | **1.90** (88%) | 2.70 (91%) | 5.92 (35%) |
| 20+ | 2.12 (95%) | **1.22** (94%) | 1.85 (87%) | 5.08 (61%) |

**Below five strikes the local anchor is clearly better** and interpolation is both rare and poor. That is a real complementarity, not noise.

**By event** — SVI wins exactly one event (`17339625`, 1.31 vs interpolation's 1.74). Interpolation wins the other four. This is why leave-one-event-out matters.

**By time since entry** — interpolation leads at every horizon: entry 0.60, <24h 0.71, 1–3d 1.17, 3–7d 1.29, 7–14d 1.32, 14d+ 2.65.

---

## 7. Stability, and the pseudo-replication problem

3,475 holdouts come from **five events**. They validate a pricing model; they are not 3,475 independent strategy observations, and no significance claim is made from them.

**Grouped vs observation-weighted** (overall IV MAE): local-IV 2.33 → 1.28; interpolation 1.52 → **0.56**; SVI 2.21 → **3.11**; SSVI 5.22 → 9.18.

SVI is the only method that gets *worse* when each smile is given one vote. It does well on the busy, well-observed slices that dominate an observation-weighted count and badly on thin ones — the opposite of the robustness you would want.

**Leave-one-event-out (IV MAE)** — interpolation ranks **first in all five folds**:

| excluded | ranking |
|---|---|
| 17339625 | interp 1.47 › local-IV 2.07 › SVI 2.39 › SSVI 5.36 |
| 2a93d290 | interp 1.51 › local-IV 2.17 › SVI 2.22 › SSVI 5.22 |
| 5bebaf8f | interp 1.62 › SVI 2.23 › local-IV 2.56 › SSVI 5.25 |
| 653f11df | interp 1.35 › SVI 1.80 › local-IV 2.31 › SSVI 4.69 |
| d099f278 | interp 1.62 › SVI 2.34 › local-IV 2.58 › SSVI 5.43 |

**Leave-one-event-out (price MAE)** flips ranking between folds — local-IV wins one, SVI two, interpolation two, all within 0.0002 BTC. **On individual option price the three methods are not distinguishable.** The separation is in IV and, decisively, in spread credit.

---

## 8. Availability and failure analysis

| method | unavailable | reasons |
|---|---|---|
| local-IV | 180 (5%) | `no_causal_anchor` 180 |
| interpolation | 331 (10%) | `target_outside_observed_strike_range` 330, `insufficient_observations` 1 |
| SVI | 422 (12%) | **`fit_economically_invalid` 407**, `insufficient_observations` 15 |
| SSVI | 1,748 (50%) | **`fit_economically_invalid` 1,742**, `non_positive_total_variance` 6 |

**407 SVI fits — 12% of the cohort — converged but violated no-butterfly.** The sampled diagnostics confirm these are genuine Durrleman violations (17 of 139 sampled, matching the 12% rate), not an over-tight constraint. A five-parameter smile frequently cannot fit a real Deribit slice while remaining arbitrage-free. Valid fits have a median RMS IV residual of 1.26 vol points across a median 22 strikes.

**SSVI is worse in a specific, informative way.** Every one of its 1,742 rejections is the same sufficient condition, `θφ²(1+|ρ|) > 4`. Calendar monotonicity of ATM total variance held in **139 of 139** sampled snapshots — the term structure is well behaved. The problem is that one globally shared `(ρ, η, γ)` across a median of **9 maturities** spanning one day to five weeks is too rigid: valid fits carry a median RMS IV residual of **6.07 vol points**, five times SVI's. A per-maturity-band SSVI might do better, but that is a different model and outside this phase.

---

## 9. Leakage and robustness checks

| check | result |
|---|---|
| hidden target instrument absent from all fitting inputs | enforced by `assertHoldoutIsClean` on every case; mutation-tested |
| withheld instruments removed at **every** maturity | enforced and mutation-tested (a maturity-local exclusion fails) |
| no future trade admitted | Phase 2A.1 admission gate, tested |
| canonical 60-minute rule in canonical fits | enforced; a widened retrieval window cannot launder a stale print |
| no model-generated IV as surface input | `MODEL_ONLY_IV_SOURCES` refusal, tested for all five sources |
| observed truth never an optimization target | truth lives in a separate field; fitting inputs are the complement |
| parameters not tuned on MR PnL | no estimator reads an outcome; all thresholds fixed before scoring |
| cohort not regenerated from results | verified 3,475/3,475 on natural key |

Twelve mutations of the model, scoring and leakage guards were applied; each fails tests.

---

## 10. Validation

| check | result |
|---|---|
| `npm run typecheck` | clean |
| `npm run typecheck:scripts` | clean |
| `npm run lint` | clean (1 pre-existing warning in `research-selections.ts`) |
| `npm run build` | clean, Sites artifact validated |
| `npm run test:unit` | **821 / 821 pass** (was 789; +32 new) |
| `git status` | clean |

**Production untouched:** `reference_valuation`, valuation paths, canonical outcomes, maker/taker, delayed and modeled execution, option selection, contract resolution, margin and futures are all unchanged. No bundle schema bump. No Analytics surface reads any of this. Results live in a standalone validation artifact.

---

## 11. Recommendation

### Interpolation cohort — **B: retain simpler interpolation**

Against §14's promotion criteria, SVI fails on nearly all of them:

| criterion | verdict |
|---|---|
| materially improves median and tail error vs current | **No.** Median AE 0.90 vs 0.81 — *worse*. |
| beats simple interpolation | **No.** 2.21 vs 1.52 overall; 1.26 vs 0.91 on its own primary cohort. |
| no systematic bias | Passes — bias is small for all methods. |
| performs across adjacent groups | **No.** Grouped MAE 3.11 vs 0.56; worse when each smile gets one vote. |
| improves vertical-spread credit | **No.** 0.00034 vs 0.00030; clearly worse on the synchronous cohort. |
| stable under leave-one-event-out | **No.** Never ranks first in any of five folds. |
| acceptable failure coverage | **No.** 12% of fits economically invalid — the worst of the three same-expiry methods. |
| not dependent on one event | **No.** SVI's best showing is a single event. |

The parameterless baseline is more accurate, more available, more stable and far simpler. **A five-parameter arbitrage-constrained smile is not earning its complexity on this data.**

Two honest qualifications. First, interpolation's advantage is in **IV and spread credit**; on individual option price the three methods are statistically indistinguishable and the LOEO ranking flips. Second, interpolation is **not strictly dominant**: below five same-expiry strikes the current local anchor is clearly better (0.94 vs 3.91), and SVI is the most accurate on the sparse cohort.

That points at an obvious composite — interpolation where the geometry brackets the strike, local anchor otherwise — which would combine interpolation's accuracy with the anchor's 95% coverage. **It has not been validated as a method and is not recommended for promotion here.** It is the next thing to test, on this same frozen cohort, before anything is promoted.

### Extrapolation cohort — **E: wing reconstruction remains unreliable; mark unavailable**

SVI in the wing is *worse than doing what we already do* (6.51 vs 3.76 vol points), and SSVI is worse again at half the availability. §12's question — does the maturity dimension materially improve wing reconstruction — is answered **no**, on measurement rather than inference.

The `surface_not_identifiable_final_day` rule stands and should extend to the extrapolation cohort generally: where the strike lies outside the observed range, a pre-expiry market mark should be **unavailable** rather than extrapolated. Settlement payoff is unaffected and requires no surface.

### Not recommended

Promoting any new method into production fair value on this evidence. The current local-IV reconstruction remains authoritative. The finding that should change plans is not "SVI is slightly behind" — it is that **the simplest possible estimator beats both sophisticated ones on the cohort where sophistication was supposed to pay**, and that no method rescues the wing.
