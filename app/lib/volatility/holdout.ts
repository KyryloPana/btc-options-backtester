/**
 * Hide-one-out validation cases for the next phase.
 *
 * No model is fitted here. This module only constructs the cases: it removes a
 * target contract (or a structure's legs) from a causal cross-section, keeps the
 * hidden truth in a SEPARATE object, and records the geometry that remains.
 *
 * The separation is the whole point. A holdout whose truth is still reachable
 * from the fitting inputs measures nothing, so `fitting_inputs` and `truth` are
 * distinct fields, `assertHoldoutIsClean` re-verifies the exclusion, and the
 * builders refuse to emit a case whose truth leaked. That check is cheap and it
 * fails loudly, which is what you want standing between a surface model and a
 * conclusion about whether it works.
 *
 * The cases are built BEFORE any model exists, so no threshold, envelope or
 * cohort in here can have been chosen after seeing a result.
 */

import type {CrossSectionObservation, ExpirySliceDiagnostics, LegEvidence, SurfaceSnapshot} from "./cross-section.ts";
import {
  classifyLeg, classifySurfaceReadiness, expirySliceDiagnostics,
  observationsFor, sliceFor, type ReadinessVerdict,
} from "./cross-section.ts";
import {contentHash} from "./reference-series.ts";

export const HOLDOUT_METHOD_VERSION = "iv-holdout-cases-v2-expiry-forward" as const;

export type HoldoutMode =
  | "exact_target_contract"
  | "structure_short_leg"
  | "structure_long_leg"
  | "structure_both_legs";

/** The hidden truth. Never present in `fitting_inputs`. */
export interface HoldoutTruth {
  readonly instrument_name: string;
  readonly trade_id: string | null;
  readonly strike: number;
  readonly option_type: "C" | "P";
  readonly expiry_timestamp_utc: string;
  readonly expiry_timestamp_ms: number;
  readonly observation_timestamp_utc: string;
  readonly observation_timestamp_ms: number;
  readonly age_minutes: number;
  readonly true_iv_decimal: number;
  readonly true_iv_api_percentage: number;
  readonly true_trade_price: number | null;
  readonly mark_price: number | null;
  readonly index_price: number;
  readonly underlying_price: number;
  readonly forward_price: number;
  readonly log_moneyness: number;
  readonly time_to_expiry_years: number;
  readonly total_implied_variance: number;
}

export interface HoldoutCase {
  readonly case_id: string;
  readonly method_version: string;
  readonly mode: HoldoutMode;
  readonly snapshot_id: string;
  readonly target_timestamp_utc: string;
  readonly target_timestamp_ms: number;
  readonly underlying_price: number;
  readonly expiry_timestamp_ms: number;
  readonly actual_dte_days: number;
  readonly event_id: string | null;
  readonly candidate_id: string | null;
  /** Everything a model may see. The held-out contract is absent by construction. */
  readonly fitting_inputs: readonly CrossSectionObservation[];
  /** Withheld. Scored against, never fitted on. */
  readonly truth: readonly HoldoutTruth[];
  readonly withheld_instruments: readonly string[];
  /** Geometry of what remains AFTER the holdout. */
  readonly remaining_slice: ExpirySliceDiagnostics | null;
  readonly remaining_leg_evidence: readonly LegEvidence[];
  readonly remaining_readiness: ReadinessVerdict;
  readonly content_hash: string;
}

const truthOf = (o: CrossSectionObservation): HoldoutTruth => ({
  instrument_name: o.instrument_name, trade_id: o.trade_id,
  strike: o.strike, option_type: o.option_type,
  expiry_timestamp_utc: o.expiry_timestamp_utc, expiry_timestamp_ms: o.expiry_timestamp_ms,
  observation_timestamp_utc: o.timestamp_utc, observation_timestamp_ms: o.timestamp_ms,
  age_minutes: o.age_minutes,
  true_iv_decimal: o.iv_decimal, true_iv_api_percentage: o.iv_api_percentage,
  true_trade_price: o.trade_price, mark_price: o.mark_price,
  forward_price: o.forward_price,
  index_price: o.index_price, underlying_price: o.underlying_price,
  log_moneyness: o.log_moneyness, time_to_expiry_years: o.time_to_expiry_years,
  total_implied_variance: o.total_implied_variance,
});

