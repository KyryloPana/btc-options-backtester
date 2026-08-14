# Runnable execution and observation trace

The Run Backtest button delegates its non-visual work to `buildAndRunObservationRequests`, the same integration boundary exercised by the observation-ledger tests. The builder groups expiry candidates by `eventId::strategyVariantId`, calls `runEventBacktest` once per group, retains alternatives as candidate attempts, and throws if the orchestration stage produces a duplicate key. The repository does not include a browser interaction framework; testing the exact shared handler is the strongest available UI integration boundary without adding a large browser dependency.

A runnable valuation path is constructed only after `simulateTakerSpread` confirms both causal post-order fills. `buildExecutedValuationPath` receives an immutable executed-entry basis: both actual prices and timestamps, filled amount, actual opening fees and net cash flow, route, and entry index evidence. It never calls retrospective entry-ledger construction. Raw and IV marks differ only in the estimated causal closing mark:

- raw diagnostic = actual net opening cash flow + raw estimated closing cash flow - raw estimated closing fees;
- IV diagnostic = actual net opening cash flow + IV-normalized estimated closing cash flow - IV estimated closing fees.

These are explicitly `diagnostic-mark` values. Realized results are emitted separately as `executedNetPnl` from causal close fills or `settlementNetPnl` from the versioned settlement ledger.

`buildObservationExport` performs structured chronology, amount, cash-flow, fee, settlement, outcome, uniqueness, and aggregate reconciliation validation. The ordinary UI export is blocked whenever any invariant fails.
