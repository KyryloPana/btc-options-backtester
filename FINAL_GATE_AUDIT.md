# Independent Post-Remediation Correctness Audit

**Canonical revision audited:** `eb67a3a99a0474c4d01b3ee77b6caee02f6d8f00`  
**Audit date:** 2026-08-14 UTC  
**Decision:** **FAIL** — the combined revision is not eligible for research use.

This was a read-only audit of production code. No implementation was repaired. The findings below trace the runnable UI path and treat existing names, comments, and tests only as leads, not proof.

## Executive findings

1. The required calculator commits are genuine ancestors of the canonical revision.
2. The UI Run Backtest handler calls `buildAndRunObservationRequests`, which calls `runEventBacktest`, but the result adapter does not populate the required `AnalysisResult.scenarioInput`. The next statement dereferences `next[0].scenarioInput.config`, so a successful non-empty run throws before results are installed.
3. Calculator code and tests still reference removed `observation.netPnl` and old `ValuationPoint.rawPnlUsd` / `ivPnlUsd` fields. The mandatory unit suite fails, and TypeScript reports these schema mismatches.
4. “Independent outcomes” are not independent. The observation ledger emits only VPOC and settlement status summaries; calculator outcomes reuse the selected lifecycle and the removed canonical `netPnl` field. Credit-capture, fixed-time, and invalidation outcomes are absent.
5. Diagnostic extrema have permanently IV-first semantics, regardless of visible chart series. The detail labels are generic, so their hidden IV preference fails the stated labeling requirement.
6. Export validation checks many internal identities, but it does not independently bind fee inputs to causal fill prices/amounts, does not establish official-combo evidence independently of a mutable boolean, and does not reject calculator-shaped data inserted into an observation/export.
7. Estimated capital omits source timestamp and BTC/USD conversion timestamp/rate fields from its output contract and rejects all PM cases even when matching simulation evidence exists. It therefore cannot satisfy the disclosure and PM requirements.

## Provenance

| Check | Result | Evidence |
|---|---|---|
| Clean starting branch | PASS | `git status --short --branch` returned only `## work`. |
| Canonical HEAD | PASS | `git rev-parse HEAD` returned `eb67a3a99a0474c4d01b3ee77b6caee02f6d8f00`. |
| Calculator merge is in HEAD | PASS | `git merge-base --is-ancestor a22c06d eb67a3a...` exited 0. |
| Calculator implementation is in merge | PASS | `git merge-base --is-ancestor 5194e13 a22c06d` exited 0. |
| Containing branch | PASS | Both `git branch --contains` commands returned `work`. |

Canonical graph:

```text
* eb67a3a (HEAD -> work) fix: enforce observation and export invariants (#13)
*   a22c06d Merge pull request #12 ... add-contract-size-scenario-calculator
|\
| * 5194e13 feat: add contract-size PnL scenario calculator
|/
*   cb9ec07 Merge pull request #11 ... runnable-execution-ledger
```

## Eighteen-point gate

### 1. Canonical ancestry and repository provenance — PASS

- **Direct evidence:** the exact HEAD and both ancestry relations are established above.
- **Affected output:** audit provenance only.
- **Test evidence:** both `merge-base --is-ancestor` commands exited 0; both commits are contained by `work`.
- **Severity:** none.
- **Required remediation:** none.

### 2. UI handler reaches `buildAndRunObservationRequests` and `runEventBacktest` — PARTIAL

- **Direct evidence:** `runBacktest` calls `buildAndRunObservationRequests`; that function groups requests and calls `runEventBacktest`.
- **Affected output:** all result tables, details, charts, calculator, aggregates, and export.
- **Adversarial/runnable finding:** the adapter returns objects without `scenarioInput`, yet immediately evaluates `next[0].scenarioInput.config`. Thus the call path reaches the ledger but cannot complete a non-empty UI run. `entryLedgers` is also declared by `AnalysisResult` but never populated.
- **Test evidence:** TypeScript reports missing required `scenarioInput` and unresolved calculator symbols.
- **Severity:** **P0 blocker**.
- **Required remediation:** construct a complete `AnalysisResult` from each observation, including immutable scenario inputs and any intended display-only ledgers, and add a rendered handler test that completes a non-empty run.

### 3. Entry signal, decision, order, supporting prints, and both fills are causal — PASS

