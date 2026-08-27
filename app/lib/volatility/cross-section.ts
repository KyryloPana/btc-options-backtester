/**
 * `historical_option_iv_observations` — the causal cross-sectional option-IV
 * observation layer.
 *
 * This is a STANDALONE dataset, deliberately separate from
 * `volatility_reference_series`, from `event_volatility_state` /
 * `structure_volatility_state`, and from research bundles. Its job is to hold
 * every qualifying real exchange print across the whole strike cross-section at
 * a causal target timestamp, so a future surface fit has something to learn a
 * smile from — and so we can measure, before building anything, whether the
 * historical tape can actually identify a surface at all.
 *
 * Everything here is PURE. Retrieval and caching live in the script layer.
 *
 * What this module does NOT do, by design: it does not fit SVI or SSVI, does not
 * interpolate, does not produce a price, and does not emit a fair value. It
 * produces observations, geometry and a readiness verdict. The readiness classes
 * are defined from EVIDENCE GEOMETRY ONLY -- never tuned against strategy PnL,
 * because a threshold chosen to make the backtest look good is not a
 * measurement.
 *
 * Admission reuses `admitMarketIvTrade`, so every circularity and causality rule
 * already locked in Phase 2A.1 applies unchanged: no constant-entry-IV, no model
 * reconstruction, no IV inverted from a model price, no future observation, no
 * contract used before its `creation_timestamp`.
 */

import {
  MARKET_IV_DIAGNOSTIC_AGE_MINUTES, MARKET_IV_MAX_AGE_MINUTES,
  admitMarketIvTrade,
  type AdmittedIvTrade, type MarketIvRejectionCode, type RawIvTradeCandidate,
} from "./market-iv-evidence.ts";
import {contentHash} from "./reference-series.ts";
import {resolveExpiryForward,EXPIRY_FORWARD_METHOD_VERSION,type ExpiryForwardEstimate} from "./expiry-forward.ts";

export const HISTORICAL_OPTION_IV_DATASET_ID = "deribit-btc-historical-option-iv-v2-expiry-forward" as const;
export const CROSS_SECTION_METHOD_VERSION = "cross-sectional-iv-observations-v2-forward-moneyness" as const;
export const SURFACE_READINESS_METHOD_VERSION = "surface-readiness-v2-forward-moneyness" as const;

/**
 * Forward convention, stated explicitly so it stays comparable later.
 *
 * Forward is reconstructed causally from same-expiry option trades. Missing
 * forward evidence makes the authoritative cross-section unavailable; it is
 * never silently replaced by the index.
 */
export const FORWARD_CONVENTION = "causal_option_trade_implied_expiry_forward" as const;

export const YEAR_MS = 365 * 24 * 3_600_000;

/* ============================ observations ============================ */

/**
 * One admitted print, carrying full trade identity, contract identity, market
 * data, target-relative evidence and surface coordinates.
 */
export interface CrossSectionObservation {
  /* trade identity */
  readonly instrument_name: string;
  readonly trade_id: string | null;
  readonly trade_seq: number | null;
  readonly timestamp_utc: string;
  readonly timestamp_ms: number;
  readonly source_host: string;
  readonly dataset_id: string;
  readonly method_version: string;
  /* contract identity */
  readonly strike: number;
  readonly option_type: "C" | "P";
  readonly expiry_timestamp_utc: string;
  readonly expiry_timestamp_ms: number;
  readonly actual_dte_days: number;
  readonly contract_created_at_utc: string | null;
  readonly settlement_period: string | null;
  readonly listed_at_target: boolean;
  /* market data */
  readonly iv_api_percentage: number;
  readonly iv_decimal: number;
  readonly trade_price: number | null;
  readonly mark_price: number | null;
  readonly index_price: number;
  readonly amount: number | null;
  readonly direction: string | null;
  readonly tick_direction: number | null;
  /* target-relative evidence */
  readonly target_timestamp_utc: string;
  readonly target_timestamp_ms: number;
  readonly age_minutes: number;
  /** The retrieval window this observation was pulled with. */
  readonly max_age_minutes: number;
  /** The canonical market-state rule. Fixed at 60 minutes, whatever was pulled. */
  readonly canonical_max_age_minutes: number;
  readonly passes_market_state_rule: boolean;
  readonly within_diagnostic_window: boolean;
  /* surface coordinates */
  readonly underlying_price: number;
  readonly forward_price: number;
  readonly forward_method_version: string;
  readonly forward_evidence_timestamp_ms: number | null;
  readonly forward_observation_count: number;
  readonly forward_convention: string;
  readonly log_moneyness: number;
  readonly time_to_expiry_years: number;
  /** Total implied variance w = IV^2 * T, in decimal^2 * years. */
  readonly total_implied_variance: number;
  readonly iv_units: "decimal";
  readonly variance_units: "decimal_squared_years";
}

