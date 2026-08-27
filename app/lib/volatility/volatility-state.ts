/**
 * The two canonical bundle volatility tables: `event_volatility_state` (one row
 * per event entry) and `structure_volatility_state` (one row per candidate).
 *
 * Both are PURE. Retrieval, caching and network access happen upstream; these
 * builders take already-resolved reference rows, realized-volatility results and
 * per-leg volatility snapshots and assemble the canonical row. That is what lets
 * the bundle stay synchronous and reproducible: the row embeds the values that
 * were actually used, plus the series identity that produced them.
 *
 * Two rules run through everything here:
 *   - a missing metric is `null` with a reason, never `0` and never carried
 *     forward from a neighbouring tenor or horizon;
 *   - a DERIVED metric is available only when every input it derives from is
 *     independently available AND passes the market-state rule. A slope with one
 *     stale endpoint is not a slope.
 */

import {
  MARKET_IV_MAX_AGE_MINUTES, NOMINAL_TENORS,
  type MarketIvRejectionCode, type MarketObservationClass, type NominalTenor,
} from "./market-iv-evidence.ts";
import type {ReferenceSeriesRow} from "./reference-series.ts";
import {
  RV_HORIZONS, type RealizedVolatilityResult, type RvHorizon,
} from "./realized-volatility.ts";
import type {IvPercentileResult} from "./iv-percentile.ts";

export const EVENT_VOLATILITY_STATE_METHOD_VERSION = "event-volatility-state-v1" as const;
export const STRUCTURE_VOLATILITY_STATE_METHOD_VERSION = "structure-volatility-state-v1" as const;

/** The tenor pairs a term-structure slope may be computed across. */
export const SLOPE_PAIRS = [
  ["7d", "14d"], ["14d", "30d"], ["7d", "30d"],
] as const satisfies readonly (readonly [NominalTenor, NominalTenor])[];

export type SlopeKey = "slope_7d_14d" | "slope_14d_30d" | "slope_7d_30d";

export type DerivedUnavailableReason =
  | "endpoint_unavailable"
  | "endpoint_failed_market_state_rule"
  | "endpoint_tenor_tolerance_failed"
  | "actual_dte_unavailable"
  | "degenerate_tenor_span";

type Iso = string | null;
const iso = (ms: number | null | undefined): Iso =>
  ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/* ============================ event volatility state ============================ */

export interface TenorReferenceState {
  readonly nominal_tenor: NominalTenor;
  readonly nominal_days: number;
  readonly tolerance_days: number;
  readonly iv_decimal: number | null;
  readonly iv_units: "decimal" | null;
  readonly actual_expiry_timestamp_utc: Iso;
  readonly actual_dte_days: number | null;
  readonly tenor_tolerance_passed: boolean;
  readonly observation_class: MarketObservationClass | "unavailable";
  readonly observation_timestamp_utc: Iso;
  readonly age_minutes: number | null;
  readonly max_age_minutes: number;
  readonly passes_market_state_rule: boolean;
  readonly reference_strike: number | null;
  readonly log_moneyness: number | null;
  readonly source_trade_ids: readonly string[];
  readonly quality: "observed" | "interpolated" | "unavailable";
  readonly status: "available" | "unavailable";
  readonly unavailable_reason_code: MarketIvRejectionCode | null;
}

export interface SlopeState {
  readonly slope: SlopeKey;
  readonly from_tenor: NominalTenor;
  readonly to_tenor: NominalTenor;
  readonly value: number | null;
  /** Per-day slope, the only comparable form once actual DTE varies. */
  readonly value_per_day: number | null;
  readonly from_actual_dte_days: number | null;
  readonly to_actual_dte_days: number | null;
  readonly status: "available" | "unavailable";
  readonly unavailable_reason: DerivedUnavailableReason | null;
}

