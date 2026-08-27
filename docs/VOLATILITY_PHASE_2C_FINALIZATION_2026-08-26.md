# Phase 2C Finalization — Recompute driver, migration and pricing freeze

**Date:** 2026-08-26
**Starting HEAD:** `volatility-phase-2a1` @ `f93c5b9`, clean, 4 commits ahead of origin
**Commits:** `bdfafa2` → `c8fea8e` → `3614774`

---

## Outcome

**The 28 persisted structures are recomputed under `causal-reference-v2-hybrid-interpolation`, the canonical bundle regenerates and validates, and structural identity is provably unchanged.**

Two defects in my own Gate B promotion surfaced during the migration and were fixed. Both were real, and neither was a coverage trade-off to be argued about — they were things the promotion had silently broken.

| | |
|---|---|
| structures recomputed | **28 / 28** |
| structural identity differences | **0** |
| bundle validates | **yes**, schema 3.7.0 |
| path points matched against v1 | **2,352 / 2,352** |
| outcomes matched | **252 / 252** |
| settlement changes | **0** |
| API requests | 965 |

---

## 1. Recompute driver (`bdfafa2`)

Gate B's blocker was that `recomputeSelectedResearch` and `ResearchSelectionService.recompute` both existed and were tested while **nothing called either**. The driver is now wired around that seam rather than around a new one.

`POST /__local/research-selections/:id/recompute`, with the engine injected so the route is testable without a network, plus `scripts/run-research-recompute.ts` for headless use.

**The engine reuses the save flow's components** — contract resolution with the same-expiry ladder, `buildExpiryCandidates`, `evaluateResearchEntryLayers`, `buildEstimatedPath`, `buildResearchOutcomes`, `analyzeDelayedExecution` — assembled through a new shared `buildDerivedResearchOutput` that the save flow now also uses. A second copy of that assembly would have been free to drift, and the two paths would have started producing different economics from the same evidence.

**The underlying candle path comes from the saved `generationSnapshot`**, so a recompute values against exactly the underlying the selection was generated against. Refetching it would let an unrelated candle revision move the economics and be misread as a pricing change.

**Reselection is impossible by construction, not by discipline.** `recomputeSelectedResearch` copies structural identity from the saved selection and accepts only derived fields; the runner additionally diffs the complete structural identity — candidate id, venue, option type, structure, strike method, requested and actual strikes, width, expiry, horizon, quantity — and refuses to write if anything moved. A test hands the engine a hostile output containing candidate ids, a candidate snapshot and a quantity, and asserts none of it lands.

**Atomicity was already correct in the service** (validate the whole store, then write). Tests cover a failing engine, a mid-run failure after partial success, malformed output, and a concurrent edit — each leaves the saved store byte-identical.

---

## 2. Two defects the migration exposed (`c8fea8e`)

### The hierarchy applied at entry and nowhere else

Path marks were priced by `modelMark`, which only knew the synchronized anchor pair and the entry-anchored constant fallback. **The promoted hierarchy never reached the valuation path** — precisely the "one methodology at entry, another silently on the path" split the design forbids.

`modelMark` now tries bracketed same-expiry interpolation first under the same Rule C. Both legs read one snapshot at that timestamp, so an interpolated pair is coherent by construction. Effect on the real sample: path marks went from 100% anchor-or-constant to **50.4% interpolation**.

### The coherence rule had lost a search

My Gate B generalization compared only each leg's single preferred mark. The previous methodology's `selectSynchronizedIvAnchors` **walks both legs' causal anchors for a pair inside the window**. When one leg upgraded to fresh interpolation while the other still had a stale anchor, the pair read as incoherent and the mark was refused — even though a perfectly synchronized older anchor pair existed and v1 had used it.

That cost 2 of 28 structures their entry mark, and because their execution scenarios were also unavailable, **the whole recomputed store failed validation and could not be persisted**.

The fix restores the search rather than loosening the rule: when the preferred tiers disagree about *when* the market was, fall back to the synchronized anchor pair; refuse only if none exists. The fallback is recorded in provenance, and the saved source names the anchor pair that actually priced the mark rather than the tier a leg would have preferred.

This is the §6 quantification, and the honest version of it: the strict rule was not costing coverage on merits — it was costing coverage because my rewrite had dropped a search. **2 of 28 entry marks (7.1%) hit the fallback; 0 are refused.**