/** Extra tape fields the base admission gate does not carry. */
export interface RawOptionPrint extends RawIvTradeCandidate {
  readonly price?: number | null;
  readonly markPrice?: number | null;
  readonly amount?: number | null;
  readonly direction?: string | null;
  readonly tickDirection?: number | null;
}

/**
 * Deterministic trade identity.
 *
 * Historical retrieval pages can repeat objects, so deduplication is required --
 * but two genuinely separate prints must survive. Deribit's `trade_id` is unique
 * per print, so it is the identity whenever present. Without one, the fallback
 * is the full coordinate tuple; two distinct fills that agree on instrument,
 * millisecond, price, amount, direction AND sequence are indistinguishable in
 * the data, so collapsing them is the only defensible choice.
 */
export function tradeIdentityKey(print: RawOptionPrint): string {
  if (print.tradeId) return `id:${print.tradeId}`;
  return [
    "coord", print.instrumentName, print.timestampMs, print.tradeSeq ?? "",
    print.price ?? "", print.amount ?? "", print.direction ?? "",
  ].join("|");
}

export interface DedupeResult {
  readonly prints: readonly RawOptionPrint[];
  readonly duplicatesRemoved: number;
  readonly duplicatesByInstrument: Readonly<Record<string, number>>;
}

/** Stable-order deduplication. The first occurrence wins, so order is preserved. */
export function dedupePrints(prints: readonly RawOptionPrint[]): DedupeResult {
  const seen = new Set<string>(), out: RawOptionPrint[] = [];
  const byInstrument: Record<string, number> = {};
  let duplicatesRemoved = 0;
  for (const print of prints) {
    const key = tradeIdentityKey(print);
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      byInstrument[print.instrumentName] = (byInstrument[print.instrumentName] ?? 0) + 1;
      continue;
    }
    seen.add(key);
    out.push(print);
  }
  return {prints: out, duplicatesRemoved, duplicatesByInstrument: byInstrument};
}

const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

/** Surface coordinates for one admitted print. Pure arithmetic on observed values. */
export function surfaceCoordinates(observation: AdmittedIvTrade): {
  readonly logMoneyness: number; readonly timeToExpiryYears: number;
  readonly totalImpliedVariance: number;
} {
  const timeToExpiryYears = (observation.expiryTimestampMs - observation.targetTimestampMs) / YEAR_MS;
  return {
    logMoneyness: observation.logMoneyness,
    timeToExpiryYears,
    // w = IV^2 * T. The quantity SVI and SSVI are actually parameterised in.
    totalImpliedVariance: observation.ivDecimal * observation.ivDecimal * timeToExpiryYears,
  };
}

export interface CrossSectionAdmission {
  readonly observations: readonly CrossSectionObservation[];
  readonly admitted: number;
  readonly rejected: Readonly<Partial<Record<MarketIvRejectionCode, number>>>;
  readonly duplicatesRemoved: number;
}

/**
 * Admit a batch of prints into the cross-section at one target timestamp.
 *
 * Deduplication runs FIRST, so a repeated page cannot inflate any downstream
 * count -- trade counts, strike counts and readiness all read the true tape.
 */
