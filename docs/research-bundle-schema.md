# Research Bundle Schema

Schema **3.6.0** is a versioned, venue-aware interchange format. Every ZIP contains `research_bundle/run.json` and `events.jsonl`, `underlying_path.jsonl`, `candidates.jsonl`, `valuations.jsonl`, `outcomes.jsonl`, `availability.jsonl`, `margin_scenarios.jsonl`, `evidence_trades.jsonl`, `structure_economics.jsonl`, `futures_comparisons.jsonl`, and `futures_path.jsonl`. Empty tables remain empty files and availability is stated in `run.json`.

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
| `futures_comparisons.jsonl` | `comparison_id` | One canonical Deribit BTC-PERPETUAL baseline per `event_id` -- never one per option structure. Carries per-unit economics (`gross_pnl_usd_per_unit`, `fees_usd_per_unit`, `funding_usd_per_unit`, `risk_to_invalidation_usd_per_unit`) plus every observation endpoint's own status. |
| `futures_path.jsonl` | event/comparison/time row | Causal perpetual OHLC observations between the reference entry and the exit endpoint. Absent bars are absent; nothing is forward-filled and the index/spot path is never substituted. |

`candidate_id` remains the structural foreign key. `availability_id` is the stable generation-attempt denominator key, introduced in 2.3.0 so two requested variants that collapse onto the same actual contracts remain inspectable without colliding. It is derived from the structural identity plus requested strikes, target horizon, and strike method, not array order; an exact repeated attempt is rejected upstream. Selected structures reconcile when at least one availability row for the same `candidate_id` is marked `is_selected:true`; they are not silently remapped.

Execution scenario status is scenario-local: `evaluated` means priced rows may exist, `unavailable` means an attempted scenario failed evidence/economic checks, and `not_evaluated` means it was intentionally not run. Unavailable and not-evaluated scenarios do not fabricate valuation/outcome rows and are not zero.

Entry evidence is filtered and assembled independently for maker and taker. Immediately after assembly, a credit scenario is `evaluated` only when its scenario-specific short premium is strictly greater than its long premium. Debit and zero-credit evidence become `unavailable` with a reason before selection persistence; current-schema persistence also rejects an evaluated row that contradicts this invariant. A failure in one scenario never borrows evidence from, or changes the status of, the other.

The generation snapshot is the foreign-key authority for saved selections. Regeneration preserves a selection only when its structural `candidate_id` still exists. A genuinely removed structure remains visibly stale, is never remapped or deleted automatically, and blocks both a new “successful” save and canonical export until the user removes/reselects it or restores its producing generation configuration.

Consumers validate the schema version, primary keys, foreign keys, venues, statuses, reason codes, finite numbers, entry economics, and source-run compatibility first. Unknown versions are rejected. Schema changes require a new version and explicit migration. Historical margin is unavailable rather than fabricated. Export reads only persisted snapshots and never refetches an exchange.

### Canonical economics, identity and provenance (3.4.0)

**One bounded structural loss (3.5.0).** `structure_economics.jsonl` and `margin_scenarios.jsonl` both derive `maximum_structural_loss_*` from `canonicalStructuralLoss`, so the two tables cannot disagree, and the analytics economics layer reads the same helper. It is the bounded structural risk of the vertical: net opening cash flow at the reference index plus the gross spread position value at each sampled settlement index, reported as a **positive USD magnitude**, with BTC as that loss converted at the stated reference index.

Settlement **delivery fees are excluded** and reported separately in `settlement_fee_treatment`. A delivery fee is a fixed BTC amount, so its USD value grows without bound as the settlement index grows; for a bear call both legs finish deep ITM, making a global fee-inclusive USD maximum mathematically **unbounded**. Sampling that tail at `Number.MAX_SAFE_INTEGER` is what produced `0.0003 BTC x 9.007e15 = $2.702 trillion` on ordinary $1k-wide spreads and poisoned futures equal-risk sizing. `global_fee_inclusive_maximum` states `bounded` or `unbounded` honestly, and the finite fee figure is labelled scenario-specific at a named settlement index. Structural loss is not Initial Margin, Maintenance Margin, protective-long cost, or a required balance; nothing in `structure_economics.jsonl` may be named as margin.

