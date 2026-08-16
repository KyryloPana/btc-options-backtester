# Research bundle schema

Schema **1.0.0** is a versioned, venue-aware interchange format. Every ZIP contains `research_bundle/run.json` and `events.jsonl`, `underlying_path.jsonl`, `candidates.jsonl`, `valuations.jsonl`, `outcomes.jsonl`, `availability.jsonl`, `margin_scenarios.jsonl`, `evidence_trades.jsonl`, `futures_comparisons.jsonl`, and `futures_path.jsonl`. Empty tables remain empty files and availability is stated in `run.json`.

**`candidates.jsonl` = selected numerator; `availability.jsonl` = complete generated denominator.** Reports calculate coverage from availability and recompute extrema from valuations, never UI summaries.

`run_id` identifies the export. Distinct saved configurations receive venue-scoped `source_run_id` values; dependent rows retain the ID and `run.json.source_runs` preserves each configuration. Every JSONL record has `venue`; entity IDs are venue-scoped. Deribit uses inverse economics, multiplier 1, BTC native/premium/settlement currency, and USD quote currency. Generic `*_native` fields permit future linear USDC/USDT venues. `null` means unavailable, never zero. Status/reason fields distinguish unavailable states. Nonfinite numbers are forbidden.

## Tables and joins

| File | Primary key | Joins / purpose |
|---|---|---|
| `run.json` | `run_id` | Metadata, source runs, methodology, venue configuration, counts and availability. |
| `events.jsonl` | `event_id` | Deduplicated selected events. |
| `underlying_path.jsonl` | `event_id + timestamp_utc` | Stored hourly path; never synthesized. |
| `candidates.jsonl` | `candidate_id` | Saved numerator; joins event. |
| `valuations.jsonl` | `valuation_id` | Candidate + timestamp + track; includes unavailable rows. |
| `outcomes.jsonl` | `outcome_id` | Candidate + ten required outcome types. |
| `availability.jsonl` | `event_id + candidate_id` | Complete saved generated denominator. |
| `margin_scenarios.jsonl` | `margin_scenario_id` | Result or explicit unavailable record. |
| `evidence_trades.jsonl` | `evidence_id` | Persisted source trade usage. |
| `futures_comparisons.jsonl` | `comparison_id` | Comparison or explicit unavailable record. |
| `futures_path.jsonl` | `event_id + instrument + timestamp_utc` | Verified futures series only. |

Consumers validate the schema version, foreign keys, venues, statuses and finite numbers first, group incompatible methodology by `source_run_id`, use availability as denominator, and use valuation/outcome facts. Unknown versions are rejected. Schema changes require a new version and explicit migration. Historical margin and futures data are not verified, so they are explicitly unavailable rather than fabricated. Export reads only persisted snapshots and never refetches an exchange.