export function admitCrossSection(input: {
  readonly prints: readonly RawOptionPrint[];
  readonly targetTimestampMs: number;
  readonly underlyingPrice: number;
  readonly sourceHost: string;
  readonly maxAgeMinutes?: number;
  readonly diagnosticAgeMinutes?: number;
  readonly excludedInstruments?: readonly string[];
  /** Optional |ln(K/S)| bound. Purely operational; never tuned on PnL. */
  readonly logMoneynessEnvelope?: number | null;
}): CrossSectionAdmission & {readonly excludedByEnvelope: number} {
  const maxAge = input.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES;
  const diagnosticAge = input.diagnosticAgeMinutes ?? MARKET_IV_DIAGNOSTIC_AGE_MINUTES;
  const {prints, duplicatesRemoved} = dedupePrints(input.prints);
  const rejected: Partial<Record<MarketIvRejectionCode, number>> = {};
  const observations: CrossSectionObservation[] = [];
  const forwardByExpiry=new Map<number,ExpiryForwardEstimate>();
  let admitted = 0, excludedByEnvelope = 0;

  for (const print of prints) {
    let forward=forwardByExpiry.get(print.expiryTimestampMs);if(!forward){forward=resolveExpiryForward({trades:prints,targetTimestampMs:input.targetTimestampMs,expiryTimestampMs:print.expiryTimestampMs,indexPrice:input.underlyingPrice,excludedInstruments:input.excludedInstruments,maxAgeMinutes:maxAge});forwardByExpiry.set(print.expiryTimestampMs,forward)}
    const result = admitMarketIvTrade(print, {
      targetTimestampMs: input.targetTimestampMs,
      underlyingPrice: input.underlyingPrice,
      maxAgeMinutes: maxAge,
      excludedInstruments: input.excludedInstruments,
      forwardPrice: forward.status==="available" ? forward.forwardPrice ?? undefined : undefined,
    });
    if (!result.admitted) { rejected[result.code] = (rejected[result.code] ?? 0) + 1; continue; }
    if(forward.status!=="available"||forward.forwardPrice===null){rejected.forward_unavailable=(rejected.forward_unavailable??0)+1;continue}
    const o = result.observation;
    if (input.logMoneynessEnvelope != null && Math.abs(o.logMoneyness) > input.logMoneynessEnvelope) {
      excludedByEnvelope += 1;
      continue;
    }
    admitted += 1;
    const coords = surfaceCoordinates(o);
    observations.push({
      instrument_name: o.instrumentName, trade_id: o.tradeId, trade_seq: o.tradeSeq,
      timestamp_utc: new Date(o.observationTimestampMs).toISOString(),
      timestamp_ms: o.observationTimestampMs,
      source_host: input.sourceHost,
      dataset_id: HISTORICAL_OPTION_IV_DATASET_ID, method_version: CROSS_SECTION_METHOD_VERSION,
      strike: o.strike, option_type: o.optionType,
      expiry_timestamp_utc: new Date(o.expiryTimestampMs).toISOString(),
      expiry_timestamp_ms: o.expiryTimestampMs,
      actual_dte_days: o.actualDteDays,
      contract_created_at_utc: o.contractCreatedAtMs === null ? null
        : new Date(o.contractCreatedAtMs).toISOString(),
      settlement_period: o.settlementPeriod,
      // Admission already refuses anything created after the target, so an
      // admitted print is listed at the target by construction.
      listed_at_target: true,
      iv_api_percentage: o.ivApiPercent, iv_decimal: o.ivDecimal,
      trade_price: num(print.price), mark_price: num(print.markPrice),
      index_price: o.indexPrice, amount: num(print.amount),
      direction: typeof print.direction === "string" ? print.direction : null,
      tick_direction: num(print.tickDirection),
      target_timestamp_utc: new Date(o.targetTimestampMs).toISOString(),
      target_timestamp_ms: o.targetTimestampMs,
      age_minutes: o.ageMinutes, max_age_minutes: maxAge,
      canonical_max_age_minutes: MARKET_IV_MAX_AGE_MINUTES,
      // Measured against the CANONICAL 60 minutes, never against whatever window
      // the caller happened to retrieve with. Otherwise a widened diagnostic
      // pull would launder a stale print into canonical-passing evidence, which
      // is precisely the contamination the diagnostic window exists to avoid.
      passes_market_state_rule: o.ageMinutes >= 0 && o.ageMinutes <= MARKET_IV_MAX_AGE_MINUTES,
      within_diagnostic_window: o.ageMinutes >= 0 && o.ageMinutes <= diagnosticAge,
      underlying_price: o.underlyingPrice, forward_price: forward.forwardPrice,
      forward_method_version: EXPIRY_FORWARD_METHOD_VERSION, forward_convention: FORWARD_CONVENTION,
      forward_evidence_timestamp_ms: forward.evidenceTimestampMs,
      forward_observation_count: forward.observationCount,
      log_moneyness: coords.logMoneyness,
      time_to_expiry_years: coords.timeToExpiryYears,
      total_implied_variance: coords.totalImpliedVariance,
      iv_units: "decimal", variance_units: "decimal_squared_years",
    });
  }
  return {observations, admitted, rejected, duplicatesRemoved, excludedByEnvelope};
}

