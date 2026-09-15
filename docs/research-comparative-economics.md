# Research Comparative Economics methodology

Research Comparative Economics answers: **“Which structural parameter choices change the economics?”** It examines the full **ex-ante** structural configuration space and compares position/configuration economics, controlled parameter changes, execution assumptions, and complete exit policies. It does not select a Strategy configuration or reconstruct account equity, concurrency, portfolio drawdown, available funds, or margin utilization. Those belong to Strategy Evaluation Economics, which answers: **“What does the chosen configuration require and produce as a deployable portfolio?”** Canonical position and configuration definitions remain those in [Economic Analysis](economic-analysis.md).

## Canonical materialization boundary

Comparative Economics is keyed by `event_id × structural_configuration_id`, never by candidate ID. Candidate IDs remain generation-attempt provenance. When several actual expiries or contract candidates map to one target-DTE/strike/width/family configuration, exactly one economic materialization may represent it: the candidate persisted as rank 1 by the existing causal, ex-ante generation policy. Array order, realized PnL, later data quality, and future outcomes are never selectors. If an older generation snapshot does not preserve a unique rank-1 decision, that configuration is explicitly unavailable until regeneration rather than being assigned an invented representative.

Every Research economic join and uniqueness check uses that event/configuration identity. The canonical candidate ID documents which attempt produced the materialization; it is not used to exclude otherwise matching economic evidence. More than one track/policy observation claiming the same event/configuration is an integrity error and no row wins by insertion order.

`selectedStructures` contains only user-selected, deployable Strategy structures. Controlled DTE, width, and strike expansion does not add to it. Those expansions request `researchStructures` with `researchRole: "comparative_economics"`, the exact structural configuration ID, and all attempt candidate IDs. Current selection-store and bundle validation allow at most one such materialization per event/configuration. Legacy ambiguous materializations are preserved for audit, marked unavailable, and require regeneration/reselection.

The upstream generation save now produces that Comparative Economics materialization for every resolvable canonical event/configuration, not only for manually selected structures or a narrow controlled comparison. It reuses the ordinary causal Reference engine and the existing empirical taker Q50/Q90 recompute engine. Immediate maker/taker scenarios on the research-only record remain explicitly `not_evaluated`; modeled evidence is never presented as an observed fill. The local recompute command refreshes both deployable selections and these research-only materializations while leaving `selectedStructures` unchanged.

## Observation and availability rules

The independent observation is an MR event. Marginal and interaction cells first collapse multiple variants to one event × cell observation, so generating more variants cannot give an event more weight. Reports retain configuration, event, opportunity, and pair denominators separately.

The complete denominator and category universe comes from `configuration_opportunities.jsonl`, not from the historical `selected` analytics cohort or from the existence of priced positions. Its `economic_opportunity` value is derived from the canonical research-only Comparative Economics materialization, never from manual Strategy selection, and is specifically the canonical **Q50 generation decision**. Reference and Q90 are attached as separate track-conditional evidence and cannot rewrite a Q50 trade, explicit no-trade, unavailable state, or integrity result. Full-track projection is intersected with canonical event × structural-configuration membership, preventing unrelated diagnostics from leaking into the report.

`priced`, explicit `no-trade`, and `unavailable` are distinct states. An explicit no-trade participates in opportunity expectancy as the deliberate zero outcome defined by the generation contract. Unavailable evidence never becomes zero and blocks a complete aggregate. Contradictions remain integrity errors.

USD statistics use canonical per-observation USD readings. They are not obtained by multiplying an aggregate BTC statistic by a single index. A complete-cohort USD statistic is withheld when any required per-observation USD value is missing; its effective and required N explain why.

BTC and USD monetary statistics are aggregated independently from their respective canonical per-observation readings. Neither currency is synthesized from the other. The primary fee-drag definition in both workspaces is canonical total realized fees USD divided by canonical gross opening credit USD; both inputs must exist and gross credit must be positive. Display currency never changes dimensionless ratio methodology.

