/**
 * Production Reference fair value: the validated hybrid estimator.
 *
 * Phase 2B and 2C scored four candidates on 3,475 frozen holdouts. Constrained
 * SVI and SSVI were rejected. What won was the plain one:
 *
 *   Tier 1  same-expiry bracketed linear interpolation in total variance,
 *           under Rule C -- target genuinely bracketed, at least five unique
 *           qualifying strikes, canonical evidence no older than 60 minutes,
 *           and never any extrapolation.
 *   Tier 2  the existing local exact-contract IV anchor, unchanged, including
 *           its 720-minute window.
 *   Tier 3  unavailable, with a reason.
 *
 * Settlement is separate and exact; it needs no IV at all.
 *
 * This module deliberately reuses the Phase 2A.3 admission gate and the Phase 2B
 * estimator rather than re-deriving either. A second definition of "a causal
 * market-IV observation" living in production would be free to drift from the
 * one the validation was run against, and the promotion evidence would quietly
 * stop applying to the code actually pricing the book.
 *
 * No SVI. No SSVI. No wing extrapolation. No cross-expiry pricing. A strike
 * outside the observed range declines to Tier 2 and, failing that, to
 * unavailable -- Phase 2C measured that the local anchor is the better estimator
 * there, so declining is the validated behaviour rather than a shortfall.
 */

import type {ContractSeries, ContractTrade} from "../backtester.ts";
import {MARKET_IV_MAX_AGE_MINUTES} from "./market-iv-evidence.ts";
import {admitCrossSection, type RawOptionPrint} from "./cross-section.ts";
import {aggregateSlice, type AggregatedStrikeObservation} from "./strike-aggregation.ts";
import {
  LINEAR_INTERPOLATION_METHOD_VERSION, LOCAL_IV_ANCHOR_METHOD_VERSION,
  estimateLinearInterpolation, type EstimationTarget,
} from "./surface-models.ts";

/**
 * Reference valuation methodology identity.
 *
 * `causal-reference-v1` must keep meaning what it meant: the pure local-anchor
 * estimator. Reusing it for different economics would make every historical
 * bundle silently claim to have been priced this way.
 */
export const REFERENCE_VALUATION_METHOD_VERSION = "causal-reference-v2-hybrid-interpolation" as const;
export const LEGACY_REFERENCE_VALUATION_METHOD_VERSION = "causal-reference-v1" as const;

/** Rule C, as validated in Phase 2C. Not a tuned number: a validated one. */
export const RULE_C_MINIMUM_UNIQUE_STRIKES = 5 as const;
export const REFERENCE_GEOMETRY_RULE = "rule_c_bracketed_min_5_unique_strikes" as const;

export type ReferenceValuationSource =
  | "same_expiry_linear_interpolation"
  | "local_iv_anchor"
  | "unavailable";

export type ReferenceDeclineReason =
  | "no_qualifying_same_expiry_observations"
  | "target_not_bracketed"
  | "unique_strike_count_below_minimum"
  | "interpolation_returned_no_value"
  | "cross_section_unavailable";

export type ReferenceUnavailableReason =
  | "no_causal_anchor"
  | "no_market_evidence"
  | "surface_not_identifiable_final_day";

