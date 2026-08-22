# Research snapshot refresh contract

The stale-placeholder root cause was that selection creation copied derived
analysis into the selection record once, including deliberate schema
placeholders for delayed and modeled execution. Later engine changes had no
operation that revisited retained selections; saving only added or removed IDs.

| Preserved structural input | Atomically recomputable output |
| --- | --- |
| event, selection, candidate and strategy-variant IDs | immediate maker/taker evaluation |
| venue, quantity and selected-at metadata | reference valuation, paths and outcomes |
| target horizon, actual expiry, requested and actual strikes | delayed and modeled execution |
| option type, instruments and contract-resolution decision | evidence usages/catalog links and diagnostics |
| generation/event source snapshots | settlement accounting and margin |

`recomputeSelectedResearch` accepts one-structure, one-event, and all-selection
scopes. It passes the saved source snapshot and a read-only structural selection
to a versioned engine, builds a detached store, and returns only after every
selected computation succeeds. `ResearchSelectionService.recompute` then
validates and performs one temp-file/rename persistence operation. Thus an
exception cannot partially replace saved results or exact contracts.

Staleness is deterministic per layer: a missing version, a version unequal to
the current engine, or a recognizable never-run `not_evaluated` placeholder is
stale. An engine-attempted `unavailable` result is not stale merely because it
is unavailable. Legacy stores migrate without rewriting identity; absent
versions make safely recomputable data visible as stale. Export remains a
faithful read of saved state and never triggers recomputation.