export interface RvState {
  readonly horizon: RvHorizon;
  readonly rv_decimal: number | null;
  readonly observation_count: number;
  readonly expected_count: number;
  readonly coverage_ratio: number;
  readonly window_start_utc: Iso;
  readonly window_end_utc: Iso;
  readonly underlying_source: string;
  readonly annualization_factor: number;
  readonly method_version: string;
  readonly status: "available" | "unavailable";
  readonly unavailable_reason: string | null;
}

export interface IvMinusRvState {
  readonly horizon: RvHorizon;
  readonly nominal_tenor: NominalTenor;
  readonly value: number | null;
  readonly status: "available" | "unavailable";
  readonly unavailable_reason: DerivedUnavailableReason | null;
}

export interface EventPercentileState {
  readonly nominal_tenor: NominalTenor;
  readonly percentile: number | null;
  readonly subject_iv_decimal: number | null;
  readonly prior_observation_count: number;
  readonly other_tenor_observations_excluded: number;
  readonly minimum_prior_observations: number;
  readonly history_start_utc: Iso;
  readonly history_end_utc: Iso;
  readonly reference_series_id: string;
  readonly reference_series_content_hash: string;
  readonly method_version: string;
  readonly status: "available" | "unavailable";
  readonly unavailable_reason: string | null;
}

/**
 * DVOL, kept deliberately thin and structurally separate. It is broad context
 * and can never stand in for a same-expiry reference, so it is not part of
 * `reference_iv` and carries no tenor.
 */
export interface BroadVolatilityState {
  readonly series_id: string | null;
  readonly method_version: string | null;
  readonly value_decimal: number | null;
  readonly observation_timestamp_utc: Iso;
  readonly age_minutes: number | null;
  readonly status: "available" | "unavailable";
  readonly unavailable_reason: string | null;
  readonly substitution_permitted: false;
}

export interface EventVolatilityStateRow {
  readonly event_id: string;
  readonly entry_timestamp_utc: string;
  readonly underlying_instrument: string;
  readonly entry_underlying_price: number | null;
  readonly method_version: string;
  readonly reference_series_id: string;
  readonly reference_series_content_hash: string;
  readonly reference_iv: readonly TenorReferenceState[];
  readonly term_structure: readonly SlopeState[];
  readonly realized_volatility: readonly RvState[];
  readonly reference_iv_percentile: readonly EventPercentileState[];
  readonly iv_minus_rv: readonly IvMinusRvState[];
  readonly broad_volatility_index: BroadVolatilityState;
}

const tenorState = (nominal: NominalTenor, row: ReferenceSeriesRow | undefined): TenorReferenceState => {
  const spec = NOMINAL_TENORS[nominal];
  if (!row) return {
    nominal_tenor: nominal, nominal_days: spec.nominalDays, tolerance_days: spec.toleranceDays,
    iv_decimal: null, iv_units: null, actual_expiry_timestamp_utc: null, actual_dte_days: null,
    tenor_tolerance_passed: false, observation_class: "unavailable", observation_timestamp_utc: null,
    age_minutes: null, max_age_minutes: MARKET_IV_MAX_AGE_MINUTES, passes_market_state_rule: false,
    reference_strike: null, log_moneyness: null, source_trade_ids: [], quality: "unavailable",
    status: "unavailable", unavailable_reason_code: "no_qualifying_observation",
  };
  // Availability is the conjunction of a real value AND the market-state rule.
  // A value that failed staleness is not "available with a caveat".
  const available = finite(row.reference_iv_decimal) && row.passes_market_state_rule && row.tenor_tolerance_passed;
  return {
    nominal_tenor: nominal, nominal_days: spec.nominalDays, tolerance_days: spec.toleranceDays,
    iv_decimal: available ? row.reference_iv_decimal : null,
    iv_units: available ? "decimal" : null,
    actual_expiry_timestamp_utc: row.reference_expiry_timestamp_utc,
    actual_dte_days: row.actual_dte_days,
    tenor_tolerance_passed: row.tenor_tolerance_passed,
    observation_class: row.observation_class,
    observation_timestamp_utc: row.observation_timestamp_utc,
    age_minutes: row.age_minutes, max_age_minutes: row.max_age_minutes,
    passes_market_state_rule: row.passes_market_state_rule,
    reference_strike: row.reference_strike, log_moneyness: row.log_moneyness,
    source_trade_ids: row.source_trade_ids,
    quality: available ? row.quality : "unavailable",
    status: available ? "available" : "unavailable",
    unavailable_reason_code: available ? null
      : row.unavailable_reason_code ?? (!row.tenor_tolerance_passed ? "tenor_tolerance_failed" : "stale_beyond_max_age"),
  };
};

