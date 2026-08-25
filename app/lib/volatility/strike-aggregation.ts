/**
 * Strike-level aggregation of raw prints into smile points.
 *
 * Forty prints on one strike and two on another are not forty and two
 * independent observations of the smile — they are two strikes. Fitting the raw
 * tape would let one heavily-traded strike dominate the curve and drag the fit
 * toward whatever happened to be busy, which for a credit spread is usually the
 * round strike nobody in the structure holds.
 *
 * So: exactly ONE aggregated observation per `expiry × strike × option_type`,
 * carrying equal fitting weight regardless of how many prints produced it. The
 * underlying raw observations, the effective age, the count and the dispersion
 * are all preserved so nothing is hidden by the collapse.
 *
 * The rule below was fixed BEFORE any holdout error was inspected, and is not a
 * function of any strategy outcome.
 */

import type {CrossSectionObservation} from "./cross-section.ts";

export const STRIKE_AGGREGATION_METHOD_VERSION = "strike-aggregation-robust-freshness-v1" as const;

/**
 * Freshness half-life, in minutes. Half the canonical 60-minute window, so a
 * print at the edge of admissibility carries a quarter the weight of one at the
 * target. Chosen from the window definition, not tuned.
 */
export const FRESHNESS_HALF_LIFE_MINUTES = 30 as const;

/**
 * Robustness cut, in median absolute deviations. A print further than this from
 * the strike's median IV is treated as an outlier — a mispriced block, a
 * crossed trade — and excluded from the aggregate but still counted and
 * reported. Never applied when it would leave fewer than three prints, because
 * "robust" on two points is just "discard one".
 */
export const OUTLIER_MAD_MULTIPLE = 3 as const;
export const MINIMUM_PRINTS_FOR_OUTLIER_REJECTION = 3 as const;

export interface AggregatedStrikeObservation {
  readonly expiry_timestamp_ms: number;
  readonly strike: number;
  readonly option_type: "C" | "P";
  readonly log_moneyness: number;
  readonly time_to_expiry_years: number;
  /** Aggregated IV, decimal. */
  readonly iv_decimal: number;
  /** Aggregated total implied variance, w = IV^2 * T. */
  readonly total_implied_variance: number;
  /** Freshness-weighted mean observation time of the contributing prints. */
  readonly effective_timestamp_ms: number;
  readonly effective_age_minutes: number;
  readonly print_count: number;
  readonly outliers_excluded: number;
  /** Median absolute deviation of contributing IVs, decimal. 0 for a single print. */
  readonly iv_mad: number;
  readonly iv_min: number;
  readonly iv_max: number;
  readonly underlying_price: number;
  /** Equal by construction: one strike, one vote. */
  readonly fitting_weight: number;
  readonly method_version: string;
}

