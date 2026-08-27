/**
 * The derived research layers for one selected structure.
 *
 * This is deliberately the ONLY implementation. The save flow builds these
 * layers when a structure is first selected, and the recompute driver rebuilds
 * them for structures already saved; both call in here. A second copy of this
 * logic living beside the first would be free to drift, and the two paths would
 * silently start producing different economics from the same evidence.
 *
 * What this builds is exactly the derived surface -- execution scenarios,
 * Reference valuation, delayed and modeled execution, margin, evidence. It
 * deliberately does NOT build structural identity: candidate id, strikes,
 * expiry, horizon and selected status belong to the saved selection and are
 * copied from it, never re-derived. That separation is what makes a recompute
 * incapable of reselecting.
 */

import {
  compactEntryEconomics, compactMarginResult, compactOutcomeSnapshot, compactValuationPoint,
  canonicalJson,
  type EvidenceTradeDto, type EvidenceUsageDto, type ExecutionScenarioSnapshot,
  type IndependentTrackSnapshot, type JsonValue, type SelectedStructure,
} from "./research-selections.ts";
import {buildModeledExecution, type ExecutionCalibrationRecord} from "./modeled-execution.ts";
import {buildResearchMarginSnapshot} from "./research-margin.ts";
import {delayedExecutionSnapshot, type DelayedExecutionAnalysis} from "./delayed-execution.ts";
import {referenceValuationSourceOf} from "./research-valuation.ts";
import type {EstimatedOutcome, EstimatedPathPoint, ResearchValuation} from "./research-valuation.ts";
import type {ExecutionMode} from "./backtester.ts";
import {CURRENT_RESEARCH_ENGINE_VERSIONS, type DerivedResearchOutput} from "./research-refresh.ts";
import {MODELED_EXECUTION_VERSION} from "./modeled-execution.ts";
import {SETTLEMENT_ACCOUNTING_VERSION} from "./settlement-provenance.ts";

/** One execution scenario's independently evaluated entry, path and outcomes. */
export interface ResearchScenarioResult {
  readonly entry: ResearchValuation;
  readonly path: readonly EstimatedPathPoint[];
  readonly outcomes: readonly EstimatedOutcome[];
}

export interface DerivedResearchInput {
  readonly candidateId: string;
  /** Maker and taker, evaluated independently from the same contracts. */
  readonly scenarios: Readonly<Record<ExecutionMode, ResearchScenarioResult>>;
  /** The execution-independent Reference track. */
  readonly reference: ResearchScenarioResult;
  /** Why the Reference track is unavailable, when it is. */
  readonly referenceUnavailableReason: string | null;
  readonly statusLayers: JsonValue;
  readonly delayed: DelayedExecutionAnalysis;
  readonly evidenceCatalog: Map<string, EvidenceTradeDto>;
  readonly modeledCalibration: ExecutionCalibrationRecord[];
  /** Structural fields, copied from the saved selection and never re-derived. */
  readonly structural: Pick<SelectedStructure, "candidateSnapshot" | "quantity">;
}

export function buildScenarioSnapshot(
  candidateId: string, mode: ExecutionMode, scenario: ResearchScenarioResult,
  usages: EvidenceUsageDto[], catalog: Map<string, EvidenceTradeDto>,
): ExecutionScenarioSnapshot {
  if (scenario.entry.status !== "priced")
    return {status: "unavailable", reason: scenario.entry.reason, entrySnapshot: null,
      valuationPathSnapshot: [], outcomeSnapshots: []};
  return {
    status: "evaluated", reason: null,
    entrySnapshot: compactEntryEconomics("deribit", candidateId, scenario.entry, usages, catalog, mode),
    valuationPathSnapshot: scenario.path.map(point =>
      compactValuationPoint("deribit", candidateId, point, usages, catalog, mode)),
    outcomeSnapshots: scenario.outcomes.map(outcome =>
      compactOutcomeSnapshot("deribit", candidateId, outcome, usages, catalog, mode)),
  };
}

