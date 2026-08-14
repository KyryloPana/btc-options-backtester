# Zero-entry evidence regression

## Reproduction identity

* Starting commit: `7c6ddd408540875964259c1ffad9a8811b840fca` (`fix: contain pnl chart within analysis panel (#17)`).
* Canonical causal engine first entered the runnable path in `7ad452b` (`fix: wire causal execution into runnable backtest`).
* August event: `1c454ed4`, long, 2024-08-07, source price 57,000; the generated UI matrix uses the 48,000 put anchor, DTE 7/14/30 and widths 1,000/2,000/3,000.
* The repository contains no checked-in August API cache. Consequently exact resolved instruments and print counts from the user's browser cache cannot be honestly reproduced in this checkout. The pre-change trace below records what canonical HEAD actually passed to execution: every Yellow rank-one candidate was rejected at the candidate → `runEventBacktest` boundary before either tape was searched. The deterministic fixture trace in the final section proves the repaired boundary and causal engine without substituting a different market snapshot.

## Phase 1: pre-change rank-one trace (canonical HEAD)

All timestamps below share the event's provisional second precision. Because execution was never invoked, fill/search evidence is explicitly `not reached`, rather than fabricated as zero.

| event ID | strategyVariantId (abbrev.) | signal / precision | source candle | decision available | latency / order / search end | desired short / long | resolved short / long; names; expiry/type | amount / metadata | retrieval | actions / tape | rejection |
|---|---|---|---|---|---|---|---|---|---|---|
| 1c454ed4 | dte=7,width=1000 | 2024-08-07T00:00:00Z / second | n/a | signal | 1s / +1s / +30m | 48000 / 47000 | retained on candidate, but dropped from displayed fallback; P | configured amount / retained on ContractSeries only | **partial although both contracts loaded** | short sell / long buy; not reached | `retrieval-incomplete` (incorrect adapter classification) |
| 1c454ed4 | dte=7,width=2000 | same | n/a | signal | same | 48000 / 46000 | same boundary; P | same | partial | not reached | `retrieval-incomplete` |
| 1c454ed4 | dte=7,width=3000 | same | n/a | signal | same | 48000 / 45000 | same boundary; P | same | partial | not reached | `retrieval-incomplete` |
| 1c454ed4 | dte=14,width=1000 | same | n/a | signal | same | 48000 / 47000 | same boundary; P | same | partial | not reached | `retrieval-incomplete` |
| 1c454ed4 | dte=14,width=2000 | same | n/a | signal | same | 48000 / 46000 | same boundary; P | same | partial | not reached | `retrieval-incomplete` |
| 1c454ed4 | dte=14,width=3000 | same | n/a | signal | same | 48000 / 45000 | same boundary; P | same | partial | not reached | `retrieval-incomplete` |
| 1c454ed4 | dte=30,width=1000 | same | n/a | signal | same | 48000 / 47000 | same boundary; P | same | partial | not reached | `retrieval-incomplete` |
| 1c454ed4 | dte=30,width=2000 | same | n/a | signal | same | 48000 / 46000 | same boundary; P | same | partial | not reached | `retrieval-incomplete` |
| 1c454ed4 | dte=30,width=3000 | same | n/a | signal | same | 48000 / 45000 | same boundary; P | same | partial | not reached | `retrieval-incomplete` |

For each row, total prints, pre-order prints, compatible prints, compatible amount, contributing prints, VWAP, fill time, and synchronization difference are **not reached**, not zero. The old `buildExpiryCandidates` overloaded `retrievalStatus="partial"` to mean Yellow liquidity. `runEventBacktest` correctly interpreted `partial` as incomplete retrieval and returned `data-unavailable` before `simulateTakerSpread`. This is the zero-execution regression.

## Boundary audit

| boundary | identity/tape/metadata result |
|---|---|
| UI selections → desired matrix | complete desired strikes, P type, DTE and width |
| manifest → inventory | complete instrument name, strike, option type, expiry, `sourceFiles`, trade tape and optional authoritative amount metadata |
| inventory + manifest → candidate | both `ContractSeries` objects retained; Yellow quality incorrectly changed retrieval status to `partial` |
| candidate → observation request | object references and rank/quality retained |
| request → `runEventBacktest` | first semantic loss: `partial` interpreted as retrieval failure; execution skipped |
| observation → AnalysisResult | `spread` remains present; fallback lookup could nevertheless expose an incomplete row when selection was absent; display read only nested contracts instead of resolved identity |
| AnalysisResult → row/details | one Yellow event badge conflated liquidity and outcome; no-trade/unavailable showed selected-exit `$0`; generic evidence text hid leg causes |

The first affected commit is `7ad452b`: it introduced the guard that treated Yellow's pre-existing `partial` quality encoding as incomplete retrieval. The earlier visible valuation was retrospective: it normalized centered/entry-window prints and was not proof of a post-order taker fill. The causal engine added in `5492e52` is correct and remains unchanged in its strict chronology/direction/amount/window/synchronization rules.

## Post-repair deterministic evidence traces

The regression fixture represents the same August matrix shape with stable timestamps so every datum is reviewable.

### Successful causal entry

* signal/decision/order: 100 / 100 / 100 ms; precision manual; fill-search end 200 ms; latency 0.
* short: desired/resolved 50,000, `BTC-X-50000-P`, P, expiry 10,000, source `api:BTC-X-50000-P`, amount metadata min/step/precision 0.1/0.1/1; action/direction sell; 2 prints loaded, 1 before order, 1 compatible strictly after; amount 1; contributor 110@0.011×1; VWAP 0.011; fill 110.
* long: desired/resolved 49,000, `BTC-X-49000-P`, P, same expiry/source/metadata; action/direction buy; 2 prints, 1 before, 1 compatible after; amount 1; contributor 115@0.011×1; VWAP 0.011; fill 115.
* synchronization difference 5 ms; spread reason `filled`.

### Legitimate no-trade

* order/search: 100–200 ms; requested 1.
* short sell tape: 2 prints loaded; 1 pre-order (90, amount 5) is rejected; only post-order contributor is 110, amount 0.4. Code: `insufficient-compatible-amount`; exact reason reports required 1, observed 0.4, and one pre-order print.
* long buy tape: one compatible post-order print at 115 covers 1.
* spread: `short-leg-rejected`; no PnL is visually presented.

### Data unavailable

* resolved manifest identifies the requested instruments but marks retrieval failed; neither candidate is ranked or assigned Green/Yellow.
* code: `retrieval-incomplete`; observation outcome `data-unavailable`; PnL is absent and aggregate denominator excludes it while signal coverage retains it.

## Stable reason taxonomy

The executable trace now emits `contract-history-unavailable`, `no-compatible-print-after-order`, `insufficient-compatible-amount`, `leg-synchronization-exceeded`, and `filled`. Candidate/orchestration classification uses `data-unavailable` for `candidate-unresolved`, `short-instrument-missing`, `long-instrument-missing`, `contract-history-unavailable`, `amount-metadata-unavailable`, and `retrieval-incomplete` evidence. `no-trade:no-listed-structure` is reserved for a complete empty manifest; it is not used for parsing, retrieval, identity, or metadata failures.

## Counts

* Before correction, canonical August UI symptom: 9 observations, 0 executed (all nine blocked before tape execution).
* After correction with the same browser cache: Yellow complete candidates reach causal execution; the exact executed count depends solely on compatible post-order tape in that cache. This repository does not claim a fabricated market count.
* Deterministic repaired fixture: 1 observation, 1 causally entered; additional fixtures prove 1 legitimate no-trade and 1 data-unavailable outcome.
