/**
 * Scoring for surface-reconstruction model validation.
 *
 * Two things this module is careful about, because both are easy ways to reach
 * a wrong conclusion:
 *
 * 1. **Availability is part of the result.** A model that only answers on easy
 *    cases will look accurate. So every comparison reports the eligible count,
 *    the unavailable count and the frozen cohort size, and a case a model
 *    cannot serve is never quietly dropped from the other models' denominators.
 *
 * 2. **Correlated holdouts are not independent observations.** Thousands of
 *    cases come from a handful of events, timestamps and smiles. Presenting a
 *    tiny standard error from them would be pseudo-replication, so every
 *    summary is reported BOTH observation-weighted and grouped — aggregated
 *    first within `event x target timestamp x expiry`, then across groups —
 *    plus an event-level view and leave-one-event-out.
 *
 * These holdouts validate a PRICING model. They do not create independent
 * strategy observations, and nothing here should be read as if they did.
 */

export const MODEL_SCORING_VERSION = "surface-model-scoring-v1" as const;

export interface ErrorSummary {
  readonly count: number;
  readonly mean_signed: number | null;
  readonly mae: number | null;
  readonly median_absolute: number | null;
  readonly rmse: number | null;
  readonly p90_absolute: number | null;
  readonly p95_absolute: number | null;
  readonly worst_absolute: number | null;
}

const EMPTY: ErrorSummary = {
  count: 0, mean_signed: null, mae: null, median_absolute: null,
  rmse: null, p90_absolute: null, p95_absolute: null, worst_absolute: null,
};

const quantile = (sorted: readonly number[], q: number): number | null => {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
};