**One configuration identity.** `effective_configuration_hash` is taken over a canonical, methodology-only representation: object keys sorted, set-like arrays sorted, `generatedAtUtc` and `applicationBuild` excluded as provenance rather than methodology. `source_run_id` is derived from the same identity. A store whose events carry different methodology hashes is **refused** at export, naming the event IDs, the hashes and the differing fields — a stale event must be regenerated, and schema migration is never a substitute.

**Build provenance.** `build_provenance_status` is derived from each source run's `application_build`, injected from Git at build time. Without Git metadata the value is the explicit sentinel `unavailable:no-build-metadata` — never a null and never an invented SHA.

**Denominator.** `trade_dataset_mr_event_count` comes from the active trade dataset (`trade_dataset_mr_event_count_source`), never from the selection store and never a hardcoded historic count.

**Manifest.** `table_availability` covers every canonical table and is derived from actual exported content. The validator checks it in both directions: usable rows can never read as unavailable, and no usable rows can never read as available.

### Canonical outcome identity (3.6.0)

Outcome identity comes from ONE semantic table (`research-outcomes.ts`), not from string shape. The previous exporter lowercased and underscored labels, so `"3D"` became `"3d"` and never matched the canonical `fixed_3d`: valid persisted fixed-time outcomes were replaced by generic unavailable rows, and `holding_hours` was hardcoded `null` on every row.

Rows now carry `outcome_identity_version`, `source_label`, `source_status` and `unmapped_source_labels`, and `status` is faithful to the source: an evaluated snapshot is never demoted, and an unavailable one is never promoted. Four states stay distinct -- snapshot absent, snapshot not-hit, snapshot evaluated, and an exporter mapping failure -- and only the last is a defect. A label no canonical policy maps to fails the export loudly rather than shipping a bundle quietly missing a policy the engine produced. `fixed_14d` is recognised but deliberately outside the exported set, so it is neither an error nor a claimed drop.

`holding_hours` is `(effective close - that track's own actual entry) / 3_600_000`, where the effective close is the valuation timestamp, falling back to the causal decision timestamp. It is measured from the track's own entry, so a delayed track reports the interval it genuinely held for. It is `null` for unreached or unavailable outcomes, and never negative, before entry, or past expiry.

Each track descriptor in `structure_economics.jsonl` carries a `source_outcomes` digest of what the producing engine persisted, so the validator compares source semantics -- status, timestamps, PnL -- against the exported rows rather than merely checking that some rows exist.

### Futures baseline semantics

The perpetual baseline is a benchmark, not a ranking. It uses the same MR event, direction, and causal decision timestamps as the options layer -- both read `resolveEventTiming`, so a VPOC exit is taken at the touch candle's *close*, never backdated to the touch. Sequence classification compares **like-for-like decision candles** — the candle each decision lands in — so neither outcome gains priority from being represented by a candle open while the other is a candle close; a touch and a breach inside one hourly candle report `sequence_status:"ambiguous"` and `exit_ordering_status:"ambiguous"` rather than one being picked.

**Endpoints are independent.** `vpoc`, `invalidation` and the fixed 3D/5D/7D endpoints each carry their own `outcome` (`reached` / `not_reached` / `not_configured`), `status` and `reason_code`. An endpoint that does not resolve never erases the entry, the causal path, the other endpoints, or the per-unit risk to invalidation: an event whose VPOC target was never reached — or was never configured — stays fully analysable, with `exit_status` naming which case it is and `path_terminus_basis` recording that the path runs to the end of the retrieved series. Funding is `not_evaluated` where there is no resolved exit, which is distinct from a funding outage.