/**
 * Re-verify that no withheld instrument survives in the fitting inputs.
 *
 * This duplicates the filter that built the case on purpose. A holdout is the
 * one artifact where a silent leak invalidates every number computed from it
 * later, so it is checked rather than assumed.
 */
export function assertHoldoutIsClean(holdout: HoldoutCase): void {
  const withheld = new Set(holdout.withheld_instruments);
  const leaked = holdout.fitting_inputs.filter(o => withheld.has(o.instrument_name));
  if (leaked.length)
    throw new Error(
      `Holdout ${holdout.case_id} leaked ${leaked.length} observation(s) of withheld instrument(s) ` +
      `${[...new Set(leaked.map(o => o.instrument_name))].join(", ")} into its fitting inputs.`,
    );
  const truthIds = new Set(holdout.truth.map(t => t.trade_id).filter(Boolean));
  const leakedTrades = holdout.fitting_inputs.filter(o => o.trade_id !== null && truthIds.has(o.trade_id));
  if (leakedTrades.length)
    throw new Error(`Holdout ${holdout.case_id} leaked ${leakedTrades.length} truth trade id(s) into its fitting inputs.`);
}

export interface HoldoutRequest {
  readonly snapshot: SurfaceSnapshot;
  readonly expiryTimestampMs: number;
  readonly mode: HoldoutMode;
  /** Instruments to withhold. Every one is removed from the fitting inputs. */
  readonly withheldInstruments: readonly string[];
  /** Legs to re-classify against the REMAINING cross-section. */
  readonly legs: readonly {
    readonly leg: "short" | "long"; readonly strike: number;
    readonly optionType: string | null; readonly instrumentName: string | null;
  }[];
  readonly eventId?: string | null;
  readonly candidateId?: string | null;
}

/**
 * Build one holdout case, or null when no truth exists to hide.
 *
 * A "holdout" of a contract that never printed would have an empty truth set and
 * nothing to score, so it is not a case.
 */
export function buildHoldoutCase(request: HoldoutRequest): HoldoutCase | null {
  const withheld = new Set(request.withheldInstruments);
  const sameExpiry = observationsFor(request.snapshot, request.expiryTimestampMs);
  const hidden = sameExpiry.filter(o => withheld.has(o.instrument_name));
  if (!hidden.length) return null;

  // Every withheld instrument disappears from the WHOLE snapshot, not only from
  // its own expiry: a model given the same contract at another maturity could
  // recover the answer through the term structure.
  const fittingInputs = request.snapshot.observations.filter(o => !withheld.has(o.instrument_name));
  const remainingSameExpiry = fittingInputs.filter(o => o.expiry_timestamp_ms === request.expiryTimestampMs);
  const remainingSlice = remainingSameExpiry.length
    ? expirySliceDiagnostics(remainingSameExpiry, request.snapshot.underlying_price) : null;

  const legEvidence = request.legs.map(leg => classifyLeg({
    leg: leg.leg, strike: leg.strike, optionType: leg.optionType,
    instrumentName: leg.instrumentName, underlyingPrice: request.snapshot.underlying_price,
    slice: remainingSlice, observations: remainingSameExpiry,
  }));
  const adjacent = request.snapshot.slices
    .filter(s => s.expiry_timestamp_ms !== request.expiryTimestampMs);
  const readiness = classifySurfaceReadiness({
    slice: remainingSlice, legs: legEvidence, adjacentSlices: adjacent,
  });

  // Truth is sorted by its own content before hashing. The evidence a case
  // hides is a SET, and the shard cache stores observations in a different
  // order from the admission order they were first built in -- so an
  // order-sensitive identity would give the same case two different ids
  // depending on whether it came from memory or from disk, which is exactly
  // what makes a "frozen cohort" unverifiable.
  const truth = [...hidden].sort((a, b) =>
    a.timestamp_ms - b.timestamp_ms
    || (a.trade_id ?? "").localeCompare(b.trade_id ?? "")
    || a.iv_decimal - b.iv_decimal).map(truthOf);
  const hash = contentHash([
    request.snapshot.content_hash, request.mode, request.expiryTimestampMs,
    [...withheld].sort(),
    [...truth.map(t => [t.instrument_name, t.trade_id, t.true_iv_decimal] as const)]
      .map(tuple => JSON.stringify(tuple)).sort(),
  ]);
  const holdout: HoldoutCase = {
    case_id: `holdout~${request.mode}~${hash}`,
    method_version: HOLDOUT_METHOD_VERSION,
    mode: request.mode,
    snapshot_id: request.snapshot.snapshot_id,
    target_timestamp_utc: request.snapshot.target_timestamp_utc,
    target_timestamp_ms: request.snapshot.target_timestamp_ms,
    underlying_price: request.snapshot.underlying_price,
    expiry_timestamp_ms: request.expiryTimestampMs,
    actual_dte_days: hidden[0]!.actual_dte_days,
    event_id: request.eventId ?? null, candidate_id: request.candidateId ?? null,
    fitting_inputs: fittingInputs, truth,
    withheld_instruments: [...withheld].sort(),
    remaining_slice: remainingSlice, remaining_leg_evidence: legEvidence,
    remaining_readiness: readiness,
    content_hash: hash,
  };
  assertHoldoutIsClean(holdout);
  return holdout;
}

