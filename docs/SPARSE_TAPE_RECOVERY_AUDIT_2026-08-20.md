# Sparse-tape recovery audit — 2026-08-20

## Audit identity and decision

- **Exact starting commit:** `d4bac7c5809e449b8391eea0dd4b2be3fede31ab` (`Rebuild research analytics around scenario tracks (#76)`). The worktree was clean.
- **Dedicated branch:** `audit/sparse-tape-recovery-20260820`.
- **Scope:** `MR event → candidate generation → contract resolution → reference valuation → immediate maker/taker → delayed observed execution → modeled execution → path/outcomes → selection → persistence → ZIP export/import → Research Analytics`.
- **Production defects fixed:** none. The audit did not find a counterexample that justified changing production behavior.
- **Overall classification:** **passed on fixtures only**. No representative user-generated historical ZIP exists in the repository, so real historical acceptance is **blocked by missing data**. Green deterministic tests are not presented as historical validity.

## Adversarial deterministic fixture inventory

The focused harness is `scripts/audit-sparse-tape.sh`. Its fixtures jointly contain all required cases:

| Required case | Deterministic evidence |
|---|---|
| two MR events; selected and unselected; clear and reselect | `research-bundle.unit`, `research-selections.unit`, and `event-lifecycle.unit` use multiple events, generated denominators larger than selections, and persistence restart after clear/reselect |
| two DTE horizons and two widths | `backtester.unit`, `duration-dte-*`, `spread-width-report.unit`, and the bundle fixture cover 7/14-day horizons and multiple widths |
| exact and nearest-listed; confirmed non-listing; retrieval failure | candidate/research valuation fixtures and analytics availability rows keep these states distinct |
| insufficient immediate tape; valid delayed execution; VPOC before delayed entry | causal valuation and delayed-execution fixtures prove quantity-independent valuation, later causal fills, and explicit `pre_entry_resolution` |
| raw exact; historical mark; interpolation; bounded extrapolation; DVOL proxy; unavailable surface | `causal-valuation.unit` exercises every valuation tier and the no-surface result |
| expected/conservative modeled scenarios | causal valuation and execution-scenario fixtures distinguish promoted expected estimates from conservative sensitivity |
| missing margin; settlement fallback; extreme valid PnL | observation ledger, analytics model, and report fixtures retain missing-capital reasons, evidenced settlement, and non-clipped extreme values |

This is a composed adversarial fixture spanning real public boundaries, not a claim that synthetic rows reproduce exchange history.

## End-to-end trace

1. Candidate generation preserves requested DTE/width attempts even when attempts collapse onto the same listed structure; availability is the generated-opportunity denominator.
2. Resolution records listing metadata separately from retrieval status. Confirmed non-listing is not inferred from empty tape or a failed fetch.
3. Reference valuation uses only causal anchors. Trade quantity can disqualify execution while the print remains a valuation anchor. Exact trade, supplied official mark, sparse interpolation, calendar interpolation, bounded extrapolation, DVOL-plus-smile prior, and unavailable remain named tiers.
4. Immediate maker/taker tracks consume opposite, side-correct evidence and do not share a synthetic “best” entry.
5. Delayed execution starts at its predetermined order timestamp, requires later evidence and sufficient size, anchors spot/DTE/path at actual completion, and reports thesis resolution before entry as a missed/pre-entry outcome.
6. Modeled expected/conservative economics remain model tracks. An expected estimate is promoted only with the configured calibration count; otherwise sensitivity is shown.
7. Raw paths use raw opening evidence and model paths use model economics. Export emits separate pricing/scenario identifiers rather than mixing values within a primary observation.
8. Selection identity is event × stable strategy variant/candidate. Clear, persistence restart, reselection, migration and selected-only bundle export are deterministic.
9. ZIP validation checks schema, joins, identities, finite values, timestamps, outcome completeness and reconciled totals before Research Analytics import.
10. Analytics normalizes all tracks onto one structural observation, retains generated opportunity denominators, reports trade-conditional and opportunity-normalized results separately, and computes per-position BTC/USD and capital-dependent ratios without pooling tracks.

## Invariant results