const median = (sorted: readonly number[]): number => {
  if (!sorted.length) return 0;
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Aggregate one strike's prints into a single smile point. */
export function aggregateStrike(
  prints: readonly CrossSectionObservation[],
): AggregatedStrikeObservation | null {
  if (!prints.length) return null;
  const first = prints[0]!;

  const ivs = [...prints.map(p => p.iv_decimal)].sort((a, b) => a - b);
  const centre = median(ivs);
  const deviations = [...ivs.map(v => Math.abs(v - centre))].sort((a, b) => a - b);
  const mad = median(deviations);

  // Outlier rejection only where it is meaningful, and never when the MAD is
  // zero (identical prints) since every deviation would then be "infinite".
  const usable = prints.length >= MINIMUM_PRINTS_FOR_OUTLIER_REJECTION && mad > 0
    ? prints.filter(p => Math.abs(p.iv_decimal - centre) <= OUTLIER_MAD_MULTIPLE * mad)
    : prints;
  const kept = usable.length ? usable : prints;

  let weightSum = 0, ivSum = 0, timeSum = 0;
  for (const p of kept) {
    const weight = Math.pow(0.5, Math.max(p.age_minutes, 0) / FRESHNESS_HALF_LIFE_MINUTES);
    weightSum += weight;
    ivSum += weight * p.iv_decimal;
    timeSum += weight * p.timestamp_ms;
  }
  // Degenerate weights (every print at the extreme edge) fall back to the
  // unweighted mean rather than dividing by zero.
  const iv = weightSum > 0 ? ivSum / weightSum : kept.reduce((s, p) => s + p.iv_decimal, 0) / kept.length;
  const effectiveMs = weightSum > 0 ? timeSum / weightSum
    : kept.reduce((s, p) => s + p.timestamp_ms, 0) / kept.length;

  const years = first.time_to_expiry_years;
  return {
    expiry_timestamp_ms: first.expiry_timestamp_ms,
    strike: first.strike, option_type: first.option_type,
    log_moneyness: first.log_moneyness, time_to_expiry_years: years,
    iv_decimal: iv, total_implied_variance: iv * iv * years,
    effective_timestamp_ms: effectiveMs,
    effective_age_minutes: (first.target_timestamp_ms - effectiveMs) / 60_000,
    print_count: prints.length, outliers_excluded: prints.length - kept.length,
    iv_mad: mad, iv_min: ivs[0]!, iv_max: ivs[ivs.length - 1]!,
    underlying_price: first.underlying_price,
    fitting_weight: 1,
    method_version: STRIKE_AGGREGATION_METHOD_VERSION,
  };
}

/** Aggregate a whole expiry slice into one smile point per strike and type. */
export function aggregateSlice(
  observations: readonly CrossSectionObservation[],
): AggregatedStrikeObservation[] {
  const groups = new Map<string, CrossSectionObservation[]>();
  for (const o of observations) {
    const key = `${o.expiry_timestamp_ms}~${o.strike}~${o.option_type}`;
    const list = groups.get(key);
    if (list) list.push(o); else groups.set(key, [o]);
  }
  return [...groups.values()]
    .map(aggregateStrike)
    .filter((x): x is AggregatedStrikeObservation => x !== null)
    .sort((a, b) => a.strike - b.strike || a.option_type.localeCompare(b.option_type));
}

/* ==================== call/put compatibility ==================== */

/**
 * Put-call parity under this project's convention (forward = index, rate = 0)
 * implies a call and a put on the same strike and expiry carry the SAME implied
 * volatility. So both are observations of one total-variance curve and are
 * fitted together.
 *
 * That is an assumption about the data, not a licence to ignore it, so matched
 * strikes are measured and reported. A large systematic call-put divergence
 * would be a finding — evidence of a forward or rate effect the convention
 * ignores — rather than something to average away.
 *
 * Calls and puts are never merged into one aggregated point: each keeps its own
 * `option_type`, count and dispersion. Only the fit sees them together.
 */
export interface CallPutCompatibility {
  readonly matched_strike_count: number;
  readonly mean_absolute_iv_difference: number | null;
  readonly median_absolute_iv_difference: number | null;
  readonly max_absolute_iv_difference: number | null;
  /** Signed mean of call IV minus put IV; a systematic offset would show here. */
  readonly mean_signed_iv_difference: number | null;
  readonly p90_absolute_iv_difference: number | null;
}

export function assessCallPutCompatibility(
  points: readonly AggregatedStrikeObservation[],
): CallPutCompatibility {
  const byStrike = new Map<number, {C?: AggregatedStrikeObservation; P?: AggregatedStrikeObservation}>();
  for (const p of points) {
    const entry = byStrike.get(p.strike) ?? {};
    entry[p.option_type] = p;
    byStrike.set(p.strike, entry);
  }
  const signed: number[] = [];
  for (const {C, P} of byStrike.values())
    if (C && P) signed.push(C.iv_decimal - P.iv_decimal);
  if (!signed.length) return {
    matched_strike_count: 0, mean_absolute_iv_difference: null,
    median_absolute_iv_difference: null, max_absolute_iv_difference: null,
    mean_signed_iv_difference: null, p90_absolute_iv_difference: null,
  };
  const absolute = [...signed.map(Math.abs)].sort((a, b) => a - b);
  return {
    matched_strike_count: signed.length,
    mean_absolute_iv_difference: absolute.reduce((a, b) => a + b, 0) / absolute.length,
    median_absolute_iv_difference: median(absolute),
    max_absolute_iv_difference: absolute[absolute.length - 1]!,
    mean_signed_iv_difference: signed.reduce((a, b) => a + b, 0) / signed.length,
    p90_absolute_iv_difference: absolute[Math.min(absolute.length - 1, Math.ceil(0.9 * absolute.length) - 1)]!,
  };
}
