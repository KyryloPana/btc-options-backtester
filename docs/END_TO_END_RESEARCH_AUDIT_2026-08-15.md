# End-to-End Research Integrity Audit — 2026-08-15

## Executive decision

**Revision audited:** `475adaddb94ee0fe023aeea2cf61e20820e81f99` (`fix: expose chart cursor and opening USD values (#27)`). The expected object existed and was exactly `HEAD`. The worktree was clean on branch `work`; the audit then created `audit/end-to-end-research-integrity`. **No production behavior was changed.**

| Gate | Decision | Controlling reason |
|---|---|---|
| Deterministic development tests | **GO** | 114/114 existing unit tests and 5/5 new audit tests pass; typecheck, build, rendered HTML and artifact checks pass. |
| Event-level historical research | **NO-GO** | P0 duplicate observations can change VWAP/IV evidence because the shared parser discards `trade_seq` and inventory does not deduplicate; displayed Research outcome USD uses entry price rather than the outcome timestamp's index. |
| Cross-event comparisons | **NO-GO** | The two P0s apply; Research export is selected-event-only and lacks the required reproducibility/coverage envelope (P1). |
| Certified live-data operation | **NO-GO** | Production-path Deribit manifest synchronization returned `phase:error, error:"fetch failed"`; the live matrix is **NOT TESTED**, never fixture-promoted. |

Live execution, live-trading readiness and proof of strategy edge are explicitly out of scope. Research marks are theoretical/model-reconstructed; this audit does not call them executable quotes.

## Environment, scope and exclusions

- Date/time zone: 2026-08-15, UTC (`Etc/UTC`); Linux, Node package requires >=22.13.0; installed Vite 8.0.13/vinext toolchain.
- Audit surface: parser, Deribit service, candle adapter, inventory/candidate engine, Research and Conservative valuation, outcome/accounting ledgers, UI source/rendered HTML, dataset persistence and both export builders.
- Production was not repaired. `tests/end-to-end-research-audit.test.ts` is audit evidence and contains explicit passing counterexamples for unresolved defects.
- The deterministic live-shaped October fixture proves deterministic semantics only. It is **not** a live acceptance result.
- Pixel browser evidence is **NOT TESTED**: no Chromium/Firefox existed, and `npx playwright@1.55.0` failed with registry HTTP 403. Rendered HTML passed, but it is not a substitute for desktop/narrow viewport screenshots.

## Requirement traceability matrix

“Manual” means code inspection or deterministic rendered evidence; “live” is reserved for the real production request path.

| Requirement | UI control | State | Calculation | Persist/export | Automated evidence | Live/manual evidence | Result |
|---|---|---|---|---|---|---|---|
| Bull-put / bear-call credit spreads | direction + spread kind | `direction`, `spreadKind` | `generateDesiredSpreads`, ordered resolver | config, exact legs | backtester and API pair tests | source inspection; live unavailable | PASS |
| Exact contract identity | contract matrix | manifests/inventory | `parseInstrumentName`, `retrieveSpread` | `contracts`, spread legs | live-shaped audit fixture | names/strike/type/expiry retained | PASS |
| 7D/14D/30D horizons | DTE checkboxes/bands | `dtes`, `dteTolerances` | desired spreads + service `resolve` | target and `actualDte` on spread | candidate tests | live unavailable | PASS |
| Technical/buffered strikes | strike mode controls | generated spreads | `generateDesiredSpreads` | `buffered`, strikes | `$1k buffer` unit | manual | PASS |
| Width | width checkboxes | `widths` | generation/nearest ordered pair | target/actual width | ordering and variants | manual | PASS |
| Friday/non-Friday | expiry annotations | derived UTC | `isFridayExpiry` | weekday/boolean | Friday metadata test | live unavailable | PASS |
| Actual DTE | matrix/detail | candidate manifest | `(expiry-entry)/DAY_MS` | `actualDte` | API resolver tests | manual | PASS |
| Contract amount | run/scenario inputs | `amount`, `scenarioAmount` | validators and all ledgers | configured/estimate amount | identity, scaling, invalid tests | manual | PASS |
| Research / Conservative | mode segmented control | `pricingAssumption` | Research estimator vs tape observation | mode/config | presentation separation tests | manual | PASS |
| Target/VPOC | event input/outcome row | event + outcomes | first touch / Research outcomes | decision/valuation timestamp | causal tests | manual | PASS |
| 50%/70% credit capture | outcome rows | Research outcomes | `buildResearchOutcomes` | estimate outcomes | Research calculator test | manual | PASS |
| Invalidation | event input/outcome row | event | candle close / Research outcomes | timestamps | causal tests | manual | PASS |
| Fixed horizon | exit configuration/outcome | policy | fixed elapsed timestamp | lifecycle | fixed-time tests | manual | PASS |
| Expiry | expiry marker/outcome | spread expiry | intrinsic/settlement ledger | outcome + ledger | expiry tests | manual | PARTIAL — zero-IV expiry is rejected before intrinsic pricing |
| BTC/USD displays | chart and opening currency controls | chart/opening modes | presentation converters | BTC raw + opening conversion | chart/opening tests | outcome USD defect below | FAIL |
| Fees/PnL/max loss/opening balance/ROR | cards/tables | observation/estimate | accounting/margin/UI formulas | partial | ledger tests | ROR absent; Research outcome USD wrong | FAIL |
| Provenance/quality | status, evidence details | quality/source fields | ranking/estimator | Research methodology/quality | evidence tests | export envelope incomplete | PARTIAL |