const median = (sorted: readonly number[]): number | null => {
  if (!sorted.length) return null;
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Summarize signed errors. Absolute-error statistics are derived, never assumed. */
export function summarizeErrors(signedErrors: readonly number[]): ErrorSummary {
  const finite = signedErrors.filter(Number.isFinite);
  if (!finite.length) return EMPTY;
  const absolute = [...finite.map(Math.abs)].sort((a, b) => a - b);
  return {
    count: finite.length,
    mean_signed: finite.reduce((a, b) => a + b, 0) / finite.length,
    mae: absolute.reduce((a, b) => a + b, 0) / absolute.length,
    median_absolute: median(absolute),
    rmse: Math.sqrt(finite.reduce((s, e) => s + e * e, 0) / finite.length),
    p90_absolute: quantile(absolute, 0.90),
    p95_absolute: quantile(absolute, 0.95),
    worst_absolute: absolute[absolute.length - 1]!,
  };
}

/** One scored case for one model. */
export interface ScoredCase {
  readonly case_id: string;
  readonly method_version: string;
  readonly event_id: string | null;
  readonly snapshot_id: string;
  readonly target_timestamp_ms: number;
  readonly expiry_timestamp_ms: number;
  readonly actual_dte_days: number;
  readonly option_type: string;
  readonly log_moneyness: number;
  readonly readiness: string;
  readonly same_expiry_strike_count: number;
  readonly truth_age_minutes: number;
  readonly hours_since_entry: number | null;
  readonly role: string;
  readonly status: "available" | "unavailable";
  readonly unavailable_reason: string | null;
  readonly is_extrapolation: boolean;
  /** Signed IV error in VOL POINTS (percentage points), estimate minus truth. */
  readonly iv_error_vol_points: number | null;
  /** Signed price error in BTC per contract, estimate minus truth. */
  readonly price_error_btc: number | null;
  readonly price_error_usd: number | null;
  /** Relative price error; null when the truth price is too small to be meaningful. */
  readonly relative_price_error: number | null;
  readonly truth_iv_decimal: number;
  readonly truth_price_btc: number | null;
  readonly estimate_iv_decimal: number | null;
  readonly estimate_price_btc: number | null;
}

/**
 * Relative price error is meaningless on a deep-OTM option worth 0.0001 BTC: a
 * one-tick miss reads as 100%. Below this the relative figure is withheld and
 * only the absolute error is reported.
 */
export const MINIMUM_PRICE_FOR_RELATIVE_ERROR_BTC = 0.0005;

export interface MethodResult {
  readonly method_version: string;
  /** Frozen cohort size. Every method divides by the same number. */
  readonly total_cohort: number;
  /** Cases where the model produced an estimate. */
  readonly eligible: number;
  /** Cases where the model was structurally unable to answer. */
  readonly unavailable: number;
  readonly availability: number;
  readonly unavailable_reasons: Readonly<Record<string, number>>;
  readonly iv_vol_points: ErrorSummary;
  readonly price_btc: ErrorSummary;
  readonly relative_price: ErrorSummary;
  /** Grouped by event x timestamp x expiry, then summarized across groups. */
  readonly grouped_iv_vol_points: ErrorSummary;
  readonly grouped_price_btc: ErrorSummary;
  readonly group_count: number;
}

const groupKey = (c: ScoredCase) => `${c.event_id}~${c.target_timestamp_ms}~${c.expiry_timestamp_ms}`;

/**
 * Aggregate scored cases into one method result.
 *
 * `totalCohort` is passed in rather than derived, so availability is measured
 * against the frozen cohort and not against whatever subset the model happened
 * to answer on.
 */
export function summarizeMethod(cases: readonly ScoredCase[], totalCohort: number): MethodResult {
  const available = cases.filter(c => c.status === "available");
  const reasons: Record<string, number> = {};
  for (const c of cases) if (c.status !== "available")
    reasons[c.unavailable_reason ?? "unspecified"] = (reasons[c.unavailable_reason ?? "unspecified"] ?? 0) + 1;

  // Grouped: mean absolute error within each smile first, so a snapshot with
  // 60 holdouts does not outvote one with 5.
  const groups = new Map<string, ScoredCase[]>();
  for (const c of available) {
    const list = groups.get(groupKey(c));
    if (list) list.push(c); else groups.set(groupKey(c), [c]);
  }
  const groupedIv: number[] = [], groupedPrice: number[] = [];
  for (const group of groups.values()) {
    const ivs = group.map(c => c.iv_error_vol_points).filter((x): x is number => x !== null);
    const prices = group.map(c => c.price_error_btc).filter((x): x is number => x !== null);
    if (ivs.length) groupedIv.push(ivs.reduce((a, b) => a + b, 0) / ivs.length);
    if (prices.length) groupedPrice.push(prices.reduce((a, b) => a + b, 0) / prices.length);
  }

  return {
    method_version: cases[0]?.method_version ?? "unknown",
    total_cohort: totalCohort,
    eligible: available.length,
    unavailable: cases.length - available.length,
    availability: totalCohort ? available.length / totalCohort : 0,
    unavailable_reasons: reasons,
    iv_vol_points: summarizeErrors(available.map(c => c.iv_error_vol_points).filter((x): x is number => x !== null)),
    price_btc: summarizeErrors(available.map(c => c.price_error_btc).filter((x): x is number => x !== null)),
    relative_price: summarizeErrors(available.map(c => c.relative_price_error).filter((x): x is number => x !== null)),
    grouped_iv_vol_points: summarizeErrors(groupedIv),
    grouped_price_btc: summarizeErrors(groupedPrice),
    group_count: groups.size,
  };
}

/** Split scored cases by a named dimension and summarize each bucket. */
export function summarizeBy(
  cases: readonly ScoredCase[], bucket: (c: ScoredCase) => string,
): Record<string, MethodResult> {
  const groups = new Map<string, ScoredCase[]>();
  for (const c of cases) {
    const key = bucket(c);
    const list = groups.get(key);
    if (list) list.push(c); else groups.set(key, [c]);
  }
  return Object.fromEntries([...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    // Each bucket's own size is its cohort, so availability stays interpretable
    // within the bucket.
    .map(([key, group]) => [key, summarizeMethod(group, group.length)]));
}

/**
 * Leave-one-event-out ranking.
 *
 * With five events carrying thousands of correlated holdouts, a single event
 * can produce an apparent winner. Dropping each event in turn and re-ranking
 * shows whether the ordering survives, which is the only stability claim this
 * sample can support.
 */
export interface LeaveOneEventOut {
  readonly excluded_event: string;
  readonly remaining_cases: number;
  readonly ranking: readonly {method_version: string; mae: number | null; eligible: number}[];
}

export function leaveOneEventOut(
  byMethod: Readonly<Record<string, readonly ScoredCase[]>>,
  metric: (c: ScoredCase) => number | null = c => c.iv_error_vol_points,
): LeaveOneEventOut[] {
  const events = [...new Set(Object.values(byMethod).flat().map(c => c.event_id).filter((x): x is string => Boolean(x)))].sort();
  return events.map(excluded => {
    const ranking = Object.entries(byMethod).map(([method, cases]) => {
      const kept = cases.filter(c => c.event_id !== excluded && c.status === "available");
      const errors = kept.map(metric).filter((x): x is number => x !== null);
      return {method_version: method, mae: summarizeErrors(errors).mae, eligible: kept.length};
    }).sort((a, b) => (a.mae ?? Infinity) - (b.mae ?? Infinity));
    return {
      excluded_event: excluded,
      remaining_cases: Object.values(byMethod).flat().filter(c => c.event_id !== excluded).length,
      ranking,
    };
  });
}

/* ==================== vertical-spread scoring ==================== */

export interface ScoredSpread {
  readonly case_id: string;
  readonly method_version: string;
  readonly event_id: string | null;
  readonly candidate_id: string | null;
  readonly snapshot_id: string;
  readonly target_timestamp_ms: number;
  readonly actual_dte_days: number;
  readonly paired_truth_class: string;
  readonly synchronization_gap_minutes: number | null;
  readonly status: "available" | "unavailable";
  readonly unavailable_reason: string | null;
  readonly observed_credit_btc: number | null;
  readonly estimated_credit_btc: number | null;
  /** Estimated minus observed, BTC per contract. */
  readonly credit_error_btc: number | null;
  readonly relative_credit_error: number | null;
  /** True when the sign of the credit flips between estimate and truth. */
  readonly credit_sign_flip: boolean;
}

export interface SpreadResult {
  readonly method_version: string;
  readonly total_cohort: number;
  readonly eligible: number;
  readonly unavailable: number;
  readonly availability: number;
  readonly unavailable_reasons: Readonly<Record<string, number>>;
  readonly credit_btc: ErrorSummary;
  readonly relative_credit: ErrorSummary;
  readonly sign_flips: number;
  readonly sign_flip_rate: number | null;
}

export function summarizeSpreads(cases: readonly ScoredSpread[], totalCohort: number): SpreadResult {
  const available = cases.filter(c => c.status === "available");
  const reasons: Record<string, number> = {};
  for (const c of cases) if (c.status !== "available")
    reasons[c.unavailable_reason ?? "unspecified"] = (reasons[c.unavailable_reason ?? "unspecified"] ?? 0) + 1;
  const flips = available.filter(c => c.credit_sign_flip).length;
  return {
    method_version: cases[0]?.method_version ?? "unknown",
    total_cohort: totalCohort,
    eligible: available.length,
    unavailable: cases.length - available.length,
    availability: totalCohort ? available.length / totalCohort : 0,
    unavailable_reasons: reasons,
    credit_btc: summarizeErrors(available.map(c => c.credit_error_btc).filter((x): x is number => x !== null)),
    relative_credit: summarizeErrors(available.map(c => c.relative_credit_error).filter((x): x is number => x !== null)),
    sign_flips: flips,
    sign_flip_rate: available.length ? flips / available.length : null,
  };
}

/* ==================== bucket helpers ==================== */

export const dteBucketOf = (days: number): string =>
  days < 1 ? "0-1d" : days < 3 ? "1-3d" : days < 7 ? "3-7d" : days < 14 ? "7-14d" : days < 30 ? "14-30d" : "30d+";

export const moneynessBucketOf = (k: number): string => {
  const m = Math.abs(k);
  const side = k < 0 ? "below" : "above";
  return m <= 0.02 ? "atm" : m <= 0.05 ? `${side}_near` : m <= 0.12 ? `${side}_mid` : `${side}_far`;
};

export const ageBucketOf = (minutes: number): string =>
  minutes <= 5 ? "0-5m" : minutes <= 15 ? "5-15m" : minutes <= 30 ? "15-30m" : "30-60m";

export const timeSinceEntryBucketOf = (hours: number | null): string =>
  hours === null ? "unknown" : hours === 0 ? "entry" : hours < 24 ? "<24h"
    : hours < 72 ? "1-3d" : hours < 168 ? "3-7d" : hours < 336 ? "7-14d" : "14d+";
