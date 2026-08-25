/**
 * Analytics-side reader for the two volatility bundle tables.
 *
 * This is the importer wiring, not a UI: it turns the serialized rows into a
 * typed projection and, crucially, MEASURES COVERAGE.
 *
 * Coverage is a first-class research result here rather than a footnote. Market
 * IV availability correlates with liquidity, and liquidity correlates with
 * regime, so "how often was there evidence" is itself a finding. Reporting a
 * mean IV across whatever happened to be observable, without stating the
 * denominator, would silently condition the whole analysis on quiet markets.
 */

import type {NominalTenor} from "./market-iv-evidence.ts";
import type {RvHorizon} from "./realized-volatility.ts";
import {RV_HORIZONS} from "./realized-volatility.ts";

export const VOLATILITY_ANALYTICS_VERSION = "volatility-analytics-projection-v1" as const;

export const NOMINAL_TENOR_ORDER: readonly NominalTenor[] = ["7d", "14d", "30d"];

type Row = Readonly<Record<string, unknown>>;
const rowsOf = (v: unknown): Row[] => Array.isArray(v) ? v.filter((x): x is Row => Boolean(x) && typeof x === "object") : [];
const str = (v: unknown): string | null => typeof v === "string" && v ? v : null;
const numeric = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

export interface AvailabilityTally {
  readonly available: number;
  readonly total: number;
  /** available / total, or null when nothing was even attempted. */
  readonly ratio: number | null;
  /** Why the unavailable ones were unavailable, counted. */
  readonly reasons: Readonly<Record<string, number>>;
}

const emptyTally = (): {available: number; total: number; reasons: Record<string, number>} =>
  ({available: 0, total: 0, reasons: {}});

const seal = (t: {available: number; total: number; reasons: Record<string, number>}): AvailabilityTally =>
  ({available: t.available, total: t.total, ratio: t.total ? t.available / t.total : null, reasons: t.reasons});

const tally = (
  bucket: {available: number; total: number; reasons: Record<string, number>},
  status: unknown, reason: unknown,
) => {
  bucket.total += 1;
  if (status === "available") { bucket.available += 1; return; }
  const key = str(reason) ?? "unspecified";
  bucket.reasons[key] = (bucket.reasons[key] ?? 0) + 1;
};

export interface VolatilityCoverage {
  readonly version: string;
  readonly eventCount: number;
  readonly structureCount: number;
  /** Events with at least one tenor of usable same-expiry reference IV. */
  readonly eventsWithAnyReferenceIv: number;
  readonly referenceIvByTenor: Readonly<Record<NominalTenor, AvailabilityTally>>;
  readonly tenorToleranceByTenor: Readonly<Record<NominalTenor, AvailabilityTally>>;
  readonly percentileByTenor: Readonly<Record<NominalTenor, AvailabilityTally>>;
  readonly realizedVolatilityByHorizon: Readonly<Record<RvHorizon, AvailabilityTally>>;
  readonly termStructure: Readonly<Record<string, AvailabilityTally>>;
  readonly broadVolatilityIndex: AvailabilityTally;
  readonly structureReference: AvailabilityTally;
  readonly legs: AvailabilityTally;
  /** Every distinct leg `observation` classification seen, counted. */
  readonly legObservations: Readonly<Record<string, number>>;
  readonly differentials: Readonly<Record<string, AvailabilityTally>>;
  /** Actual DTE actually resolved per nominal tenor, for the label-vs-reality gap. */
  readonly actualDteByTenor: Readonly<Record<NominalTenor, readonly number[]>>;
}

export interface VolatilityAnalyticsProjection {
  readonly events: readonly Row[];
  readonly structures: readonly Row[];
  readonly coverage: VolatilityCoverage;
  /** True only when at least one genuinely available market observation exists. */
  readonly hasMarketEvidence: boolean;
}

/**
 * Project the two tables and measure coverage.
 *
 * Accepts the raw `AnalysisDataset["tables"]` shape so the analytics layer needs
 * no adapter, and tolerates both tables being absent — a pre-3.7.0 bundle, or
 * one exported without the volatility pipeline, projects to zero coverage rather
 * than to an error.
 */