/**
 * Build the Reference track snapshot.
 *
 * `source` is derived from the valuation itself, so a saved structure always
 * names the tier that actually priced it rather than a fixed label.
 */
export function buildReferenceTrack(
  candidateId: string, reference: ResearchScenarioResult, unavailableReason: string | null,
  usages: EvidenceUsageDto[], catalog: Map<string, EvidenceTradeDto>,
): IndependentTrackSnapshot {
  if (reference.entry.status !== "priced") return {
    status: "unavailable", reason: unavailableReason, source: "unavailable",
    entrySnapshot: null, valuationPathSnapshot: [], outcomeSnapshots: [],
    provenance: canonicalJson({executionIndependent: true}),
  };
  return {
    status: "valued", reason: null,
    source: referenceValuationSourceOf(reference.entry),
    entrySnapshot: compactEntryEconomics("deribit", candidateId, reference.entry, usages, catalog, null),
    valuationPathSnapshot: reference.path.map(point =>
      compactValuationPoint("deribit", candidateId, point, usages, catalog, null)),
    outcomeSnapshots: reference.outcomes.map(outcome =>
      compactOutcomeSnapshot("deribit", candidateId, outcome, usages, catalog, null)),
    provenance: canonicalJson({
      executionIndependent: true, requestedAmountDoesNotGate: true,
      quality: reference.entry.estimateQuality,
      methodVersion: CURRENT_RESEARCH_ENGINE_VERSIONS.referenceValuation,
    }),
  };
}

/**
 * Assemble every derived layer for one structure.
 *
 * Maker and taker are evaluated independently and neither can substitute for
 * the other; the Reference track is built from its own valuation and is never
 * gated on either of them, which is what keeps a structurally valid candidate
 * in the economic cohort when no fill evidence exists.
 */
export function buildDerivedResearchOutput(input: DerivedResearchInput): DerivedResearchOutput {
  const usages: EvidenceUsageDto[] = [];
  const executionScenarios = {
    maker: buildScenarioSnapshot(input.candidateId, "maker", input.scenarios.maker, usages, input.evidenceCatalog),
    taker: buildScenarioSnapshot(input.candidateId, "taker", input.scenarios.taker, usages, input.evidenceCatalog),
  };
  const referenceValuation = buildReferenceTrack(
    input.candidateId, input.reference, input.referenceUnavailableReason, usages, input.evidenceCatalog);

  const delayedExecution = delayedExecutionSnapshot(input.delayed,
    input.reference.entry.status === "priced" ? input.reference.entry.netOpeningCashFlowBtc : undefined);
  const modeledExecution = buildModeledExecution(referenceValuation, input.modeledCalibration);

  return {
    executionScenarios, referenceValuation,
    delayedExecution: canonicalJson(delayedExecution),
    modeledExecution,
    // Margin reads the Reference track, so it is built from the recomputed one
    // rather than carried over from the previous methodology.
    marginSnapshot: compactMarginResult(buildResearchMarginSnapshot({
      candidateSnapshot: input.structural.candidateSnapshot,
      quantity: input.structural.quantity,
      referenceValuation,
    })),
    // Usages reference the event-level evidence catalog; the per-structure
    // snapshot list stays empty, exactly as the save flow leaves it. Omitting
    // the field entirely persists `undefined`, which is not a JSON value and is
    // rejected by store validation.
    evidenceTradeSnapshots: [],
    evidenceUsages: usages,
    statusLayers: canonicalJson(input.statusLayers),
    versions: {
      immediateExecution: CURRENT_RESEARCH_ENGINE_VERSIONS.immediateExecution,
      referenceValuation: CURRENT_RESEARCH_ENGINE_VERSIONS.referenceValuation,
      delayedExecution: CURRENT_RESEARCH_ENGINE_VERSIONS.delayedExecution,
      modeledExecution: MODELED_EXECUTION_VERSION,
      settlementAccounting: SETTLEMENT_ACCOUNTING_VERSION,
      margin: CURRENT_RESEARCH_ENGINE_VERSIONS.margin,
    },
  };
}