/**
 * Term-structure slope between two tenors.
 *
 * Reported both raw and per actual day, because the Friday cycle means a
 * "7D vs 14D" pair is routinely 5.9 vs 12.9 actual days. Dividing by the nominal
 * gap would misstate the slope by whatever the cycle happened to offer.
 */
export function buildSlope(from: TenorReferenceState, to: TenorReferenceState, key: SlopeKey): SlopeState {
  const base = {
    slope: key, from_tenor: from.nominal_tenor, to_tenor: to.nominal_tenor,
    from_actual_dte_days: from.actual_dte_days, to_actual_dte_days: to.actual_dte_days,
  } as const;
  const unavailable = (reason: DerivedUnavailableReason): SlopeState =>
    ({...base, value: null, value_per_day: null, status: "unavailable", unavailable_reason: reason});

  if (!from.tenor_tolerance_passed || !to.tenor_tolerance_passed) return unavailable("endpoint_tenor_tolerance_failed");
  if (from.status !== "available" || to.status !== "available") return unavailable("endpoint_unavailable");
  if (!from.passes_market_state_rule || !to.passes_market_state_rule)
    return unavailable("endpoint_failed_market_state_rule");
  if (!finite(from.iv_decimal) || !finite(to.iv_decimal)) return unavailable("endpoint_unavailable");
  if (!finite(from.actual_dte_days) || !finite(to.actual_dte_days)) return unavailable("actual_dte_unavailable");

  const span = to.actual_dte_days - from.actual_dte_days;
  const value = to.iv_decimal - from.iv_decimal;
  // Two nominally different tenors that resolved to the SAME listed expiry give
  // a zero span. That is a real Deribit condition, not a divide-by-zero to hide.
  if (span === 0) return {...base, value, value_per_day: null, status: "unavailable",
    unavailable_reason: "degenerate_tenor_span"};
  return {...base, value, value_per_day: value / span, status: "available", unavailable_reason: null};
}

const rvState = (horizon: RvHorizon, r: RealizedVolatilityResult | undefined): RvState => r ? {
  horizon, rv_decimal: r.status === "available" ? r.rvDecimal : null,
  observation_count: r.observationCount, expected_count: r.expectedCount,
  coverage_ratio: r.coverageRatio,
  window_start_utc: iso(r.windowStartMs), window_end_utc: iso(r.windowEndMs),
  underlying_source: r.underlyingSource, annualization_factor: r.annualizationFactor,
  method_version: r.methodVersion, status: r.status,
  unavailable_reason: r.unavailableReason ?? null,
} : {
  horizon, rv_decimal: null, observation_count: 0, expected_count: 0, coverage_ratio: 0,
  window_start_utc: null, window_end_utc: null, underlying_source: "unavailable",
  annualization_factor: 0, method_version: "unavailable", status: "unavailable",
  unavailable_reason: "no_bars_in_window",
};

