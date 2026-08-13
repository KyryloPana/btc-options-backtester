# BTC Options Backtester

A TypeScript backtester for BTC mean-reversion events and historical Deribit inverse-option trades.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

The optional server-side API setting defaults to Deribit's public History API:

```env
DERIBIT_HISTORY_API_URL="https://history.deribit.com/api/v2/public"
```

No API key is required. The browser calls project-local `/__deribit/history/*` routes; only the server contacts Deribit. The server combines active and expired BTC option manifests, caches only lightweight instrument metadata in `.local-cache/`, resolves eligible expiries and strikes, and downloads exact selected-leg trade ranges on demand. Raw historical responses are not written to disk.

## Workflow

1. Select a bundled MR event or add one manually.
2. Resolve or manually enter the UTC entry timestamp and supply strategy levels.
3. Configure expiry horizons, DTE bands, widths, payoff type, execution, fees, amount, and pricing outputs.
4. Choose **Load contracts**. Use **Refresh API manifest** when fresh listing metadata is needed.
5. Audit candidate ranking, entry liquidity, normalization, PnL paths, and exits.
6. Export the full run as JSON.

The default expiry bands are 5–10D, 11–18D, and 24–38D. Both spread legs use one eligible expiry, are resolved independently, and retain the intended strike ordering. Contract existence is established from Deribit's `creation_timestamp`, never inferred from the first observed trade. Deribit `direction` is the taker side; existing maker/taker compatibility behavior is preserved.

Trade retrieval uses the official 1,000-row maximum, sequence-bounded pagination, `trade_seq` deduplication, exact timestamp filtering, retry handling, and bounded per-contract concurrency. Candidate selection continues to use entry-time liquidity only; valuation and exit mechanics are unchanged.

## Validation

```bash
npm run test:unit
npm run lint
npm run build
npm run validate:artifact
```

## Entry and PnL cash-flow identities

Option prices are BTC **per one option contract**. The selected contract amount scales those prices into total BTC cash flows; USD ledgers convert each cash flow using the BTC index at that cash flow's timestamp.

For a credit spread:

```text
gross entry credit = sold premium received - bought premium paid
net opening cash flow = gross entry credit * amount - opening fees
mark-to-close PnL = opening cash flow - closing cost - exit fees
```

A debit spread mirrors those directions: its opening cash flow is the negative gross debit less opening fees, and its closing proceeds are positive. The first valuation-path point models a hypothetical immediate close. It includes opening and closing fees, so it may be negative and is not the gross entry credit or debit.

Green, Yellow, and Red are evidence-reliability grades only. They never indicate whether a position was profitable. Entry pricing evidence and each independent exit's pricing evidence retain separate grades; the displayed overall grade combines entry evidence with the selected exit only.