Ordinary PnL summaries are trade-conditional: only genuinely priced positions contribute, and explicit no-trades are not inserted as zero. Q50 opportunity-normalized expectancy is separate: priced Q50 trades contribute Q50 PnL, explicit no-trades contribute the methodology-defined zero, unavailable opportunities block the result, and every canonical opportunity remains in its denominator.

A priced policy endpoint remains usable for descriptive PnL and holding-time statistics when its entry and exit timestamps are known, even if the full MTM or margin path is incomplete. Peak margin, capital-days, drawdown, and deployable portfolio chronology remain unavailable until their complete causal paths exist. Missing selected-policy endpoint PnL on a canonical Q50 trade does not alter the generation decision: the identity remains an intended trade, while that policy metric and strict opportunity expectancy are unavailable.

## Descriptive and controlled views

Marginal DTE, strike-rule, width, and (when present) structure-family summaries are explicitly **descriptive/composition-sensitive**. They are not causal estimates.

Controlled comparisons pair within event before aggregation. A DTE pair holds strike rule, width, family, exit policy, and execution track fixed; width and strike comparisons analogously hold every other structural dimension fixed. Each metric has its own paired N because a missing value on either side is never imputed as zero.

The controlled pair universe is formed from canonical opportunities before metric availability is checked. Each marginal, interaction, and matched metric reports eligible events or pairs, effective metric N, and missing N. A partial descriptive value is explicitly labelled partial rather than masquerading as complete.

Two-dimensional DTE × width, DTE × strike, and strike × width cells contain only combinations observed in the data. Holding the third dimension fixed gives a controlled slice. Selecting all values of that dimension is explicitly composition-sensitive.

## Execution and exit policy

Execution layers are not interchangeable: Reference is the execution-independent counterfactual, modeled expected is empirical Q50 taker execution and the normal central case, and modeled conservative is empirical Q90 taker execution. Degradation pairs the exact same event × structural configuration × exit policy across Reference → Q50 → Q90 and retains coverage loss.

Execution survival and degradation are calculated separately within configuration, DTE, strike, and width groups. Source-only, destination-only, common, union, and net coverage change are named independently; no assumption is made that destination coverage must be smaller.

Exit-policy economics holds the analytical execution track fixed and covers Thesis, 50% and 70% capture, 3D/5D/7D caps, and Settlement benchmark. Alternative-policy deltas pair the same event and configuration against Thesis. This all-policy analysis is independent of the page-local analytical basis and never mutates Strategy Evaluation.

No winner, score, optimal parameter, or recommendation is produced. Costs, return, risk, and capital deltas have different meanings, and the report presents evidence rather than making a post-hoc strategy selection.

## Q50 evidence gating and policy pairs

The Q50 generation state gates modeled-expected trade evidence. A priced Q50 row attached to a canonical `explicit_no_trade` or `unavailable` identity is excluded from trade-conditional metrics and diagnosed as an integrity contradiction. Reference and Q90 may still price the same counterfactual identity; they never rewrite its Q50 decision. No synthetic zero position is created. Deliberate zero remains confined to Q50 opportunity-normalized expectancy for canonical explicit no-trades.

Configuration evidence attention distinguishes integrity-invalid, wholly unavailable canonical-USD metrics, partial canonical-USD coverage, and low-N Q50 tails. These are separate from the count of canonical Q50-unavailable opportunities. Primary fee drag is a partial-capable statistic over positions with both canonical total-realized-fees USD and positive canonical gross-opening-credit USD; its effective positions and priced-position denominator are disclosed.

Integrity, per-metric availability, currency coverage, margin capability, and tail sample size are independent evidence dimensions. A missing verified margin path makes only opening/peak margin, capital-days, and margin-denominated return unavailable; it does not erase a priced endpoint PnL, known fees, structural loss, or other independently supported economics. Every metric records eligible, effective, and missing independent-event counts plus its missing-reason distribution. BTC and USD coverage are assessed independently from exact canonical observations.

Every canonical `comparative_economics` materialization receives its own margin-scenario export, whether or not it is selected for Strategy. The producer uses the existing versioned segregated Standard Margin reconstruction; a supported path is exported and an unsupported or incomplete reconstruction is exported as unavailable with its exact reason. The consumer clips that path to the selected track entry and policy endpoint, takes opening and peak requirements only within that window, and integrates piecewise-constant initial margin using each interval's contemporaneous index for USD. Portfolio Margin and Cross Standard Margin remain explicitly unsupported and are never synthesized from segregated Standard Margin.