- **Direct evidence:** `executionClock` delays candle evidence until close; `tapeFill` admits only compatible trades strictly after order and through the forward deadline; `simulateTakerSpread` requires both complete synchronized legs.
- **Affected output:** `entryExecution`, entry cash flow, diagnostics, margin, and terminal PnL.
- **Test evidence:** execution-validity tests cover pre-signal prints, candle-close decisions, accumulation, insufficiency, and two-leg completeness; structured validation checks post-order timestamps and configured amounts.
- **Severity:** none for the primary selected entry.
- **Required remediation:** retain these invariants.

### 4. Exit trigger, decision, order, supporting prints, and both close fills are causal — PASS (selected exit only)

- **Direct evidence:** VPOC/fixed trigger construction feeds a new `executionClock`; `simulateTakerExit` uses closing-side prints strictly after the close order and requires synchronized complete legs. The validator checks trigger/decision/order/fill chronology and amounts.
- **Affected output:** selected lifecycle and executed terminal PnL.
- **Test evidence:** execution-validity tests cover pre-trigger rejection and triggered-unfilled behavior.
- **Severity:** high limitation: this does not rescue item 18 because alternative outcomes are not executed independently.
- **Required remediation:** apply the same complete lifecycle independently to every advertised outcome.

### 5. Taker tape proxy is the only authoritative executed scenario — PASS

- **Direct evidence:** `StrategyVariantConfig.primaryExecutionScenario` only accepts `taker-tape-proxy`; entry and exit execution both use the tape simulators.
- **Affected output:** primary observation execution and PnL.
- **Test evidence:** execution tests assert causal compatible tape behavior.
- **Severity:** none.
- **Required remediation:** retain the constrained type and runtime path.

### 6. Maker analysis remains optimistic and opportunity-only — PASS

- **Direct evidence:** `assessMakerOpportunity` returns `status: "opportunity-only"`; the primary observation path never calls it.
- **Affected output:** diagnostic maker display only.
- **Test evidence:** unit test explicitly verifies maker-compatible prints remain optimistic opportunity evidence.
- **Severity:** none.
- **Required remediation:** retain separation from observations and exports.

### 7. Missing entry, close, path, and settlement data stay missing — PASS

- **Direct evidence:** missing/partial candidates become unavailable or no-trade; incomplete entry does not produce execution PnL; missing close evidence carries to settlement; missing delivery price produces `entered-exit-unfilled`; diagnostic valuation returns explicit unavailable points rather than filling values.
- **Affected output:** observations, coverage, path gaps, and terminal results.
- **Test evidence:** missing-value, close-evidence, delivery-price, and path-splitting tests pass.
- **Severity:** none.
- **Required remediation:** retain explicit missingness.

### 8. Candidate alternatives do not multiply denominator observations — PASS

- **Direct evidence:** `buildUniqueObservationRequests` groups candidates by `eventId::stableVariantId` before execution.
- **Affected output:** aggregate denominators.
- **Test evidence:** grouping test verifies alternatives remain one variant while a genuine different width creates another.
- **Severity:** none.
- **Required remediation:** retain grouping before execution.

### 9. Exactly one observation exists per `eventId::strategyVariantId` — PASS

- **Direct evidence:** execution results are inserted into a map and duplicate keys throw; validator independently flags duplicates.
- **Affected output:** observations and aggregates.
- **Test evidence:** deduplication and duplicate-export tests pass.
- **Severity:** none.
- **Required remediation:** retain both construction-time and validation-time checks.

### 10. Complete no-trades remain in denominator with zero PnL; unavailable events remain explicit and reduce coverage — PASS

- **Direct evidence:** no-trade branches attach `zeroPnl`; unavailable branches omit PnL; aggregation excludes unavailable rows from `completeEvents` while retaining all rows in `totalOriginalSignals`.
- **Affected output:** execution rate, coverage, and average PnL per complete signal.
- **Test evidence:** Events B/C and execution-validity denominator tests pass.
- **Severity:** none.
- **Required remediation:** retain semantics.

### 11. Diagnostic paths use actual executed opening cash flow and actual opening fees — PASS

- **Direct evidence:** `runEventBacktest` passes actual two-leg fill prices/timestamps, filled amount, routed opening fee, and `entryCashFlow.netBtc` to `buildExecutedValuationPath`; the diagnostic function anchors each mark to that net opening cash flow.
- **Affected output:** raw/IV diagnostic path and extrema.
- **Test evidence:** the materially different retrospective-print regression passes.
- **Severity:** none.
- **Required remediation:** retain actual-entry basis.

