import {
  MARKET_IV_MAX_AGE_MINUTES, MARKET_IV_METHOD_VERSION, MARKET_IV_MONEYNESS_TOLERANCE,
  admitMarketIvTrade, resolveReferenceIv, resolveTenor,
  type AdmittedIvTrade, type MarketIvRejectionCode, type MarketObservationClass,
  type NominalTenor, type RawIvTradeCandidate, type ReferenceIvInterpolationInput,
} from "./market-iv-evidence.ts";

/**
 * The standalone market-IV reference series.
 *
 * This is deliberately NOT a research-bundle table. It is a market-wide series
 * independent of any MR event, cached in monthly shards so expanding the event
 * sample reuses history instead of redownloading it. A research bundle later
 * embeds only the snapshots it actually used plus this series' identity and
 * content hash, so it stays reproducible without carrying years of rows.
 *
 * The builder is PURE: given retrieved trades, listed expiries and an underlying
 * price it returns rows and an identity. All IO lives in the cache/retrieval
 * layer, which keeps the methodology testable without a network.
 *
 * DVOL is a SEPARATE series with its own id and method version. It is a broad
 * whole-surface index, so it can never stand in for a same-expiry reference --
 * see `dvolSeriesIdentity` and the `dvol_cannot_substitute` rejection.
 */

export const REFERENCE_SERIES_METHOD_VERSION = "volatility-reference-series-v2" as const;
export const REFERENCE_SERIES_ID = "deribit-btc-same-expiry-reference-v2" as const;
/** `index_price` carried by Deribit BTC option trades. Not BTC-PERPETUAL. */
export const DERIBIT_OPTION_INDEX_UNDERLYING = "deribit_btc_usd_index" as const;
export const DVOL_SERIES_ID = "deribit-btc-dvol-hourly-v1" as const;
export const DVOL_METHOD_VERSION = "deribit-dvol-index-v1" as const;
/** DVOL history genuinely begins here; earlier targets have no broad reference. */
export const DVOL_FIRST_AVAILABLE_MS = Date.UTC(2021, 2, 24);

/** Deribit host routing, preserving the audited asymmetry. */
export const OPTION_HISTORY_HOST = "https://history.deribit.com/api/v2/public" as const;
/** The history mirror returns HTTP 400 for the volatility index, so DVOL uses www. */
export const DVOL_HOST = "https://www.deribit.com/api/v2/public" as const;