---

## 3. Structural integrity

| assertion | result |
|---|---|
| events | 6 → 6 |
| events with selections | 5 → 5 |
| selected structures | 28 → 28 |
| generated candidate universe | 627 → 627 |
| candidate ids identical | **yes** |
| structural differences | **0** |
| duplicate candidate ids | 0 |
| one economics row per candidate | **yes** (28) |
| execution rows | 56 (28 maker + 28 taker) |
| unavailable never coerced to zero | verified |

**Execution independence:** all 28 structures carry a Reference valuation; **24 have no evaluated execution scenario at all**, and all 24 still hold a Reference mark. Evaluated execution rows are 5 before and 5 after — the Reference change did not touch execution.

One pre-existing characteristic, checked rather than assumed: `actual_dte_days` in `candidates.jsonl` is derived per execution scenario, so 51 of 56 rows are null and 4 candidates carry two different values. **Identical before and after the migration** (`nullDte=51, scenarioDependent=4` both times), so it is an exporter characteristic, not a regression. Whether the exporter should derive DTE structurally is a separate question.

---

## 4. Production tier usage, measured

This replaces the Gate B inference of "roughly 76 / 20 / 4". Those numbers were explicitly flagged as unreliable because the Phase 2A.3 cache held only 60-minute windows. Measured on the real recompute with full production history:

| | interpolation | local anchor | constant-entry-IV | intrinsic-at-expiry |
|---|---|---|---|---|
| **entry** (28) | **75.0%** | 25.0% | — | — |
| **path** (2,352) | **50.4%** | 35.3% | 13.1% | 1.2% |
| **outcomes** (252) | **52.4%** | 16.3% | 3.2% | 28.2% unavailable |

Entry tier pairs: 19 interpolation/interpolation, 7 anchor/anchor, 2 interpolation/anchor resolved by the coherence fallback.

By event (entry + path):

| event | interpolation | anchor | constant | intrinsic |
|---|---|---|---|---|
| `17339625` | 46.4% | 37.8% | 14.5% | 1.3% |
| `2a93d290` | 72.0% | 22.0% | 4.2% | 1.7% |
| `5bebaf8f` | 52.3% | 40.5% | 6.2% | 0.9% |
| `653f11df` | 68.8% | 22.2% | 8.0% | 1.0% |
| `d099f278` | 35.3% | 43.2% | 20.4% | 1.1% |

The Gate B guess was close at entry and materially wrong on the path: the anchor tier is much larger than inferred, and `constant-entry-IV` — a pricing fallback that has always existed on the path, never market evidence — carries 13%.

---

## 5. Interpolation integrity

Every interpolation, entry and path: **1,207 points.**

| assertion | result |
|---|---|
| target genuinely bracketed | **all** |
| ≥5 unique qualifying strikes | **all**, 0 below the floor |
| evidence ≤60 minutes | **all** |
| SVI / SSVI / DVOL source present | **none** |
| own-leg prints excluded | enforced per leg |
| wing extrapolation | none |

Geometry on the entry marks, which carry the bracket detail: unique strikes min 5 / median 7 / max 12; bracket width min 2,000 / median 3,000 / max 4,000 USD; observation age min 1.5 / median 21.1 / P95 57.1 minutes.

The only entry decline reason was `unique_strike_count_below_minimum` (7 legs) — Rule C doing its job, not missing data.

---

## 6. Old versus new

All 28 transitioned from the overloaded `local_iv_interpolation` label to an explicit tier: **19 → `same_expiry_linear_interpolation`, 9 → `local_iv_anchor`.**

**Entry spread credit** (BTC per contract): median delta **0**, mean +0.000085, P90 +0.00050, P95 +0.00093, max +0.00169, min −0.00090. Median absolute 0.000115.

**Valuation path**: 2,352 matched, **0 old-only, 0 new-only** — coverage is identical. Median delta 0, P90 0.00029, P95 0.00054, max 0.01215. Median absolute 0.0000126.

**Outcomes**: 175 estimated→estimated, 71 unavailable→unavailable, **6 unavailable→estimated** — coverage improved, none lost.

