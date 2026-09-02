import { delayedEconomicPathAvailable, type CanonicalTrack } from "./research-tracks.ts";
import { canonicalOutcomeId, outcomeHoldingHours, outcomeSourceStatus, outcomeTriggerStatus } from "./research-outcomes.ts";
import { indexByCandidate, readCanonicalStructuralLoss, type StructuralLossReading } from "./canonical-structural-loss.ts";
import type { AnalysisDataset } from "./research-analysis";
import { projectVolatilityAnalytics, type VolatilityAnalyticsProjection } from "./volatility/volatility-analytics.ts";

export const ANALYTICS_STARTING_COMMIT =
  "bb78a6fd79c03c3150491596a0134e32f4afa6eb";
export const ANALYTICS_TRACKS = [
  "reference",
  "immediate_maker",
  "immediate_taker",
  "delayed_maker",
  "delayed_taker",
  "modeled_expected",
  "modeled_conservative",
  "penalty_sensitivity",
] as const;
export type AnalyticsTrack = (typeof ANALYTICS_TRACKS)[number];
const CANONICAL_TRACK_FOR_ANALYTICS:Readonly<Partial<Record<AnalyticsTrack,CanonicalTrack>>>={
 reference:"reference_fair_value",immediate_maker:"strict_maker",immediate_taker:"strict_taker",
 delayed_maker:"delayed_maker",delayed_taker:"delayed_taker",
 modeled_expected:"modeled_expected",modeled_conservative:"modeled_conservative",
};
export const ANALYTICS_TRACK_METADATA: Readonly<Record<AnalyticsTrack, {
  label:string; observed:boolean; modeled:boolean; executionScenario:"maker"|"taker"|null;
  role:"central"|"counterfactual"|"conservative"|"sensitivity"; description:string;
}>> = {
  reference:{label:"Reference fair value",observed:false,modeled:false,executionScenario:null,role:"counterfactual",description:"Execution-independent fair-value counterfactual."},
  immediate_maker:{label:"Immediate maker opportunity",observed:true,modeled:false,executionScenario:"maker",role:"sensitivity",description:"Exact causal tape maker opportunity."},
  immediate_taker:{label:"Immediate taker execution",observed:true,modeled:false,executionScenario:"taker",role:"sensitivity",description:"Exact causal tape taker execution."},
  delayed_maker:{label:"Delayed maker opportunity",observed:true,modeled:false,executionScenario:"maker",role:"sensitivity",description:"Delayed causal tape maker opportunity."},
  delayed_taker:{label:"Delayed taker execution",observed:true,modeled:false,executionScenario:"taker",role:"sensitivity",description:"Delayed causal tape taker execution."},
  modeled_expected:{label:"Empirical expected taker · Q50",observed:false,modeled:true,executionScenario:null,role:"central",description:"Central empirical taker execution using per-leg Q50 concessions."},
  modeled_conservative:{label:"Empirical conservative taker · Q90",observed:false,modeled:true,executionScenario:null,role:"conservative",description:"Conservative empirical taker execution using per-leg Q90 concessions."},
  penalty_sensitivity:{label:"Declared sensitivity",observed:false,modeled:true,executionScenario:null,role:"sensitivity",description:"Declared execution-penalty sensitivity; not observed execution."},
};
export type SourceTier = "high" | "medium" | "low" | "unavailable";
type Row = Readonly<Record<string, unknown>>;
const n = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const s = (v: unknown) => (typeof v === "string" ? v : null);
const time = (v: unknown) => {
  const numeric = n(v);
  if (numeric !== null) return numeric;
  const x = s(v);
  return x === null ? null : Date.parse(x);
};
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const tier = (v: unknown): SourceTier =>
  v === "green" || v === "high"
    ? "high"
    : v === "yellow" || v === "medium"
      ? "medium"
      : v === "red" || v === "low"
        ? "low"
        : "unavailable";