/* ======================= per-expiry slice diagnostics ======================= */

export interface StrikeGeometry {
  readonly strike: number;
  readonly log_moneyness: number;
  readonly observation_count: number;
  readonly call_count: number;
  readonly put_count: number;
  readonly freshest_age_minutes: number;
}

export interface ExpirySliceDiagnostics {
  readonly expiry_timestamp_utc: string;
  readonly expiry_timestamp_ms: number;
  readonly actual_dte_days: number;
  readonly qualifying_trade_count: number;
  readonly unique_instrument_count: number;
  readonly unique_strike_count: number;
  readonly call_count: number;
  readonly put_count: number;
  readonly freshest_age_minutes: number | null;
  readonly median_age_minutes: number | null;
  readonly p95_age_minutes: number | null;
  readonly min_log_moneyness: number | null;
  readonly max_log_moneyness: number | null;
  readonly min_strike: number | null;
  readonly max_strike: number | null;
  readonly observations_below_atm: number;
  readonly observations_above_atm: number;
  readonly atm_bracketed: boolean;
  readonly strikes: readonly StrikeGeometry[];
}

const quantile = (sorted: readonly number[], q: number): number | null => {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
};

/**
 * Geometry of one expiry's observed cross-section.
 *
 * "ATM bracketed" means at least one observed strike sits below the causal
 * underlying and at least one above it. Without that, any ATM statement is an
 * extrapolation, however many prints the slice contains.
 */
export function expirySliceDiagnostics(
  observations: readonly CrossSectionObservation[],
  underlyingPrice: number,
): ExpirySliceDiagnostics {
  const first = observations[0];
  const geometryForward = first?.forward_price ?? underlyingPrice;
  const ages = observations.map(o => o.age_minutes).sort((a, b) => a - b);
  const byStrike = new Map<number, CrossSectionObservation[]>();
  for (const o of observations) {
    const list = byStrike.get(o.strike);
    if (list) list.push(o); else byStrike.set(o.strike, [o]);
  }
  const strikes: StrikeGeometry[] = [...byStrike.entries()]
    .sort(([a], [b]) => a - b)
    .map(([strike, group]) => ({
      strike, log_moneyness: Math.log(strike / geometryForward),
      observation_count: group.length,
      call_count: group.filter(o => o.option_type === "C").length,
      put_count: group.filter(o => o.option_type === "P").length,
      freshest_age_minutes: Math.min(...group.map(o => o.age_minutes)),
    }));
  const logMoneyness = observations.map(o => o.log_moneyness);
  const below = strikes.filter(s => s.strike < geometryForward).length;
  const above = strikes.filter(s => s.strike > geometryForward).length;

  return {
    expiry_timestamp_utc: first?.expiry_timestamp_utc ?? new Date(0).toISOString(),
    expiry_timestamp_ms: first?.expiry_timestamp_ms ?? 0,
    actual_dte_days: first?.actual_dte_days ?? 0,
    qualifying_trade_count: observations.length,
    unique_instrument_count: new Set(observations.map(o => o.instrument_name)).size,
    unique_strike_count: byStrike.size,
    call_count: observations.filter(o => o.option_type === "C").length,
    put_count: observations.filter(o => o.option_type === "P").length,
    freshest_age_minutes: ages.length ? ages[0]! : null,
    median_age_minutes: quantile(ages, 0.5),
    p95_age_minutes: quantile(ages, 0.95),
    min_log_moneyness: logMoneyness.length ? Math.min(...logMoneyness) : null,
    max_log_moneyness: logMoneyness.length ? Math.max(...logMoneyness) : null,
    min_strike: strikes.length ? strikes[0]!.strike : null,
    max_strike: strikes.length ? strikes[strikes.length - 1]!.strike : null,
    observations_below_atm: below, observations_above_atm: above,
    atm_bracketed: below > 0 && above > 0,
    strikes,
  };
}

/* ============================ leg classification ============================ */