export interface EventVolatilityStateInput {
  readonly eventId: string;
  readonly entryTimestampMs: number;
  readonly underlyingInstrument: string;
  readonly entryUnderlyingPrice: number | null;
  readonly referenceSeriesId: string;
  readonly referenceSeriesContentHash: string;
  /** One reference row per nominal tenor at the entry timestamp. */
  readonly referenceRows: readonly ReferenceSeriesRow[];
  readonly realizedVolatility: Partial<Record<RvHorizon, RealizedVolatilityResult>>;
  readonly percentiles: Partial<Record<NominalTenor, IvPercentileResult>>;
  readonly broadVolatility?: BroadVolatilityState;
  /** Which RV horizon pairs with which nominal tenor for IV-minus-RV. */
  readonly ivMinusRvPairs?: readonly (readonly [NominalTenor, RvHorizon])[];
}

const DEFAULT_IV_RV_PAIRS = [
  ["7d", "7d"], ["14d", "14d"], ["30d", "30d"],
] as const satisfies readonly (readonly [NominalTenor, RvHorizon])[];

export const DVOL_UNAVAILABLE: BroadVolatilityState = Object.freeze({
  series_id: null, method_version: null, value_decimal: null, observation_timestamp_utc: null,
  age_minutes: null, status: "unavailable",
  unavailable_reason: "No broad volatility observation was supplied for this timestamp.",
  substitution_permitted: false,
} as const);

export function buildEventVolatilityState(input: EventVolatilityStateInput): EventVolatilityStateRow {
  const byTenor = new Map(input.referenceRows.map(r => [r.nominal_tenor, r]));
  const tenors: NominalTenor[] = ["7d", "14d", "30d"];
  const referenceIv = tenors.map(t => tenorState(t, byTenor.get(t)));
  const state = new Map(referenceIv.map(r => [r.nominal_tenor, r]));

  const term = SLOPE_PAIRS.map(([from, to]) =>
    buildSlope(state.get(from)!, state.get(to)!, `slope_${from}_${to}` as SlopeKey));

  const realized = RV_HORIZONS.map(h => rvState(h, input.realizedVolatility[h]));
  const rvByHorizon = new Map(realized.map(r => [r.horizon, r]));

  const percentiles = tenors.map<EventPercentileState>(t => {
    const p = input.percentiles[t];
    const subject = state.get(t)!;
    if (!p) return {
      nominal_tenor: t, percentile: null, subject_iv_decimal: subject.iv_decimal,
      prior_observation_count: 0, other_tenor_observations_excluded: 0,
      minimum_prior_observations: 0, history_start_utc: null, history_end_utc: null,
      reference_series_id: input.referenceSeriesId,
      reference_series_content_hash: input.referenceSeriesContentHash,
      method_version: "unavailable", status: "unavailable",
      unavailable_reason: "no_prior_observations",
    };
    return {
      nominal_tenor: t, percentile: p.percentile, subject_iv_decimal: p.subjectIvDecimal,
      prior_observation_count: p.priorObservationCount,
      other_tenor_observations_excluded: p.otherTenorObservationsExcluded,
      minimum_prior_observations: p.minimumPriorObservations,
      history_start_utc: iso(p.historyStartMs), history_end_utc: iso(p.historyEndMs),
      reference_series_id: p.referenceSeriesId,
      reference_series_content_hash: p.referenceSeriesContentHash,
      method_version: p.methodVersion, status: p.status,
      unavailable_reason: p.unavailableReason,
    };
  });

  const ivMinusRv = (input.ivMinusRvPairs ?? DEFAULT_IV_RV_PAIRS).map<IvMinusRvState>(([tenor, horizon]) => {
    const iv = state.get(tenor), rv = rvByHorizon.get(horizon);
    if (!iv || iv.status !== "available" || !finite(iv.iv_decimal))
      return {horizon, nominal_tenor: tenor, value: null, status: "unavailable",
        unavailable_reason: "endpoint_unavailable"};
    if (!rv || rv.status !== "available" || !finite(rv.rv_decimal))
      return {horizon, nominal_tenor: tenor, value: null, status: "unavailable",
        unavailable_reason: "endpoint_unavailable"};
    return {horizon, nominal_tenor: tenor, value: iv.iv_decimal - rv.rv_decimal,
      status: "available", unavailable_reason: null};
  });

  return {
    event_id: input.eventId,
    entry_timestamp_utc: new Date(input.entryTimestampMs).toISOString(),
    underlying_instrument: input.underlyingInstrument,
    entry_underlying_price: finite(input.entryUnderlyingPrice) ? input.entryUnderlyingPrice : null,
    method_version: EVENT_VOLATILITY_STATE_METHOD_VERSION,
    reference_series_id: input.referenceSeriesId,
    reference_series_content_hash: input.referenceSeriesContentHash,
    reference_iv: referenceIv,
    term_structure: term,
    realized_volatility: realized,
    reference_iv_percentile: percentiles,
    iv_minus_rv: ivMinusRv,
    broad_volatility_index: input.broadVolatility ?? DVOL_UNAVAILABLE,
  };
}

