# Economic Analysis methodology

Economics is a **selected-cohort, one-policy** report. It is not evaluated until a Complete Exit Policy is configured. Once configured, every economic observation is keyed by `candidate_id × analytical_track × exit_policy`, and the winning endpoint is consumed from Complete Exit-Policy Analysis without independently reordering triggers.

## Analytical tracks and denominator

Central Economics is empirical expected-taker Q50 (`modeled_expected`). Reference is the execution-independent fair-value counterfactual, Q90 (`modeled_conservative`) is conservative execution, and Maker/Taker/delayed layers remain diagnostics. Each layer's opportunity denominator is the unique candidate identities in the selected cohort after canonical cohort projection. Controlled Short-Strike research is excluded; unavailable and rejected/no-trade observations remain distinct from priced positions.

## Entry, fees, and risk

Entry gross credit, opening fees, and net opening cash flow are canonical track candidate fields produced by the routed entry ledger. Closing execution fees, delivery fees, and BTC/USD PnL come from the selected canonical outcome. Total realized fees are opening execution + closing execution + delivery, with settlement delivery never relabelled as closing execution. Execution adjustment is executed/modelled credit minus unslipped credit and is not charged a second time.

Two risk quantities are intentionally separate:

1. **Canonical Reference structural loss** is the candidate-level, execution-independent quantity shared with Spread Width and other structural reports. Economics consumes that export unchanged.
2. **Track maximum net loss** is evaluated by the same authoritative inverse-vertical structural-payoff primitive using that analytical track's executed/modelled leg premiums, quantity, opening fees, and entry reference index.

Return on canonical structural loss is a cross-track diagnostic. Return on track maximum net loss is the execution-dependent efficiency measure, and risk-based position equity uses track maximum net loss.

## Policy-window Standard Margin

Historical account quantities are supported only for **Standard Margin + segregated/dedicated account**. Cross Standard Margin and every historical Portfolio Margin configuration are unsupported. Structural economics remain available in those modes, but opening/peak margin, margin returns, margin capital-days, and complete minimum equity are unavailable with a reason. Segregated Standard Margin is never relabelled as Cross or Portfolio Margin.

The bundle already serializes the canonical Standard Margin path under `margin_scenarios.margin_inputs.path`, including timestamp, IM, MM, index and the row-level model/deployment provenance. Economics clips that path from the track's actual entry through the selected policy's actual valuation terminal. The path must begin at entry. Opening IM/MM are its first point; policy-window peak IM/MM and their timestamps are maxima only inside that window.

Margin capital-days are the piecewise-constant time integral of IM over the selected-policy window, with the final in-window point held to the policy terminal. They are **not** peak IM multiplied by holding time and never use an expiry-window summary after an earlier exit. An absent or incomplete path makes both policy-window peak margin and margin capital-days unavailable.

## Returns and sizing

Every return requires a positive, available denominator. Missing and zero denominators remain unavailable.

For one position:

- risk-side required equity = track maximum net loss / configured maximum risk fraction;
- margin-side required equity = policy-window peak IM / configured maximum margin utilization;
- complete minimum equity = maximum of the two, only when both are available.

The global **Duration capital basis** control scopes Duration & DTE capital-time analysis. Economics reports its canonical structural-risk and policy-window margin denominators independently; that control does not switch or hide Economics denominators.

## Configuration-level economics and portfolio selection

A structural configuration is identified canonically at export by `structural_configuration_id` (version `structural-configuration-v1`). Its inputs are only ex-ante choices: target DTE family, strike method, requested width, structure type, and quantity. Actual DTE, substituted strikes/width, PnL, and exits are deliberately excluded. Schema 4.2 persists the identifier, normalized fields, and version; schema 4.1 imports derive it only from those already-persisted ex-ante fields.

Configuration comparisons use one independent MR event per observation. A configuration/event pair must contain at most one candidate; duplicates are an integrity error naming every conflicting candidate. Trade-conditional statistics use priced events only. Explicit canonical no-trades contribute zero to opportunity-normalized expectancy, while unavailable evidence makes that expectancy unavailable. P10/P5 require at least `max(20, minimumCellEvents)` independent priced events.

No configuration is selected from historical performance. Configuration-level economics are always comparable, but account chronology is built only for `selectedStructuralConfigurationId`; otherwise the report says to select a configuration.

## Time-indexed strategy portfolio

For the explicitly selected configuration, timestamps are the union of entry, exit, canonical valuation, and canonical policy-window margin points. Exits occur before entries at an exact timestamp. Every open position needs an exact canonical net-PnL mark and exact margin state at that timestamp; there is no forward-fill.

At a complete state:

- `modeledEquityBtc(t) = startingAccountEquity + realizedClosedPnl(t) + sum(openPositionNetPnl(t))`;
- `aggregateIM(t) = sum(openPositionIM(t))` and likewise for MM;
- `modeledAvailableFundsBtc(t) = modeledEquityBtc(t) - aggregateIM(t)` under segregated Standard Margin only;
- `requiredEquityRisk(t) = sum(gross trackMaximumNetLoss) / maximumRiskFraction`;
- `requiredEquityMargin(t) = aggregateIM(t) / maximumMarginUtilization`;
- `requiredEquity(t) = max(requiredEquityRisk(t), requiredEquityMargin(t))` only when both sides are available.

Peak aggregate IM/MM are maxima of the contemporaneous aggregate series, never sums of per-position opening or individual peak values. Modeled-equity drawdown is peak-to-trough on the complete MTM series. Realized-only equity drawdown is retained under that explicit diagnostic name. USD modeled equity uses the causal index at each state. “Modeled available funds” is an analytical reserve calculation, not a claim about historical authenticated Deribit account balances.