## Data lineage trace

The new live-shaped fixture follows:

1. Raw Deribit-style `result.trades` contains `instrument_name`, millisecond `timestamp`, BTC `price`, `index_price`, `direction`, `amount`, API-percent `iv`, and `trade_seq`.
2. `parseContractText` extracts rows and `parseDeribitTrade` creates normalized `ContractTrade`. It retains `ivApiPercent` and creates `ivDecimal = ivApiPercent / 100` exactly once.
3. **P0:** the parser drops `trade_seq` unless the service first aliases it to `trade_id`. Generic/imported raw JSON therefore has no sequence identity.
4. **P0:** `buildInventory` appends and timestamp-sorts but does not deduplicate. The audit fixture supplies sequence 2 twice: the sold inventory has three rows rather than two. Amount-weighted VWAP, observed amount, quality and IV tie selection can therefore change silently.
5. Instrument parsing and candidate resolution retain exact expiry, strike and option type; the service's joint ordered-pair resolver prevents same-strike or inverted legs.
6. `estimateResearchSpread` chooses direct bounded VWAP when possible and independently retains each exact leg's model anchor. The fixture preserves 71% sold IV and 49% bought IV.
7. `parseOhlcCandles` validates millisecond timestamps, positive values, ordering and requested-range boundary coverage. `resolveUnderlyingIndex` permits exact, containing, or at most one-interval preceding evidence.
8. `buildEstimatedPath` generates 4-hour points, uses causal local observations or leg-specific entry IV (`constant-entry-IV`), emits typed missing-index reasons, and terminates at exact expiry.
9. `buildResearchOutcomes` persists decision/valuation timestamps for estimated paths; Conservative uses execution clocks and post-order tape fills.
10. Accounting preserves BTC values and entry/closing conversion ledgers for Conservative observations. Research UI/export exposes opening conversion provenance but not a correct outcome-time USD conversion.
11. UI presents Research and Conservative through separate adapters.
12. Research export contains methodology, exact contracts, evidence, path and outcomes, but is a single selected event and lacks the run envelope listed under P1-01.

### Lineage verification results

| Check | Result | Evidence |
|---|---|---|
| `ivApiPercent` retained / decimal exactly once | PASS | parser plus deterministic 70%→0.70 assertion |
| Independent short/long IV | PASS | deterministic 0.71 vs 0.49 anchor/path assertion |
| No contract substitution | PASS | exact names and structural resolution tests |
| Duplicates/out-of-order harmless | **FAIL (P0-01)** | out-of-order is sorted; duplicate sequence survives and changes inventory |
| Pagination/range coverage | PASS | sequence-gap rejection and candle boundary validation |
| Empty/partial/malformed visible | PARTIAL | service failures and candle emptiness are explicit; malformed trade rows are silently skipped by text parser |
| Millisecond UTC | PASS | millisecond boundary checks and UTC date helpers |
| No future decision evidence | PASS for tested selection/execution; PARTIAL globally | causal tests pass; nearest Research anchor can be after target by design for reconstruction and is labeled modeled, not execution |
| Raw/normalized/modeled distinction | PASS in Research estimate/path | distinct source and IV fields |