/**
 * Every single-contract holdout available in one expiry slice.
 *
 * Each observed instrument becomes its own case, which is what gives the next
 * phase coverage across moneyness and call/put rather than only at the strikes a
 * structure happened to select.
 */
export function buildSingleContractHoldouts(input: {
  readonly snapshot: SurfaceSnapshot;
  readonly expiryTimestampMs: number;
  readonly eventId?: string | null;
}): HoldoutCase[] {
  const instruments = [...new Set(observationsFor(input.snapshot, input.expiryTimestampMs)
    .map(o => o.instrument_name))].sort();
  const cases: HoldoutCase[] = [];
  for (const instrument of instruments) {
    const observation = observationsFor(input.snapshot, input.expiryTimestampMs)
      .find(o => o.instrument_name === instrument)!;
    const holdout = buildHoldoutCase({
      snapshot: input.snapshot, expiryTimestampMs: input.expiryTimestampMs,
      mode: "exact_target_contract", withheldInstruments: [instrument],
      legs: [{leg: "short", strike: observation.strike,
        optionType: observation.option_type, instrumentName: instrument}],
      eventId: input.eventId ?? null,
    });
    if (holdout) cases.push(holdout);
  }
  return cases;
}

/* ======================= vertical-spread holdouts ======================= */

export type PairedTruthClass =
  | "synchronous"
  | "asynchronous_within_window"
  | "single_leg_only";

/**
 * A paired holdout for a vertical.
 *
 * Individual-option error is not the quantity the strategy cares about: the
 * legs are traded together, so leg errors can cancel or amplify in the spread
 * credit. This carries both legs' truth plus their synchronization gap, so the
 * next phase can measure leg IV error, leg price error AND spread-credit error
 * and see which of those actually matters.
 *
 * No observed spread fill is invented. When the legs printed at different times
 * the gap is recorded and the pairing is classified as asynchronous; the truth
 * stays two separate prints.
 */
export interface SpreadHoldoutCase {
  readonly case_id: string;
  readonly method_version: string;
  readonly event_id: string | null;
  readonly candidate_id: string | null;
  readonly snapshot_id: string;
  readonly target_timestamp_utc: string;
  readonly expiry_timestamp_ms: number;
  readonly actual_dte_days: number;
  readonly option_type: string | null;
  readonly short_strike: number;
  readonly long_strike: number;
  readonly short_truth: HoldoutTruth | null;
  readonly long_truth: HoldoutTruth | null;
  readonly paired_truth_class: PairedTruthClass;
  readonly synchronization_gap_minutes: number | null;
  readonly max_observation_age_minutes: number | null;
  /**
   * Observed spread credit in BTC, per unit, from the two real prints. Null
   * unless BOTH legs printed -- a one-sided pair has no observed credit.
   */
  readonly observed_spread_credit_native: number | null;
  readonly holdout: HoldoutCase;
}

