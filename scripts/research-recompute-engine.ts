/**
 * Server-side recompute engine for already-saved research selections.
 *
 * This is the missing driver around the existing `ResearchRecomputeEngine`
 * seam. It rebuilds DERIVED research for structures that are already selected;
 * it never selects, reranks or substitutes anything. `recomputeSelectedResearch`
 * copies structural identity from the saved selection and accepts only derived
 * fields from here, so reselection is impossible by construction rather than by
 * discipline.
 *
 * It reuses the same components the save flow runs -- contract resolution with
 * the same-expiry ladder, `buildExpiryCandidates`, `evaluateResearchEntryLayers`,
 * `buildEstimatedPath`, `buildResearchOutcomes`, `analyzeDelayedExecution` --
 * and assembles them through the shared `buildDerivedResearchOutput`. The only
 * difference from a first selection is that the selection already exists.
 *
 * The underlying candle path comes from the saved `generationSnapshot`, so a
 * recompute values against exactly the underlying the selection was generated
 * against. Re-fetching it would let an unrelated candle revision move the
 * economics and be misread as a pricing change.
 */

import {buildExpiryCandidates, valuationTimestamps, type Candle, type ContractCandidateManifest, type ContractSeries, type DesiredSpread, type ExecutionMode, type RetrievedSpread} from "../app/lib/backtester.ts";
import {
  buildEstimatedPath, buildResearchOutcomes, evaluateResearchEntryLayers,
  type EstimatedOutcome, type EstimatedPathPoint, type ResearchValuation,
} from "../app/lib/research-valuation.ts";
import {analyzeDelayedExecution} from "../app/lib/delayed-execution.ts";

import {buildDerivedResearchOutput, type ResearchScenarioResult} from "../app/lib/research-derived.ts";
import type {DerivedResearchOutput, ResearchRecomputeEngine} from "../app/lib/research-refresh.ts";
import type {EvidenceTradeDto, ResearchSelectionStore} from "../app/lib/research-selections.ts";
import {DeribitHistoryService, type DesiredRequest} from "./deribit-history-api.ts";
import type {ExecutionCalibrationIndex} from "../app/lib/empirical-taker-execution.ts";

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => typeof v === "string" && v ? v : undefined;

export interface RecomputeDiagnostics {
  eventId: string;
  candidateId: string;
  status: "recomputed" | "failed";
  reason?: string;
  referenceStatus?: string;
  referenceSource?: string;
  crossSectionInstruments?: number;
  apiRequests?: number;
  cacheReused?: boolean;
}

export interface RecomputeEngineOptions {
  readonly service: DeribitHistoryService;
  /** Optional compact v1 artifact index; absence deliberately leaves empirical tracks unavailable. */
  readonly executionCalibration?: Pick<ExecutionCalibrationIndex,"execution"|"reference"|"artifact">;
  /** Collected per structure, for the migration audit. */
  readonly diagnostics?: RecomputeDiagnostics[];
  readonly onProgress?: (message: string) => void;
}

/** One resolved market state per event, shared by every structure on it. */
interface EventMarketState {
  readonly spreadsById: Map<string, RetrievedSpread>;
  readonly inventory: ContractSeries[];
  readonly crossSectionInstruments: number;
  readonly apiRequests: number;
}

/**
 * Resolve one event's market state ONCE.
 *
 * Every selected structure on the event -- all widths, both scenarios -- reads
 * this. `resolve` deduplicates instruments internally and caches trade ranges,
 * so the same-expiry ladder is retrieved once per event and expiry however many
 * candidates consume it.
 */
