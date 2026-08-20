# Tiered causal valuation shadow report

Starting commit: `8a1b18949a486d756597443d7813fd57e465593f`.

The independent reference-valuation and causal delayed-observed tracks were present and tested before this work began. The new surface track remains shadow-only: it never changes raw execution coverage, never calls a print or modeled price a fill, and retains constant-entry IV only as the separately labelled legacy sensitivity.

## Ladder and controls

The deterministic ladder is exact causal trade IV/price, actually supplied official mark, same-expiry piecewise IV interpolation, adjacent-expiry total-variance interpolation, bounded extrapolation, DVOL-level-anchored smile prior, then unavailable. Each leg records bounds, tier, anchor count/age, interpolation status, nearest-anchor log-moneyness distance, version, reason codes, and a grade that is explicitly unrelated to fill probability.

Sparse cross-sections use two-parameter piecewise interpolation. The implementation deliberately does not invoke SVI/SSVI until a separately validated dense fitter exists. Invalid IVs, noncausal anchors, future-trained priors, unbounded extrapolations, and model failures are rejected. DVOL comes only from Deribit's volatility-index endpoint and supplies a level—not a contract IV.

## Deterministic shadow fixture coverage

The checked-in nine-case ladder fixture is a capability/acceptance fixture, not a claim about production population coverage. Cumulative coverage is: raw qualifying execution **0/9**; exact valuation anchor **2/9**; official marks **3/9**; same-expiry interpolation **4/9**; maturity interpolation **5/9**; bounded extrapolation **6/9**; DVOL prior **7/9**; unavailable **2/9**. Raw execution coverage remains **0/9** before and after every valuation tier.

The blockers represented by unavailable outcomes are `no-volatility-level-input` and `future-trained-prior-rejected`; production callers can additionally receive missing underlying, contract metadata, extrapolation-bound, and model-failure reason codes.

## Overlap validation

`validation/causal-valuation-shadow.json` is the deterministic chronological/leave-one-out report. Its small illustrative overlap has bias **−0.005 BTC**, MAE **0.015 BTC**, median absolute percentage error **20%**, p95 absolute error **0.01 BTC**, and zero credit-sign errors. Segmentation fields are declared but cannot be responsibly estimated from two observations. In production, reports must segment by DTE, moneyness/delta, type, width, volatility regime, tier, and density; promotion must also pass tail-credit rules.

## Execution scenarios and limitations

Fair, expected, and conservative scenario generation runs for observed and unobserved cases alike. Concessions always reduce achievable spread credit; fees and slippage remain outside this concession. The promotion floor is 30 qualifying paired overlaps. The fixture has **n=0**, so no expected-execution estimator earned promotion. Output exposes the predetermined 50/100/250/500 bp `assumption sensitivity` grid and a conservative 500 bp case instead. This work therefore completes the shadow capability, **not** estimator promotion or a claim of complete empirical coverage.

Limitations: no dense no-arbitrage SVI fitter is enabled; bounds are deterministic scenario bands rather than confidence intervals; mark history remains sparse and is never synthesized; DVOL is approximately a 30-day market volatility level; forward falls back only when the caller explicitly supplies its consistent underlying convention; and real-dataset coverage depends on available historical anchors.