Exit-policy deltas pair each complete alternative against Thesis by exact event and structural-configuration identity before aggregation. A missing side reduces the metric-specific paired N and is never inserted as zero. Absolute policy cohorts remain separately visible. The full-matrix tail is explicitly the fixed-generation-baseline **Q50 trade-conditional P10**, even while Reference or Q90 is selected; BTC and USD tail availability are evaluated independently.

## Shared admissibility and trade-conditional denominators

Research and Strategy use the same canonical track-evidence gate. Modeled-expected evidence is admissible only for canonical Q50 `trade` identities; stale priced rows on `explicit_no_trade` or `unavailable` identities are excluded and integrity-diagnosed. Reference and Q90 remain counterfactual tracks over canonical membership.

The canonical opportunity universe still determines configuration existence, generation-state counts, opportunity-normalized expectancy, and execution coverage. Ordinary modeled-expected metrics instead use independent events containing canonical Q50 trades as their metric-eligible denominator, so a deliberate no-trade is not mislabeled as missing PnL. Reference and Q90 use all canonical counterfactual opportunity identities as their metric-eligible denominator. Duplicate track/policy event × configuration evidence is never resolved by row order: it is excluded from controlled, execution, and policy deltas and reported as duplicate evidence.

## Self-contained analytical exit basis

Comparative Economics is available immediately for a valid dataset and owns its analytical exit-policy view state. Thesis is the deterministic default. The local selector changes the exit basis for outcome-dependent ordinary configuration, marginal, interaction, and controlled-comparison economics only; it does not configure Strategy Evaluation, Candidate Configuration, or the separate Research Exit Policy report. Canonical opportunity/generation state and exit-independent entry evidence remain unchanged. The Economics by Exit Policy panel always evaluates every canonical policy and always pairs alternatives against Thesis, regardless of the local analytical basis.
# Production-boundary regeneration

Comparative Economics materialization is initiated from the application's **Research → Controlled matrix** workflow. Confirming that workflow persists `researchRole="comparative_economics"` rows only; it does not add or modify Strategy `selectedStructures`. Preserve the source selection store before any regeneration:

```bash
cp data/research-selections/<dataset>.json data/research-selections/<dataset>.pre-comparative-recompute.json
```

After materialization, recompute the persisted structures with the current causal market and execution-calibration inputs:

```bash
node --experimental-strip-types scripts/run-research-recompute.ts \
  <dataset> artifacts/research-recompute-audit.json \
  --execution-estimator=<execution-calibration-directory-or-json>
```

This step may retrieve Deribit historical instruments, contract trades, delivery prices, and the same-expiry volatility ladder. The command refuses to write if selected or Comparative Economics structural identity changes. A schema 1.9 store without unambiguous persisted rank provenance must instead be regenerated from its originating generation state.

Export the bundle from the running local application without modifying its JSON:

```bash
curl --fail --output artifacts/<dataset>-research.zip \
  "http://localhost:3000/api/research-bundle?datasetId=<dataset>"
```

Import validation, the final production-boundary acceptance summary, and the full forensic audit are then:

```bash
npm run audit:research-economics -- artifacts/<dataset>-research.zip --acceptance
npm run audit:research-economics -- artifacts/<dataset>-research.zip \
  --output artifacts/<dataset>-research-forensic-audit.json
```

The acceptance command exits non-zero for current-schema integrity contradictions. Ordinary unavailable historical evidence is reported by reason and is not corruption. A Low-N tail is a statistical limitation; its shared minimum is `max(20, analysisConfiguration.minimumCellEvents)` and is never reduced by the audit.

## Checkout artifact availability

This checkout does not contain the exact production `data/research-selections/<dataset>.json`, a production Research bundle ZIP/directory, or a current execution-calibration artifact. Consequently production regeneration and production coverage counts cannot be evaluated from this checkout. The deterministic tests exercise the same boundaries without claiming production-data coverage.