/* ========================== structure volatility state ========================== */

/** Exactly the shape `legVolatility` already produces, consumed unchanged. */
export interface LegVolatilitySnapshot {
  readonly ivDecimal: number | null;
  readonly ivApiPercent?: number | null;
  readonly ivUnits?: string | null;
  readonly ivSource?: string | null;
  readonly ivSourceTimestampMs?: number | null;
  readonly observation?: string | null;
  readonly dteDays?: number | null;
}

export interface LegVolatilityState {
  readonly leg: "short" | "long";
  readonly instrument: string | null;
  readonly strike: number | null;
  readonly iv_decimal: number | null;
  readonly iv_api_percentage: number | null;
  readonly iv_units: "decimal" | null;
  readonly iv_source: string | null;
  readonly iv_source_timestamp_utc: Iso;
  readonly age_minutes: number | null;
  readonly max_age_minutes: number;
  readonly passes_market_state_rule: boolean;
  readonly observation: string;
  readonly quality: "observed" | "unavailable";
  readonly status: "available" | "unavailable";
  readonly unavailable_reason: string | null;
}

export interface StructureDifferential {
  readonly differential: "short_minus_reference_iv" | "long_minus_reference_iv" | "short_minus_long_iv";
  readonly value: number | null;
  readonly status: "available" | "unavailable";
  readonly unavailable_reason: DerivedUnavailableReason | null;
}

export interface StructureReferenceState {
  readonly iv_decimal: number | null;
  readonly method: MarketObservationClass | "unavailable";
  readonly reference_strike: number | null;
  readonly reference_log_moneyness: number | null;
  readonly reference_age_minutes: number | null;
  readonly max_age_minutes: number;
  readonly passes_market_state_rule: boolean;
  readonly excluded_own_legs: boolean;
  readonly source_trade_ids: readonly string[];
  readonly status: "available" | "unavailable";
  readonly unavailable_reason_code: MarketIvRejectionCode | null;
}

export interface StructureVolatilityStateRow {
  readonly event_id: string;
  readonly candidate_id: string;
  readonly entry_timestamp_utc: string;
  readonly actual_expiry_timestamp_utc: Iso;
  readonly actual_dte_days: number | null;
  readonly short_strike: number | null;
  readonly long_strike: number | null;
  readonly option_type: string | null;
  readonly method_version: string;
  readonly reference_series_id: string;
  readonly reference_series_content_hash: string;
  readonly legs: readonly LegVolatilityState[];
  readonly same_expiry_reference: StructureReferenceState;
  readonly differentials: readonly StructureDifferential[];
  /**
   * A vertical has no single implied volatility. The field exists to say so
   * explicitly, so no consumer invents one from the two legs.
   */
  readonly synthesized_spread_iv: null;
  readonly synthesized_spread_iv_note: string;
}

export const NO_SYNTHESIZED_SPREAD_IV_NOTE =
  "A vertical spread has no single implied volatility. The legs are reported separately and differenced explicitly.";

