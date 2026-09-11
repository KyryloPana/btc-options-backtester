# Economic Analysis methodology

Strategy Evaluation Economics answers: **“What does the chosen configuration require and produce as a deployable portfolio?”** It is a strictly **one-structural-configuration, one-policy** report. It is not evaluated until both a canonical Candidate Configuration and a Complete Exit Policy are selected. Once configured, every visible strategy statistic is scoped to that configuration before aggregation and keyed by `event × structural_configuration_id × analytical_track × exit_policy`. Cross-configuration DTE, strike, and width questions belong exclusively to [Research Comparative Economics](research-comparative-economics.md).

## Analytical tracks and denominator

Central Economics is empirical expected-taker Q50 (`modeled_expected`). Reference is the execution-independent fair-value counterfactual, Q90 (`modeled_conservative`) is conservative execution, and Maker/Taker/delayed layers remain diagnostics. Each layer's opportunity denominator is the selected configuration's event × configuration opportunities after canonical cohort projection. Reference/Q50/Q90 pairing occurs only after applying that same configuration scope. Controlled Short-Strike research and every non-selected configuration are excluded; unavailable and rejected/no-trade observations remain distinct from priced positions. With no selected configuration, the report returns `not_selected` and displays no pooled economic fallback.

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

## Selected-configuration economics and portfolio selection

A structural configuration is identified canonically at export by `structural_configuration_id` (version `structural-configuration-v2`). Its inputs are only ex-ante structural choices: target DTE family, strike method, requested width, and direction-neutral structure family. Quantity is a separate sizing input. Direction, actual DTE, substituted strikes/width, PnL, and exits are deliberately excluded. Schema 4.3 persists and validates the identifier and normalized fields; schema 4.2 imports recompute it only from persisted ex-ante fields.

The selected configuration uses one independent MR event per observation. A configuration/event pair must contain at most one candidate; duplicates are an integrity error naming every conflicting candidate. Trade-conditional statistics use priced events only. Explicit canonical no-trades contribute zero to opportunity-normalized expectancy, while unavailable evidence makes that expectancy unavailable. P10/P5 require at least `max(20, minimumCellEvents)` independent priced events.

No configuration is selected from historical performance. Strategy Evaluation never browses or ranks the full configuration universe: it consumes only `selectedStructuralConfigurationId`. The full configuration matrix and controlled parameter comparisons are shown once, in Research Comparative Economics. Account chronology is built only for the selected identity; otherwise Strategy Economics asks for Candidate Configuration selection.

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

## Corrected matrix, configuration, and portfolio objects (schema 4.4)

The research matrix denominator is the canonical `configuration_opportunities.jsonl`: exactly one row for each qualifying MR event × attempted ex-ante structural configuration. Generation attempts remain represented even when no candidate was entered. Its structured Q50 state is `trade`, `explicit_no_trade`, or `unavailable`; only `empirical_nonpositive_credit_after_fees` is an explicit economic rejection. Pending recompute, insufficient calibration, missing Reference inputs, and every other methodological failure remain unavailable.

A structural configuration is direction-neutral: nominal target-DTE family + short-strike rule + requested width + `credit_vertical` family. Direction, quantity, actual expiry/DTE/strikes/width, exits, and PnL are excluded. Quantity remains position sizing, not structural identity. Identity version v2 is recomputed during validation. Native schema 4.4 bundles with inconsistent normalized fields or hashes fail; schema 4.2 migration can recompute v2 from its persisted ex-ante fields, while its missing structured opportunity decision is explicitly unavailable.

The generation state is resolved against the configured Complete Exit Policy before aggregation: `priced_trade` requires exactly one matching priced position with finite PnL; `explicit_no_trade` remains the single canonical economic rejection; every intended trade with a missing, unpriced, or conflicting selected-policy result becomes `unavailable`. Opportunity expectancy is `sum(priced Q50 PnL + zero for canonical explicit no-trades) / all eligible event × selected-configuration opportunities`, and is unavailable if any eligible opportunity is unavailable. Trade-conditional PnL statistics use priced trades only. Strategy headline KPIs only appear after explicit configuration selection; before selection no matrix or pooled fallback is shown.