/** Everything needed to audit one leg's Reference mark after the fact. */
export interface ReferenceLegValuation {
  readonly source: ReferenceValuationSource;
  readonly method_version: string;
  readonly geometry_rule: string;
  readonly iv_decimal: number | null;
  readonly instrument_name: string;
  readonly strike: number;
  readonly option_type: "C" | "P";
  readonly target_timestamp_utc: string;
  readonly expiry_timestamp_utc: string;
  readonly underlying_price: number;
  /* interpolation provenance */
  readonly lower_strike: number | null;
  readonly upper_strike: number | null;
  readonly lower_iv_decimal: number | null;
  readonly upper_iv_decimal: number | null;
  readonly lower_observation_age_minutes: number | null;
  readonly upper_observation_age_minutes: number | null;
  readonly unique_qualifying_strike_count: number;
  readonly qualifying_observation_count: number;
  readonly max_evidence_age_minutes: number;
  /* fallback provenance */
  readonly interpolation_declined_reason: ReferenceDeclineReason | null;
  readonly anchor_instrument_name: string | null;
  readonly anchor_timestamp_utc: string | null;
  readonly anchor_age_minutes: number | null;
  /* unavailable provenance */
  readonly unavailable_reason: ReferenceUnavailableReason | null;
  /**
   * Effective evidence time behind this mark. Interpolation carries the freshest
   * contributing observation; an anchor carries its own print. Spread coherence
   * is judged on this, so the two tiers stay comparable.
   */
  readonly effective_evidence_timestamp_ms: number | null;
}

const iso = (ms: number | null): string | null =>
  ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();

/**
 * Adapt the production tape to the admission gate.
 *
 * `creationTimestamp` travels through so the listing gate applies here exactly
 * as it does in the research pipeline: a contract that did not exist at the
 * target is not evidence for it.
 */
const toPrint = (series: ContractSeries, trade: ContractTrade): RawOptionPrint => ({
  instrumentName: series.instrumentName,
  tradeId: trade.tradeId ?? null,
  tradeSeq: trade.tradeSeq === undefined ? null : Number(trade.tradeSeq),
  strike: series.strike,
  optionType: series.optionType === "C" ? "C" : "P",
  expiryTimestampMs: series.expiryTimestamp,
  settlementPeriod: null,
  contractCreatedAtMs: series.creationTimestamp ?? null,
  timestampMs: trade.timestamp,
  ivApiPercent: trade.ivApiPercent ?? (trade.ivDecimal === undefined ? null : trade.ivDecimal * 100),
  ivDecimal: trade.ivDecimal ?? null,
  indexPrice: trade.indexPrice,
  price: trade.price,
  markPrice: trade.markPrice ?? null,
  amount: trade.amount,
  direction: trade.direction,
});

export interface ReferenceCrossSection {
  readonly points: readonly AggregatedStrikeObservation[];
  readonly uniqueStrikeCount: number;
  readonly observationCount: number;
  readonly maxAgeMinutes: number;
  readonly underlyingPrice: number;
}

/**
 * Build the same-expiry smile at one target from the retrieved ladder.
 *
 * `excludeInstruments` exists for the self-reference rule: when a leg is being
 * valued, its own prints must not be among the observations used to value it,
 * or the estimate is partly a restatement of the answer.
 */
export function buildReferenceCrossSection(input: {
  readonly sameExpirySeries: readonly ContractSeries[];
  readonly expiryTimestampMs: number;
  readonly targetTimestampMs: number;
  readonly underlyingPrice: number;
  readonly excludeInstruments?: readonly string[];
  readonly maxAgeMinutes?: number;
}): ReferenceCrossSection {
  const maxAge = input.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES;
  const prints: RawOptionPrint[] = [];
  for (const series of input.sameExpirySeries) {
    if (series.expiryTimestamp !== input.expiryTimestampMs) continue;
    for (const trade of series.trades) prints.push(toPrint(series, trade));
  }
  // Admission is the Phase 2A.1 gate, unchanged: no model IV, no future print,
  // no contract used before it was listed, deterministic deduplication.
  const admitted = admitCrossSection({
    prints, targetTimestampMs: input.targetTimestampMs,
    underlyingPrice: input.underlyingPrice, sourceHost: "production-retrieval",
    maxAgeMinutes: maxAge, excludedInstruments: input.excludeInstruments,
  });
  const points = aggregateSlice(admitted.observations);
  return {
    points,
    uniqueStrikeCount: new Set(points.map(p => p.strike)).size,
    observationCount: admitted.observations.length,
    maxAgeMinutes: maxAge,
    underlyingPrice: input.underlyingPrice,
  };
}