/**
 * Model-produced leg volatility is a PRICING state, never market evidence. Any
 * leg whose observation is not a real market observation is unavailable here,
 * whatever number the pricing model attached to it.
 */
const MARKET_LEG_OBSERVATIONS: ReadonlySet<string> = new Set(["observed"]);

const legState = (
  leg: "short" | "long",
  snapshot: LegVolatilitySnapshot | null | undefined,
  context: {instrument: string | null; strike: number | null; entryTimestampMs: number; maxAgeMinutes: number},
): LegVolatilityState => {
  const base = {
    leg, instrument: context.instrument, strike: context.strike,
    max_age_minutes: context.maxAgeMinutes,
  } as const;
  const unavailable = (observation: string, reason: string): LegVolatilityState => ({
    ...base, iv_decimal: null, iv_api_percentage: null, iv_units: null,
    iv_source: snapshot?.ivSource ?? null,
    iv_source_timestamp_utc: iso(snapshot?.ivSourceTimestampMs ?? null),
    age_minutes: null, passes_market_state_rule: false, observation,
    quality: "unavailable", status: "unavailable", unavailable_reason: reason,
  });
  if (!snapshot) return unavailable("unavailable", "No leg volatility snapshot was produced.");
  const observation = snapshot.observation ?? "unavailable";
  if (!MARKET_LEG_OBSERVATIONS.has(observation))
    return unavailable(observation,
      "Leg volatility observation " + JSON.stringify(observation) + " is a pricing state, not market evidence.");
  if (!finite(snapshot.ivDecimal) || snapshot.ivDecimal <= 0)
    return unavailable(observation, "Leg volatility carries no positive IV.");

  const sourceMs = snapshot.ivSourceTimestampMs;
  const ageMinutes = finite(sourceMs) ? (context.entryTimestampMs - sourceMs) / 60_000 : null;
  const passes = ageMinutes !== null && ageMinutes >= 0 && ageMinutes <= context.maxAgeMinutes;
  if (!passes) return {
    ...base, iv_decimal: null, iv_api_percentage: null, iv_units: null,
    iv_source: snapshot.ivSource ?? null, iv_source_timestamp_utc: iso(sourceMs ?? null),
    age_minutes: ageMinutes, passes_market_state_rule: false, observation,
    quality: "unavailable", status: "unavailable",
    unavailable_reason: ageMinutes === null
      ? "Leg volatility carries no source timestamp, so its age cannot be established."
      : "Leg volatility is " + ageMinutes.toFixed(1) + " minutes from entry, outside the "
        + context.maxAgeMinutes + "-minute market-state window.",
  };
  return {
    ...base, iv_decimal: snapshot.ivDecimal,
    iv_api_percentage: finite(snapshot.ivApiPercent) ? snapshot.ivApiPercent : snapshot.ivDecimal * 100,
    iv_units: "decimal", iv_source: snapshot.ivSource ?? null,
    iv_source_timestamp_utc: iso(sourceMs ?? null), age_minutes: ageMinutes,
    passes_market_state_rule: true, observation, quality: "observed",
    status: "available", unavailable_reason: null,
  };
};

export interface StructureVolatilityStateInput {
  readonly eventId: string;
  readonly candidateId: string;
  readonly entryTimestampMs: number;
  readonly actualExpiryTimestampMs: number | null;
  readonly actualDteDays: number | null;
  readonly shortStrike: number | null;
  readonly longStrike: number | null;
  readonly optionType: string | null;
  readonly shortInstrument?: string | null;
  readonly longInstrument?: string | null;
  readonly referenceSeriesId: string;
  readonly referenceSeriesContentHash: string;
  readonly shortLeg: LegVolatilitySnapshot | null;
  readonly longLeg: LegVolatilitySnapshot | null;
  /**
   * Same-expiry reference resolved with the structure's OWN legs excluded, so
   * the differential is not measured against itself.
   */
  readonly reference: ReferenceSeriesRow | null;
  readonly maxAgeMinutes?: number;
}