Execution survival uses paired candidate + event + complete-Exit-Policy identities. Reference→Q50 and Q50→Q90 report median within-pair changes; absolute layer cards are secondary.

Portfolio chronology consumes exact selected-policy-window marks. An open constituent requires exact PnL, IM, and MM at the portfolio timestamp. Missing paths or marks invalidate the aggregate state—there is no zero assumption, opening-margin fallback, LOCF, or interpolation. Aggregate bounded risk is named aggregate track maximum net loss and sums gross without directional netting. UTC-crossing state intervals split at midnight; daily IM capital-days reconcile to the global time integral.

A selected configuration receives a complete portfolio only when every opportunity is `priced_trade` or `explicit_no_trade`. Any unavailable intended trade gates the entire deployable chronology, account requirement, drawdown, and concurrency result rather than silently producing a priced-subset portfolio. After reconstruction, every invested timestamp is audited for exact PnL, IM, and MM. Missing constituent state makes the chronology `partial`: its raw points remain diagnostic, but drawdown, peak-risk, available-funds, capital-time, and required-account conclusions are unavailable. The audit retains incomplete-state counts, the first incomplete timestamp, and separate missing-PnL/IM/MM counts.

An explicit no-trade contributes zero only when it does not conflict with a genuinely priced matching selected-policy position. Such a contradiction receives `explicit_no_trade_conflicts_with_priced_position`, makes the configuration an integrity error, invalidates expectancy, and blocks complete portfolio reconstruction. A harmless non-priced placeholder does not create that contradiction.

For segregated Standard Margin, the canonical protective-long position and valid vertical geometry must exist, but its contemporaneous mark is not a mathematical input. The verified formula charges the causal marked short option only; the long has zero standalone SM and supplies no short-leg offset. Long-mark coverage is retained separately as optional evidence. A missing short mark, index, vertical geometry, or verified rule date still makes margin unavailable. Cross SM and PM remain unsupported.

Current run provenance names `causal-reference-v3-expiry-forward-hybrid/repricing-v2`, the expiry-specific causal-forward basis, and `option-trade-implied-forward-v1`. Generation metadata declares no fixed global rate and states that Reference valuation is unavailable when causal expiry-forward evidence is absent. The old `simple-model-reconstruction/1.0.0` label is restricted to its retired local export DTO and cannot source current run metadata.

Schema 4.4 separates authoritative `generation_assumptions` from unchanged `source_generation_assumptions_raw`. The former is validated against the current effective Reference contract; the latter retains exact legacy or unknown persisted metadata for audit without presenting `rate: 0` as current methodology.

Production bundle export materializes volatility upstream from the local evidence/cache pipeline and passes the resulting event and structure snapshots into synchronous `buildResearchBundle()`. Empty upstream evidence remains empty/unavailable; the exporter performs no network retrieval and creates no volatility estimate.

## Local regeneration and acceptance audit

The canonical persisted input is `data/research-selections/<dataset-id>.json`; the matching independent-event denominator is read from `data/trade-datasets/<dataset-id>.json`. Refresh saved derived rows with `node --experimental-strip-types scripts/run-research-recompute.ts <dataset-id> <audit.json> --execution-estimator=<artifact-directory-or-json>`. With `BTC_OPTIONS_LOCAL_DATA_ROOT` and `BTC_OPTIONS_VOLATILITY_CACHE_ROOT` pointing to the prepared immutable evidence/cache, start the local application and download `/__local/research-bundle/<dataset-id>`; that endpoint materializes volatility before synchronous bundle construction. Run `npm run audit:volatility-production -- <dataset-id> data/research-selections` to emit the canonical volatility coverage audit. Regeneration uses the corrected margin implementation automatically; no bundle-row rewriting or additional code change is required.