export interface SpreadHoldoutRequest {
  readonly snapshot: SurfaceSnapshot;
  readonly expiryTimestampMs: number;
  readonly eventId: string | null;
  readonly candidateId: string | null;
  readonly optionType: string | null;
  readonly shortStrike: number;
  readonly longStrike: number;
  readonly shortInstrument: string;
  readonly longInstrument: string;
  /** Both legs printing within this gap counts as synchronous. */
  readonly synchronousWithinMinutes?: number;
}

export const DEFAULT_SYNCHRONOUS_WINDOW_MINUTES = 5 as const;

export function buildSpreadHoldout(request: SpreadHoldoutRequest): SpreadHoldoutCase | null {
  const synchronousWithin = request.synchronousWithinMinutes ?? DEFAULT_SYNCHRONOUS_WINDOW_MINUTES;
  const sameExpiry = observationsFor(request.snapshot, request.expiryTimestampMs);
  const freshest = (instrument: string) => sameExpiry
    .filter(o => o.instrument_name === instrument)
    .sort((a, b) => a.age_minutes - b.age_minutes)[0] ?? null;

  const short = freshest(request.shortInstrument), long = freshest(request.longInstrument);
  if (!short && !long) return null;

  const holdout = buildHoldoutCase({
    snapshot: request.snapshot, expiryTimestampMs: request.expiryTimestampMs,
    mode: short && long ? "structure_both_legs" : short ? "structure_short_leg" : "structure_long_leg",
    withheldInstruments: [request.shortInstrument, request.longInstrument],
    legs: [
      {leg: "short", strike: request.shortStrike, optionType: request.optionType, instrumentName: request.shortInstrument},
      {leg: "long", strike: request.longStrike, optionType: request.optionType, instrumentName: request.longInstrument},
    ],
    eventId: request.eventId, candidateId: request.candidateId,
  });
  if (!holdout) return null;

  const gapMinutes = short && long
    ? Math.abs(short.timestamp_ms - long.timestamp_ms) / 60_000 : null;
  const pairedTruthClass: PairedTruthClass = !short || !long ? "single_leg_only"
    : gapMinutes !== null && gapMinutes <= synchronousWithin ? "synchronous"
      : "asynchronous_within_window";

  // Credit is short premium minus long premium, per unit, in BTC. Only stated
  // when both legs are real prints -- never synthesized from one side.
  const observedCredit = short?.trade_price != null && long?.trade_price != null
    ? short.trade_price - long.trade_price : null;

  return {
    case_id: `spread-holdout~${request.candidateId ?? "unpaired"}~${holdout.content_hash}`,
    method_version: HOLDOUT_METHOD_VERSION,
    event_id: request.eventId, candidate_id: request.candidateId,
    snapshot_id: request.snapshot.snapshot_id,
    target_timestamp_utc: request.snapshot.target_timestamp_utc,
    expiry_timestamp_ms: request.expiryTimestampMs,
    actual_dte_days: (short ?? long)!.actual_dte_days,
    option_type: request.optionType,
    short_strike: request.shortStrike, long_strike: request.longStrike,
    short_truth: short ? truthOf(short) : null,
    long_truth: long ? truthOf(long) : null,
    paired_truth_class: pairedTruthClass,
    synchronization_gap_minutes: gapMinutes,
    max_observation_age_minutes: short && long ? Math.max(short.age_minutes, long.age_minutes)
      : (short ?? long)!.age_minutes,
    observed_spread_credit_native: observedCredit,
    holdout,
  };
}

/**
 * Composition summary, so a later phase can state its sample without
 * recomputing it.
 *
 * TWO DENOMINATORS live here and they are not interchangeable, so every field
 * names the one it uses:
 *
 *   - a CASE is one withheld instrument at one snapshot. This is the frozen
 *     scoring cohort: every model comparison must divide by `total_cases`.
 *   - a TRUTH OBSERVATION is one individual withheld exchange print. A case
 *     hides every print of its instrument in the canonical window, which is
 *     4-5 prints on average and can be well over a hundred.
 *
 * Reporting a case-level count beside an observation-level one without saying
 * which is which produces two mutually inconsistent universes in the same
 * table, which is exactly what happened in the Phase 2A.3 report.
 */