export type LegEvidenceClass =
  | "exact_observed"
  | "interpolation_candidate"
  | "extrapolation_required"
  | "unidentifiable";

export interface LegEvidence {
  readonly leg: "short" | "long";
  readonly strike: number;
  readonly option_type: string | null;
  readonly instrument_name: string | null;
  readonly log_moneyness: number;
  readonly classification: LegEvidenceClass;
  /** A print on this exact contract, same option type, in the canonical window. */
  readonly exact_observation_count: number;
  readonly exact_observed: boolean;
  readonly inside_observed_strike_range: boolean;
  readonly nearest_observed_strike: number | null;
  readonly nearest_observed_strike_distance: number | null;
  readonly observed_strikes_below: number;
  readonly observed_strikes_above: number;
  readonly freshest_exact_age_minutes: number | null;
}

/**
 * Classify one candidate leg against an expiry's observed cross-section.
 *
 * The hierarchy is strictly geometric:
 *   exact_observed          -- this very contract printed.
 *   interpolation_candidate -- observed strikes bracket it on BOTH sides, so a
 *                              smile through the observations passes over it.
 *   extrapolation_required  -- observations exist but all sit on one side; any
 *                              value here is an extension beyond the evidence.
 *   unidentifiable          -- too little geometry to say anything.
 *
 * Bracketing is required on both sides deliberately. A single neighbouring
 * strike does not identify a smile, and calling that "interpolation" would
 * launder an extrapolation.
 */
export function classifyLeg(input: {
  readonly leg: "short" | "long";
  readonly strike: number;
  readonly optionType: string | null;
  readonly instrumentName: string | null;
  readonly underlyingPrice: number;
  readonly slice: ExpirySliceDiagnostics | null;
  readonly observations: readonly CrossSectionObservation[];
  readonly minimumStrikesPerSide?: number;
}): LegEvidence {
  const minimumPerSide = input.minimumStrikesPerSide ?? 1;
  const forward = input.observations[0]?.forward_price;
  const logMoneyness = forward && forward > 0 ? Math.log(input.strike / forward) : Number.NaN;
  const base = {
    leg: input.leg, strike: input.strike, option_type: input.optionType,
    instrument_name: input.instrumentName, log_moneyness: logMoneyness,
  } as const;

  const sameType = input.observations.filter(o =>
    input.optionType === null || o.option_type === input.optionType);
  const exact = sameType.filter(o =>
    input.instrumentName !== null ? o.instrument_name === input.instrumentName : o.strike === input.strike);
  const strikes = input.slice?.strikes ?? [];
  const below = strikes.filter(s => s.strike < input.strike).length;
  const above = strikes.filter(s => s.strike > input.strike).length;
  const nearest = strikes.length
    ? strikes.reduce((best, s) =>
      Math.abs(s.strike - input.strike) < Math.abs(best.strike - input.strike) ? s : best)
    : null;
  const inRange = Boolean(input.slice?.min_strike !== null && input.slice?.max_strike !== null
    && input.strike >= (input.slice?.min_strike ?? Infinity)
    && input.strike <= (input.slice?.max_strike ?? -Infinity));

  const classification: LegEvidenceClass =
    exact.length ? "exact_observed"
      : below >= minimumPerSide && above >= minimumPerSide ? "interpolation_candidate"
        : strikes.length ? "extrapolation_required"
          : "unidentifiable";

  return {
    ...base, classification,
    exact_observation_count: exact.length,
    exact_observed: exact.length > 0,
    inside_observed_strike_range: inRange,
    nearest_observed_strike: nearest?.strike ?? null,
    nearest_observed_strike_distance: nearest ? Math.abs(nearest.strike - input.strike) : null,
    observed_strikes_below: below, observed_strikes_above: above,
    freshest_exact_age_minutes: exact.length ? Math.min(...exact.map(o => o.age_minutes)) : null,
  };
}

/* ============================ readiness classes ============================ */

export type SurfaceReadinessClass =
  | "same_expiry_dense"
  | "same_expiry_sparse"
  | "cross_expiry_supported"
  | "extrapolation_required"
  | "surface_unidentifiable";