const trackOf = (r: Row, legacyIvCompatibility=false): AnalyticsTrack | null => {
  const explicit = s(r.analytics_track);
  if (explicit && ANALYTICS_TRACKS.includes(explicit as AnalyticsTrack))
    return explicit as AnalyticsTrack;
  const scenario = s(r.execution_scenario),
    pricing = s(r.pricing_track),
    delay = n(r.entry_delay_hours) ?? n(rec(r.delayed_execution).delay_hours);
  if (scenario === "maker")
    return delay && delay > 0 ? "delayed_maker" : "immediate_maker";
  if (scenario === "taker")
    return delay && delay > 0 ? "delayed_taker" : "immediate_taker";
  if (pricing === "raw_vwap") return null;
  // Current bundles require analytics_track. This mapping is limited to explicitly
  // older imports and is never labelled with empirical estimator provenance.
  if(legacyIvCompatibility&&pricing === "iv_normalized") return "modeled_expected";
  return null;
};
export interface PositionEconomics {
  grossCredit: number | null;
  netCredit: number | null;
  entryFees: number | null;
  closingFees: number | null;
  concession: number | null;
  maximumEconomicLoss: number | null;
  openingIm: number | null;
  openingMm: number | null;
  peakIm: number | null;
  peakMm: number | null;
  pnlNative: number | null;
  pnlUsd: number | null;
  returnOnMaxLoss: number | null;
  returnOnOpeningMargin: number | null;
  returnOnPeakCapital: number | null;
  capitalDays: number | null;
  denominatorReasons: readonly string[];
}
export interface ScenarioTrack {
  id: string;
  track: AnalyticsTrack;
  status:
    | "available"
    | "unavailable"
    | "pre_entry_resolution"
    | "legacy_limited";
  observed: boolean;
  modeled: boolean;
  entryTime: number | null;
  actualDteDays: number | null;
  source: string;
  sourceTier: SourceTier;
  modelVersion: string | null;
  calibrationCount: number | null;
  uncertainty: {
    lower: number | null;
    central: number | null;
    upper: number | null;
  };
  extrapolated: boolean;
  dvolProxy: boolean;
  synchronizationMinutes: number | null;
  entryEvidence: unknown;
  openingLedger: unknown;
  valuationPath: readonly Row[];
  /** Canonical named outcomes.  Consumers must not assume snapshot ordering. */
  outcomes: Readonly<Record<string, Row>>;
  exitPolicy: string;
  economics: PositionEconomics;
  reason: string | null;
}
export interface AnalyticalObservation {
  id: string;
  eventId: string;
  candidateId: string;
  strategyVariantId: string;
  structure: {
    direction: string | null;
    width: number | null;
    strikeMethod: string | null;
    optionType: string | null;
    signalDteDays: number | null;
    expiryTime: number | null;
    amount: number | null;
  };
  contractStatus: string;
  resolution: string;
  tracks: Readonly<Partial<Record<AnalyticsTrack, ScenarioTrack>>>;
  reasons: readonly string[];
}
export interface Denominators {
  generatedOpportunities: number;
  contractResolved: number;
  confirmedNonListings: number;
  retrievalFailures: number;
  referenceValued: number;
  immediateMakerSupported: number;
  immediateTakerSupported: number;
  delayedSupported: Readonly<Record<string, number>>;
  modeledValued: number;
  referenceAvailable:number;
  immediateMakerAvailable:number;
  immediateTakerAvailable:number;
  delayedMakerAvailable:number;
  delayedTakerAvailable:number;
  modeledExpectedAvailable:number;
  modeledConservativeAvailable:number;
  fullyUnavailable: number;
}
export interface TrackSummary {
  track: AnalyticsTrack;
  eligible: number;
  entered: number;
  events: number;
  tradeConditional: { count: number; pnl: number | null; denominator: string };
  opportunityNormalized: {
    count: number;
    pnl: number;
    missed: number;
    denominator: string;
  };
  sourceComposition: Readonly<Record<string, number>>;
  tierComposition: Readonly<Record<SourceTier, number>>;
  excludedRetrievalFailures: number;
}
export interface ResearchAnalyticsModel {
  observations: readonly AnalyticalObservation[];
  denominators: Denominators;
  summaries: readonly TrackSummary[];
  resolution: readonly { eventId: string; state: string }[];
  warnings: readonly string[];
  /**
   * Market volatility evidence, read straight from the bundle and never
   * recomputed here. Absent tables project to zero coverage, so a consumer that
   * forgets to check availability reads zeroes in the DENOMINATOR, not a
   * fabricated volatility.
   */
  volatility: VolatilityAnalyticsProjection;
}

/**
 * Dataset-scoped owner of canonical normalization and compatibility projections.
 * AnalysisDataset is immutable for an import session, so identity is the precise
 * invalidation boundary. Projections share all unchanged tables and are created
 * at most once per track.
 */
export interface ResearchAnalyticsContext {
  readonly dataset: AnalysisDataset;
  readonly model: ResearchAnalyticsModel;
  projection(track: AnalyticsTrack): AnalysisDataset;
  readonly materializedTracks: readonly AnalyticsTrack[];
}

const contexts = new WeakMap<AnalysisDataset, ResearchAnalyticsContext>();
let normalizationBuilds = 0;
let projectionBuilds = 0;

export function researchAnalyticsPerformanceCounters() {
  return { normalizationBuilds, projectionBuilds } as const;
}

export function resetResearchAnalyticsPerformanceCounters() {
  normalizationBuilds = 0;
  projectionBuilds = 0;
}

export function createResearchAnalyticsContext(d: AnalysisDataset): ResearchAnalyticsContext {
  const existing = contexts.get(d);
  if (existing) return existing;
  normalizationBuilds++;
  const model = buildResearchAnalyticsModelUncached(d);
  const projections = new Map<AnalyticsTrack, AnalysisDataset>();
  const context: ResearchAnalyticsContext = {
    dataset: d,
    model,
    projection(track) {
      const cached = projections.get(track);
      if (cached) return cached;
      projectionBuilds++;
      const projected = projectAnalyticsTrack(d, track, model);
      projections.set(track, projected);
      return projected;
    },
    get materializedTracks() { return [...projections.keys()]; },
  };
  contexts.set(d, context);
  return context;
}

export function buildResearchAnalyticsModel(d: AnalysisDataset): ResearchAnalyticsModel {
  return createResearchAnalyticsContext(d).model;
}

/** Statuses only a raw engine snapshot uses; never a tabular outcome status. */
const SNAPSHOT_ONLY_STATUSES = new Set(["estimated", "not-hit"]);

/** ISO string from either an ISO string or a millisecond timestamp. */
const isoTime = (v: unknown): string | null => {
  const x = s(v);
  if (x !== null) return x;
  const ms = n(v);
  return ms === null ? null : new Date(ms).toISOString();
};

