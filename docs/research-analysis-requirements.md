# Research analysis requirements

## Governing contracts

This document is the durable requirements source for Research Analytics. The canonical eleven-file bundle supersedes earlier analysis drafts. **`candidates.jsonl` is the explicitly selected performance numerator; `availability.jsonl` is the complete generated denominator.** Unselected structures must never be copied into candidates.

Schema 2.0.0 includes every persisted research event, including zero-selection events, and all generated availability and stored underlying candles. Version 1 bundles may be migrated only in visibly degraded mode; absent facts remain absent.

## Analytical logic and readiness audit

| Analysis | Exact source | Readiness |
|---|---|---|
| Resolution ordering/censoring | `events.sequence_status`, trigger/decision timestamps, `observation_end_timestamp_utc` | available |
| Underlying MFE/MAE and touch/breach | `underlying_path.{timestamp_utc,high,low}`, event direction/entry, candidate strikes | derivable |
| Actual DTE | candidate entry/expiry and `actual_dte_hours`, `actual_dte_days` | available |
| Valuation and credit capture | raw/model `valuations`, entry cash flow and fees | available or degraded per point |
| Width/expiry/strike comparisons | complete `availability` denominator, selected `candidates` numerator | available |
| Exit policies | `outcomes`, with trigger separate from decision availability | available or degraded per outcome |
| Exact inverse payoff | inverse contract metadata, legs, quantity, settlement/index facts | derivable |
| Delayed entry | causal opening-side trade/quote evidence at the delayed timestamp | unavailable unless supplied |
| Historical margin | verified historical margin observations | unavailable |
| Current-formula scenarios | explicitly versioned formula and inputs | unavailable unless supplied |
| Portfolio reconstruction | selected timestamps, quantities, valuation paths and compatible source runs | degraded |
| Futures comparison | verified futures instrument series only | unavailable |
| Raw/model tracks | both valuation rows, including unavailable points | available/degraded |

Generic `exitTimestamp` is descriptive exit lineage and is never invalidation time. Invalidation is derived from the first completed stored candle that breaches the documented invalidation level; trigger time is candle open and decision availability is candle close. VPOC follows the same causal distinction. Unresolved observations are right-censored at the explicit observation end.

Opening-side and closing-side evidence are not interchangeable. Closing marks cannot price a hypothetical delayed opening. Spot or index candles cannot be relabeled as futures, and current formulas cannot be described as historical margin.

## Universe and reporting guardrails

Preflight reports total companion trade-dataset MR events, persisted research events, events with generated candidates, events with selected candidates, and events with stored underlying paths. Without a matching canonical companion that proves the full MR universe, event-universe completeness is false and consumers must not claim per-opportunity statistics.

All imports validate required files and schema, JSON/JSONL, primary and foreign keys, source-run lineage, venue/currency consistency, UTC timestamps, finite values, enums and reason codes, selection/denominator consistency, entry-to-expiry bounds, and arithmetic reconciliation. Incompatible runs are not silently merged. Valid input is normalized once into a typed immutable `AnalysisDataset`; reports, charts, conclusions, statistical inference, and PDF generation are explicitly deferred.