/**
 * Provisional geometric thresholds.
 *
 * These are CONSERVATIVE placeholders, not optimal values, and they were not
 * derived from strategy results. `DENSE_MINIMUM_STRIKES = 5` is the smallest
 * count at which a three-parameter smile through the relevant region is not
 * trivially saturated; `DENSE_MINIMUM_PER_SIDE = 2` requires genuine two-sided
 * support around each relevant strike rather than one lucky neighbour. Every
 * underlying count is reported alongside the class, so a later phase can
 * re-derive thresholds from fit quality instead of from these guesses.
 */
export const DENSE_MINIMUM_STRIKES = 5 as const;
export const DENSE_MINIMUM_PER_SIDE = 2 as const;
export const SPARSE_MINIMUM_STRIKES = 2 as const;
/** Adjacent maturities usable as cross-expiry (SSVI-style) support. */
export const CROSS_EXPIRY_MINIMUM_STRIKES = 4 as const;

export interface ReadinessInput {
  readonly slice: ExpirySliceDiagnostics | null;
  readonly legs: readonly LegEvidence[];
  /** Slices at other listed expiries at the same target, for cross-expiry support. */
  readonly adjacentSlices: readonly ExpirySliceDiagnostics[];
}

export interface ReadinessVerdict {
  readonly readiness: SurfaceReadinessClass;
  readonly rationale: string;
  readonly same_expiry_strike_count: number;
  readonly adjacent_usable_expiry_count: number;
  readonly all_legs_inside_observed_range: boolean;
  readonly any_leg_extrapolation_required: boolean;
  readonly all_legs_exact_observed: boolean;
  readonly method_version: string;
}

/**
 * Deterministic readiness verdict. The order of tests is the definition.
 *
 * Extrapolation outranks density: a slice with twenty strikes that all sit below
 * the short leg still cannot value that leg without extending past its evidence,
 * and reporting it as "dense" would hide exactly the case we are trying to
 * count. Cross-expiry support is only offered when the same expiry is too thin,
 * never as a rescue for a strike outside the observed range -- borrowing a
 * neighbouring maturity does not create strike information that never existed.
 */
export function classifySurfaceReadiness(input: ReadinessInput): ReadinessVerdict {
  const strikeCount = input.slice?.unique_strike_count ?? 0;
  const adjacentUsable = input.adjacentSlices
    .filter(s => s.unique_strike_count >= CROSS_EXPIRY_MINIMUM_STRIKES && s.atm_bracketed).length;
  const legs = input.legs;
  const anyExtrapolation = legs.some(l => l.classification === "extrapolation_required");
  const allExact = legs.length > 0 && legs.every(l => l.classification === "exact_observed");
  const allInRange = legs.length > 0 && legs.every(l => l.inside_observed_strike_range);
  const denseAroundLegs = legs.length > 0 && legs.every(l =>
    l.classification === "exact_observed"
    || (l.observed_strikes_below >= DENSE_MINIMUM_PER_SIDE && l.observed_strikes_above >= DENSE_MINIMUM_PER_SIDE));

  const verdict = (readiness: SurfaceReadinessClass, rationale: string): ReadinessVerdict => ({
    readiness, rationale,
    same_expiry_strike_count: strikeCount,
    adjacent_usable_expiry_count: adjacentUsable,
    all_legs_inside_observed_range: allInRange,
    any_leg_extrapolation_required: anyExtrapolation,
    all_legs_exact_observed: allExact,
    method_version: SURFACE_READINESS_METHOD_VERSION,
  });

  if (!strikeCount && !adjacentUsable)
    return verdict("surface_unidentifiable", "No qualifying same-expiry observations and no usable adjacent maturity.");
  if (legs.some(l => l.classification === "unidentifiable") && !adjacentUsable)
    return verdict("surface_unidentifiable", "A relevant leg has no observed strike geometry at all.");
  if (anyExtrapolation)
    return verdict("extrapolation_required",
      `At least one relevant strike lies outside the observed strike range (${strikeCount} same-expiry strikes).`);
  if (strikeCount >= DENSE_MINIMUM_STRIKES && denseAroundLegs)
    return verdict("same_expiry_dense",
      `${strikeCount} same-expiry strikes with at least ${DENSE_MINIMUM_PER_SIDE} observed strikes on each side of every relevant leg.`);
  if (strikeCount >= SPARSE_MINIMUM_STRIKES)
    return verdict("same_expiry_sparse",
      `${strikeCount} same-expiry strikes: usable, but the geometry around the relevant legs is weak.`);
  if (adjacentUsable)
    return verdict("cross_expiry_supported",
      `Same-expiry evidence is too thin (${strikeCount} strikes); ${adjacentUsable} adjacent maturities carry usable cross-sections.`);
  return verdict("surface_unidentifiable", `Only ${strikeCount} same-expiry strikes and no usable adjacent maturity.`);
}