/**
 * Project ONE canonical outcome into the older tabular shape.
 *
 * FIDELITY RULE. Track availability governs whether the TRACK exists; it never
 * decides whether an individual exit policy was reached or priced. The
 * projection previously wrote `status: available ? "priced" : "unavailable"`
 * and `trigger_status: ... ?? "reached"`, so an available Reference track
 * silently reported every exit -- including an invalidation that never
 * happened -- as reached and priced.
 *
 * Each outcome now keeps its OWN canonical state. A state that the source
 * already carries is passed through untouched; only a snapshot that carries no
 * exported state at all is classified, and then by the same canonical helpers
 * the exporter uses, never by a second mapping table written here. Nothing is
 * promoted, and a genuinely evaluated source outcome is not demoted either.
 *
 * `priced` is the older tabular vocabulary for the canonical `evaluated`; the
 * two are the same state under different names, so translating between them is
 * not a status change.
 */
function projectOutcome(
  x: Row,
  name: string,
  candidateId: string,
  scenario: "maker" | "taker" | null,
  track: ScenarioTrack,
  expiry: number | null,
): Row {
  // Canonical identity first, then the exported column, then the snapshot label.
  const outcomeType =
    s(x.outcome_type) ??
    canonicalOutcomeId(x.label) ??
    canonicalOutcomeId(name) ??
    name;
  // An exported row already states these; a raw snapshot is classified by the
  // canonical helpers rather than assumed.
  const triggerStatus = s(x.trigger_status) ?? outcomeTriggerStatus(x);
  const sourceStatus = s(x.source_status) ?? outcomeSourceStatus(x);
  const decision = isoTime(x.decision_available_timestamp_utc) ?? isoTime(x.decisionTimestamp);
  const valuation = isoTime(x.valuation_timestamp_utc) ?? isoTime(x.valuationTimestamp);
  const nativePnl = n(x.net_pnl_native) ?? n(x.estimatedNetPnlBtc) ?? n(x.raw_net_pnl_native);
  const usdPnl = n(x.net_pnl_usd) ?? n(x.estimatedNetPnlUsd) ?? n(x.raw_net_pnl_usd);
  // Two vocabularies share the field name. An exported tabular row states
  // evaluated/priced/unavailable; a raw engine snapshot states estimated/not-hit.
  // A snapshot status is a SOURCE status, so it is classified rather than
  // passed through as if it were already a tabular one. `evaluated` and `priced`
  // are the same state under two names, so translating between them is not a
  // status change.
  const raw = s(x.status);
  const tabular = raw !== null && !SNAPSHOT_ONLY_STATUSES.has(raw) ? raw : null;
  const status =
    tabular === "evaluated" || tabular === "priced"
      ? "priced"
      : tabular !== null
        ? tabular
        : triggerStatus === "reached" && sourceStatus === "estimated" && nativePnl !== null
          ? "priced"
          : "unavailable";
  const priced = status === "priced";
  const holding =
    x.holding_hours !== undefined
      ? n(x.holding_hours)
      : outcomeHoldingHours({
          reached: priced,
          entryTimestampMs: track.entryTime,
          valuationTimestampMs: valuation === null ? null : Date.parse(valuation),
          decisionTimestampMs: decision === null ? null : Date.parse(decision),
          expiryTimestampMs: expiry,
        });
  return {
    ...x,
    candidate_id: candidateId,
    execution_scenario: scenario,
    analytics_track: track.track,
    outcome_type: outcomeType,
    status,
    trigger_status: triggerStatus,
    source_status: sourceStatus,
    decision_available_timestamp_utc: decision,
    valuation_timestamp_utc: valuation,
    holding_hours: holding,
    // A per-pricing-track status that the source already stated is preserved;
    // otherwise it follows this outcome's own state, never the track's.
    raw_status: s(x.raw_status) ?? status,
    iv_normalized_status: s(x.iv_normalized_status) ?? status,
    net_pnl_native: nativePnl,
    net_pnl_usd: usdPnl,
    raw_net_pnl_native: n(x.raw_net_pnl_native) ?? nativePnl,
    raw_net_pnl_usd: n(x.raw_net_pnl_usd) ?? usdPnl,
    iv_normalized_net_pnl_native: n(x.iv_normalized_net_pnl_native) ?? nativePnl,
    iv_normalized_net_pnl_usd: n(x.iv_normalized_net_pnl_usd) ?? usdPnl,
  };
}

/**
 * Project one canonical analytical track back into the tabular shape consumed
 * by the older report calculators.  This is deliberately the only compatibility
 * boundary: report modules must not decode reference_valuation,
 * delayed_execution or modeled_execution themselves.
 *
 * Structural candidate fields always come from one strategy-variant row.  The
 * projected economic/path fields come exclusively from the requested track;
 * an unavailable track is retained as an explicitly unavailable candidate.
 */