export function projectVolatilityAnalytics(
  tables: Readonly<Record<string, readonly Row[] | undefined>>,
): VolatilityAnalyticsProjection {
  const events = rowsOf(tables.event_volatility_state);
  const structures = rowsOf(tables.structure_volatility_state);

  const referenceIv = Object.fromEntries(NOMINAL_TENOR_ORDER.map(t => [t, emptyTally()]));
  const tolerance = Object.fromEntries(NOMINAL_TENOR_ORDER.map(t => [t, emptyTally()]));
  const percentile = Object.fromEntries(NOMINAL_TENOR_ORDER.map(t => [t, emptyTally()]));
  const dte: Record<NominalTenor, number[]> = {"7d": [], "14d": [], "30d": []};
  const rv = Object.fromEntries(RV_HORIZONS.map(h => [h, emptyTally()]));
  const slopes: Record<string, {available: number; total: number; reasons: Record<string, number>}> = {};
  const broad = emptyTally();
  let eventsWithAnyReferenceIv = 0;

  for (const event of events) {
    let anyTenor = false;
    for (const entry of rowsOf(event.reference_iv)) {
      const tenor = str(entry.nominal_tenor) as NominalTenor | null;
      if (!tenor || !(tenor in referenceIv)) continue;
      tally(referenceIv[tenor]!, entry.status, entry.unavailable_reason_code);
      // Tolerance is tracked separately from availability: a tenor can resolve
      // to a listed expiry and still be the wrong tenor.
      tally(tolerance[tenor]!, entry.tenor_tolerance_passed === true ? "available" : "unavailable",
        "tenor_tolerance_failed");
      const actual = numeric(entry.actual_dte_days);
      if (actual !== null) dte[tenor].push(actual);
      if (entry.status === "available") anyTenor = true;
    }
    if (anyTenor) eventsWithAnyReferenceIv += 1;

    for (const entry of rowsOf(event.reference_iv_percentile)) {
      const tenor = str(entry.nominal_tenor) as NominalTenor | null;
      if (!tenor || !(tenor in percentile)) continue;
      tally(percentile[tenor]!, entry.status, entry.unavailable_reason);
    }
    for (const entry of rowsOf(event.realized_volatility)) {
      const horizon = str(entry.horizon) as RvHorizon | null;
      if (!horizon || !(horizon in rv)) continue;
      tally(rv[horizon]!, entry.status, entry.unavailable_reason);
    }
    for (const entry of rowsOf(event.term_structure)) {
      const key = str(entry.slope) ?? "unknown";
      slopes[key] ??= emptyTally();
      tally(slopes[key]!, entry.status, entry.unavailable_reason);
    }
    const index = event.broad_volatility_index;
    if (index && typeof index === "object")
      tally(broad, (index as Row).status, (index as Row).unavailable_reason);
  }

  const structureReference = emptyTally(), legs = emptyTally();
  const legObservations: Record<string, number> = {};
  const differentials: Record<string, {available: number; total: number; reasons: Record<string, number>}> = {};

  for (const structure of structures) {
    const reference = structure.same_expiry_reference;
    if (reference && typeof reference === "object")
      tally(structureReference, (reference as Row).status, (reference as Row).unavailable_reason_code);
    for (const leg of rowsOf(structure.legs)) {
      tally(legs, leg.status, leg.unavailable_reason);
      const observation = str(leg.observation) ?? "unavailable";
      legObservations[observation] = (legObservations[observation] ?? 0) + 1;
    }
    for (const d of rowsOf(structure.differentials)) {
      const key = str(d.differential) ?? "unknown";
      differentials[key] ??= emptyTally();
      tally(differentials[key]!, d.status, d.unavailable_reason);
    }
  }

  const sealAll = <K extends string>(source: Record<string, {available: number; total: number; reasons: Record<string, number>}>) =>
    Object.fromEntries(Object.entries(source).map(([k, v]) => [k, seal(v)])) as Record<K, AvailabilityTally>;

  const coverage: VolatilityCoverage = {
    version: VOLATILITY_ANALYTICS_VERSION,
    eventCount: events.length,
    structureCount: structures.length,
    eventsWithAnyReferenceIv,
    referenceIvByTenor: sealAll<NominalTenor>(referenceIv),
    tenorToleranceByTenor: sealAll<NominalTenor>(tolerance),
    percentileByTenor: sealAll<NominalTenor>(percentile),
    realizedVolatilityByHorizon: sealAll<RvHorizon>(rv),
    termStructure: sealAll(slopes),
    broadVolatilityIndex: seal(broad),
    structureReference: seal(structureReference),
    legs: seal(legs),
    legObservations,
    differentials: sealAll(differentials),
    actualDteByTenor: {
      "7d": [...dte["7d"]].sort((a, b) => a - b),
      "14d": [...dte["14d"]].sort((a, b) => a - b),
      "30d": [...dte["30d"]].sort((a, b) => a - b),
    },
  };

  return {
    events, structures, coverage,
    hasMarketEvidence: eventsWithAnyReferenceIv > 0 || structureReference.available > 0 || legs.available > 0,
  };
}