| # | Invariant | Classification | Audit result |
|---:|---|---|---|
| 1 | Non-listing versus tape absence | passed on fixtures only | Separate contract-resolution and retrieval states survive analytics. |
| 2 | Quantity gates execution, not valuation | passed on fixtures only | A sub-size exact print values the leg but is explicitly insufficient for execution. |
| 3 | Maker/taker causality and side | passed on fixtures only | Independent direction evidence is required for each side. |
| 4 | Delayed evidence never backdated | passed on fixtures only | Earlier buckets cannot consume later trades; completion time is the latest leg. |
| 5 | Pre-entry resolution explicit | passed on fixtures only | VPOC/invalidation/expiry before completion are missed entries; analytics says `pre_entry_resolution`. |
| 6 | No future anchors/priors | passed on fixtures only | Future anchors are filtered and future-trained priors are rejected. |
| 7 | DVOL not direct strike IV | passed on fixtures only | DVOL is transformed through a named smile prior and reason-coded as a level prior. |
| 8 | Modeled not described as observed | passed on fixtures only | Analytics `observed`/`modeled` flags and labels are mutually truthful. |
| 9 | Raw path not model-entry anchored | passed on fixtures only | Bundle pricing tracks and executable-window validation remain separate. |
| 10 | No primary “best available” mixing | passed on fixtures only | Summaries are per track; raw and modeled rows are never pooled. |
| 11 | Structural identity stable across tracks | passed on fixtures only | Tracks attach to event × strategy variant and do not multiply observations. |
| 12 | Save/clear/reload/export | passed on fixtures only | Restart, clear, event isolation, reselection and ZIP checks pass. |
| 13 | Migration deterministic/idempotent | passed on fixtures only | Current schema is unchanged by migration; legacy conversion is explicit and repeatable. |
| 14 | Analytics denominators reconcile | passed on fixtures only | Availability count equals generated opportunities and retrieval exclusions are disclosed. |
| 15 | BTC/USD ledgers hand-reconcile | passed on fixtures only | Opening net = gross − fees; outcome USD equals BTC × timestamp index in deterministic rows. |
| 16 | Matched comparisons | passed on fixtures only | DTE/width/strike reports match structural keys and scenario tracks before comparing. |
| 17 | Missing margin suppression | passed on fixtures only | PnL remains; opening/peak-capital returns become unavailable with reasons. |
| 18 | Extreme values visible | passed on fixtures only | Numeric tables do not winsorize/remove the extreme fixture observation. |
| 19 | Low-confidence include/exclude | passed on fixtures only | UI filtering is explicit; tier counts remain in the immutable model. |
| 20 | Visual filter does not alter denominators/export | passed on fixtures only | Filtering derives visible rows after model creation; deterministic export consumes the unfiltered model. |

## Real historical acceptance — blocked

No `.zip` file is present outside dependencies/build artifacts, and no representative user-generated historical bundle was supplied. Therefore regeneration of three historical events, old/new economics comparison, live coverage by tier, and hand reconciliation against exchange history are **blocked by missing data**. No result was invented and no fixture was promoted to “real data.”

To unblock, provide the original user-generated ZIP and its companion MR-event dataset, then:

1. Record the ZIP SHA-256, schema version, engine commit, configuration and event count.
2. Import it without migration edits and capture validation/capability diagnostics.
3. Choose at least three existing events spanning both directions and materially different dates/liquidity.
4. Regenerate the same DTE/width/strike variants from the current engine, saving the selected variants only after inspecting contracts and evidence.
5. Export a new ZIP, record its SHA-256, import it into Research Analytics, and export the unfiltered analytics JSON.
6. Tabulate generated, resolved, non-listed, retrieval-failed, reference-valued, immediate, delayed and modeled counts by contract and valuation tier.
7. Hand-reconcile one immediate, one delayed and one modeled position: each leg, quantity, gross/net BTC, fees, outcome BTC, timestamp conversion index, USD PnL, maximum loss and every available margin denominator.
8. Compare old/new identities, coverage and economics. Investigate every difference exceeding the larger of one native tick, one fee tick, or 1% of absolute position PnL.
9. Capture the screens listed below with the imported real bundle and retain the source rows used by each inspector.

## Visual acceptance — blocked by environment

No Chromium, Chrome or Firefox executable is installed. Attempting `npx --yes playwright@1.55.0 --version` was rejected by the configured registry with HTTP 403. Consequently actual desktop/narrow layout inspection and the requested screenshots are **blocked by missing browser tooling**, not passed from selectors or rendered HTML.

Required evidence after unblocking (desktop at 1440×1000 and narrow at 390×844): valued-structure table, expanded evidence, unavailable diagnostics, delayed-entry view, Duration/DTE, width/strike, execution robustness, per-position economics, and event-level inspector. Each image must show the viewport size, imported ZIP identity, active track/filter, and denominator ledger; inspect clipping, horizontal overflow, sticky layers, focus/expansion and long diagnostic wrapping.

## Area classification

| Area | Classification |
|---|---|
| Generation through contract resolution | passed on fixtures only |
| Reference valuation and causal surfaces | passed on fixtures only |
| Immediate and delayed observed execution | passed on fixtures only |
| Modeled execution and scenario isolation | passed on fixtures only |
| Paths, outcomes and settlement fallback | passed on fixtures only |
| Selection, persistence, migration and ZIP | passed on fixtures only |
| Research Analytics denominators/economics | passed on fixtures only |
| Real historical economics and coverage | blocked by missing data |
| Desktop/narrow visual acceptance | blocked by missing data (browser executable/tooling) |

## Conclusion

The software path is deterministic and the adversarial fixtures support the twenty invariants. This audit does **not** establish exchange-history accuracy, strategy edge, executable liquidity, or visual acceptance. The system is therefore not called complete: completion still requires a representative historical ZIP, reconciled old/new economics, and inspected screenshots.

## Executed checks

| Command | Result |
|---|---|
| `./scripts/audit-sparse-tape.sh` | PASS — 257 tests, 257 passed |
| `npm run test:unit` | PASS — 402 tests, 402 passed |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — verified Sites artifact |
| `npm test` | PASS — unit suite, build, and rendered HTML |
| `git diff --check` | PASS |
| `git status --short` | PASS — only this report and focused harness were untracked before commit |
| `npx --yes playwright@1.55.0 --version` | BLOCKED — registry HTTP 403; no screenshot tooling installed |
