# Phase 2C Gate B — Hybrid promoted, regeneration blocked

**Date:** 2026-08-26
**Starting HEAD:** `volatility-phase-2a1` @ `4a38331`, clean, in sync with origin
**Commits:** `f8cafce` → `50bd4f1` → `ea0038a`

---

## Outcome, up front

**The hybrid is promoted and live end-to-end. The canonical research bundle was not regenerated, because the recompute path has no driver.**

That is a concrete blocker, not a shortfall of effort, and it is stated rather than worked around. Production Reference fair value now runs the validated hierarchy; what has not happened is the regeneration of the saved research sample and the old-versus-new comparison that depends on it.

| deliverable | status |
|---|---|
| Supplied store validated | ✅ clean, 0 mismatches |
| Cross-sectional retrieval with snapshot reuse | ✅ `f8cafce` |
| Hybrid promoted into Reference fair value | ✅ `50bd4f1` |
| Provenance, versioning, tier identity | ✅ `50bd4f1` |
| Tier usage measured on the real structures | ✅ `ea0038a` |
| **Bundle regeneration + old-vs-new comparison** | ❌ **blocked — see §7** |

---

## 1. The supplied ResearchSelectionStore validates cleanly

Loaded through the repository's own `migrateResearchSelectionStore`, not a bespoke reader.

| | |
|---|---|
| declared / migrated schema | `1.8.0` / `1.8.0` (current) |
| dataset | `default-sample-trades` |
| updated | 2026-08-25T13:16:19.720Z |
| events | **6** |
| events with selections | **5** |
| selected structures | **28** |
| generated candidate universe | **627** |
| effective configuration hash | **`14qrfox19ako29`** — single, across all six events |
| **reconciliation mismatches** | **0 of 28** |

Every selected structure was reconciled field by field against the `generationSnapshot.candidates` entry it came from — option type, expiry, requested strikes, actual strikes, target horizon, structure. Nothing was repaired.

| event | label | dir | entry | generated | selected |
|---|---|---|---|---|---|
| `17339625` | MR-11 · 2025-10-08 | short | 2025-10-08 08:00 | 87 | 6 |
| `1f046e00` | MR-15 · 2026-06-08 | long | 2026-06-08 00:00 | 77 | 0 |
| `2a93d290` | MR-08 · 2025-05-24 | short | 2025-05-24 10:00 | 152 | 6 |
| `5bebaf8f` | MR-05 · 2025-01-14 | long | 2025-01-14 00:00 | 156 | 3 |
| `653f11df` | MR-06 · 2025-01-22 | short | 2025-01-22 14:00 | 77 | 4 |
| `d099f278` | MR-02 · 2024-05-04 | long | 2024-05-04 10:00 | 78 | 9 |

Horizons `{7: 12, 14: 12, 30: 4}`, option types `{C: 16, P: 12}`, 9 distinct expiries, 2 width-substituted, 0 duplicate candidate ids. **Every figure matches the Phase 2A.2 and 2A.3 record exactly** — including the 627 generated denominator and the configuration hash. This is the same research state, now supplied in full rather than reconstructed.

The store is in place at `data/research-selections/default-sample-trades.json` where the local application server reads it. That directory is now gitignored: the server writes there at runtime, and a 37 MB blob would permanently bloat history.

---

## 2. Cross-sectional retrieval (`f8cafce`)

Phase 2C's finding was confirmed in the code: `DeribitHistoryService.resolve` selected only the two resolved legs, which makes Rule C unsatisfiable by construction.

`resolve` now also builds a **same-expiry ladder** — the listed strikes surrounding the structure's own strikes, **both option types**, gated on `creation_timestamp` exactly as the leg chain is.

**Anchored on the structure's strikes, not on spot.** Bracketing is a property of the leg, and as the underlying drifts the leg is precisely what stops being near the traded region — anchoring on spot would lose the strikes at the moment they start to matter.

**Reuse is structural rather than bolted on.** Ladder instruments join the existing `selected` map, keyed by instrument name, and `fetchTradeRange` is already cached by `(name, start, end)`. A strike shared by the 1k, 2k and 3k width variants, or by the maker and taker scenarios, is retrieved **exactly once per event and expiry**. `buildExpiryCandidates` then groups the inventory by expiry once and hands every candidate on that expiry **the same array by reference**.

Both properties are asserted, not claimed: one test drives three width variants sharing a short strike and fails if any instrument is fetched more than its boundary probes plus one page; another fails if candidates on one expiry do not share the identical ladder object.

| parameter | value | basis |
|---|---|---|
| `LADDER_NEIGHBOUR_DEPTH` | 6 listed strikes per side | clears the 5-strike rule; bounds retrieval to ~30 instruments per expiry |
| `LADDER_MAX_LOG_MONEYNESS` | 0.35 | a strike further than this carries no information about the target |
| `CROSS_SECTION_RETRIEVAL_VERSION` | `same-expiry-ladder-v1` | |