/** FNV-1a, matching the hashing already used for bundle row identity. */
export function contentHash(value: unknown): string {
  let h = 2166136261;
  for (const c of JSON.stringify(value)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export interface ListedExpiry {
  readonly expiryTimestampMs: number;
  readonly createdAtMs?: number | null;
  readonly settlementPeriod?: string | null;
  readonly strikes: readonly number[];
}

export interface ReferenceSeriesRow {
  readonly series_id: string;
  readonly method_version: string;
  readonly timestamp_utc: string;
  readonly timestamp_ms: number;
  readonly underlying_instrument: string;
  readonly underlying_price: number | null;
  readonly nominal_tenor: NominalTenor;
  readonly reference_expiry_timestamp_utc: string | null;
  readonly actual_dte_days: number | null;
  readonly tenor_tolerance_passed: boolean;
  readonly reference_iv_decimal: number | null;
  readonly iv_units: "decimal" | null;
  readonly reference_strike: number | null;
  readonly log_moneyness: number | null;
  readonly observation_class: MarketObservationClass | "unavailable";
  readonly observation_source: "deribit_trade_iv" | "interpolation" | null;
  readonly observation_timestamp_utc: string | null;
  readonly age_minutes: number | null;
  readonly max_age_minutes: number;
  readonly passes_market_state_rule: boolean;
  readonly diagnostic_age_minutes: number | null;
  readonly source_trade_ids: readonly string[];
  readonly interpolation_inputs: readonly ReferenceIvInterpolationInput[];
  readonly contract_settlement_period: string | null;
  readonly own_legs_excluded: boolean;
  readonly quality: "observed" | "interpolated" | "unavailable";
  readonly unavailable_reason_code: MarketIvRejectionCode | null;
}

export interface ReferenceSeriesBuildInput {
  readonly timestampMs: number;
  readonly underlyingInstrument: string;
  readonly underlyingPrice: number;
  readonly listedExpiries: readonly ListedExpiry[];
  /** Raw Deribit prints. Every one passes through admission before use. */
  readonly candidates: readonly RawIvTradeCandidate[];
  readonly tenors?: readonly NominalTenor[];
  readonly excludedInstruments?: readonly string[];
  readonly maxAgeMinutes?: number;
}

export interface ReferenceSeriesBuildResult {
  readonly rows: readonly ReferenceSeriesRow[];
  readonly admitted: number;
  readonly rejected: Readonly<Partial<Record<MarketIvRejectionCode, number>>>;
}

/** Canonical evaluated state for a complete tape with no causal option index. */
export function buildUnavailableReferenceSeriesRows(input: {
  readonly timestampMs: number;
  readonly listedExpiries: readonly ListedExpiry[];
  readonly tenors?: readonly NominalTenor[];
  readonly reasonCode?: MarketIvRejectionCode;
  readonly maxAgeMinutes?: number;
}): readonly ReferenceSeriesRow[] {
  const maxAge = input.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES;
  return (input.tenors ?? (["7d", "14d", "30d"] as const)).map(nominal => {
    const tenor = resolveTenor(nominal, input.timestampMs, input.listedExpiries);
    return {
      series_id: REFERENCE_SERIES_ID, method_version: REFERENCE_SERIES_METHOD_VERSION,
      timestamp_utc: new Date(input.timestampMs).toISOString(), timestamp_ms: input.timestampMs,
      underlying_instrument: DERIBIT_OPTION_INDEX_UNDERLYING, underlying_price: null,
      nominal_tenor: nominal, reference_expiry_timestamp_utc: iso(tenor.actualExpiryTimestampMs),
      actual_dte_days: tenor.actualDteDays, tenor_tolerance_passed: tenor.tenorTolerancePassed,
      reference_iv_decimal: null, iv_units: null, reference_strike: null, log_moneyness: null,
      observation_class: "unavailable", observation_source: null, observation_timestamp_utc: null,
      age_minutes: null, max_age_minutes: maxAge, passes_market_state_rule: false,
      diagnostic_age_minutes: null, source_trade_ids: [], interpolation_inputs: [],
      contract_settlement_period: null, own_legs_excluded: false, quality: "unavailable",
      unavailable_reason_code: input.reasonCode ?? "missing_index_price",
    };
  });
}

/** Admission boundary for rows reused by the current reference-series cache. */
export function isCurrentReferenceRow(row: unknown): row is ReferenceSeriesRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Partial<ReferenceSeriesRow>;
  if (r.series_id !== REFERENCE_SERIES_ID || r.method_version !== REFERENCE_SERIES_METHOD_VERSION ||
      r.underlying_instrument !== DERIBIT_OPTION_INDEX_UNDERLYING ||
      !Number.isFinite(r.timestamp_ms) || !(["7d", "14d", "30d"] as const).includes(r.nominal_tenor as NominalTenor)) return false;
  if (r.observation_class === "unavailable")
    return r.reference_iv_decimal === null && r.iv_units === null && r.passes_market_state_rule === false && r.quality === "unavailable" && r.unavailable_reason_code !== null;
  return typeof r.reference_iv_decimal === "number" && r.reference_iv_decimal > 0 &&
    r.iv_units === "decimal" && r.passes_market_state_rule === true && typeof r.underlying_price === "number" && r.underlying_price > 0;
}

/** A timestamp is reusable only after all canonical current-method tenors were evaluated. */
export function isReferenceTimestampComplete(rows: readonly unknown[], timestampMs: number): boolean {
  const found = new Set(rows.filter(isCurrentReferenceRow).filter(r => r.timestamp_ms === timestampMs).map(r => r.nominal_tenor));
  return (["7d", "14d", "30d"] as const).every(tenor => found.has(tenor));
}

const iso = (ms: number | null): string | null => ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();

/**
 * Build one timestamp's reference rows, one per nominal tenor.
 *
 * Every candidate is put through `admitMarketIvTrade`, so a model-sourced or
 * future or unlisted print cannot reach the series regardless of what the
 * caller passes.
 */
export function buildReferenceSeriesRows(input: ReferenceSeriesBuildInput): ReferenceSeriesBuildResult {
  const tenors = input.tenors ?? (["7d", "14d", "30d"] as const);
  const maxAge = input.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES;
  const rejected: Partial<Record<MarketIvRejectionCode, number>> = {};
  const admittedByExpiry = new Map<number, AdmittedIvTrade[]>();
  let admitted = 0;

  for (const candidate of input.candidates) {
    const result = admitMarketIvTrade(candidate, {
      targetTimestampMs: input.timestampMs,
      underlyingPrice: input.underlyingPrice,
      maxAgeMinutes: maxAge,
      excludedInstruments: input.excludedInstruments,
    });
    if (!result.admitted) { rejected[result.code] = (rejected[result.code] ?? 0) + 1; continue; }
    admitted += 1;
    const list = admittedByExpiry.get(result.observation.expiryTimestampMs);
    if (list) list.push(result.observation); else admittedByExpiry.set(result.observation.expiryTimestampMs, [result.observation]);
  }

  const rows = tenors.map<ReferenceSeriesRow>(nominal => {
    const tenor = resolveTenor(nominal, input.timestampMs, input.listedExpiries);
    const shared = {
      series_id: REFERENCE_SERIES_ID, method_version: REFERENCE_SERIES_METHOD_VERSION,
      timestamp_utc: new Date(input.timestampMs).toISOString(), timestamp_ms: input.timestampMs,
      underlying_instrument: input.underlyingInstrument, underlying_price: input.underlyingPrice,
      nominal_tenor: nominal,
      reference_expiry_timestamp_utc: iso(tenor.actualExpiryTimestampMs),
      actual_dte_days: tenor.actualDteDays,
      tenor_tolerance_passed: tenor.tenorTolerancePassed,
      max_age_minutes: maxAge, own_legs_excluded: Boolean(input.excludedInstruments?.length),
    } as const;
    const unavailable = (code: MarketIvRejectionCode): ReferenceSeriesRow => ({
      ...shared, reference_iv_decimal: null, iv_units: null, reference_strike: null, log_moneyness: null,
      observation_class: "unavailable", observation_source: null, observation_timestamp_utc: null,
      age_minutes: null, passes_market_state_rule: false, diagnostic_age_minutes: null,
      source_trade_ids: [], interpolation_inputs: [], contract_settlement_period: null,
      quality: "unavailable", unavailable_reason_code: code,
    });

    // An out-of-tolerance tenor is unavailable, never silently relabelled: a
    // 39-day expiry is not a 30-day reference.
    if (tenor.actualExpiryTimestampMs === null) return unavailable(tenor.reasonCode ?? "no_qualifying_observation");
    if (!tenor.tenorTolerancePassed) return unavailable("tenor_tolerance_failed");

    const expiry = input.listedExpiries.find(e => e.expiryTimestampMs === tenor.actualExpiryTimestampMs);
    const observations = admittedByExpiry.get(tenor.actualExpiryTimestampMs) ?? [];
    const reference = resolveReferenceIv(observations, {
      underlyingPrice: input.underlyingPrice,
      listedStrikes: expiry?.strikes ?? [],
      // Observations are already grouped by expiry above; the pin makes that
      // guarantee explicit rather than relying on the grouping staying correct.
      expectedExpiryTimestampMs: tenor.actualExpiryTimestampMs,
      maxAgeMinutes: maxAge,
      moneynessTolerance: MARKET_IV_MONEYNESS_TOLERANCE,
      ownLegsExcluded: Boolean(input.excludedInstruments?.length),
    });
    if (reference.status !== "available") return unavailable(reference.reasonCode ?? "no_qualifying_observation");

    return {
      ...shared,
      reference_iv_decimal: reference.ivDecimal, iv_units: "decimal",
      reference_strike: reference.referenceStrike, log_moneyness: reference.logMoneyness,
      observation_class: reference.observationClass ?? "unavailable",
      observation_source: reference.observationClass === "local_interpolation" ? "interpolation" : "deribit_trade_iv",
      observation_timestamp_utc: iso(reference.observationTimestampMs),
      age_minutes: reference.ageMinutes, passes_market_state_rule: reference.passesMarketStateRule,
      diagnostic_age_minutes: reference.ageMinutes,
      source_trade_ids: reference.sourceTradeIds,
      interpolation_inputs: reference.interpolationInputs,
      contract_settlement_period: expiry?.settlementPeriod ?? null,
      quality: reference.observationClass === "local_interpolation" ? "interpolated" : "observed",
      unavailable_reason_code: null,
    };
  });

  return {rows, admitted, rejected};
}

/* ============================ series identity ============================ */

export interface ReferenceSeriesManifest {
  readonly series_id: string;
  readonly method_version: string;
  readonly market_iv_method_version: string;
  readonly source_host: string;
  readonly source_endpoints: readonly string[];
  readonly underlying_instrument: string;
  readonly coverage_start_utc: string | null;
  readonly coverage_end_utc: string | null;
  readonly row_count: number;
  readonly shard_ids: readonly string[];
  readonly content_hash: string;
  readonly configuration: {
    readonly max_age_minutes: number;
    readonly diagnostic_age_minutes: number;
    readonly moneyness_tolerance: number;
    readonly nominal_tenors: readonly NominalTenor[];
  };
  readonly generated_at_utc: string;
}

/** `YYYY-MM` shard for a timestamp. Shards are reusable across event samples. */
export function shardIdFor(timestampMs: number): string {
  const d = new Date(timestampMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Content hash over the rows' MEANING, not their formatting or generation time.
 *
 * `generated_at_utc` and retrieval timestamps are deliberately excluded so
 * regenerating identical evidence yields an identical hash -- otherwise a bundle
 * referencing the series could never be checked for drift.
 */
export function referenceSeriesContentHash(rows: readonly ReferenceSeriesRow[]): string {
  const canonical = [...rows]
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.nominal_tenor.localeCompare(b.nominal_tenor))
    .map(r => [
      r.series_id, r.method_version, r.timestamp_ms, r.nominal_tenor,
      r.reference_expiry_timestamp_utc, r.actual_dte_days, r.tenor_tolerance_passed,
      r.reference_iv_decimal, r.reference_strike, r.log_moneyness,
      r.observation_class, r.observation_timestamp_utc, r.age_minutes,
      r.passes_market_state_rule, [...r.source_trade_ids].sort(),
      r.quality, r.unavailable_reason_code,
    ]);
  return contentHash(canonical);
}

export function buildReferenceSeriesManifest(input: {
  readonly rows: readonly ReferenceSeriesRow[];
  readonly underlyingInstrument: string;
  readonly generatedAtUtc: string;
  readonly sourceHost?: string;
}): ReferenceSeriesManifest {
  const timestamps = input.rows.map(r => r.timestamp_ms).filter(Number.isFinite);
  return {
    series_id: REFERENCE_SERIES_ID,
    method_version: REFERENCE_SERIES_METHOD_VERSION,
    market_iv_method_version: MARKET_IV_METHOD_VERSION,
    source_host: input.sourceHost ?? OPTION_HISTORY_HOST,
    source_endpoints: ["get_instruments", "get_last_trades_by_instrument_and_time"],
    underlying_instrument: input.underlyingInstrument,
    coverage_start_utc: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    coverage_end_utc: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    row_count: input.rows.length,
    shard_ids: [...new Set(input.rows.map(r => shardIdFor(r.timestamp_ms)))].sort(),
    content_hash: referenceSeriesContentHash(input.rows),
    configuration: {
      max_age_minutes: MARKET_IV_MAX_AGE_MINUTES,
      diagnostic_age_minutes: 240,
      moneyness_tolerance: MARKET_IV_MONEYNESS_TOLERANCE,
      nominal_tenors: ["7d", "14d", "30d"],
    },
    generated_at_utc: input.generatedAtUtc,
  };
}

/* ============================ DVOL, kept separate ============================ */

export interface DvolPoint {
  readonly timestampMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface DvolSeriesRow {
  readonly series_id: string;
  readonly method_version: string;
  readonly timestamp_utc: string;
  readonly timestamp_ms: number;
  readonly dvol_close: number;
  readonly dvol_open: number;
  readonly dvol_high: number;
  readonly dvol_low: number;
  /** DVOL is quoted in percent; the decimal form is carried for comparability. */
  readonly dvol_decimal: number;
  readonly resolution_seconds: number;
  readonly source: "deribit_volatility_index";
  readonly source_host: string;
}

export function buildDvolRows(points: readonly DvolPoint[], resolutionSeconds = 3600): DvolSeriesRow[] {
  return points
    .filter(p => Number.isFinite(p.timestampMs) && Number.isFinite(p.close) && p.close > 0)
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map(p => ({
      series_id: DVOL_SERIES_ID, method_version: DVOL_METHOD_VERSION,
      timestamp_utc: new Date(p.timestampMs).toISOString(), timestamp_ms: p.timestampMs,
      dvol_close: p.close, dvol_open: p.open, dvol_high: p.high, dvol_low: p.low,
      dvol_decimal: p.close / 100,
      resolution_seconds: resolutionSeconds,
      source: "deribit_volatility_index", source_host: DVOL_HOST,
    }));
}

/**
 * Identity for the DVOL series. Distinct `series_id` and `method_version` from
 * the same-expiry series, which is what makes substitution detectable.
 */
export function dvolSeriesIdentity(rows: readonly DvolSeriesRow[]) {
  const timestamps = rows.map(r => r.timestamp_ms);
  return {
    series_id: DVOL_SERIES_ID, method_version: DVOL_METHOD_VERSION,
    source_host: DVOL_HOST, source_endpoint: "get_volatility_index_data",
    first_available_utc: new Date(DVOL_FIRST_AVAILABLE_MS).toISOString(),
    coverage_start_utc: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    coverage_end_utc: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    row_count: rows.length,
    content_hash: contentHash(rows.map(r => [r.timestamp_ms, r.dvol_close])),
  } as const;
}

/**
 * DVOL may never fill a missing same-expiry reference. This is the enforcement
 * point: any caller tempted to substitute gets a typed refusal instead.
 */
export function refuseDvolSubstitution(nominal: NominalTenor): {
  readonly status: "unavailable"; readonly reasonCode: MarketIvRejectionCode; readonly detail: string;
} {
  return {
    status: "unavailable", reasonCode: "dvol_cannot_substitute",
    detail: `DVOL is a broad whole-surface index and cannot serve as the ${nominal} same-expiry reference. The tenor stays unavailable.`,
  };
}

/**
 * Reference row for a KNOWN expiry, with no nominal-tenor resolution.
 *
 * A selected structure's expiry is not an approximation of a 7/14/30-day label
 * -- it is the exact expiry the structure trades. Putting it through tenor
 * resolution would judge it against a tolerance that does not apply and mark a
 * perfectly good 27-day reference unavailable for failing to be a 7-day one.
 *
 * `nominal_tenor` is still stamped for row shape, but the tolerance is reported
 * as passed by construction: there is nothing to approximate.
 */
export function buildExpiryReferenceRow(input: {
  readonly timestampMs: number;
  readonly underlyingInstrument: string;
  readonly underlyingPrice: number;
  readonly expiry: ListedExpiry;
  readonly candidates: readonly RawIvTradeCandidate[];
  readonly excludedInstruments?: readonly string[];
  readonly maxAgeMinutes?: number;
  readonly nominalTenorLabel?: NominalTenor;
}): ReferenceSeriesRow {
  const maxAge = input.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES;
  const admitted: AdmittedIvTrade[] = [];
  for (const candidate of input.candidates) {
    if (candidate.expiryTimestampMs !== input.expiry.expiryTimestampMs) continue;
    const result = admitMarketIvTrade(candidate, {
      targetTimestampMs: input.timestampMs, underlyingPrice: input.underlyingPrice,
      maxAgeMinutes: maxAge, excludedInstruments: input.excludedInstruments,
    });
    if (result.admitted) admitted.push(result.observation);
  }

  const actualDteDays = (input.expiry.expiryTimestampMs - input.timestampMs) / 86_400_000;
  const shared = {
    series_id: REFERENCE_SERIES_ID, method_version: REFERENCE_SERIES_METHOD_VERSION,
    timestamp_utc: new Date(input.timestampMs).toISOString(), timestamp_ms: input.timestampMs,
    underlying_instrument: input.underlyingInstrument, underlying_price: input.underlyingPrice,
    nominal_tenor: input.nominalTenorLabel ?? "7d",
    reference_expiry_timestamp_utc: iso(input.expiry.expiryTimestampMs),
    actual_dte_days: actualDteDays,
    // The expiry is given, so there is no tenor approximation to fail.
    tenor_tolerance_passed: true,
    max_age_minutes: maxAge, own_legs_excluded: Boolean(input.excludedInstruments?.length),
  } as const;

  const reference = resolveReferenceIv(admitted, {
    underlyingPrice: input.underlyingPrice, listedStrikes: input.expiry.strikes,
    expectedExpiryTimestampMs: input.expiry.expiryTimestampMs,
    maxAgeMinutes: maxAge, moneynessTolerance: MARKET_IV_MONEYNESS_TOLERANCE,
    ownLegsExcluded: Boolean(input.excludedInstruments?.length),
  });
  if (reference.status !== "available") return {
    ...shared, reference_iv_decimal: null, iv_units: null, reference_strike: null, log_moneyness: null,
    observation_class: "unavailable", observation_source: null, observation_timestamp_utc: null,
    age_minutes: null, passes_market_state_rule: false, diagnostic_age_minutes: null,
    source_trade_ids: [], interpolation_inputs: [],
    contract_settlement_period: input.expiry.settlementPeriod ?? null,
    quality: "unavailable", unavailable_reason_code: reference.reasonCode ?? "no_qualifying_observation",
  };
  return {
    ...shared,
    reference_iv_decimal: reference.ivDecimal, iv_units: "decimal",
    reference_strike: reference.referenceStrike, log_moneyness: reference.logMoneyness,
    observation_class: reference.observationClass ?? "unavailable",
    observation_source: reference.observationClass === "local_interpolation" ? "interpolation" : "deribit_trade_iv",
    observation_timestamp_utc: iso(reference.observationTimestampMs),
    age_minutes: reference.ageMinutes, passes_market_state_rule: reference.passesMarketStateRule,
    diagnostic_age_minutes: reference.ageMinutes,
    source_trade_ids: reference.sourceTradeIds, interpolation_inputs: reference.interpolationInputs,
    contract_settlement_period: input.expiry.settlementPeriod ?? null,
    quality: reference.observationClass === "local_interpolation" ? "interpolated" : "observed",
    unavailable_reason_code: null,
  };
}