### 12. Diagnostic extrema never replace executed or settlement terminal PnL — PASS

- **Direct evidence:** tables source terminal values only from `executedNetPnl ?? settlementNetPnl`; diagnostic values have distinct `diagnostic*` fields and point roles.
- **Affected output:** terminal result table and detail card.
- **Test evidence:** observation end-to-end tests validate terminal ledger identities.
- **Severity:** none, separate from the mislabeled extrema failure in item 18.
- **Required remediation:** retain field separation.

### 13. Fees use actual causal fills; official-combo treatment requires real route evidence — PARTIAL

- **Direct evidence:** production fee construction uses actual entry/exit fill prices and amount. `effectiveRoute` prevents a combo waiver when the configuration boolean is false.
- **Affected output:** entry/closing cash flows, terminal PnL, settlement result, and capital estimate.
- **Adversarial finding:** export validation recalculates a fee only from mutable fee-ledger inputs; it does not compare fee `inputPriceBtc` and `absoluteAmount` to causal fill prices and amounts. “Evidence” is only a mutable `officialComboEvidence` boolean, not route evidence independently bound to an order/trade identifier. A self-consistent fee-input rewrite or a forged `true` boolean can pass.
- **Test evidence:** the existing tamper test changes `finalFee` only; it does not prove rejection of a self-consistent changed input or forged combo evidence.
- **Severity:** **P0 export-integrity failure**.
- **Required remediation:** bind every fee leg to execution side, fill price, filled amount, route, schedule effective time, and immutable official combo order evidence during validation.

### 14. Settlement uses the versioned ledger, correct effective-date boundary, and delivery fees — PASS

- **Direct evidence:** settlement is built through `buildOptionSettlementLedger`; validation reconstructs both legs, checks the effective-date version, economic PnL, generated futures, and delivery fees.
- **Affected output:** settled terminal PnL and exports.
- **Test evidence:** accounting boundary/delivery tests and settlement tamper tests pass.
- **Severity:** none for the canonical settlement branch.
- **Required remediation:** use this same ledger for each independently evaluated settlement outcome.

### 15. All four margin models dispatch correctly; missing PM evidence returns typed unavailable — PASS

- **Direct evidence:** SM models call `estimateStandardOptionMargin`; PM models require portfolio evidence and otherwise return `state: "unavailable"` with the requested model.
- **Affected output:** `marginResult` and scenario capital input.
- **Test evidence:** all-four-model dispatch test passes.
- **Severity:** none for observation margin; calculator disclosure remains failed under item 18.
- **Required remediation:** retain dispatch; calculator must consume matching PM evidence instead of rejecting all PM.

### 16. Export validation independently verifies all required invariants — FAIL

- **Direct evidence:** chronology, leg amounts, cash-flow identities, duplicate keys, settlement reconstruction, and aggregate reconciliation are present.
- **Affected output:** JSON export trustworthiness.
- **Tamper matrix:**
  - pre-order entry print — **rejected**;
  - pre-trigger/close-order exit print — **rejected**;
  - partial/one-leg fill represented as filled — **rejected by amount/evidence checks**;
  - amount mismatch — **rejected**;
  - changed fee total — **rejected**, but a self-consistent changed fee input is **not independently bound to fills**;
  - false official-combo claim — **not reliably rejected** when the mutable evidence boolean is forged true;
  - duplicate observation key — **rejected**;
  - changed settlement/delivery fee — **rejected**;
  - changed aggregate denominator — **rejected**;
  - calculator scenario inserted as an extra observation property — **not rejected** because there is no strict schema/additional-property check or calculator-data prohibition.
- **Test evidence:** existing structured tamper tests prove only the successful subset. Static adversarial tracing proves the missing cross-bindings; the mandatory type/build gate also fails before an export can be considered independently auditable.
- **Severity:** **P0 blocker**.
- **Required remediation:** validate against a closed schema, reject calculator fields, cross-bind fee inputs and official route evidence to actual execution records, and add the full adversarial matrix as audit tests.

### 17. Contract-size scenarios fully rerun execution/accounting without mutating primary state — PASS

- **Direct evidence:** `calculateContractSizeScenario` calls `runEventBacktest` with a copied config and requested amount, using already cached candidates/candles; UI calculator state is separate React state; export reads only primary `analysisResults[].observation`.
- **Affected output:** local scenario only.
- **Test evidence:** base reproduction, size-dependent tape accumulation, nonlinearity, and primary-state immutability tests pass.
- **Severity:** none for isolation, although the UI cannot reach the calculator because item 2 fails.
- **Required remediation:** retain local-state/export separation while repairing semantics independently.