## Entry and candidate selection

Calls and puts use structural option type and same-expiry chain selection. Calls require bought strike above sold; puts require bought strike below sold. DTE bands filter expiries before pair resolution; requested horizon and actual DTE remain separate. Width/strike mode change desired strikes. Friday is derived only in presentation/export and the test proves it does not mutate ranking. Conservative Green/Yellow evidence is computed from causal tape, while Research model anchors do not create executed fills.

Amount 1 is identity scaling. Valid Research amounts scale premiums, fees, maximum loss and PnL once; larger Conservative amounts rerun tape accumulation rather than multiply a base fill. Invalid non-positive/non-finite Research amounts fail before path construction. This audit accepts the stated premise that contract amount is already correctly configured.

## Valuation-path semantics and edge matrix

| Case | Expected / observed | Result |
|---|---|---|
| Deep ITM / ATM / OTM | finite, non-negative inverse model results | PASS |
| Near expiry | finite for positive IV | PASS |
| Zero volatility at expiry | intrinsic expected; validation rejects IV=0 first | **FAIL (P1-02)** |
| Missing IV | typed missing short/long entry IV | PASS |
| Extreme index/strike | finite and non-negative in audit matrix | PASS |
| Exact expiry grid | included once; no post-expiry points | PASS |
| Index evidence | target index + source timestamp/method retained | PASS |
| Local versus constant IV | local only within exact-leg observation policy; otherwise each leg's own entry IV | PASS |
| Spread value sequencing | per-contract close value precedes amount, fees and net PnL | PASS |
| Missing index | `missing-target-index`, `missingField=targetIndex`; never zero | PASS |

## Formula-level financial reconciliation

Let `A` be amount, `S0` event-entry BTC/USD index, `St` point index, `Ps/Pb` opening BTC prices per contract, `Cs/Cb` closing BTC prices per contract, `Fo/Fc` fees, and width `W` USD.

| Display/value | Formula and currency | Source/provenance | Audit |
|---|---|---|---|
| Sold/bought opening BTC | `Ps*A`, `Pb*A` | exact-leg estimate/fill | PASS |
| Gross opening BTC | `(Ps-Pb)*A` | entry legs | PASS |
| Net opening BTC | gross − `Fo` | fee ledger | PASS |
| Opening USD-at-entry | BTC opening component × `S0` | entry target index + timestamp | PASS |
| Closing spread/contract | bought-close − sold-close economic cost (presentation sign is explicit) | target point | PASS |
| BTC mark-to-market PnL | net opening BTC − close cost − `Fc` | point estimate | PASS |
| Point USD mark | BTC point PnL × `St` | point target index | PASS for chart |
| Timestamp cash-flow USD | opening net × opening index + closing net × closing index | Conservative cash-flow ledgers | PASS |
| Research outcome USD row | currently outcome BTC PnL × event entry price | UI only | **FAIL (P0-02)** |
| Theoretical maximum loss BTC | `max(0, W/S0*A − net opening BTC)` | Research detail/export | PASS for displayed event; separated from margin |
| Estimated opening balance | protective premium `Pb*A + Fo` | explicitly labeled estimate | PASS as stated assumption, not margin |
| Margin/capital | versioned SM or evidenced PM; unavailable without PM evidence | margin result | PASS |
| Gross/net/fees | routed per-leg fees once at open and close | fee ledger | PASS |
| Return on risk | no event/cross-event Research value found | none | **FAIL (P1-03)** |

Rounding tolerance in ledger tests is `1e-10` relative for structured observations and `1e-12` in formula unit helpers. Raw BTC remains in estimate, path, cash-flow and PnL fields.