export interface ReferenceLegInput {
  readonly leg: ContractSeries;
  readonly targetTimestampMs: number;
  readonly underlyingPrice: number;
  readonly crossSection: ReferenceCrossSection | null;
  /** Latest causal same-contract print within the 720-minute window, if any. */
  readonly anchor: ContractTrade | undefined;
  readonly minimumUniqueStrikes?: number;
}

/**
 * Value one leg through the validated hierarchy.
 *
 * The tier order is the methodology. Interpolation is tried first because it
 * won the holdout comparison; the anchor is tried second because Phase 2C
 * measured it as the better estimator exactly where interpolation declines.
 */
export function valueReferenceLeg(input: ReferenceLegInput): ReferenceLegValuation {
  const minimumStrikes = input.minimumUniqueStrikes ?? RULE_C_MINIMUM_UNIQUE_STRIKES;
  const leg = input.leg;
  const optionType: "C" | "P" = leg.optionType === "C" ? "C" : "P";
  const base = {
    method_version: REFERENCE_VALUATION_METHOD_VERSION,
    geometry_rule: REFERENCE_GEOMETRY_RULE,
    instrument_name: leg.instrumentName, strike: leg.strike, option_type: optionType,
    target_timestamp_utc: new Date(input.targetTimestampMs).toISOString(),
    expiry_timestamp_utc: new Date(leg.expiryTimestamp).toISOString(),
    underlying_price: input.underlyingPrice,
    max_evidence_age_minutes: input.crossSection?.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES,
    unique_qualifying_strike_count: input.crossSection?.uniqueStrikeCount ?? 0,
    qualifying_observation_count: input.crossSection?.observationCount ?? 0,
  } as const;

  const target: EstimationTarget = {
    strike: leg.strike, optionType,
    logMoneyness: Math.log(leg.strike / input.underlyingPrice),
    timeToExpiryYears: (leg.expiryTimestamp - input.targetTimestampMs) / (365 * 24 * 3_600_000),
    underlyingPrice: input.underlyingPrice,
    targetTimestampMs: input.targetTimestampMs,
    expiryTimestampMs: leg.expiryTimestamp,
  };

  /* ---- Tier 1: bracketed same-expiry interpolation, Rule C ---- */

  let decline: ReferenceDeclineReason | null = null;
  const points = input.crossSection?.points ?? [];
  if (!input.crossSection) decline = "cross_section_unavailable";
  else if (!points.length) decline = "no_qualifying_same_expiry_observations";
  else if (input.crossSection.uniqueStrikeCount < minimumStrikes) decline = "unique_strike_count_below_minimum";
  else {
    const estimate = estimateLinearInterpolation(points, target);
    if (estimate.status === "available" && estimate.iv_decimal !== null) {
      const below = [...points].filter(p => p.log_moneyness < target.logMoneyness)
        .sort((a, b) => a.log_moneyness - b.log_moneyness).at(-1) ?? null;
      const above = [...points].filter(p => p.log_moneyness > target.logMoneyness)
        .sort((a, b) => a.log_moneyness - b.log_moneyness)[0] ?? null;
      const exact = points.filter(p => p.log_moneyness === target.logMoneyness);
      const contributors = exact.length ? exact : [below, above].filter((x): x is AggregatedStrikeObservation => x !== null);
      const freshest = contributors.length
        ? Math.max(...contributors.map(p => p.effective_timestamp_ms)) : null;
      return {
        ...base, source: "same_expiry_linear_interpolation",
        method_version: `${REFERENCE_VALUATION_METHOD_VERSION}/${LINEAR_INTERPOLATION_METHOD_VERSION}`,
        iv_decimal: estimate.iv_decimal,
        lower_strike: below?.strike ?? null, upper_strike: above?.strike ?? null,
        lower_iv_decimal: below?.iv_decimal ?? null, upper_iv_decimal: above?.iv_decimal ?? null,
        lower_observation_age_minutes: below?.effective_age_minutes ?? null,
        upper_observation_age_minutes: above?.effective_age_minutes ?? null,
        interpolation_declined_reason: null,
        anchor_instrument_name: null, anchor_timestamp_utc: null, anchor_age_minutes: null,
        unavailable_reason: null,
        effective_evidence_timestamp_ms: freshest,
      };
    }
    // The estimator refuses to extrapolate; that refusal is the validated
    // behaviour and is recorded as such rather than as a failure.
    decline = estimate.unavailable_reason === "target_outside_observed_strike_range"
      ? "target_not_bracketed"
      : estimate.unavailable_reason === "insufficient_observations"
        ? "unique_strike_count_below_minimum" : "interpolation_returned_no_value";
  }

  /* ---- Tier 2: existing local exact-contract anchor, unchanged ---- */

  const anchor = input.anchor;
  if (anchor?.ivDecimal !== undefined && anchor.ivDecimal > 0 && anchor.timestamp <= input.targetTimestampMs)
    return {
      ...base, source: "local_iv_anchor",
      method_version: `${REFERENCE_VALUATION_METHOD_VERSION}/${LOCAL_IV_ANCHOR_METHOD_VERSION}`,
      iv_decimal: anchor.ivDecimal,
      lower_strike: null, upper_strike: null, lower_iv_decimal: null, upper_iv_decimal: null,
      lower_observation_age_minutes: null, upper_observation_age_minutes: null,
      interpolation_declined_reason: decline,
      anchor_instrument_name: anchor.instrumentName,
      anchor_timestamp_utc: iso(anchor.timestamp),
      anchor_age_minutes: (input.targetTimestampMs - anchor.timestamp) / 60_000,
      unavailable_reason: null,
      effective_evidence_timestamp_ms: anchor.timestamp,
    };

  /* ---- Tier 3: unavailable ---- */

  // The final-day rule is not a blanket refusal below one day to expiry: a leg
  // with genuine bracketed or exact evidence is priced by the tiers above. It
  // only names the case where neither tier could be supported that close in.
  const finalDay = (leg.expiryTimestamp - input.targetTimestampMs) < 86_400_000;
  return {
    ...base, source: "unavailable",
    iv_decimal: null,
    lower_strike: null, upper_strike: null, lower_iv_decimal: null, upper_iv_decimal: null,
    lower_observation_age_minutes: null, upper_observation_age_minutes: null,
    interpolation_declined_reason: decline,
    anchor_instrument_name: null, anchor_timestamp_utc: null, anchor_age_minutes: null,
    unavailable_reason: finalDay ? "surface_not_identifiable_final_day"
      : decline === "cross_section_unavailable" || decline === "no_qualifying_same_expiry_observations"
        ? "no_market_evidence" : "no_causal_anchor",
    effective_evidence_timestamp_ms: null,
  };
}

/**
 * Leg coherence for a spread mark.
 *
 * The existing engine required the two legs' causal anchors to be synchronized
 * within an hour, because a spread valued from a short leg marked at 10:00 and a
 * long leg marked at 14:00 is not a spread value. That requirement is preserved
 * and generalized: it now applies to whichever evidence each tier actually used,
 * so mixing an interpolated leg with a twelve-hour-old anchor cannot slip past a
 * rule that used to catch two twelve-hour-old anchors.
 */
export function referenceLegsAreSynchronized(
  short: ReferenceLegValuation, long: ReferenceLegValuation, maxGapMs: number,
): {synchronized: boolean; gapMinutes: number | null} {
  const a = short.effective_evidence_timestamp_ms, b = long.effective_evidence_timestamp_ms;
  if (a === null || b === null) return {synchronized: false, gapMinutes: null};
  const gap = Math.abs(a - b);
  return {synchronized: gap <= maxGapMs, gapMinutes: gap / 60_000};
}