async function resolveEventMarket(
  service: DeribitHistoryService,
  event: ResearchSelectionStore["events"][number],
): Promise<EventMarketState> {
  const source = obj(obj(event.sourceRun as unknown).event);
  const entryTimestamp = num(source.entryTimestamp);
  if (entryTimestamp === undefined) throw new Error(`Event ${event.eventId} has no entry timestamp.`);
  const entryPrice = num(source.entryPrice);
  if (entryPrice === undefined) throw new Error(`Event ${event.eventId} has no entry price.`);

  const configuration = obj(event.generationSnapshot.configuration as unknown);
  const dteWindows = obj(configuration.dteWindows);

  // One retrieval request per selected structure's OWN structural identity.
  // Nothing here proposes a candidate; it re-resolves contracts for selections
  // that already exist.
  const requests: DesiredRequest[] = [];
  const desired: DesiredSpread[] = [];
  const seen = new Set<string>();
  for (const structure of event.selectedStructures) {
    const candidate = event.generationSnapshot.candidates.find(c => c.candidateId === structure.candidateId);
    if (!candidate) throw new Error(`Selected ${structure.candidateId} is absent from its generation snapshot.`);
    const shortStrike = num(candidate.actualStrikes.short), longStrike = num(candidate.actualStrikes.long);
    if (shortStrike === undefined || longStrike === undefined)
      throw new Error(`Selected ${structure.candidateId} has no resolved strikes to re-resolve contracts for.`);
    const window = obj(dteWindows[String(candidate.targetHorizon)]);
    const requestId = `${structure.candidateId}`;
    if (seen.has(requestId)) continue;
    seen.add(requestId);
    requests.push({
      requestId, targetDte: candidate.targetHorizon,
      minDte: num(window.min) ?? candidate.targetHorizon - 3,
      maxDte: num(window.max) ?? candidate.targetHorizon + 8,
      soldStrike: shortStrike, boughtStrike: longStrike,
      optionType: candidate.optionType === "P" ? "P" : "C",
    });
    desired.push({
      id: requestId, targetDte: candidate.targetHorizon,
      targetWidth: candidate.actualStrikes.width ?? Math.abs(shortStrike - longStrike),
      anchorStrike: shortStrike,
      soldStrike: shortStrike, boughtStrike: longStrike,
      optionType: candidate.optionType === "P" ? "P" : "C",
      spreadKind: "credit", structure: candidate.structure, buffered: false,
    } as DesiredSpread);
  }

  const before = service.totalRequestCount;
  const resolved = await service.resolve(entryTimestamp, requests);
  const built = buildExpiryCandidates(
    desired, resolved.candidates as unknown as ContractCandidateManifest[],
    entryTimestamp, entryPrice, resolved.inventory as unknown as ContractSeries[],
    "taker", "all-eligible", "research-estimate");

  // Key by the ORIGINAL request id so a structure finds its own contracts, and
  // pick the expiry the saved selection actually holds rather than re-ranking.
  const spreadsById = new Map<string, RetrievedSpread>();
  for (const structure of event.selectedStructures) {
    const candidate = event.generationSnapshot.candidates.find(c => c.candidateId === structure.candidateId)!;
    const match = built.find(s =>
      s.id.startsWith(structure.candidateId) && s.expiryTimestamp === candidate.actualExpiryTimestamp);
    if (match) spreadsById.set(structure.candidateId, match);
  }

  return {
    spreadsById, inventory: resolved.inventory as unknown as ContractSeries[],
    crossSectionInstruments: resolved.crossSection?.ladderInstrumentCount ?? 0,
    apiRequests: service.totalRequestCount - before,
  };
}

/**
 * Build the recompute engine.
 *
 * Market state is resolved once per event and memoized, so recomputing 9
 * structures on one event costs one resolve rather than nine.
 */