function projectAnalyticsTrack(
  d: AnalysisDataset,
  requested: AnalyticsTrack,
  model: ResearchAnalyticsModel,
): AnalysisDataset {
  const rows = d.tables.candidates ?? [];
  const candidates: Row[] = [], outcomes: Row[] = [], valuations: Row[] = [];
  for (const observation of model.observations) {
    const base = rows.find(r =>
      s(r.event_id) === observation.eventId &&
      (s(r.strategy_variant_id) ?? s(r.candidate_id)) === observation.strategyVariantId,
    ) ?? rows.find(r => s(r.candidate_id) === observation.candidateId);
    if (!base) continue;
    const track = observation.tracks[requested];
    const entry = rec(track?.entryEvidence);
    const sold = rec(entry.sold), bought = rec(entry.bought);
    const metadata=ANALYTICS_TRACK_METADATA[requested],scenario=metadata.executionScenario;
    const available = track?.status === "available";
    candidates.push({
      ...base,
      candidate_id: observation.candidateId,
      strategy_variant_id: observation.strategyVariantId,
      structure_execution_id: `${observation.candidateId}~${requested}`,
      analytics_track: requested,
      execution_scenario: scenario,
      execution_observed: metadata.observed,
      execution_modeled: metadata.modeled,
      execution_scenario_status: available ? "evaluated" : "unavailable",
      execution_scenario_reason: track?.reason ?? `${requested} unavailable`,
      structure_entry_timestamp_utc: track?.entryTime === null || track?.entryTime === undefined ? null : new Date(track.entryTime).toISOString(),
      entry_index_price: n(entry.entryTargetIndex) ?? n(entry.targetIndex) ?? n(base.entry_index_price),
      entry_legs: available ? {
        short: { price_native: n(sold.priceBtcPerContract) ?? n(sold.price_native) },
        long: { price_native: n(bought.priceBtcPerContract) ?? n(bought.price_native) },
      } : null,
      gross_credit_debit_native: available ? track.economics.grossCredit : null,
      opening_fees_native: available ? track.economics.entryFees : null,
      net_opening_cash_flow_native: available ? track.economics.netCredit : null,
    });
    if (!track) continue;
    for (const [name, value] of Object.entries(track.outcomes))
      outcomes.push(projectOutcome(rec(value), name, observation.candidateId, scenario, track, observation.structure.expiryTime));
    for (const value of track.valuationPath) {
      const x = rec(value);
      const nativePnl = n(x.net_pnl_native) ?? n(x.estimatedNetPnlBtc);
      const targetIndex = n(x.targetIndex) ?? n(x.target_index);
      const explicitUsd = n(x.net_pnl_usd) ?? n(x.estimatedNetPnlUsd);
      valuations.push({
        ...x,
        candidate_id: observation.candidateId,
        execution_scenario: scenario,
        pricing_track: requested === "reference" ? "reference" : requested,
        valuation_status: "priced",
        timestamp_utc: s(x.timestamp_utc) ?? (n(x.timestamp) === null ? null : new Date(n(x.timestamp)!).toISOString()),
        net_pnl_native: nativePnl,
        net_pnl_usd: explicitUsd ?? (nativePnl !== null && targetIndex !== null && targetIndex > 0 ? nativePnl * targetIndex : null),
        net_pnl_usd_provenance: explicitUsd !== null ? "persisted_usd_pnl" : nativePnl !== null && targetIndex !== null && targetIndex > 0 ? "derived_native_pnl_times_contemporaneous_target_index" : null,
      });
    }
  }
  return {...d, tables: {...d.tables, candidates, outcomes, valuations}};
}

export function datasetForAnalyticsTrack(d: AnalysisDataset, requested: AnalyticsTrack): AnalysisDataset {
  return createResearchAnalyticsContext(d).projection(requested);
}

function economics(
  r: Row,
  margin: Row | undefined,
  outcome: Row | undefined,
  entryTime: number | null,
  structuralLoss?: StructuralLossReading,
): PositionEconomics {
  const gross = n(r.gross_credit_debit_native),
    entryFees = n(r.opening_fees_native) ?? 0,
    net =
      n(r.net_opening_cash_flow_native) ??
      (gross === null ? null : gross - entryFees),
    closing = n(outcome?.closing_fees_native) ?? 0,
    pnl = n(outcome?.net_pnl_native),
    usd = n(outcome?.net_pnl_usd),
    width = n(rec(r.actual_strikes).width),
    qty = n(r.quantity) ?? 1,
    // Canonical bounded structural risk, read through the single canonical
    // adapter: structure_economics first, margin_scenarios as reconciliation.
    // The width-minus-credit derivation below is algebraically identical to
    // `canonicalStructuralLoss` for an inverse vertical
    // (width/index x qty - net credit) and is retained only as a last resort
    // for rows that carry neither canonical source; it is never preferred over
    // a canonical value, so the two can no longer diverge silently.
    maxLoss =
      structuralLoss?.btc ??
      n(margin?.maximum_structural_loss_native) ??
      (width !== null && net !== null && n(r.entry_index_price) !== null
        ? Math.max(0, (width / n(r.entry_index_price)!) * qty - net)
        : null),
    openIm =
      n(margin?.incremental_initial_margin_native) ??
      n(margin?.opening_im_native),
    openMm =
      n(margin?.incremental_maintenance_margin_native) ??
      n(margin?.opening_mm_native),
    peakIm = n(margin?.peak_initial_margin_native) ?? openIm,
    peakMm = n(margin?.peak_maintenance_margin_native) ?? openMm,
    exit =
      time(outcome?.valuation_timestamp_utc) ??
      time(outcome?.decision_timestamp_utc),
    days =
      entryTime !== null && exit !== null && exit >= entryTime
        ? (exit - entryTime) / 864e5
        : null,
    reasons: string[] = [];
  if (maxLoss === null) reasons.push("maximum structural loss unavailable");
  if (openIm === null) reasons.push("opening margin unavailable");
  if (peakIm === null) reasons.push("peak capital unavailable");
  if (pnl === null) reasons.push("exit PnL unavailable");
  return {
    grossCredit: gross,
    netCredit: net,
    entryFees,
    closingFees: closing,
    concession:
      n(r.execution_concession_native) ?? n(r.conservative_slippage_native),
    maximumEconomicLoss: maxLoss,
    openingIm: openIm,
    openingMm: openMm,
    peakIm,
    peakMm,
    pnlNative: pnl,
    pnlUsd: usd,
    returnOnMaxLoss: pnl !== null && maxLoss ? pnl / maxLoss : null,
    returnOnOpeningMargin: pnl !== null && openIm ? pnl / openIm : null,
    returnOnPeakCapital: pnl !== null && peakIm ? pnl / peakIm : null,
    capitalDays: days !== null && peakIm !== null ? days * peakIm : null,
    denominatorReasons: reasons,
  };
}