| outcome | n | median Δ | P95 Δ | max Δ |
|---|---|---|---|---|
| VPOC | 13 | +0.000083 | +0.00065 | +0.00065 |
| 3D | 28 | −0.000019 | +0.00067 | +0.00155 |
| 5D | 28 | +0.000016 | +0.00133 | +0.00136 |
| 7D | 22 | 0 | +0.00033 | +0.00048 |
| Invalidation | 0 | — | — | — |

No invalidation outcome matched because none of these six events triggered invalidation.

**Credit-capture timing moved on 38 outcome rows** — expected, since the marks that trigger capture thresholds changed.

**Settlement: 28 compared, 28 identical, 0 differing.** Settlement is `unavailable` in both v1 and v2, for the same pre-existing reason — "Official Deribit delivery price is unavailable." That gap predates this work and was not introduced by it; settlement economics are invariant, as required.

The differences are small: a median of zero and a P95 around 0.0005 BTC per contract. This is a pricing-integrity comparison. Nothing here says the strategy is better or worse.

---

## 7. Retrieval and reuse

| | |
|---|---|
| API requests, whole migration | **965** |
| per event | 100 – 273 |
| ladder instruments retrieved per event | 32 – 86 |
| structures served | 28, across 5 events and 9 expiries |

Market state is resolved once per event and memoized, so nine structures on one event cost one resolve. Within a resolve, ladder instruments join the existing `selected` map keyed by instrument name and `fetchTradeRange` is cached by `(name, start, end)`, so a strike shared by the 1k, 2k and 3k widths — or by the maker and taker scenarios — is retrieved once.

---

## 8. Regenerated bundle

| | |
|---|---|
| schema | **3.7.0** |
| reference methodology | **`causal-reference-v2-hybrid-interpolation`** |
| effective configuration hash | **`14qrfox19ako29`** (unchanged) |
| validates | **yes** |
| events / candidates / availability | 6 / 56 / 627 |
| valuations / outcomes | 18,676 / 549 |
| structure economics / margin | 28 / 28 |
| evidence trades | 1,692 |

Every recomputed structure reports `causal-reference-v2-hybrid-interpolation`; none reports `causal-reference-v1`, and the legacy identity remains readable for older bundles.

Two notes on the counts. `evidence_trades` fell from 2,833 to 1,692 because interpolated marks cite neighbouring strikes rather than exact-contract anchors, so fewer exact-contract prints are recorded as evidence usages. And `event_volatility_state` / `structure_volatility_state` are **0** because the volatility tables are populated only when the volatility pipeline injects them into the exporter, exactly as Phase 2A.2 designed; they are unavailable-by-design here, not lost.

---

## 9. Validation

| gate | result |
|---|---|
| `npm run typecheck` | clean |
| `npm run typecheck:scripts` | clean |
| `npm run lint` | clean (1 pre-existing warning in `research-selections.ts`) |
| `npm run test:unit` | **873 / 873** (was 858; +15 new) |
| `npm run build` | clean, Sites artifact validated |
| bundle validator | **valid** |
| `git status` | clean |

New tests cover: recompute route and service invocation; unchanged selections genuinely recomputed rather than skipped; structural identity preserved against a hostile engine; derived fields refreshed; stale `causal-reference-v1` becoming current; scoped recompute leaving other structures untouched; the identity check detecting a moved strike, a lost candidate, an added one and a moved expiry; four atomicity failure modes; and the coherence fallback firing, being recorded, and still refusing when no synchronized pair exists.

---

## 10. Remaining genuine limitations

- **Settlement is unavailable for all 28**, because the official Deribit delivery price could not be retrieved. Pre-existing and unchanged by this work, but it means settlement economics are currently unproven rather than verified-equal.
- **Volatility state tables are empty in the regenerated bundle.** By design — they need the volatility pipeline injected into the exporter. Populating them is a separate run.
- **Path marks record their tier as `ivSource`, not full leg provenance.** Enough to audit which tier priced each point, not enough to audit the bracketing strikes used at a path point the way entry marks allow.
- **`constant-entry-IV` carries 13.1% of path marks.** It is a legitimate pricing fallback and Phase 2A guards keep it out of market-IV evidence, but it is not market evidence and should not be read as such.
- **Five events.** This is a pricing migration on a small sample; it validates the methodology, not the strategy.

---

**PRICING FREEZE COMPLETE — existing 28 selected structures recomputed under `causal-reference-v2-hybrid-interpolation`; canonical research bundle regenerated and validated.**