export function createResearchRecomputeEngine(options: RecomputeEngineOptions): {
  engine: ResearchRecomputeEngine;
  prime: (store: ResearchSelectionStore) => void;
} {
  const markets = new Map<string, Promise<EventMarketState>>();
  const calibration=options.executionCalibration;
  const eventsById = new Map<string, ResearchSelectionStore["events"][number]>();

  const engine: ResearchRecomputeEngine = async input => {
    const event = eventsById.get(input.eventId);
    if (!event) throw new Error(`Event ${input.eventId} was not primed for recompute.`);
    const structure = input.structure;

    if (!markets.has(input.eventId))
      markets.set(input.eventId, resolveEventMarket(options.service, event));
    const market = await markets.get(input.eventId)!;

    const source = obj(obj(event.sourceRun as unknown).event);
    const entryTimestamp = num(source.entryTimestamp)!;
    const entryPrice = num(source.entryPrice)!;
    const candles = (event.generationSnapshot.underlyingHourlyPath ?? []) as unknown as Candle[];
    const spread = market.spreadsById.get(structure.candidateId);
    const candidate = event.generationSnapshot.candidates.find(c => c.candidateId === structure.candidateId)!;

    const record = (row: RecomputeDiagnostics) => options.diagnostics?.push(row);

    if (!spread) {
      // Contracts could not be re-resolved. The structure keeps its identity and
      // reports an honest unavailable rather than silently losing its economics.
      const empty: ResearchScenarioResult = {entry: {valuationMode: "research-estimate", executionMode: "taker",
        targetTimestamp: entryTimestamp, status: "unavailable", estimateQuality: "unavailable",
        reason: "Exact contracts could not be re-resolved for recomputation.", disclaimer: ""} as ResearchValuation,
        path: [], outcomes: []};
      record({eventId: input.eventId, candidateId: structure.candidateId, status: "failed",
        reason: "contracts_unresolved"});
      return buildDerivedResearchOutput({
        candidateId: structure.candidateId,
        scenarios: {maker: empty, taker: empty}, reference: empty,
        referenceUnavailableReason: "Exact contracts could not be re-resolved for recomputation.",
        statusLayers: null, delayed: {status: "unavailable", reason: "Contracts unresolved."} as never,
        evidenceCatalog: new Map<string, EvidenceTradeDto>(),
        modeledCalibration: calibration,
        structural: {candidateSnapshot: structure.candidateSnapshot, quantity: structure.quantity},
      });
    }

    // Exactly the save flow's sequence, on the same components.
    const amount = structure.quantity ?? 1;
    const slippageBps = num(obj(obj(structure.referenceValuation as unknown).entrySnapshot).slippageBps) ?? 0;
    const grid = spread.expiryTimestamp === undefined ? [entryTimestamp]
      : valuationTimestamps(entryTimestamp, spread.expiryTimestamp, [num(source.vpocTimestamp) ?? 0]);

    const layers = evaluateResearchEntryLayers({
      spread, targetTimestamp: entryTimestamp, targetIndex: entryPrice,
      amount, slippageBps,
    });
    const evaluate = (mode: ExecutionMode): ResearchScenarioResult => {
      const entry = layers[mode].entry;
      const path = entry.status === "priced"
        ? buildEstimatedPath({spread, timestamps: grid, candles, entry, slippageBps}) : [];
      const outcomes = entry.status === "priced"
        ? buildResearchOutcomes({event: source as never, spread, entry, path, candles}) : [];
      return {entry, path: path as EstimatedPathPoint[], outcomes: outcomes as EstimatedOutcome[]};
    };

    const referenceEntry = layers.model.entry;
    const referencePath = referenceEntry.status === "priced"
      ? buildEstimatedPath({spread, timestamps: grid, candles, entry: referenceEntry, slippageBps}) : [];
    const referenceOutcomes = referenceEntry.status === "priced"
      ? buildResearchOutcomes({event: source as never, spread, entry: referenceEntry, path: referencePath, candles}) : [];

    const delayed = analyzeDelayedExecution({
      spread, event: source as never, signalTimestamp: entryTimestamp,
      underlyingCandles: candles, primarySize: amount, slippageBps,
    });

    record({
      eventId: input.eventId, candidateId: structure.candidateId, status: "recomputed",
      referenceStatus: referenceEntry.status,
      referenceSource: referenceEntry.status === "priced"
        ? `${referenceEntry.referenceProvenance?.short.source ?? "?"}/${referenceEntry.referenceProvenance?.long.source ?? "?"}`
        : str(referenceEntry.reasonCode) ?? "unavailable",
      crossSectionInstruments: market.crossSectionInstruments,
      apiRequests: market.apiRequests,
    });
    void candidate;

    return buildDerivedResearchOutput({
      candidateId: structure.candidateId,
      scenarios: {maker: evaluate("maker"), taker: evaluate("taker")},
      reference: {entry: referenceEntry, path: referencePath as EstimatedPathPoint[],
        outcomes: referenceOutcomes as EstimatedOutcome[]},
      referenceUnavailableReason: referenceEntry.status === "priced" ? null : layers.model.reason ?? null,
      statusLayers: layers as never,
      delayed,
      evidenceCatalog: new Map((event.evidenceCatalog ?? []).map(t => [t.evidenceId, t])),
      modeledCalibration: calibration,
      structural: {candidateSnapshot: structure.candidateSnapshot, quantity: structure.quantity},
    }) satisfies DerivedResearchOutput;
  };

  return {
    engine,
    prime(store) {
      for (const event of store.events) eventsById.set(event.eventId, event);
    },
  };
}