/* ============================ maturity coverage ============================ */

export interface MaturityCoverage {
  readonly usable_expiry_count: number;
  readonly actual_dte_span_days: number | null;
  readonly nearest_expiry_below_utc: string | null;
  readonly nearest_expiry_below_dte_days: number | null;
  readonly nearest_expiry_above_utc: string | null;
  readonly nearest_expiry_above_dte_days: number | null;
  readonly target_expiry_bracketed_in_maturity: boolean;
  /** Gaps between consecutive usable maturities, in days. */
  readonly maturity_gaps_days: readonly number[];
  readonly largest_maturity_gap_days: number | null;
}

/**
 * Maturity geometry around one target expiry.
 *
 * SSVI ties maturities together, so whether the selected expiry is BRACKETED in
 * maturity -- a usable slice both nearer and further out -- decides whether a
 * term-structure model could inform it, or would have to extrapolate in time.
 */
export function maturityCoverage(
  slices: readonly ExpirySliceDiagnostics[],
  targetExpiryMs: number,
  minimumStrikes = CROSS_EXPIRY_MINIMUM_STRIKES,
): MaturityCoverage {
  const usable = slices
    .filter(s => s.unique_strike_count >= minimumStrikes)
    .sort((a, b) => a.expiry_timestamp_ms - b.expiry_timestamp_ms);
  const below = usable.filter(s => s.expiry_timestamp_ms < targetExpiryMs).at(-1) ?? null;
  const above = usable.find(s => s.expiry_timestamp_ms > targetExpiryMs) ?? null;
  const dtes = usable.map(s => s.actual_dte_days);
  const gaps = usable.slice(1).map((s, i) => s.actual_dte_days - usable[i]!.actual_dte_days);

  return {
    usable_expiry_count: usable.length,
    actual_dte_span_days: dtes.length ? Math.max(...dtes) - Math.min(...dtes) : null,
    nearest_expiry_below_utc: below?.expiry_timestamp_utc ?? null,
    nearest_expiry_below_dte_days: below?.actual_dte_days ?? null,
    nearest_expiry_above_utc: above?.expiry_timestamp_utc ?? null,
    nearest_expiry_above_dte_days: above?.actual_dte_days ?? null,
    target_expiry_bracketed_in_maturity: below !== null && above !== null,
    maturity_gaps_days: gaps,
    largest_maturity_gap_days: gaps.length ? Math.max(...gaps) : null,
  };
}

/* ============================ snapshots ============================ */

export interface SurfaceSnapshot {
  readonly snapshot_id: string;
  readonly dataset_id: string;
  readonly method_version: string;
  readonly readiness_method_version: string;
  readonly target_timestamp_utc: string;
  readonly target_timestamp_ms: number;
  readonly underlying_price: number;
  readonly forward_convention: string;
  readonly source_host: string;
  readonly max_age_minutes: number;
  readonly diagnostic_age_minutes: number;
  readonly log_moneyness_envelope: number | null;
  readonly excluded_by_envelope: number;
  readonly duplicates_removed: number;
  readonly admitted_count: number;
  readonly rejected: Readonly<Partial<Record<MarketIvRejectionCode, number>>>;
  readonly observations: readonly CrossSectionObservation[];
  readonly slices: readonly ExpirySliceDiagnostics[];
  readonly content_hash: string;
}

/**
 * Content hash over the OBSERVATIONS only.
 *
 * Diagnostics are derived, so hashing them too would make the identity change
 * for a pure refactor of the diagnostics while the evidence stayed identical.
 * The hash answers exactly one question: is this the same evidence?
 */
export function snapshotContentHash(observations: readonly CrossSectionObservation[]): string {
  return contentHash([...observations]
    .map(o => [o.instrument_name, o.trade_id, o.timestamp_ms, o.iv_api_percentage, o.index_price,o.forward_price])
    .sort((a, b) => String(a).localeCompare(String(b))));
}