### 18. Calculator extrema, estimated capital, and independent outcomes are economically and temporally correct — FAIL

- **Direct evidence / extrema:** `scenarioPathMetrics` expects removed `rawPnlUsd` / `ivPnlUsd` keys while scenario observations contain `diagnosticRawUnrealizedPnlUsd` / `diagnosticIvUnrealizedPnlUsd`. It defaults permanently to IV. The main detail extrema also always prefer IV irrespective of chart selection, but use generic labels (“Best diagnostic unrealized”, “Max adverse”). This is hidden IV-first semantics and fails the explicit-label requirement.
- **Direct evidence / outcomes:** `scenarioOutcomes` returns only VPOC and settlement. It borrows `selectedExitLifecycle`, does not independently execute each rule, and reads removed `observation.netPnl`. Credit-capture, fixed-time, and invalidation outcomes do not exist. Trigger/decision/order/fills/fees are not retained per outcome.
- **Direct evidence / capital:** `OpeningCapitalRequirement` lacks account assumption, source timestamp, BTC/USD rate, and conversion timestamp fields. It hardcodes protective-leg-first display rather than modeling a general configured opening sequence. Every PM model returns unavailable even with matching simulation evidence. The output does not carry theoretical maximum loss separately.
- **Affected output:** calculator extrema, outcome rows, execution status/PnL, and estimated account balance.
- **Test evidence:** `npm run test:unit` fails the independent-outcome calculator test because `observation.netPnl` is undefined. TypeScript also flags old path/PnL properties and UI wiring. Size/VWAP and insufficient-tape tests do pass, but cannot compensate for semantic failures.
- **Severity:** **P0 blocker**.
- **Required remediation:** use diagnostic schema fields; couple extrema to active series or label them explicitly IV; independently run VPOC, both credit captures, every valid fixed-time exit, invalidation, and settlement from the same scenario entry; preserve each lifecycle and ledger; prohibit post-expiry fixed exits; expose complete capital assumptions/evidence/conversion provenance and use matching PM evidence when available.

## Mandatory calculator checks

| Requirement | Result | Evidence |
|---|---|---|
| Base amount reproduces base observation | PASS | Deep-equality unit test passes. |
| Size may change prints, VWAP, timestamps, synchronization, fees, margin, feasibility, PnL | PARTIAL | Accumulation, VWAP, timestamp, fee, and nonlinear behavior are covered; the broken terminal property and absent independent outcomes prevent complete proof. |
| No linear multiplication | PASS | Scenario calls `runEventBacktest`; nonlinear-size test passes. |
| Insufficient tape says “Not executable at this size” without extrapolated PnL | PARTIAL | Engine reports non-executable and no extrema, but UI wiring/type failures prevent proof of the required displayed message. |
| Both-instrument minimum/increment/precision | PASS | `validateScenarioAmount` loops over both metadata records; tests cover invalid values. |
| Missing path observations remain gaps | PASS | Metrics filter missing values and path segmentation preserves gaps. |
| Scenario does not mutate primary state/export | PASS | Deep-clone comparison passes; export sources only primary observations. |
| Extrema semantics and labeling | FAIL | Permanently IV-first/default with generic detail labels; calculator reads obsolete field names. |
| Independent outcomes | FAIL | Only VPOC/settlement summaries; no independent lifecycle/accounting and removed `netPnl` reuse. |
| Estimated account balance | FAIL | Required assumptions, timestamps, conversion evidence, theoretical-loss separation, configurable order, and evidenced PM support are absent/incomplete. |

## Validation summary

- `git diff --check`: passed with this audit document present.
- `npm run test:unit`: **failed** — 70 passed, 1 failed. Failure: `independent filled PnL uses recalculated entry, closing fees, and selected amount`, with `TypeError` reading `identity` from undefined `observation.netPnl`.
- The remaining mandatory commands are recorded in the final response after execution.
- Browser screenshots are not semantic evidence and were not required to establish these failures. Their absence is not part of the fail decision.

## Final decision

The gate cannot pass because the runnable UI adapter, export independence, calculator schema, independent outcomes, extrema semantics, and capital-evidence contract fail mandatory requirements. Passing causal-entry, selected-exit, denominator, settlement, and margin tests does not make the combined results research-usable.

POST-REMEDIATION GATE FAILED — results remain unusable
