# Research Economics forensic audit

This audit explains Research Comparative Economics inputs without repairing, coercing, or reclassifying them. It consumes the same imported `AnalysisDataset` as Research Analytics and writes deterministic JSON.

## Run it

```bash
npm run audit:research-economics -- /path/to/research-bundle.zip
npm run audit:research-economics -- /path/to/extracted/research_bundle --output audit.json
```

The directory form must contain every canonical research-bundle file. Import validation still runs; invalid bundles fail rather than producing a partial, misleading audit.

## Output ledgers

- `canonicalOpportunityLedger` records every persisted event × structural-configuration row, its opportunity id, structural fields, attempted and canonical candidate ids, immutable Q50 decision/reason, and all candidate mappings (including selection and research-role flags).
- `trackMaterializationLedger` reconciles each canonical identity against Reference, Q50, and Q90. It records canonical track descriptors, materialized candidate rows, entry/path/outcome counts, Thesis and Settlement pricing, normalization status/reason, duplicate evidence, and Q50 contradictions.
- `integrityReasonDistribution` reports both affected identity count and affected structural-configuration count for each exact cause. No duplicate is resolved by array order.
- `q50UnavailableReasonDistribution` preserves producer `reason_code` values rather than collapsing unavailable observations into zero or a generic bucket.
- `identityReconciliation` compares opportunity, availability, candidate, computed structural identity, and normalized-position ids for every materialized candidate. Disagreement is explicit.
- `configurationEvidenceLedger` reproduces the Q50/Thesis report classification for every structural configuration, including opportunity counts, selected-track priced coverage, integrity, tail N, and every canonical-USD metric's status, reason, and effective/eligible/missing event counts. The summary therefore reconciles the screen's priced, INVALID, unavailable-USD, and Low-N totals directly.
- `marginAndUsdCoverage` reports BTC and USD separately for PnL, gross/net credit, fees, opening/peak IM, and capital-days. Its denominator is the track's metric-eligible canonical identities (Q50 trade identities only for modeled expected; all canonical identities for Reference/Q90), and absent or duplicate normalized evidence remains a reasoned missing observation.
- `exitPolicyCoverage` reports every canonical policy independently by track, including priced, reached-but-unpriced, absent/unavailable source outcomes, pre-entry, after-expiry, and ambiguous timing.

The audit never fabricates PositionEconomics, never converts missing values to zero, and never derives USD from an aggregate BTC statistic. The only deliberate zero in the product remains the separately defined Q50 explicit-no-trade term in opportunity-normalized expectancy; this audit only reports that generation state.

For current selection stores, `modeled_execution_not_attempted` is no longer a synonym for “not manually selected.” Generation persists one research-only `comparative_economics` materialization for each resolvable canonical event/configuration, and the empirical recompute operates on those rows as well as Strategy selections. That materialization is the sole producer of `configuration_opportunities.economic_opportunity`. A missing rank-1 representative, failed Reference input, or insufficient empirical calibration remains a reasoned producer-side unavailable state; it is not repaired during export or audit.

## Root-cause taxonomy and repository evidence

No complete production research bundle is committed in this repository, so the reported production-screen totals (81 opportunities, 36 configurations, 7 events, 47 unavailable opportunities, and 19 invalid configurations) cannot be truthfully decomposed from checked-in data. Run the command against that exact bundle to obtain its distribution.

The deterministic unit fixture currently exercises the following observed audit distribution:

- one `explicit_no_trade_conflicts_with_priced_position` identity/configuration;
- one `unavailable_q50_opportunity_conflicts_with_priced_position` identity/configuration;
- one Q50 unavailable opportunity with producer reason `modeled_execution_not_attempted`;
- one duplicate canonical opportunity identity (two source rows, one identity/configuration);
- one canonical candidate plus a noncanonical candidate attempt on the same identity, retained as provenance without becoming duplicate economic evidence;
- one candidate whose candidate-side structural id disagrees with its canonical opportunity mapping.

These categories mean different things:

| Class | Examples | Interpretation |
| --- | --- | --- |
| Producer problem | stale priced Q50 row on canonical no-trade/unavailable; producer-specific unavailable reason | Upstream generation/materialization evidence is contradictory or absent. |
| Consumer/join problem | opportunity, availability, candidate, or normalized-position structural ids disagree | Evidence cannot safely join to the canonical identity and is explicitly listed. |
| Integrity problem | duplicate canonical identity or duplicate selected-track evidence | Ambiguous evidence is withheld; no first/last-write precedence is used. |
| Legitimate unavailable state | a reasoned canonical `unavailable`, absent source outcome, reached but unpriced outcome | Missing evidence remains unavailable and is grouped by its exact reason. |
| Small-N state | too few independent MR events for a tail threshold | This is neither an integrity error nor proof of missing USD evidence. The forensic ledgers expose counts; report tail thresholds remain unchanged. |

The audit is intentionally diagnostic. Any producer or methodology repair must be reviewed separately against the canonical Q50, causal valuation, and per-observation USD rules.