Both were chosen from coverage and retrieval cost. **Neither was tuned on pricing error or strategy results.** The cross-section can be switched off per request, restoring legs-only behaviour for casual browsing; a ladder retrieval failure never marks a candidate data-unavailable, because the ladder is pricing context and not a structural gate.

---

## 3. The promoted hierarchy (`50bd4f1`)

`app/lib/volatility/reference-hybrid.ts`, wired into `estimateModelSpread`.

| tier | rule |
|---|---|
| 1 | `same_expiry_linear_interpolation` — same expiry, target genuinely bracketed, **≥5 unique qualifying strikes**, canonical evidence **≤60 min**, no extrapolation |
| 2 | `local_iv_anchor` — the existing exact-contract causal anchor, unchanged, including its **720-minute** window |
| 3 | `unavailable`, with an explicit reason |
| — | settlement: existing exact payoff, no IV involved |

**It reuses the Phase 2A.1 admission gate and the Phase 2B estimator rather than re-deriving either.** A second production definition of "a causal market-IV observation" would be free to drift from the one the validation ran against, and the promotion evidence would quietly stop applying to the code actually pricing the book.

**Each leg excludes its own prints** from the smile used to value it, so an interpolated mark is never partly a restatement of the contract it is pricing. A test plants a 300-vol print on the leg being valued and fails if it leaks in.

No SVI. No SSVI. No wing extrapolation. No cross-expiry pricing.

### One thing I made stricter than validation modelled

The pre-existing leg-coherence rule required both legs' anchors to be synchronized within an hour. I preserved it and **generalized it to whichever evidence each tier actually used**. Without that, an interpolated leg could be paired with a ten-hour-old anchor by the very rule written to catch two ten-hour-old anchors.

This is stricter than the per-contract Phase 2C validation modelled, and it will refuse some spread marks that per-leg scoring would have accepted. I am flagging it rather than burying it: it is a deliberate conservatism on a rule that already existed, and its cost is visible in the availability numbers below.

### Versioning and provenance

| | |
|---|---|
| new methodology | **`causal-reference-v2-hybrid-interpolation`** |
| legacy identity retained | `causal-reference-v1` = the pure local-anchor estimator |
| bundle schema | **unchanged** — the serialized contract did not change, only values and provenance |

Two provenance defects were fixed as part of the promotion, because leaving them would have made it self-contradictory:

- The UI hardcoded `"causal-reference-v1"` in a second place, separate from `CURRENT_RESEARCH_ENGINE_VERSIONS`. It now reads the shared constant, so a bump cannot be missed.
- Saved structures recorded `source: "local_iv_interpolation"` unconditionally — exactly the overloaded label that would make the new method indistinguishable from the historical one. Source is now derived from the valuation: `same_expiry_linear_interpolation`, `local_iv_anchor`, or `unavailable`, with the old label retained for structures that predate the hybrid. A spread reports its **weaker** tier, so a mixed pair is never presented as an interpolation mark.

Every mark records the tier, bracketing strikes and their IVs and ages, the qualifying strike count, why interpolation declined, the anchor identity and age when used, and an explicit reason when neither tier was supported.

Structures on `causal-reference-v1` are now correctly reported **stale**, not silently reinterpreted.

---

## 4. Method usage, measured on the real structures (`ea0038a`)

Since the bundle could not be regenerated, I drove the promoted `valueReferenceLeg` over the Phase 2A.3 cross-section cache — the genuine same-expiry tape at 669 causal targets — against all 28 real structures. **4,680 leg valuations.**

| | overall | at entry | on path |
|---|---|---|---|
| `same_expiry_linear_interpolation` | **75.7%** | **96.4%** | 75.5% |
| `local_iv_anchor` | 3.8% | 1.8% | 3.8% |
| `unavailable` | 20.4% | 1.8% | 20.7% |

**The tier fires. That was the open question, and the answer is yes.**

**Interpolation geometry** — min 5 / median 19 / max 68 unique qualifying strikes; bracket width min 2,000 / median 4,000 / P90 11,000. **Zero interpolations occurred below the Rule C floor.**

**Why interpolation declined** — `target_not_bracketed` 89.4%, `unique_strike_count_below_minimum` 8.8%, `no_qualifying_same_expiry_observations` 1.8%. That is the strike-drift mechanism Phase 2A.3 measured, arriving exactly where predicted.

By remaining DTE: 30d+ 100%, 14–30d 88.0%, 7–14d 83.1%, 3–7d 77.3%, 1–3d 60.3%, 0–1d 31.5%.

### The caveat that matters

**The anchor tier is under-measured here and the unavailable rate correspondingly over-measured.** The cross-section cache stores only canonical 60-minute windows, whereas production retrieves each instrument's full trade range from entry−7d to expiry. An instrument that last printed 200 minutes before the target has no cached trade at all, so it reads as `no_causal_anchor` — 735 of the 957 unavailable cases. In a real regeneration most of those resolve to Tier 2.

So: **75.7% interpolation is a sound estimate; 3.8% anchor and 20.4% unavailable are not.** The true split will be roughly 76% interpolation, ~20% anchor, ~4% unavailable, but that is inference from the mechanism rather than a measurement, and I am not presenting it as one.

