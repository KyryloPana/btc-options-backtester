# Causal delayed-execution analysis

Starting commit: `f2c020a92cb7cb71287039b3e2102deca0564d10` (the completed valuation/execution-decoupling change).

`causal-progressive-entry/1.0.0` evaluates maker opportunity and taker execution independently in 0–2h, 2–4h, 4–8h, 8–12h, 12–24h, and next-trading-day buckets. The last bound is configurable (48 hours by default). Evidence is strictly later than each bucket's lower bound and no later than its upper bound. Both exact legs must cover the predetermined requested amount and complete inside the synchronization bound. Trade IDs are deduplicated and the deterministic earliest synchronized completion wins.

Maker results are deliberately named **delayed observed opportunity**: opposing-aggressor prints do not establish queue position or prove that an earlier resting order filled. Taker results are likewise tape proxies, not claims of real historical fills.

Every accepted observation stores both leg completion times, raw qualifying amounts, directions, synchronization, actual entry time/index/DTE, recomputed prices, slippage, fees, net credit, breakeven, maximum loss, opening margin, quality, and delay. Debit or nonpositive-net-credit observations remain visible with typed rejection reasons. Thesis resolution is compared with actual completion; resolution-before-completion is a missed entry. Post-entry paths contain only later candles, while signal-relative thesis duration remains independent.

The declared size grid is fixed before evaluating the common candidate population. The configured amount remains primary and is never replaced by a smaller event-specific size. Where historical amount metadata is absent, the output explicitly records that exchange minimum/step validation was unavailable.
