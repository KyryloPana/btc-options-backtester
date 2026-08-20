# Research Analytics normalization and reconciliation

Starting commit: `bb78a6fd79c03c3150491596a0134e32f4afa6eb`.

## Analytical identity and denominator changes

The only observation identity is `event_id × strategy_variant_id`. Reference,
maker, taker, delayed, modeled, conservative, and penalty scenarios are tracks
on that observation. Variant rows remain clustered by event; event counts are
reported separately and legacy-undifferentiated rows cannot be matched.

The denominator ledger deliberately keeps these non-interchangeable counts:

* **Generated opportunities** counts generation attempts in availability data.
* **Contract resolved** counts attempts with an exact/listed contract result.
* **Confirmed non-listings** counts explicit exchange non-listing results.
* **Retrieval failures** counts data access failures; these never become zero PnL.
* **Reference valued** counts normalized observations with an economic reference.
* **Immediate maker/taker supported** count normalized observations with available
  observed entry evidence for that side.
* **Delayed supported by bucket** counts available delayed observed tracks; a
  pre-entry thesis resolution is not supported or entered.
* **Modeled valued** counts observations with at least one valid expected or
  conservative modeled track, never as observed execution.
* **Fully unavailable** counts normalized observations without any available track.

Reference valuation is independent from execution evidence. A reference-only structure contributes
once to the reference/economic population because observation identity remains
`event_id × strategy_variant_id`; its maker and taker rows do not multiply that observation. When
those scenarios are unavailable/not evaluated, it contributes zero to immediate maker, immediate
taker, matched maker-vs-taker, and strict observed-execution PnL denominators.

Each execution summary has two explicitly different statistics. Trade-conditional
uses entered trades with priced exit PnL. Opportunity-normalized uses eligible
opportunities, assigns zero deployed capital and zero PnL only to a missed entry,
and excludes retrieval failures. Each metric carries its own count and denominator
text. Source and quality-tier composition accompany every selected track; the UI
can exclude the lowest tier.

## Hand reconciliations

The deterministic test fixture provides a compact reconciliation for every major
track. Amount is one contract and the settlement conversion index is explicitly
represented by the exported USD result.

| Track | Gross BTC | Entry fees | Net credit | Close fees | Settlement PnL | Capital basis | Notes |
|---|---:|---:|---:|---:|---:|---:|---|
| Reference economic | 0.0800 | unavailable | 0.0800 value | unavailable | unavailable | unavailable | Independent mark, high tier, interval 0.07–0.09 where supplied. It is valuation, not a fill. |
| Immediate maker observed | 0.1000 | 0.0100 | 0.0900 | 0.0100 | 0.0400 BTC / 4,000 USD | opening IM 0.20; peak IM 0.25 | Ledger check: `0.1000 − 0.0100 = 0.0900`. Five-day holding gives `0.25 × 5 = 1.25` capital-days. Returns use max loss, opening IM, and peak IM independently. |
| Immediate taker observed | 0.0800 | 0.0100 | 0.0700 | 0.0100 | 0.0200 BTC / 2,000 USD | unavailable | The position stays in analysis; margin-based returns are unavailable with the reason displayed. |
| Delayed maker observed | 0.0700 | 0.0100 | 0.0600 | — | not a trade | — | Entry is day 3, while VPOC resolves day 2. It is classified `pre_entry_resolution`; holding does not begin at the signal. |
| Modeled expected | 0.0800 | 0.0100 | 0.0700 | 0.0000 | 0.0300 BTC / 3,000 USD | unavailable | Model `m1`, calibration count 12, low tier, interval 0.05/0.07/0.09. It enters economics but never observed-execution statistics. |
| Modeled conservative / penalty | fixture unavailable | — | — | — | — | — | Explicit unavailable state rather than borrowing expected-model or raw economics. |

## Comparison invariants

Matched DTE comparisons must match event, direction, width, strike method, option
type, track, amount and exit policy. Width/strike comparisons additionally keep
DTE and entry scenario fixed. Execution-robustness pairs hold the complete
structural identity and amount fixed. Structural match counts and metric-specific
comparable counts are distinct because missing margin invalidates only margin
returns, not credit or PnL. No comparison can pair raw execution on one side with
model fair value on the other unless that named raw-versus-model comparison uses
the same structural variant.

Underlying resolution is sourced only from the event table: VPOC first,
invalidation first, neither/right-censored, or ambiguous. Track controls do not
alter it. MFE/MAE ends at first resolution, the two resolutions are competing
outcomes, and Kaplan–Meier is reserved for time to first resolution.