## Outcome logic

- Causal Conservative entry and exit retain signal, decision, order, supporting prints and fill timestamps. Maker evidence stays `opportunity-only` and cannot become authoritative execution.
- Research target/50%/70%/invalidation/fixed/expiry outcomes are explicitly estimates. First qualifying path/candle observations are selected in chronological order and bounded by expiry.
- Missing causal close tape remains triggered-unfilled/unavailable or falls back to evidenced settlement; it is never treated as a historical close.
- The selected lifecycle persists its decision timestamp. Presentation rerenders consume stored results rather than re-running the engine.
- **Limitation:** the Research outcome UI's USD number is not timestamp-correct (P0-02), despite the BTC outcome and decision timestamp being retained.

## UI audit

### Automated/rendered evidence

Rendered HTML passes. Source-level presentation tests establish separate BTC/USD, PnL/value, raw-marker and outcome-marker controls; selected Research inspector is outside the SVG, keyboard navigable, clearable with Escape, shrinkable, and color states carry text labels. Dataset/event switches clear result arrays; run completion includes amount, candle count/range and priced/total points. Missing Research points show reason and field.

### Screenshot matrix

| View | Evidence | Result |
|---|---|---|
| Desktop normal width | no browser executable; Playwright acquisition HTTP 403 | **NOT TESTED** |
| Narrow supported width | same limitation | **NOT TESTED** |

No screenshot files are claimed. Rendered HTML and CSS/source tests cannot prove absence of pixel overlap, so chart-marker obstruction and full responsive overlap remain NOT TESTED manually.

### React hook warning

`npm run lint` reports one `react-hooks/exhaustive-deps` warning: startup effect omits `refreshDatasets`. The comment says startup discovery intentionally runs once. The function is recreated each render and closes over current state; today it is invoked at initial mount only and tests/build show no functional failure. Classification: **actionable P3 maintainability warning**, not demonstrated research corruption. A future function edit can create a stale closure; remediation should memoize the callback or inline the startup-only logic, but production was intentionally not changed here.

## Storage and export

Dataset schema validation rejects invalid dates, duplicate IDs, malformed required event fields and unsafe dataset IDs/path traversal. Writes use unique temp file + rename and clean up failed temp writes. Round-trip/save tests preserve values and ordering.

**P1-01:** Research export omits top-level `schemaVersion`, `runId`, configuration hash, code commit, data provenance object and run quality state. UI exports only the selected `AnalysisResult` as a one-element `results` array. Although `eventId`, mode and estimate disclaimer reduce ambiguity, it cannot satisfy reproducible batch/cross-event research or requested/received denominator coverage. Observation export has schema/validation and aggregates, but also lacks code commit/configuration hash/run ID. Result: storage PASS, Research export FAIL for certification and cross-event comparison.

## Historical `FINAL_GATE_AUDIT.md` P0/P1 re-evaluation

| Old item | Current result | Evidence |
|---|---|---|
| 2 UI result adapter missing `scenarioInput` / crash | RESOLVED | adapter now sets complete scenario input; tests/typecheck pass |
| 13 fee inputs not fill-bound / forged combo flag | RESOLVED | validator cross-binds fee price/amount and rejects bare official combo; adversarial tests pass |
| 16 open export schema permits calculator injection | RESOLVED for named calculator/unknown primary fields | validator closed field set and recursive calculator scan tests pass; reproducibility metadata remains new P1-01 |
| 18 obsolete calculator fields / missing independent outcomes / capital disclosure | RESOLVED for compile/runtime and tested outcome calculations; PARTIAL for Research ROR/export | scenario tests pass; typecheck passes; Research ROR remains absent |
| Old unit/type/build failures | RESOLVED | 114/114 unit, typecheck and build pass |
| Old lint unused-state warnings | RESOLVED | replaced by one startup hook dependency warning (P3) |

All other historical PASS/PARTIAL assertions were re-read against current engine and regression tests; no former P0/P1 is accepted solely because the old document said so.

## Findings

### P0-01 — Duplicate Deribit-shaped rows silently change inventory and research marks

