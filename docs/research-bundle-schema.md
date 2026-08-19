# Research Bundle Schema

Schema **2.3.0** is a versioned, venue-aware interchange format. Every ZIP contains `research_bundle/run.json` and `events.jsonl`, `underlying_path.jsonl`, `candidates.jsonl`, `valuations.jsonl`, `outcomes.jsonl`, `availability.jsonl`, `margin_scenarios.jsonl`, `evidence_trades.jsonl`, `futures_comparisons.jsonl`, and `futures_path.jsonl`. Empty tables remain empty files and availability is stated in `run.json`.

**`candidates.jsonl` = selected performance numerator; `availability.jsonl` = complete generated denominator.** Reports calculate coverage from availability and recompute extrema from valuations, never UI summaries.

## Keys and join semantics

| File | Row key | Notes |
|---|---|---|
| `run.json` | `run_id` | Metadata, source runs, methodology, venue configuration, counts and availability. |
| `events.jsonl` | `event_id` | Persisted MR events, including zero-selection events. |
| `underlying_path.jsonl` | event/time row | Stored event candles. |
| `candidates.jsonl` | `structure_execution_id` | Selected numerator row per structural candidate and execution scenario. `candidate_id` is stable structural identity and is intentionally shared by maker/taker rows. |
| `valuations.jsonl` | `valuation_id` | Joins `candidate_id + execution_scenario`; evaluated scenarios only. |
| `outcomes.jsonl` | `outcome_id` | Joins `candidate_id + execution_scenario`; evaluated scenarios only. |
| `availability.jsonl` | `availability_id` | Complete generated denominator row. Multiple requested widths/policies may resolve to the same structural `candidate_id`; each row retains `requested_strikes` and `actual_strikes`. |
| `margin_scenarios.jsonl` | `margin_scenario_id` | Joins selected structural `candidate_id`. |
| `evidence_trades.jsonl` | `evidence_id` | Raw trade catalog with usage references that include `execution_scenario`. |
| `futures_comparisons.jsonl` | `comparison_id` | Explicit futures comparison availability. |

`candidate_id` remains the structural foreign key. `availability_id` is the generation-attempt denominator key, introduced in 2.3.0 so two requested variants that collapse onto the same actual contracts remain inspectable without colliding. Selected structures reconcile when at least one availability row for the same `candidate_id` is marked `is_selected:true`; they are not silently remapped.

Execution scenario status is scenario-local: `evaluated` means priced rows may exist, `unavailable` means an attempted scenario failed evidence/economic checks, and `not_evaluated` means it was intentionally not run. Unavailable and not-evaluated scenarios do not fabricate valuation/outcome rows and are not zero.

Consumers validate the schema version, primary keys, foreign keys, venues, statuses, reason codes, finite numbers, entry economics, and source-run compatibility first. Unknown versions are rejected. Schema changes require a new version and explicit migration. Historical margin and futures data are unavailable rather than fabricated. Export reads only persisted snapshots and never refetches an exchange.

## Version history

* **2.3.0** adds `availability_id`, `requested_strikes`, and `actual_strikes` to `availability.jsonl`; preserves duplicate structural generation attempts; and distinguishes attempted-but-invalid execution scenarios as `unavailable`.
* **2.2.0** added parallel maker/taker execution scenarios with `structure_execution_id` as the candidates row key.
* **2.0.0** exports every persisted event, generated availability denominator, and stored hourly path even when no candidate is selected.