export function buildStructureVolatilityState(input: StructureVolatilityStateInput): StructureVolatilityStateRow {
  const maxAgeMinutes = input.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES;
  const shortLeg = legState("short", input.shortLeg, {
    instrument: input.shortInstrument ?? null, strike: input.shortStrike,
    entryTimestampMs: input.entryTimestampMs, maxAgeMinutes,
  });
  const longLeg = legState("long", input.longLeg, {
    instrument: input.longInstrument ?? null, strike: input.longStrike,
    entryTimestampMs: input.entryTimestampMs, maxAgeMinutes,
  });

  const r = input.reference;
  const referenceAvailable = r !== null && finite(r.reference_iv_decimal) && r.passes_market_state_rule;
  const reference: StructureReferenceState = {
    iv_decimal: referenceAvailable ? r.reference_iv_decimal : null,
    method: r?.observation_class ?? "unavailable",
    reference_strike: r?.reference_strike ?? null,
    reference_log_moneyness: r?.log_moneyness ?? null,
    reference_age_minutes: r?.age_minutes ?? null,
    max_age_minutes: r?.max_age_minutes ?? maxAgeMinutes,
    passes_market_state_rule: r?.passes_market_state_rule ?? false,
    // A reference that did NOT exclude the subject legs is self-referential and
    // must not be differenced against them.
    excluded_own_legs: r?.own_legs_excluded ?? false,
    source_trade_ids: r?.source_trade_ids ?? [],
    status: referenceAvailable ? "available" : "unavailable",
    unavailable_reason_code: referenceAvailable ? null
      : r?.unavailable_reason_code ?? "no_qualifying_observation",
  };

  const differential = (
    kind: StructureDifferential["differential"], a: number | null, b: number | null, ok: boolean,
  ): StructureDifferential =>
    ok && finite(a) && finite(b)
      ? {differential: kind, value: a - b, status: "available", unavailable_reason: null}
      : {differential: kind, value: null, status: "unavailable", unavailable_reason: "endpoint_unavailable"};

  // A differential against the reference is only meaningful when the reference
  // genuinely excluded this structure's own legs.
  const referenceUsable = reference.status === "available" && reference.excluded_own_legs;
  const differentials: StructureDifferential[] = [
    differential("short_minus_reference_iv", shortLeg.iv_decimal, reference.iv_decimal,
      shortLeg.status === "available" && referenceUsable),
    differential("long_minus_reference_iv", longLeg.iv_decimal, reference.iv_decimal,
      longLeg.status === "available" && referenceUsable),
    differential("short_minus_long_iv", shortLeg.iv_decimal, longLeg.iv_decimal,
      shortLeg.status === "available" && longLeg.status === "available"),
  ];

  return {
    event_id: input.eventId, candidate_id: input.candidateId,
    entry_timestamp_utc: new Date(input.entryTimestampMs).toISOString(),
    actual_expiry_timestamp_utc: iso(input.actualExpiryTimestampMs),
    actual_dte_days: finite(input.actualDteDays) ? input.actualDteDays : null,
    short_strike: finite(input.shortStrike) ? input.shortStrike : null,
    long_strike: finite(input.longStrike) ? input.longStrike : null,
    option_type: input.optionType ?? null,
    method_version: STRUCTURE_VOLATILITY_STATE_METHOD_VERSION,
    reference_series_id: input.referenceSeriesId,
    reference_series_content_hash: input.referenceSeriesContentHash,
    legs: [shortLeg, longLeg],
    same_expiry_reference: reference,
    differentials,
    synthesized_spread_iv: null,
    synthesized_spread_iv_note: NO_SYNTHESIZED_SPREAD_IV_NOTE,
  };
}