**Rule:** silent data substitution/corruption is P0. `parseDeribitTrade` discards `trade_seq`; `buildInventory` appends without identity deduplication. A duplicated sequence contributes twice to VWAP, observed liquidity and potentially IV anchor ties.

Reproduce:

```bash
node --experimental-strip-types --test --test-name-pattern='duplicate rows' tests/end-to-end-research-audit.test.ts
```

Expected audit proof: pass, stating the sold inventory contains three rows and every parsed `tradeSeq` is undefined. This is a passing counterexample, not a correctness pass.

### P0-02 — Research outcome USD uses entry price, not outcome timestamp index

`ResearchDetail` renders `money(outcome.estimatedNetPnl * result.eventPrice)`. This is neither a point-time USD mark nor timestamp-converted USD cash-flow PnL and is labeled only as money. Cross-date currency semantics are wrong.

```bash
node --experimental-strip-types --test --test-name-pattern='outcome USD' tests/end-to-end-research-audit.test.ts
```

### P1-01 — Research exports are not reproducible batch artifacts

Missing required envelope and selected-event-only scope prevent denominator/coverage reconstruction. Reproduce with the named `Research export` audit test.

### P1-02 — Expired zero-volatility option does not use intrinsic

`priceInverseOption` validates `ivDecimal > 0` before the expiry intrinsic branch. Reproduce with the named `4-hour grid` audit test (the counterexample asserts current `unavailable`).

### P1-03 — Return-on-risk unavailable

No Research event/cross-event ROR value or denominator is displayed/exported. Maximum loss and estimated opening balance exist, but users cannot reproduce a risk-normalized comparison.

### P2-01 — Malformed trade rows can be silently discarded

`parseContractText` skips malformed NDJSON lines and `parseDeribitTrade` null rows without a rejection count/quality state. Candle and service-level total failures are visible, but partial malformed trade input is not.

### P3-01 — Startup dataset hook dependency warning

Actionable maintainability issue described above; no observed research result impact.

### NOT TESTED-01 — Browser pixel/layout acceptance

No installed browser and registry policy blocked Playwright. No screenshots are claimed.

### NOT TESTED-02 — Real production live matrix

The real `/__deribit/history/index` request reached the production service but manifest sync failed. Therefore call/put, bullish/bearish, Friday/non-Friday, 7/14/30D, two widths, direct Green, modeled Research and intentionally unavailable live cases are all **NOT TESTED**, not PASS.

## Exact commands and results

| Command | Result |
|---|---|
| `git status --short --branch; git rev-parse HEAD; git cat-file -t 475ad...` | clean `work`; exact expected HEAD; object `commit` |
| `npm run test:unit` | PASS — 114 tests, 114 pass, 0 fail |
| `node --experimental-strip-types --test tests/end-to-end-research-audit.test.ts` | PASS — 5 tests, 5 pass, 0 fail (three named counterexamples document failures) |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS exit 0 with 1 React hook warning |
| `npm run build` | PASS — five Vite stages; artifact validated |
| `node --test tests/rendered-html.test.mjs` | PASS — 1/1 |
| `npm run validate:artifact` | PASS |
| `curl .../__deribit/history/status`, `curl -X POST .../index`, status poll | request path reached; final `phase:error`, `fetch failed`; live NOT TESTED |
| `npx --yes playwright@1.55.0 --version` | environment warning — HTTP 403; screenshots NOT TESTED |
| `git diff --check` | run after final document/test edits; see commit record |

## Final decision

1. **Deterministic development tests: GO.** This means the deterministic suite is runnable and internally stable; counterexample tests explicitly prevent mistaking suite green for research certification.
2. **Event-level historical research: NO-GO.** P0 duplicate corruption and P0 outcome USD conversion violate the decision rule.
3. **Cross-event comparisons: NO-GO.** P0s plus missing reproducibility/coverage envelope and ROR denominator.
4. **Certified live-data operation: NO-GO.** Required live matrix is NOT TESTED because Deribit synchronization failed.
5. **Out of scope:** live execution/live-trading readiness and proof of strategy edge.
