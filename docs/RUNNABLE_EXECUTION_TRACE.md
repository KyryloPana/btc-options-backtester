# Runnable causal execution trace

## Call graphs

**Pre-remediation:** `Run Backtest` → `buildValuation`/centered normalization → `evaluateExits` → most convenient hit/path PnL → filtered UI result/export.

**Runnable v1:** `Run Backtest` → `runEventBacktest` → rank-1 candidate → `simulateTakerSpread` → fill cash flow/fees/margin → configured VPOC policy → `simulateTakerExit` → fill cash flow **or** `buildOptionSettlementLedger` fallback → observation net PnL. Tables, details, chart, full-set aggregates and JSON export retain the observation ledger. `buildValuationPath` is invoked only after an entry fill and is a diagnostic research mark; it never supplies primary fills or PnL.

## Event A deterministic trace

| Item | Timestamp/value | Ledger meaning |
|---|---:|---|
| Source hourly candle | 0–1000 ms | Touch is not actionable at candle open. |
| Decision available | 1000 ms | Source candle close. |
| Entry submitted | 1010 ms | 10 ms configured latency. |
| Sold-leg fill | 1020 ms @ 0.050 BTC | +0.050 BTC. |
| Bought-leg fill | 1025 ms @ 0.020 BTC | −0.020 BTC. |
| Gross entry cash flow | +0.030 BTC | Actual taker fills only. |
| Opening fees | −0.000600 BTC | Synchronized-leg proxy; both legs charged. |
| Target candle / decision | 2000–2100 ms | Trigger available at close. |
| Exit submitted | 2110 ms | A 1900 ms print is ignored. |
| Short buyback | 2120 ms @ 0.010 BTC | −0.010 BTC. |
| Long sale | 2125 ms @ 0.005 BTC | +0.005 BTC. |
| Gross close cash flow | −0.005 BTC | Actual closing fills only. |
| Closing fees | −0.000600 BTC | Both closing legs charged. |
| **Net PnL** | **+0.023800 BTC / $1,190 at $50,000** | `0.030 - 0.005 - 0.0006 - 0.0006`. |

The denominator is one `original event × strategyVariantId`; candidate expiries are child attempts. The deterministic selected policy is VPOC target with settlement fallback. An unfilled triggered close remains open and settles; expiry is never modeled as a taker exit. Official-combo fee treatment requires an actual evidence flag. Margin defaults to a dedicated segregated Standard Margin subaccount and a causal historical formula estimate.
