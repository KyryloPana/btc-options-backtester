# BTC Options Backtester

A local TypeScript backtester for BTC mean-reversion events and historical Deribit inverse-option trades.

## Run locally

Requirements: Node.js 22.13 or newer and npm. Windows PowerShell is supported.

```bash
npm install
npm run dev
```

Open the local URL printed by the development server. A production build is available through `npm run build` and `npm run start`.

## Workflow

1. Select one of the bundled MR-only backtest events or add an event manually.
2. Enter the failed extreme, VPOC target, invalidation level, and recorded dates/prices.
3. Resolve the entry/exit time from the first Binance BTCUSDT hourly candle whose range contains the recorded price. A manual UTC override is available.
4. Configure expiry horizons, admissible DTE bands, expiry-selection mode, widths, payoff type, execution, fees, amount, and pricing outputs.
5. Index the configured Deribit contract archive and load only the exact leg files needed for every expiry candidate inside the selected bands.
6. Audit candidate ranking, entry liquidity, exact contract retrieval, five-window normalization, 4H PnL paths, and independent exit results.
7. Export the full run as JSON.

## Local contract source

The included `.env.local` is configured for:

```env
CONTRACT_DATA_PATH="D:\market_data\deribit\BTC\contracts"
```

Keep the archive outside the project. On first use, click **Index & load contracts**. The local server scans filenames and writes a small manifest cache under `.local-cache/`; later sessions reuse it. **Refresh index** rescans the archive when files have been added or removed. The manifest discovers eligible expiries first; only their resolved leg files are parsed and sent to the browser.

Contract filenames or their parent path must contain an instrument name such as `BTC-1APR20-6000-C`. JSON and JSONL files are supported.

## Contract input

Each trade should include:

```json
{
  "timestamp": 1585710843731,
  "price": 0.0565,
  "iv": 99.25,
  "instrument_name": "BTC-1APR20-6000-C",
  "index_price": 6361.95,
  "direction": "buy",
  "amount": 0.1
}
```

The parser accepts JSON arrays, one JSON object, an object with `trades`, an object with `result.trades`, or newline-delimited JSON.

## Implemented mechanics

- MR trades only from the supplied full backtest; breakout and vPOC-add-on trades are excluded.
- Expiry horizons are `~7D`, `~14D`, and `~30D`; their configurable default bands are 5–10D, 11–18D, and 24–38D actual DTE.
- Liquidity-aware mode is the default. Every listed expiry in the band is evaluated; unusable/Red candidates are rejected, Green ranks above Yellow, and target-horizon proximity breaks ties. The winner and one viable alternative are retained.
- Closest DTE retains the viable expiry nearest the target. Test all eligible retains every viable candidate. No weekday or Friday preference is hard-coded.
- Candidate viability requires both resolved legs, evidence that both existed at entry, sensible strike ordering, and observed non-model prices within ±2h.
- Candidate ranking uses only information available at entry: immediate entry-window prints plus prior-24h/prior-7d trade and amount metrics. Future path and exit liquidity never influence selection.
- Bullish extremes round down and bearish extremes round up to $1,000. A second $1,000 outward-buffer branch is added when the extreme is within $100 of the rounded strike.
- Imported strikes resolve to the nearest available strike for the chosen expiry. Both legs share the same expiry.
- “Existed at entry” is conservatively proven only when the file contains at least one print at or before entry. Trade files alone cannot prove a listing that had not traded.
- Deribit `direction` is treated as the taker side. Maker-mode sold legs use taker-buy prints; maker-mode bought legs use taker-sell prints. Taker mode reverses that mapping.
- VWAP, median, min/max, amount, IV, index range, and staleness are calculated for ±15m, ±30m, ±1h, ±2h, and ±12h windows.
- IV normalization reprices inverse BTC options at the target index and target time with the observed weighted IV, `r = 0`, and a Black-style approximation.
- Raw VWAP and IV-normalized prices remain separate throughout the output.
- Fees use `min(0.0003 BTC, 0.125 × option price) × amount` per leg. Separate legs are the default; combo mode applies the buy/sell-leg fee discount.
- BTC and USD ledgers are separate. USD converts entry and exit cash flows at their respective BTC index prices.
- The PnL grid runs every 4 hours through expiry and includes VPOC, recorded exit, invalidation, and settlement points.
- Exit rules: VPOC hit; 50%/70% credit capture; fixed 3D/5D/7D/14D; 4H close beyond invalidation; expiry intrinsic settlement.
- Green/yellow/red flags propagate from leg to spread to event. Results can be filtered to all, green/yellow, or green only.
- Exported results store the target horizon, actual DTE, candidate rank, selection reason, and entry-liquidity evidence.

## Important assumptions

- The timestamp resolver identifies the first qualifying **hour bucket**, not the exact minute inside that candle.
- BTCUSDT is used as the practical hourly spot proxy. You can override timestamps manually if your price-action record used a different venue/index.
- IV-normalized pricing is an illiquidity correction, not a fitted volatility surface. It intentionally uses `r = 0` in v1.
- Expiry uses the closest available hourly BTC index proxy. Exact Deribit delivery-price reconstruction would require the official 07:30–08:00 UTC index samples.
- Red model-fallback observations stay in “All tests” and are excluded by the stricter trust filters.

## Validation

```bash
npm run test:unit
npm run lint
npm run build
npm run validate:artifact
```