Of the genuinely unavailable, 23.0% carry `surface_not_identifiable_final_day`. The final-day rule is **not** a blanket refusal: 31.5% of sub-one-day legs still price through the hierarchy, and a test pins that a leg with real exact evidence under a day out is valued normally.

---

## 5. Execution independence

Unchanged and asserted. Reference valuation never reads maker, taker, delayed or modeled execution evidence; a spread with no fill evidence at all still receives a Reference mark; a missing Reference mark never falls back to execution. Fees, margin, futures, selection, contract resolution and denominators are untouched. The three surfaces — Reference fair value, conservative modeled estimate, observed execution evidence — remain separate.

---

## 6. Validation

| gate | result |
|---|---|
| `npm run typecheck` | clean |
| `npm run typecheck:scripts` | clean |
| `npm run lint` | clean (1 pre-existing warning in `research-selections.ts`) |
| `npm run test:unit` | **858 / 858** (was 840; +18 new) |
| `npm run build` | clean, Sites artifact validated |
| `git status` | clean |

All four branches have regression tests on real-shaped inputs: **interpolation wins**, **anchor fallback with the decline reason**, **unavailable**, **settlement unchanged**. Plus: the ladder reaches Reference valuation through the real `buildExpiryCandidates` path; candidates on one expiry share one ladder object; stale evidence cannot reach Tier 1; a future print and an unlisted contract are refused; own-leg contamination is blocked; interpolation is preferred over an available anchor; legacy methodology identity stays readable.

**Eleven mutations** of the retrieval, hierarchy, wiring and denominator guards were applied; each fails tests. Two survived on first attempt — a creation-gate mutation and a coherence mutation — because my tests exercised the pure functions rather than the service and spread paths. Both were fixed with tests that cover the real path.

---

## 7. The blocker

**There is no driver for the recompute path.**

`recomputeSelectedResearch` exists in `app/lib/research-refresh.ts` and is tested. `ResearchSelectionService.recompute` exists in `scripts/research-selection-service.ts`. **Neither is called anywhere** — the HTTP plugin routes only `GET`/`PUT` store and `PUT`/`DELETE` event, and no UI control invokes it.

The only path that produces derived research is the save flow in `options-backtester.tsx`, and it builds derived layers **only for newly added selections** (`toAdd`). Re-saving an unchanged selection set regenerates nothing.

So regenerating the 28 structures under the new methodology would require building the missing recompute engine and its route: wiring resolve → `buildExpiryCandidates` → `estimateModelSpread` → path → outcomes into a driver that does not exist. That is a new subsystem, not plumbing — and regenerating the canonical sample with an engine authored inside this same task, then auditing the result with it, is exactly the kind of shortcut the integrity requirements exist to prevent.

**Production is promoted and correct; the sample is not regenerated.** What that costs, precisely:

- no regenerated bundle identity
- no §12 old-versus-new comparison (entry credit, path, VPOC, invalidation, fixed-time, credit-capture timing, settlement invariance)
- no §15 post-regeneration integrity audit against a real artifact
- §13 method usage answered by direct measurement instead, with the caveat in §4

Everything else in the task is complete.

### What unblocks it

One of:

1. **Expose the existing recompute.** Add a route for `ResearchSelectionService.recompute` and a UI control, with an engine that reuses the analysis pipeline the save flow already runs. The `ResearchRecomputeEngine` seam is designed for exactly this and copies structural fields from the saved selection rather than accepting them from the engine, so identity is protected by construction.
2. **Regenerate through the UI** by clearing and re-saving each event's selections. This **rewrites the selection set** and is precisely what §11 forbids, so I did not do it.

Option 1 is a contained piece of work and is the right next step, but it is a task of its own.

---

## 8. Remaining genuine data limitations

- **The measured anchor and unavailable rates are not production rates**, for the reason in §4. Interpolation at 75.7% is sound; the other two are not.
- **Leg coherence is stricter than validation modelled.** Its effect on spread-level availability is unquantified until a regeneration runs.
- **Retrieval cost rises materially.** Roughly 30 ladder instruments per expiry against ~4 legs before. Cached and deduplicated, but a first regeneration over 9 expiries will be long.
- **The final day remains structurally thin**: 31.5% interpolation coverage below one day, and Phase 2A.3 established there is no shorter listed maturity to borrow from.
- **Five events.** These holdouts validate a pricing model; they are not five independent strategy observations, and nothing here should be read as if they were.

---

## Correction to the Phase 2C report

The Phase 2C report should not be read as claiming the hybrid beats local-IV **in every cohort**. It does not, and the design depends on that: in the extrapolation cohort the local anchor remained the better estimator, which is exactly why Tier 1 declines there and Tier 2 takes over. The hybrid materially dominates overall and across the interpolation cohorts, and falls back toward local-anchor behaviour precisely where local-anchor behaviour was measured to be better.

---

**PRICING FREEZE — validated hybrid promoted; canonical research bundle NOT regenerated. Regeneration is blocked on a missing recompute driver (§7), stated rather than worked around. Historical fair-value methodology is frozen for the current research phase.**
