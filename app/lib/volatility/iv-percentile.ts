/**
 * Causal expanding historical IV percentile.
 *
 * Locked by the Phase-2A methodology audit:
 *   - the reference distribution is the broad volatility_reference_series,
 *     NEVER the MR events alone. An event-only distribution would be a sample of
 *     event conditions, so every event would sit near its own median.
 *   - expanding, not a tuned rolling window: at target T every valid reference
 *     observation with `timestamp < T` participates, strictly.
 *   - below MINIMUM_PRIOR_OBSERVATIONS the percentile is unavailable rather than
 *     a confidently-stated number computed from too little history.
 *
 * No future observation can enter, by construction: the filter is strict `<`.
 */

export const IV_PERCENTILE_METHOD_VERSION = "expanding-causal-iv-percentile-v1" as const;

/**
 * Roughly 30 days of hourly reference observations. Below about a month the
 * prior set is dominated by a single volatility regime, so the percentile would
 * measure recency rather than history.
 */
export const MINIMUM_PRIOR_OBSERVATIONS = 720 as const;

export type PercentileUnavailableReason =
  | "insufficient_prior_history"
  | "no_prior_observations"
  | "subject_value_unavailable";

/** One point of the reference distribution. Only market-evidence rows belong here. */
export interface ReferenceObservation {
  readonly timestampMs: number;
  readonly ivDecimal: number;
}

export interface IvPercentileResult {
  readonly status: "available" | "unavailable";
  /** Empirical percentile in [0, 1]. */
  readonly percentile: number | null;
  readonly subjectIvDecimal: number | null;
  readonly priorObservationCount: number;
  readonly minimumPriorObservations: number;
  readonly historyStartMs: number | null;
  readonly historyEndMs: number | null;
  readonly referenceSeriesId: string;
  readonly referenceSeriesContentHash: string;
  readonly methodVersion: string;
  readonly unavailableReason: PercentileUnavailableReason | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Empirical percentile of `value` within `sorted`, by the midpoint convention:
 * ties contribute half their weight, so an exact duplicate of every prior
 * observation returns 0.5 rather than 0 or 1.
 */
export function empiricalPercentile(sorted: readonly number[], value: number): number {
  if (!sorted.length) return 0;
  let below = 0, equal = 0;
  for (const x of sorted) {
    if (x < value) below += 1;
    else if (x === value) equal += 1;
  }
  return (below + equal / 2) / sorted.length;
}

/**
 * Percentile of the subject IV against every reference observation strictly
 * before the target timestamp.
 */
export function causalIvPercentile(input: {
  readonly subjectIvDecimal: number | null;
  readonly targetTimestampMs: number;
  readonly history: readonly ReferenceObservation[];
  readonly referenceSeriesId: string;
  readonly referenceSeriesContentHash: string;
  readonly minimumPriorObservations?: number;
}): IvPercentileResult {
  const minimum = input.minimumPriorObservations ?? MINIMUM_PRIOR_OBSERVATIONS;
  const base = {
    minimumPriorObservations: minimum,
    referenceSeriesId: input.referenceSeriesId,
    referenceSeriesContentHash: input.referenceSeriesContentHash,
    methodVersion: IV_PERCENTILE_METHOD_VERSION,
  } as const;

  // STRICTLY before the target. This is the whole causality guarantee.
  const prior = input.history
    .filter(o => finite(o.timestampMs) && finite(o.ivDecimal) && o.ivDecimal > 0)
    .filter(o => o.timestampMs < input.targetTimestampMs);
  const timestamps = prior.map(o => o.timestampMs);
  const historyStartMs = timestamps.length ? Math.min(...timestamps) : null;
  const historyEndMs = timestamps.length ? Math.max(...timestamps) : null;

  if (!finite(input.subjectIvDecimal) || input.subjectIvDecimal <= 0)
    return {...base, status: "unavailable", percentile: null, subjectIvDecimal: null,
      priorObservationCount: prior.length, historyStartMs, historyEndMs,
      unavailableReason: "subject_value_unavailable"};
  if (!prior.length)
    return {...base, status: "unavailable", percentile: null, subjectIvDecimal: input.subjectIvDecimal,
      priorObservationCount: 0, historyStartMs, historyEndMs,
      unavailableReason: "no_prior_observations"};
  if (prior.length < minimum)
    return {...base, status: "unavailable", percentile: null, subjectIvDecimal: input.subjectIvDecimal,
      priorObservationCount: prior.length, historyStartMs, historyEndMs,
      unavailableReason: "insufficient_prior_history"};

  const sorted = prior.map(o => o.ivDecimal).sort((a, b) => a - b);
  return {...base, status: "available",
    percentile: empiricalPercentile(sorted, input.subjectIvDecimal),
    subjectIvDecimal: input.subjectIvDecimal,
    priorObservationCount: prior.length, historyStartMs, historyEndMs,
    unavailableReason: null};
}
