# Research Persistence Payload Regression Report

## Reproduction and baseline

HEAD was exactly `3ccef4a603c77e4a6f9df4e51daacb09b2335bcd`. A deterministic nine-structure fixture (three each at 7D/14D/30D, 181 points for 30D) included immediate, reference, delayed, modeled expected/conservative/five-row sensitivity, settlement-shaped outcomes, Standard Margin, 90 causal calibration rows and 1,000 repeated delayed tape rows. The exact compact event JSON used by event PUT is measured with `TextEncoder`/`JSON.stringify`.

The schema-1.7 runtime-shaped body was **10,348,894 bytes**, above the unchanged **10,000,000-byte** parser guard. The route therefore returns **HTTP 413**; clients where the dev-server connection is terminated can surface the same condition as `Failed to fetch`. The normalized schema-1.8 body is **4,360,754 bytes**. Largest compact 30D structure: **490,429 bytes**.

## Component measurements

| Component | Before bytes | Before % | After bytes | After % |
|---|---:|---:|---:|---:|
| Generation | 36,470 | 0.35% | 36,470 | 0.84% |
| Evidence catalog/usages | 38 | 0.00% | 3,308,328 | 75.87% |
| Immediate Maker/Taker | 2,034 | 0.02% | 2,034 | 0.05% |
| Reference | 172,146 | 1.66% | 172,146 | 3.95% |
| Delayed | 7,398,207 | 71.49% | 664,419 | 15.24% |
| Modeled expected/conservative/sensitivity | 2,624,979 | 25.36% | 62,316 | 1.43% |
| Margin | 111,519 | 1.08% | 111,519 | 2.56% |
| Other | 3,501 | 0.03% | 3,522 | 0.08% |

Reduction: **57.86%**. Generation configuration/candidates/hourly path cost 36,470 bytes; selected structures cost 10,310,926 bytes before compaction. Per 30D structure, delayed fell from 864,664 to 88,038 bytes and modeled fell from 391,160 to 6,924 bytes; the canonical reference remained 33,341 bytes and margin remained 21,751 bytes.

## Root cause and architecture

Delayed v2 persisted full attempts, repeated `supportingTrades`, completed-leg tape, post-entry paths and policy copies. Modeled v2 persisted causal calibration `records` in expected, conservative and sensitivity metadata, plus seven reference-derived valuation paths (expected, conservative and five grid rows). These additions defeated the earlier 1.6 event normalization.

Schema 1.8 establishes one allow-list boundary for new saves, refresh/recompute, service writes and migration. Delayed attempts retain compact window/status/support diagnostics. Completed legs retain evidence IDs, amounts, completion/VWAP/slipped prices and synchronization data while raw trades move to the event catalog with typed usages. Policy is stored once. The completed delayed canonical path/outcomes remain.

Modeled calibration retains counts, policy/cutoff, fingerprint, penalties and validation, never record arrays. Expected/conservative and sensitivity rows retain model identity, penalty, opening ledger, outcomes and provenance. Their paths carry an explicit derivation descriptor and are reconstructed by the shared modeled-execution helper from the canonical reference marks plus each modeled opening ledger. Reference and Standard Margin paths are not degraded. Futures remain solely event-level in `generationSnapshot.futuresMarket`; no per-structure copy is introduced. Status layers were measured but are not rewritten because existing layer diagnostics remain independently useful.

Migration from 1.7 and all older supported versions is deterministic and idempotent. It applies the same event compactor, extracts delayed evidence, removes calibration records and collapses reference-derived modeled paths without changing entry/outcome economics or candidate/scenario identity.

## Suspected duplication audit

- Delayed attempts, completed short leg and completed long leg did contain runtime `supportingTrades`: removed from nested DTOs; completed evidence is catalogued and referenced.
- Expected, conservative and penalty sensitivity each contained full calibration `records`: removed; summary/fingerprint retained.
- Sensitivity stored five full reference-derived paths, and expected/conservative stored two more: removed and deterministically reconstructible.
- Status layers: retained as independent diagnostic state.
- Margin: compact irreducible path retained; no measured recursive tape/calibration duplication.
- Futures: event-level only; no per-structure duplication.

## Semantic and service acceptance

Compaction preserves immediate/reference/delayed opening economics, outcomes, settlement provenance, Standard Margin, evidence identities/usages, scenario identity and all nine candidate identities. Modeled path PnL reconstruction uses the same equation as runtime (`modeled net opening cash flow + reference close value - closing fee`). Event PUT now passes below both the 8 MB hard regression budget and unchanged parser guard, and GET returns all nine identities.