export const snapshotId = (targetTimestampMs: number, contentHashValue: string): string =>
  `${HISTORICAL_OPTION_IV_DATASET_ID}~${new Date(targetTimestampMs).toISOString()}~${contentHashValue}`;

/** Build one deterministic causal surface snapshot at a target timestamp. */
export function buildSurfaceSnapshot(input: {
  readonly prints: readonly RawOptionPrint[];
  readonly targetTimestampMs: number;
  readonly underlyingPrice: number;
  readonly sourceHost: string;
  readonly maxAgeMinutes?: number;
  readonly diagnosticAgeMinutes?: number;
  readonly logMoneynessEnvelope?: number | null;
  readonly excludedInstruments?: readonly string[];
}): SurfaceSnapshot {
  const maxAge = input.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES;
  const diagnosticAge = input.diagnosticAgeMinutes ?? MARKET_IV_DIAGNOSTIC_AGE_MINUTES;
  const admission = admitCrossSection({
    prints: input.prints, targetTimestampMs: input.targetTimestampMs,
    underlyingPrice: input.underlyingPrice, sourceHost: input.sourceHost,
    maxAgeMinutes: maxAge, diagnosticAgeMinutes: diagnosticAge,
    excludedInstruments: input.excludedInstruments,
    logMoneynessEnvelope: input.logMoneynessEnvelope ?? null,
  });

  const byExpiry = new Map<number, CrossSectionObservation[]>();
  for (const o of admission.observations) {
    const list = byExpiry.get(o.expiry_timestamp_ms);
    if (list) list.push(o); else byExpiry.set(o.expiry_timestamp_ms, [o]);
  }
  const slices = [...byExpiry.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => expirySliceDiagnostics(group, input.underlyingPrice));

  const hash = snapshotContentHash(admission.observations);
  return {
    snapshot_id: snapshotId(input.targetTimestampMs, hash),
    dataset_id: HISTORICAL_OPTION_IV_DATASET_ID,
    method_version: CROSS_SECTION_METHOD_VERSION,
    readiness_method_version: SURFACE_READINESS_METHOD_VERSION,
    target_timestamp_utc: new Date(input.targetTimestampMs).toISOString(),
    target_timestamp_ms: input.targetTimestampMs,
    underlying_price: input.underlyingPrice,
    forward_convention: FORWARD_CONVENTION,
    source_host: input.sourceHost,
    max_age_minutes: maxAge, diagnostic_age_minutes: diagnosticAge,
    log_moneyness_envelope: input.logMoneynessEnvelope ?? null,
    excluded_by_envelope: admission.excludedByEnvelope,
    duplicates_removed: admission.duplicatesRemoved,
    admitted_count: admission.admitted,
    rejected: admission.rejected,
    observations: admission.observations,
    slices,
    content_hash: hash,
  };
}

/**
 * Rebuild a snapshot from already-admitted cached observations.
 *
 * The shard cache stores the snapshot header and its observations separately,
 * so a later phase can reconstitute the exact evidence a snapshot was built
 * from. Admission is NOT re-run: these rows already passed it, and re-admitting
 * them against a freshly supplied underlying could silently change the set.
 * The content hash is recomputed and must match the stored one, which is what
 * makes "the frozen cohort" a checkable claim rather than an assertion.
 */
export function snapshotFromObservations(
  header: Omit<SurfaceSnapshot, "observations" | "slices">,
  observations: readonly CrossSectionObservation[],
): SurfaceSnapshot {
  const byExpiry = new Map<number, CrossSectionObservation[]>();
  for (const o of observations) {
    const list = byExpiry.get(o.expiry_timestamp_ms);
    if (list) list.push(o); else byExpiry.set(o.expiry_timestamp_ms, [o]);
  }
  const slices = [...byExpiry.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => expirySliceDiagnostics(group, header.underlying_price));
  return {...header, observations, slices};
}

/** The slice for one expiry, or null when that expiry produced no observations. */
export const sliceFor = (snapshot: SurfaceSnapshot, expiryMs: number): ExpirySliceDiagnostics | null =>
  snapshot.slices.find(s => s.expiry_timestamp_ms === expiryMs) ?? null;

export const observationsFor = (snapshot: SurfaceSnapshot, expiryMs: number): CrossSectionObservation[] =>
  snapshot.observations.filter(o => o.expiry_timestamp_ms === expiryMs);
