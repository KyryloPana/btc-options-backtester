# Research-bundle integrity audit — 2026-08-16

## Scope and reproducible acceptance

The audit started at `dbb1bea` and exercised the persisted-selection service, a newly constructed service instance (the restart boundary), the production bundle builder, the production ZIP writer, and the validator. The deterministic two-event fixture has four saved priced structures (including one explicitly Red-but-priced), two unselected priced structures, and one unavailable structure. Its generated denominator is seven. It uses two target horizons (7 and 14 days), two widths (10 and 20), Deribit venue identity, raw and IV-normalized valuation tracks, unavailable valuation points, exact evidence trades, VPOC, an unhit invalidation, fixed exits after expiry, settlement, and explicit unavailable verified margin and futures records.

The acceptance row counts are: `run.json` 1, `events.jsonl` 2, `underlying_path.jsonl` 1, `candidates.jsonl` 4, `valuations.jsonl` 16, `outcomes.jsonl` 40, `availability.jsonl` 7, `margin_scenarios.jsonl` 4, `evidence_trades.jsonl` 4, `futures_comparisons.jsonl` 2, and `futures_path.jsonl` 0. The test writes and inspects the real ZIP signature and reconciles both run counts to their corresponding JSONL tables.

## Findings and corrections

The original validator checked only file presence, JSON syntax, schema version, venue presence, two foreign-key relationships, and a text search for nonfinite tokens. It could accept duplicate primary IDs, availability/selection disagreement, incompatible source runs, invalid timestamps, unknown status/reason codes, missing tracks or outcomes, venue/currency contradictions, and tampered totals. The validator now rejects each of those conditions and recursively checks numeric finiteness. Deterministic relative tolerance is `1e-12 × max(1, |expected|, |actual|)` for exported arithmetic.

The exporter emitted the UI-style missing-field token `targetIndex`; it is now canonicalized to `target-index`. No UI filters or UI-only state participate in bundle construction: the numerator comes only from `selectedStructures`, while the denominator comes from the persisted generation snapshots. Persistence tests cover event and dataset isolation, stable venue-scoped IDs, idempotent resave, durable deselection, hidden selections, stale snapshot retention, atomic restart, canonical JSON, and nonfinite rejection.

## Economic, temporal, and provenance truthfulness

Validation independently reconciles leg prices and quantity to opening gross, opening gross less fees to net opening cash flow, and native PnL times each point's target index to USD PnL. Application accounting tests additionally cover closing value/fees, capture, extrema, outcomes, holding duration, and remaining DTE. Temporal tests enforce causal completed-candle decisions, bounded entry evidence, no future evidence, expiry bounds, after-expiry fixed outcomes, settlement, and VPOC/invalidation ordering. Hourly underlying rows retain the `candle-open` convention.

Raw VWAP and IV-normalized rows remain separate and mandatory. Unavailable raw values remain null; IV and exact evidence timestamp/source fields survive; and model diagnostics retain the direct opening basis rather than replacing it with retrospective modeled entry pricing.

Deribit candidates declare inverse style, BTC native/premium/settlement currencies, USD quote currency, and multiplier 1. A schema-only hypothetical Bybit linear option proves USDC native/premium/settlement representation and does not introduce fabricated market data. Historical verified margin and futures series remain explicitly unavailable: protective-leg cost is kept separate from account requirement, initial/maintenance margin values stay null, stored spot/index candles are not relabeled as futures, and reproduction inputs remain in the saved snapshots.

Static deployments cannot write selection snapshots or invoke the local ZIP endpoint. The UI reports that limitation and instructs the operator to use the local application server. Ordinary JSON export remains independent of the selected-only bundle export.

## Adversarial matrix

The negative matrix corrupts one valid production bundle per case and proves rejection of duplicate primary IDs, broken foreign keys, candidates absent from saved selections, selected candidates absent from availability, missing venue, currency contradictions, nonfinite JSON, out-of-bounds timestamps, missing required outcomes, unknown status and reason codes, missing pricing tracks, unreconciled totals, flattened/incompatible source runs, and unknown schema versions.