Prices come from `get_tradingview_chart_data` on `BTC-PERPETUAL`; commissions from `get_instrument`; funding from `get_funding_rate_history` on the main public host, which the history mirror does not serve. Funding is summed from `interest_1h` over the hours actually held and priced at each hour's own perpetual bar. A single missing hour leaves `funding_status:"partial"`, `funding_usd_per_unit:null` and `net_pnl_usd_per_unit_after_funding:null`: an unknown funding bill is never a zero funding bill, and the price-and-fee baseline still stands.

Per-unit economics are authoritative. `quantity` is a derived equal-dollar-risk convenience that names the structure it was scaled against in `quantity_basis`; when no such structure exists the row reports `equal_risk_sizing_status:"downstream_derivable"` and the per-unit values still stand. Futures margin, leverage, liquidation and equal-capital normalization are deliberately out of scope and stay explicitly unavailable.

## Version history

* **3.0.0** separates trigger state (`reached`, `not_reached`, `unavailable`, `after_expiry`, `ambiguous`) from per-track pricing state (`priced`, `unavailable`, `not_applicable`), preserves per-track PnL independently, removes unused `fixed_14d`, and requires `credit_capture_25`. Legacy outcomes migrate as ambiguous/degraded because their trigger and pricing histories cannot be reconstructed safely.

* **2.3.0** adds `availability_id`, `requested_strikes`, and `actual_strikes` to `availability.jsonl`; preserves duplicate structural generation attempts; and distinguishes attempted-but-invalid execution scenarios as `unavailable`.
* **2.2.0** added parallel maker/taker execution scenarios with `structure_execution_id` as the candidates row key.
* **2.0.0** exports every persisted event, generated availability denominator, and stored hourly path even when no candidate is selected.

## Selection schema 1.3.0: independent model track

Selection stores now persist `modelTrack` beside (never inside) `executionScenarios.maker` and
`executionScenarios.taker`. `statusLayers` preserves structural, model, maker, taker, raw-VWAP,
reason-code, amount, direction, time-window, and synchronization evidence. A selection with
`selectionProvenance: "model-only-diagnostic"` has a valid theoretical track while both execution
scenarios remain unavailable; analytics must not count that model track as execution coverage or
raw PnL. Versions 1.0.0–1.2.0 migrate deterministically with an unevaluated model track and
`legacy` provenance; execution economics are never fabricated during migration.

## Schema 3.2.0 / selection schema 1.4.0: structural, valuation, and execution separation

`strategy_variant_id` is the canonical identity for the event, configuration, actual expiry,
actual short and long instruments, and target width. During the compatibility period it is equal
to `candidate_id`; maker, taker, delayed, reference, expected-modeled, and conservative-modeled
tracks all reference that one identity and never create scenario-specific structural identities.

Selections and exported availability/candidate rows now carry a typed `contract_resolution`, an
execution-independent `reference_valuation`, independent immediate maker and taker scenarios, and
explicit `not_evaluated` delayed/modeled placeholders. Contract resolution distinguishes
`exact_resolved`, `nearest_listed_resolved`, `confirmed_not_listed`, `retrieval_failure`, and
`metadata_unavailable`. An authoritative listing remains resolved when its trade retrieval is empty;
tape amount is relevant only to execution evidence. Reference economics are never copied into raw
maker/taker rows or their coverage. Legacy records migrate with explicit legacy/unavailable states;
no missing evidence or economics is inferred.

Reference valuation is independent from execution evidence. A selected structure is canonically
retainable when either (a) at least one immediate maker/taker scenario is genuinely `evaluated`, or
(b) its `reference_valuation` passes the complete structural, causal, provenance, timestamp, and
economic-reconciliation audit. Consequently, a reference-valued structure does not require
immediate maker or taker historical support. The two scenario rows remain `unavailable` or
`not_evaluated`, keep execution-dependent fields null, and produce no valuation/outcome rows.
Delayed and modeled fields in schema 3.2.0 are metadata/placeholders and do not independently make
a candidate retainable. A status label alone, an unresolved structure, unavailable provenance,
future evidence, or unreconciled reference economics cannot satisfy the reference branch.
