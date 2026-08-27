# Historical execution calibration — Phase 1 (2026-08-27)

## Reproducibility record

Work started on branch `work` at `fd2fe246b8a4bf38ae87e49009430aa13c269e06`, with a clean working tree. The frozen identities observed before editing were research bundle `3.7.0`, research selection `1.8.0`, Reference `causal-reference-v2-hybrid-interpolation`, and modeled execution `modeled-execution-v2`. The configured unit gate contained 875 test cases before this phase; this phase adds 7, for 882 passing cases after implementation.

Recent production commits were inspected through `de77b9d`, `3614774`, `c8fea8e`, `bdfafa2`, `ea0038a`, and `50bd4f1`. Production Reference is unchanged: (1) Rule-C, same-expiry, genuinely bracketed interpolation in total variance with at least five unique strikes; (2) the strictly causal exact-contract local-IV anchor; (3) unavailable. Exact settlement remains separate. SVI and SSVI are validation/research candidates, not production tiers.

## Existing execution prototype audit

`buildExecutionCalibrationRecords` walks only persisted selected MR structures. It admits evaluated immediate and delayed maker/taker spread rows only when a same-timestamp Reference spread credit exists, normalizes `fair credit - observed credit` by absolute fair spread credit, and drops non-finite and **all negative/favourable** bps. `calibrationMeta` uses only rows strictly earlier than the modeled target, requires 30 rows, and calculates a median/P90. `buildModeledExecution` currently promotes a maker median as “expected” when sufficiently populated and a taker upper tail as conservative; otherwise conservative execution retains the declared 500 bp fallback. Thus it is a small, selected-structure, spread-credit sample rather than the option tape; maker queue position is unidentified; and truncating favourable residuals biases the prototype. This phase deliberately does not alter any of that runtime behaviour. Maker calibration remains technical debt and outside this dataset.

## Architecture and method

`execution_calibration_observations` / `execution-calibration-observations-v1` is standalone under `.local-cache/execution-calibration/execution_calibration_observations`. Raw retrieval shards, immutable content-addressed observation JSONL, and an immutable manifest are separate from the canonical bundle. No bundle or selection schema changed.

The declared sampling frame is every retrieved BTC option print in the requested half-open UTC interval with actual DTE **1–46 days** and `|ln(strike/index)| <= 0.35`, both option types and both directions. These bounds cover the production 5–10, 11–18, and 24–38 DTE windows with a buffer and the validated cross-section envelope. Selection reads only time/contract coordinates, never residual, PnL, MR status, or model performance. The intended audit interval is monthly-sharded 2023-10-01 through 2026-08-27, giving nearly four months of prehistory before the earliest 2024-01-27 MR event. The CLI accepts explicit half-open dates so each calendar month can be materialized and reused.

Retrieval generalizes the existing currency-wide `get_last_trades_by_currency_and_time` path. A saturated 1,000-row response is bisected deterministically down to one millisecond; a saturated indivisible leaf is recorded incomplete and can never yield eligible rows. Trade-ID-first deduplication preserves `trade_seq`; instrument metadata supplies creation time. Raw shard bytes are reused only for an exact interval and carry a hash.

For target trade `T`, evidence is first filtered to `timestamp < T`, same expiry, and a different instrument. This rejects the target, every print of its instrument (the stricter independent-primary rule), future prints, and same-millisecond prints before the existing market-IV admission gate runs. Admitted evidence uses the frozen 60-minute window, contract-listing gate and forward-equals-index/rate-zero convention. Existing robust strike aggregation and existing total-variance interpolation are called directly. Primary eligibility additionally enforces Rule C (bracketed, five unique strikes, no extrapolation). The diagnostic production hybrid calls the existing hybrid with the same target-free slice and may use a genuinely earlier exact-instrument anchor. Both fair premiums call `priceInverseOption` (`Deribit inverse Black–Scholes/1.0.0`). Deribit `mark_price` is retained only as a diagnostic.

Rows preserve signed decimal/vol-point IV residuals, adverse-direction IV residuals, signed/adverse BTC premium residuals, and relative bps only when `|fair premium| >= 1e-8 BTC`. Negative/favourable values are retained. Causal activity fields use only prior tape (5/15/60-minute same-instrument counts/amounts, prior-trade age, 60-minute expiry activity and strike breadth). Date, ISO week, expiry, instrument, expiry×date and UTC-hour groups support grouped validation. No spread, depth, imbalance, queue, impact, maker probability, bucket or estimator is invented.

Deribit `direction` is used as aggressor/taker side. This agrees with the repository's parser and execution-side semantics (`README.md` and `execution-side.ts`) and the official Deribit public trade schema, which defines `direction` from the taker perspective: [Deribit API documentation](https://docs.deribit.com/#public-get_last_trades_by_currency_and_time). The semantic claim is versioned as `deribit-public-trades-direction-aggressor-v1`; unknown values remain raw and produce no action-aware residual.

## Real-data audit status (hard environmental blocker)

The required real run was attempted exactly as:

```text
node --experimental-strip-types scripts/build-execution-calibration.ts 2023-10-01 2023-11-01
```

It failed before receiving any bytes with DNS `EAI_AGAIN history.deribit.com`. A direct HTTPS probe also failed at the environment proxy with `403 CONNECT tunnel failed`. There was no pre-existing `.local-cache` shard in this checkout. Consequently **zero real rows were retrieved, and no empirical coverage, residual, mark-disagreement, clustering, missingness, bucket-support, or bias numbers can honestly be reported**. Synthetic results are not substituted and the convenience attempt is not described as a universe. No cache manifest was emitted from incomplete data.

This is a delivery blocker for the empirical portion of Prompt 1, not evidence about Deribit coverage. Once network/DNS access is available, run monthly shards across 2023-10 through 2026-08, retain every immutable manifest, and aggregate their audit objects. The emitted audit includes universe identities, status reconciliation, call/put and buy/sell counts, months, independent/hybrid/mark availability, full un-winsorized requested percentiles, fair-minus-mark distributions, and top instrument/expiry/date clustering. Cohort tables and equal-day/expiry-day medians should then be added to this report from those real manifests before estimator promotion.

## Bias audit and Prompt 2 recommendation

The implementation exposes the necessary dimensions (DTE, signed and absolute log-moneyness, option type, direction, activity, amount, geometry, calendar and grouping IDs), and failed rows are retained with explicit status. But the unavailable real run means none has measured support yet. It is therefore impossible to claim that far-OTM, short-DTE, quiet, earlier-period, call/put or buy/sell eligibility is balanced; impossible to quantify effective environments; and impossible to compare execution residual scale with fair-reference disagreement.

**Recommendation for Prompt 2: do not promote either conditional buckets or global quantiles yet. Fair-value uncertainty/data coverage remains unmeasured because the real calibration audit is blocked.** After completing the real run, proceed to coarse conditional buckets only if grouped counts and mark-disagreement diagnostics demonstrate support; otherwise restrict evaluation to broad/global empirical quantiles. This report does not implement either estimator.

## Frozen-boundary confirmation

The architectural separation remains `Reference fair value != modeled executable value != observed execution evidence`. The new dataset is never consulted by selection, pricing, Reference, execution scenarios, economics, outcomes, fees, margin, or the research bundle. Runtime modeled execution, its maker logic, minimum 30-row rule and 500 bp fallback remain byte-for-byte unchanged.