export interface HoldoutComposition {
  /** Frozen scoring cohort. The denominator for every model comparison. */
  readonly total_cases: number;
  /** Individual withheld prints across all cases. NOT a scoring denominator. */
  readonly total_truth_observations: number;
  readonly truth_observations_per_case: {
    readonly min: number; readonly median: number;
    readonly mean: number; readonly max: number;
  };
  readonly cases_by_mode: Readonly<Record<string, number>>;
  readonly cases_by_readiness: Readonly<Record<string, number>>;
  readonly cases_by_option_type: Readonly<Record<string, number>>;
  readonly cases_by_dte_bucket: Readonly<Record<string, number>>;
  readonly cases_by_moneyness_bucket: Readonly<Record<string, number>>;
  readonly truth_observations_by_option_type: Readonly<Record<string, number>>;
  readonly truth_observations_by_moneyness_bucket: Readonly<Record<string, number>>;
  readonly distinct_events: number;
  readonly distinct_snapshots: number;
  /** Identity of the frozen cohort. Changes if the case set changes at all. */
  readonly cohort_content_hash: string;
}

/**
 * A case's own option type and moneyness bucket.
 *
 * Every truth in a case is the SAME instrument at the SAME snapshot, so strike,
 * option type and underlying are constant across it; the first truth defines
 * the case. A case with no truth cannot exist -- `buildHoldoutCase` returns null
 * rather than emitting one.
 */
export const caseOptionType = (holdout: HoldoutCase): string => holdout.truth[0]?.option_type ?? "unknown";
export const caseLogMoneyness = (holdout: HoldoutCase): number | null => holdout.truth[0]?.log_moneyness ?? null;

export const dteBucket = (days: number): string =>
  days < 3 ? "0-3d" : days < 7 ? "3-7d" : days < 14 ? "7-14d" : days < 30 ? "14-30d" : "30d+";

export const moneynessBucket = (logMoneyness: number): string => {
  const m = Math.abs(logMoneyness);
  const side = logMoneyness < 0 ? "below" : "above";
  return m <= 0.02 ? "atm" : m <= 0.05 ? `${side}_near` : m <= 0.12 ? `${side}_mid` : `${side}_far`;
};

export function summarizeHoldouts(cases: readonly HoldoutCase[]): HoldoutComposition {
  const count = (values: readonly string[]) => {
    const out: Record<string, number> = {};
    for (const v of values) out[v] = (out[v] ?? 0) + 1;
    return out;
  };
  const truths = cases.flatMap(c => c.truth);
  const perCase = cases.map(c => c.truth.length).sort((a, b) => a - b);
  const median = perCase.length
    ? perCase.length % 2 ? perCase[(perCase.length - 1) / 2]!
      : (perCase[perCase.length / 2 - 1]! + perCase[perCase.length / 2]!) / 2
    : 0;

  return {
    total_cases: cases.length,
    total_truth_observations: truths.length,
    truth_observations_per_case: {
      min: perCase.length ? perCase[0]! : 0,
      median,
      mean: perCase.length ? truths.length / perCase.length : 0,
      max: perCase.length ? perCase[perCase.length - 1]! : 0,
    },
    cases_by_mode: count(cases.map(c => c.mode)),
    cases_by_readiness: count(cases.map(c => c.remaining_readiness.readiness)),
    cases_by_option_type: count(cases.map(caseOptionType)),
    cases_by_dte_bucket: count(cases.map(c => dteBucket(c.actual_dte_days))),
    cases_by_moneyness_bucket: count(cases.map(c => {
      const k = caseLogMoneyness(c);
      return k === null ? "unknown" : moneynessBucket(k);
    })),
    truth_observations_by_option_type: count(truths.map(t => t.option_type)),
    truth_observations_by_moneyness_bucket: count(truths.map(t => moneynessBucket(t.log_moneyness))),
    distinct_events: new Set(cases.map(c => c.event_id).filter(Boolean)).size,
    distinct_snapshots: new Set(cases.map(c => c.snapshot_id)).size,
    // Order-independent, so the identity tracks the case SET rather than the
    // order a run happened to build it in.
    cohort_content_hash: contentHash([...cases.map(c => c.case_id)].sort()),
  };
}

export {sliceFor};