const snapshotRow = (base: Row, entry: Row): Row => ({
  ...base,
  gross_credit_debit_native: n(entry.grossSpreadBtc),
  opening_fees_native: n(entry.openingFeesBtc),
  net_opening_cash_flow_native: n(entry.netOpeningCashFlowBtc),
  entry_index_price: n(entry.entryTargetIndex) ?? n(entry.targetIndex),
  entry_quality: entry.estimateQuality,
});
function canonicalSnapshotTrack(
  id: string,
  track: AnalyticsTrack,
  base: Row,
  snapshot: Row,
  expiry: number | null,
  signal: number | null,
  structuralLoss?: StructuralLossReading,
): ScenarioTrack {
  const entry = rec(snapshot.entrySnapshot),
    statusValue = s(snapshot.status),
    // A delayed track additionally needs a usable causal post-entry path: the
    // shared contract, so entry-only delayed evidence is never selected as a
    // complete PnL cohort.
    available =
      (statusValue === "valued" ||
        statusValue === "evaluated" ||
        statusValue === "available") &&
      (!track.startsWith("delayed_") ||
        delayedEconomicPathAvailable(snapshot, expiry)),
    entryTime =
      time(entry.valuationTimestamp) ?? time(entry.targetTimestamp) ?? signal,
    unc = rec(snapshot.uncertainty),
    row = snapshotRow(base, entry),
    path = Array.isArray(snapshot.valuationPathSnapshot)
      ? (snapshot.valuationPathSnapshot.filter(
          (x) => x && typeof x === "object",
        ) as Row[])
      : [],
    outcomeRows = Array.isArray(snapshot.outcomeSnapshots)
      ? (snapshot.outcomeSnapshots.filter(
          (x) => x && typeof x === "object",
        ) as Row[])
      : [],
    outcome = outcomeRows.find((x) => /settlement|terminal/i.test(s(x.label) ?? s(x.outcome_type) ?? "")) ?? outcomeRows[0],
    source =
      s(snapshot.source) ??
      s(entry.priceSource) ??
      (track.startsWith("modeled") ? "model" : "canonical snapshot");
  return {
    id: `${id}~${track}`,
    track,
    status: available ? "available" : "unavailable",
    observed: [
      "immediate_maker",
      "immediate_taker",
      "delayed_maker",
      "delayed_taker",
    ].includes(track),
    modeled: track.startsWith("modeled") || track === "penalty_sensitivity",
    entryTime,
    actualDteDays:
      expiry !== null && entryTime !== null
        ? (expiry - entryTime) / 864e5
        : null,
    source,
    sourceTier: tier(
      entry.estimateQuality ??
        snapshot.quality_tier ??
        rec(snapshot.provenance).quality,
    ),
    modelVersion: s(snapshot.modelVersion) ?? s(snapshot.model_version),
    calibrationCount:
      n(snapshot.calibrationCount) ?? n(snapshot.calibration_count),
    uncertainty: {
      lower: n(unc.lower),
      central: n(unc.central) ?? n(entry.netOpeningCashFlowBtc),
      upper: n(unc.upper),
    },
    extrapolated:
      s(snapshot.source) === "surface_extrapolation" ||
      snapshot.extrapolated === true,
    dvolProxy:
      s(snapshot.source) === "dvol_anchored_smile_proxy" ||
      snapshot.dvolProxy === true,
    synchronizationMinutes: n(entry.synchronizationGapMinutes),
    entryEvidence: entry,
    openingLedger: {
      gross: n(entry.grossSpreadBtc),
      fees: n(entry.openingFeesBtc),
      net: n(entry.netOpeningCashFlowBtc),
    },
    valuationPath: path,
    outcomes: Object.fromEntries(outcomeRows.map((x, index) => [
      (s(x.label) ?? s(x.outcome_type) ?? s(x.rule) ?? `outcome_${index}`).toLowerCase(), x,
    ])),
    exitPolicy: s(snapshot.exitPolicy) ?? "economic valuation",
    economics: economics(
      row,
      undefined,
      outcome
        ? ({
            ...outcome,
            net_pnl_native: n(outcome.estimatedNetPnlBtc),
            net_pnl_usd: n(outcome.estimatedNetPnlUsd),
            valuation_timestamp_utc: outcome.valuationTimestamp,
          } as Row)
        : undefined,
      entryTime,
      structuralLoss,
    ),
    reason: available ? null : (s(snapshot.reason) ?? `${track} unavailable`),
  };
}

