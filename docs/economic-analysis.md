# Economic Analysis methodology

Economic observations are keyed by `candidate_id × execution_scenario × pricing_track × exit_policy`. The report consumes the winning observation from Complete Exit-Policy Analysis; it does not independently reorder triggers.

## Reused accounting primitives

- Entry gross credit, opening fees, and net opening cash flow are canonical candidate fields produced by the entry ledger.
- Closing and delivery fees and BTC/USD PnL are canonical selected outcome fields. A settlement outcome's closing fee is the authoritative delivery fee.
- Maximum economic loss calls `payoffExtrema` from `expiry-payoff`, which in turn uses inverse intrinsic BTC settlement and `calculateDeliveryFee`. The reported loss is the absolute value of the worst canonical net payoff. Requested width is never an input.
- The versioned option execution schedule remains in `accounting.ts`: since 2019-07-01 each leg is `min(0.0003 BTC, 12.5% × option premium) × amount`. Research Analytics does not install another fee schedule.
- IM, MM, peak IM and peak MM are read only from canonical margin scenarios. Peak values are never replaced by opening values or maximum loss.

Returns are `realized BTC PnL / positive BTC denominator`. Capital-days use verified peak IM multiplied by actual holding hours divided by 24. Missing and zero denominators remain unavailable.

## Portfolio chronology and account sizing

The path contains every selected entry and Exit-Policy valuation timestamp. Exact timestamp ties close first and open second; `candidate_id` sorts events inside each phase. This models no overlap at a boundary where one position exits exactly as another enters. States are steps and are never interpolated. Aggregate maximum loss is a gross sum with no bullish/bearish offset.

`maximumRiskFraction` and `maximumMarginUtilization` are locked configuration inputs in `(0, 1)`, not outputs fitted to history. For each state, the risk requirement is aggregate maximum loss divided by the former and the margin requirement is aggregate verified IM divided by the latter. A complete required account size exists only when both constraints exist; it is the maximum over time of their pointwise maximum.

Standard Margin is supported only to the extent that canonical scenarios contain verified values. Portfolio Margin is explicitly unsupported without a verified portfolio-state simulation and is never approximated by summing Standard Margin. Native BTC collateral changes on realized exits. Its USD equivalent uses the canonical index at that event, keeping BTC trading PnL distinct from BTC/USD movement. Available funds require both configured starting BTC collateral and verified margin.