function buildResearchAnalyticsModelUncached(
  d: AnalysisDataset,
): ResearchAnalyticsModel {
  const t = d.tables,
    events = new Map((t.events ?? []).map((r) => [s(r.event_id)!, r])),
    margins = t.margin_scenarios ?? [],
    // Canonical structural risk is READ once per candidate, never recomputed.
    structureEconomicsById = indexByCandidate(t.structure_economics),
    marginById = indexByCandidate(margins),
    structuralLossFor = (candidateId: string | null): StructuralLossReading | undefined =>
      candidateId === null
        ? undefined
        : readCanonicalStructuralLoss({
            economics: structureEconomicsById.get(candidateId),
            margin: marginById.get(candidateId),
          }),
    canonicalDescriptorFor = (candidateId:string|null,track:AnalyticsTrack):Row|undefined => {
      const canonical=CANONICAL_TRACK_FOR_ANALYTICS[track],economics=candidateId===null?undefined:structureEconomicsById.get(candidateId);
      return canonical&&economics&&Array.isArray(economics.tracks)
        ? economics.tracks.find(raw=>s(rec(raw).track)===canonical) as Row|undefined
        : undefined;
    },
    gateCanonicalTrack = (candidateId:string|null,track:AnalyticsTrack,value:ScenarioTrack):ScenarioTrack => {
      const descriptor=canonicalDescriptorFor(candidateId,track),status=s(descriptor?.status);
      if(!descriptor||status==="available"||status==="evaluated"||status==="valued")return value;
      return {...value,status:"unavailable",entryTime:null,actualDteDays:null,entryEvidence:null,openingLedger:null,
        valuationPath:[],outcomes:{},economics:{grossCredit:null,netCredit:null,entryFees:null,closingFees:null,concession:null,
          maximumEconomicLoss:null,openingIm:null,openingMm:null,peakIm:null,peakMm:null,pnlNative:null,pnlUsd:null,
          returnOnMaxLoss:null,returnOnOpeningMargin:null,returnOnPeakCapital:null,capitalDays:null,
          denominatorReasons:[s(descriptor.reason)??`${track} explicitly unavailable in canonical structure economics`]},
        reason:s(descriptor.reason)??`${track} explicitly unavailable in canonical structure economics`};
    },
    outcomes = t.outcomes ?? [],
    vals = t.valuations ?? [],
    groups = new Map<
      string,
      { eventId: string; variant: string; rows: Row[]; availability: Row[] }
    >();
  for (const a of t.availability ?? []) {
    const eventId = s(a.event_id) ?? "unknown",
      variant =
        s(a.strategy_variant_id) ??
        s(a.candidate_id) ??
        s(a.availability_id) ??
        "unknown",
      key = `${eventId}×${variant}`,
      g = groups.get(key) ?? { eventId, variant, rows: [], availability: [] };
    g.availability.push(a);
    groups.set(key, g);
  }
  for (const r of t.candidates ?? []) {
    const eventId = s(r.event_id) ?? "unknown",
      variant = s(r.strategy_variant_id) ?? s(r.candidate_id) ?? "unknown",
      key = `${eventId}×${variant}`,
      g = groups.get(key) ?? { eventId, variant, rows: [], availability: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const observations = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, g]) => {
      const base = g.rows[0] ?? g.availability[0] ?? {},
        event = events.get(g.eventId),
        expiry = time(base.expiry_timestamp_utc),
        signal =
          time(event?.signal_timestamp_utc) ?? time(event?.entry_timestamp_utc),
        tracks: Partial<Record<AnalyticsTrack, ScenarioTrack>> = {};
      for (const r of g.rows) {
        const tr = trackOf(r, Number(d.schemaVersion.split(".")[0])<3 || (Number(d.schemaVersion.split(".")[0])===3&&Number(d.schemaVersion.split(".")[1])<7));
        if (!tr) continue;
        const entry =
            time(r.structure_entry_timestamp_utc) ??
            time(r.valuation_timestamp_utc),
          eventResolution =
            time(event?.vpoc_decision_timestamp_utc) ??
            time(event?.invalidation_decision_timestamp_utc),
          legacy = r.execution_scenario_legacy_undifferentiated === true,
          status = legacy
            ? "legacy_limited"
            : eventResolution !== null &&
                entry !== null &&
                eventResolution < entry
              ? "pre_entry_resolution"
              : r.execution_scenario_status === "evaluated" ||
                  r.valuation_status === "priced"
                ? "available"
                : "unavailable",
          margin = margins.find(
            (x) =>
              s(x.candidate_id) === s(r.candidate_id) &&
              s(x.execution_scenario) === s(r.execution_scenario),
          ),
          outcome = outcomes.find(
            (x) =>
              s(x.candidate_id) === s(r.candidate_id) &&
              s(x.execution_scenario) === s(r.execution_scenario) &&
              s(x.outcome_type) === (s(r.exit_policy) ?? "settlement"),
          ),
          rv = rec(r.reference_valuation),
          unc = rec(r.uncertainty),
          source =
            s(r.valuation_source) ??
            s(rv.source) ??
            (tr.startsWith("modeled") ? "model" : "observed");
        tracks[tr] = gateCanonicalTrack(s(r.candidate_id),tr,{
          id: `${id}~${tr}`,
          track: tr,
          status,
          observed: [
            "immediate_maker",
            "immediate_taker",
            "delayed_maker",
            "delayed_taker",
          ].includes(tr),
          modeled: tr.startsWith("modeled") || tr === "penalty_sensitivity",
          entryTime: entry,
          actualDteDays:
            expiry !== null && entry !== null ? (expiry - entry) / 864e5 : null,
          source,
          sourceTier: tier(
            r.quality_tier ?? r.entry_quality ?? rv.quality_tier,
          ),
          modelVersion: s(r.model_version),
          calibrationCount: n(r.calibration_count),
          uncertainty: {
            lower: n(unc.lower),
            central: n(unc.central) ?? n(r.net_opening_cash_flow_native),
            upper: n(unc.upper),
          },
          extrapolated: r.extrapolated === true,
          dvolProxy: r.dvol_proxy === true,
          synchronizationMinutes: n(r.spread_synchronization_minutes),
          entryEvidence: r.entry_legs ?? null,
          openingLedger: r.opening_ledger ?? {
            gross: r.gross_credit_debit_native,
            fees: r.opening_fees_native,
            net: r.net_opening_cash_flow_native,
          },
          valuationPath: vals.filter(
            (x) =>
              s(x.candidate_id) === s(r.candidate_id) &&
              s(x.execution_scenario) === s(r.execution_scenario) &&
              (!s(x.analytics_track) || s(x.analytics_track) === tr),
          ),
          outcomes: Object.fromEntries(outcomes.filter(
            (x) => s(x.candidate_id) === s(r.candidate_id) && s(x.execution_scenario) === s(r.execution_scenario),
          ).map((x, index) => [(s(x.outcome_type) ?? `outcome_${index}`).toLowerCase(), x])),
          exitPolicy: s(r.exit_policy) ?? "settlement",
          economics: economics(r, margin, outcome, entry, structuralLossFor(s(r.candidate_id))),
          reason: s(r.execution_scenario_reason),
        });
      }
      const baseLoss = structuralLossFor(s(base.candidate_id));
      const ref = rec(base.reference_valuation),candidateId=s(base.candidate_id),referenceDescriptor=canonicalDescriptorFor(candidateId,"reference");
      if (Object.keys(ref).length||referenceDescriptor)
        tracks.reference = gateCanonicalTrack(candidateId,"reference",canonicalSnapshotTrack(
          id,"reference",base,ref,expiry,signal,baseLoss,
        ));
      const delayed = rec(base.delayed_execution);
      const delayedMakerDescriptor=canonicalDescriptorFor(candidateId,"delayed_maker"),delayedTakerDescriptor=canonicalDescriptorFor(candidateId,"delayed_taker");
      if (Object.keys(delayed).length||delayedMakerDescriptor||delayedTakerDescriptor) {
        const maker = rec(delayed.maker), taker = rec(delayed.taker);
        if (Object.keys(maker).length||delayedMakerDescriptor)
          tracks.delayed_maker = gateCanonicalTrack(candidateId,"delayed_maker",canonicalSnapshotTrack(
            id,
            "delayed_maker",
            base,
            maker,
            expiry,
            signal,
            baseLoss,
          ));
        if (Object.keys(taker).length||delayedTakerDescriptor)
          tracks.delayed_taker = gateCanonicalTrack(candidateId,"delayed_taker",canonicalSnapshotTrack(
            id,
            "delayed_taker",
            base,
            taker,
            expiry,
            signal,
            baseLoss,
          ));
        if (!Object.keys(maker).length && !Object.keys(taker).length && !delayedMakerDescriptor && !delayedTakerDescriptor) {
          tracks.delayed_maker = canonicalSnapshotTrack(
            id,
            "delayed_maker",
            base,
            delayed,
            expiry,
            signal,
            baseLoss,
          );
          tracks.delayed_taker = canonicalSnapshotTrack(
            id,
            "delayed_taker",
            base,
            delayed,
            expiry,
            signal,
            baseLoss,
          );
        }
      }
      const modeled = rec(base.modeled_execution);
      for (const [name, track] of [
        ["expected", "modeled_expected"],
        ["conservative", "modeled_conservative"],
        ["penaltySensitivity", "penalty_sensitivity"],
      ] as const) {
        const snapshot = rec(modeled[name]),descriptor=canonicalDescriptorFor(candidateId,track);
        if (Object.keys(snapshot).length||descriptor)
          tracks[track] = gateCanonicalTrack(candidateId,track,canonicalSnapshotTrack(
            id,track,base,snapshot,expiry,signal,baseLoss,
          ));
      }
      return {
        id,
        eventId: g.eventId,
        candidateId: s(base.candidate_id) ?? g.variant,
        strategyVariantId: g.variant,
        structure: {
          direction: s(base.direction),
          width: n(rec(base.actual_strikes).width),
          strikeMethod: s(base.strike_method),
          optionType: s(base.option_type),
          signalDteDays:
            expiry !== null && signal !== null
              ? (expiry - signal) / 864e5
              : null,
          expiryTime: expiry,
          amount: n(base.quantity),
        },
        contractStatus:
          s(rec(base.contract_resolution).status) ??
          s(g.availability[0]?.contract_status) ??
          "unknown",
        resolution: s(event?.sequence_status) ?? "unknown",
        tracks,
        reasons: g.availability
          .map((x) => s(x.unavailable_reason) ?? s(x.reason))
          .filter((x): x is string => !!x),
      };
    });
  const availability = t.availability ?? [],
    isRetrieval = (r: Row) =>
      /retriev|data.failure/i.test(
        `${s(r.contract_status) ?? ""} ${s(r.unavailable_reason) ?? s(r.reason) ?? ""}`,
      ),
    denominators: Denominators = {
      generatedOpportunities: availability.length,
      contractResolved: availability.filter((r) =>
        [
          "resolved",
          "listed",
          "exact",
          "exact_resolved",
          "nearest_listed_resolved",
        ].includes(
          s(rec(r.contract_resolution).status) ?? s(r.contract_status) ?? "",
        ),
      ).length,
      confirmedNonListings: availability.filter((r) =>
        /non.?listing|not.?listed/i.test(
          s(r.contract_status) ?? s(r.unavailable_reason) ?? "",
        ),
      ).length,
      retrievalFailures: availability.filter(isRetrieval).length,
      referenceValued: observations.filter(
        (o) => o.tracks.reference?.status === "available",
      ).length,
      immediateMakerSupported: observations.filter(
        (o) => o.tracks.immediate_maker?.status === "available",
      ).length,
      immediateTakerSupported: observations.filter(
        (o) => o.tracks.immediate_taker?.status === "available",
      ).length,
      delayedSupported: {
        maker: observations.filter(
          (o) => o.tracks.delayed_maker?.status === "available",
        ).length,
        taker: observations.filter(
          (o) => o.tracks.delayed_taker?.status === "available",
        ).length,
      },
      modeledValued: observations.filter(
        (o) =>
          o.tracks.modeled_expected?.status === "available" ||
          o.tracks.modeled_conservative?.status === "available",
      ).length,
      referenceAvailable:observations.filter(o=>o.tracks.reference?.status==="available").length,
      immediateMakerAvailable:observations.filter(o=>o.tracks.immediate_maker?.status==="available").length,
      immediateTakerAvailable:observations.filter(o=>o.tracks.immediate_taker?.status==="available").length,
      delayedMakerAvailable:observations.filter(o=>o.tracks.delayed_maker?.status==="available").length,
      delayedTakerAvailable:observations.filter(o=>o.tracks.delayed_taker?.status==="available").length,
      modeledExpectedAvailable:observations.filter(o=>o.tracks.modeled_expected?.status==="available").length,
      modeledConservativeAvailable:observations.filter(o=>o.tracks.modeled_conservative?.status==="available").length,
      fullyUnavailable: observations.filter(
        (o) => !Object.values(o.tracks).some((x) => x?.status === "available"),
      ).length,
    };
  const summaries = ANALYTICS_TRACKS.map((track) => {
    const eligible = observations.filter(
        (o) =>
          o.tracks[track] &&
          !o.reasons.some((x) => /retriev|data.failure/i.test(x)),
      ),
      entered = eligible.filter((o) => o.tracks[track]?.status === "available"),
      pnls = entered
        .map((o) => o.tracks[track]!.economics.pnlNative)
        .filter((x): x is number => x !== null),
      sourceComposition: Record<string, number> = {},
      tierComposition = { high: 0, medium: 0, low: 0, unavailable: 0 };
    for (const o of entered) {
      const x = o.tracks[track]!;
      sourceComposition[x.source] = (sourceComposition[x.source] ?? 0) + 1;
      tierComposition[x.sourceTier]++;
    }
    return {
      track,
      eligible: eligible.length,
      entered: entered.length,
      events: new Set(eligible.map((o) => o.eventId)).size,
      tradeConditional: {
        count: pnls.length,
        pnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
        denominator: "entered trades with priced exit PnL",
      },
      opportunityNormalized: {
        count: eligible.length,
        pnl: eligible.length
          ? pnls.reduce((a, b) => a + b, 0) / eligible.length
          : 0,
        missed: eligible.length - entered.length,
        denominator:
          "eligible opportunities; missed entries are zero deployment and zero PnL; retrieval failures excluded",
      },
      sourceComposition,
      tierComposition,
      excludedRetrievalFailures: observations.filter(
        (o) =>
          o.tracks[track] &&
          o.reasons.some((x) => /retriev|data.failure/i.test(x)),
      ).length,
    };
  });
  return {
    observations,
    denominators,
    summaries,
    resolution: [...events]
      .map(([eventId, e]) => ({
        eventId,
        state: s(e.sequence_status) ?? "unknown",
      }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId)),
    warnings: [
      "Tracks are never pooled. One observation is event × strategyVariantId.",
      "Legacy-undifferentiated tracks are visible but excluded from matched comparisons.",
    ],
    volatility: projectVolatilityAnalytics(t),
  };
}

export function deterministicAnalyticsExport(model: ResearchAnalyticsModel) {
  return (
    JSON.stringify(
      model,
      (key, value) =>
        key === "entryEvidence" && value === undefined ? null : value,
      2,
    ) + "\n"
  );
}
