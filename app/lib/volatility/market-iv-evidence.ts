/**
 * The MARKET-IV EVIDENCE domain.
 *
 * This module exists to make one class of mistake structurally difficult: a
 * value produced by the option PRICING model being consumed as though it were
 * evidence of what the market's implied volatility was.
 *
 * Two domains, deliberately kept apart:
 *
 *   A. PRICING IV -- what the valuation model uses. Its legitimate states are
 *      `local-observed-IV`, `constant-entry-IV`, `intrinsic-at-expiry` and
 *      `unavailable` (see `ModelIvSource` in research-valuation.ts). A
 *      constant-entry carry-forward is a statement about the MODEL having
 *      nothing newer, never a statement that market IV was unchanged.
 *
 *   B. MARKET IV EVIDENCE -- what the historical tape supports at a timestamp.
 *      Only a real Deribit trade print carrying exchange-supplied IV qualifies,
 *      plus interpolation whose every input is itself such a print.
 *
 * ENFORCEMENT, NOT CONVENTION. An admitted observation carries a brand that
 * only `admitMarketIvTrade` can attach, so a downstream consumer cannot be
 * handed a hand-built object that merely looks right, and `assertMarketEvidence`
 * gives a runtime backstop at every domain boundary. Rejections are typed and
 * carry a reason code rather than collapsing to null.
 *
 * Thresholds here are LOCKED by the Phase-2A methodology audit and must not be
 * tuned against MR outcomes. Changing one requires a method-version bump.
 */

export const MARKET_IV_METHOD_VERSION = "market-iv-evidence-v1" as const;

/**
 * Market-state staleness. Deliberately NOT the pricing model's 720-minute
 * anchor age: that exists so a mark can be produced at all, whereas a claim
 * about market state needs far tighter evidence. The audit measured a freshest
 * near-ATM observation of 2-7 minutes and a bracketing pair inside 60 minutes at
 * every sampled timestamp.
 */
export const MARKET_IV_MAX_AGE_MINUTES = 60 as const;
/** Recorded for coverage analysis only. It never changes canonical availability. */
export const MARKET_IV_DIAGNOSTIC_AGE_MINUTES = 240 as const;
/** |ln(K/S)| envelope for a nearest-strike reference. */
export const MARKET_IV_MONEYNESS_TOLERANCE = 0.05 as const;

/** Nominal tenor labels and their locked actual-DTE tolerances, in days. */
export const NOMINAL_TENORS = {
  "7d": {nominalDays: 7, toleranceDays: 3},
  "14d": {nominalDays: 14, toleranceDays: 4},
  "30d": {nominalDays: 30, toleranceDays: 8},
} as const;
export type NominalTenor = keyof typeof NOMINAL_TENORS;

/**
 * IV source labels that are PRICING states. A value carrying any of these is a
 * model output and can never be market evidence, however well-formed it looks.
 */
export const MODEL_ONLY_IV_SOURCES: readonly string[] = Object.freeze([
  "constant-entry-IV",
  "intrinsic-at-expiry",
  "model-reconstructed",
  "model_anchor",
  "surface_extrapolation",
  "dvol_anchored_smile_proxy",
  "unavailable",
]);

/** `legVolatility.observation` values that are not market evidence. */
export const MODEL_ONLY_OBSERVATION_CLASSES: readonly string[] = Object.freeze([
  "reconstructed",
  "unavailable",
]);

export type MarketObservationClass = "exact_atm" | "nearest_strike_reference" | "local_interpolation";

export type MarketIvRejectionCode =
  | "iv_source_is_model"
  | "observation_reconstructed"
  | "iv_from_model_price"
  | "intrinsic_at_expiry"
  | "future_observation"
  | "stale_beyond_max_age"
  | "contract_not_listed_at_target"
  | "expiry_not_after_target"
  | "missing_iv"
  | "non_positive_iv"
  | "missing_index_price"
  | "self_leg_excluded"
  | "moneyness_outside_tolerance"
  | "no_qualifying_observation"
  | "interpolation_inputs_not_bracketing"
  | "interpolation_input_not_observed"
  | "extrapolation_refused"
  | "tenor_tolerance_failed"
  | "dvol_cannot_substitute";

/** Attached only by `admitMarketIvTrade`. Not exported, so it cannot be forged. */
const MARKET_EVIDENCE_BRAND: unique symbol = Symbol("market-iv-evidence");

/** A single real exchange print admitted as market evidence. */
export interface AdmittedIvTrade {
  readonly [MARKET_EVIDENCE_BRAND]: true;
  readonly instrumentName: string;
  readonly tradeId: string | null;
  readonly tradeSeq: number | null;
  readonly strike: number;
  readonly optionType: "C" | "P";
  readonly expiryTimestampMs: number;
  readonly settlementPeriod: string | null;
  readonly contractCreatedAtMs: number | null;
  readonly observationTimestampMs: number;
  readonly targetTimestampMs: number;
  readonly ageMinutes: number;
  readonly ivDecimal: number;
  readonly ivApiPercent: number;
  readonly indexPrice: number;
  readonly underlyingPrice: number;
  readonly logMoneyness: number;
  readonly actualDteDays: number;
}

export interface MarketIvRejection {
  readonly admitted: false;
  readonly code: MarketIvRejectionCode;
  readonly detail: string;
}
export type MarketIvAdmission = {readonly admitted: true; readonly observation: AdmittedIvTrade} | MarketIvRejection;

const reject = (code: MarketIvRejectionCode, detail: string): MarketIvRejection => ({admitted: false, code, detail});
const finite = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

/** A raw candidate print, before admission. Shapes match the Deribit tape. */
export interface RawIvTradeCandidate {
  readonly instrumentName: string;
  readonly tradeId?: string | null;
  readonly tradeSeq?: number | null;
  readonly strike: number;
  readonly optionType: "C" | "P";
  readonly expiryTimestampMs: number;
  readonly settlementPeriod?: string | null;
  /** Deribit `creation_timestamp`. A contract is not evidence before it existed. */
  readonly contractCreatedAtMs?: number | null;
  readonly timestampMs: number;
  /** Exchange-supplied IV, percent (Deribit `iv`). */
  readonly ivApiPercent?: number | null;
  /** Normalized decimal, when the caller already converted. */
  readonly ivDecimal?: number | null;
  readonly indexPrice?: number | null;
  /**
   * Provenance of the IV. Anything in MODEL_ONLY_IV_SOURCES is refused. A raw
   * exchange print normally carries no source at all, which is fine.
   */
  readonly ivSource?: string | null;
  /** `legVolatility.observation`, when the candidate came from that plumbing. */
  readonly observation?: string | null;
  /** True when the IV was recovered by inverting a model price. Always refused. */
  readonly impliedFromModelPrice?: boolean;
}

export interface AdmissionContext {
  readonly targetTimestampMs: number;
  /** Causal underlying at the target. Used for log-moneyness. */
  readonly underlyingPrice: number;
  readonly maxAgeMinutes?: number;
  /**
   * Instruments excluded to keep a reference self-reference-safe -- typically
   * the subject structure's own short and long legs.
   */
  readonly excludedInstruments?: readonly string[];
}

/**
 * The single gate into the market-evidence domain.
 *
 * Every rejection below corresponds to a circularity or causality rule from the
 * methodology audit; none is advisory.
 */
export function admitMarketIvTrade(candidate: RawIvTradeCandidate, context: AdmissionContext): MarketIvAdmission {
  const target = context.targetTimestampMs;
  const maxAge = context.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES;

  // --- circularity: model output can never become market evidence ---
  if (candidate.impliedFromModelPrice === true)
    return reject("iv_from_model_price", "The IV was recovered by inverting a model-generated price, so it returns the model's own input.");
  const source = typeof candidate.ivSource === "string" ? candidate.ivSource : null;
  if (source !== null && MODEL_ONLY_IV_SOURCES.includes(source))
    return reject(source === "intrinsic-at-expiry" ? "intrinsic_at_expiry" : "iv_source_is_model",
      `IV source ${JSON.stringify(source)} is a pricing-model state, not a market observation.`);
  const observation = typeof candidate.observation === "string" ? candidate.observation : null;
  if (observation !== null && MODEL_ONLY_OBSERVATION_CLASSES.includes(observation))
    return reject("observation_reconstructed", `Observation class ${JSON.stringify(observation)} is model-reconstructed.`);

  // --- self-reference exclusion ---
  if (context.excludedInstruments?.includes(candidate.instrumentName))
    return reject("self_leg_excluded", `${candidate.instrumentName} is excluded to keep this reference self-reference-safe.`);

  // --- causality ---
  const observed = finite(candidate.timestampMs);
  if (observed === null) return reject("missing_iv", "The candidate carries no usable observation timestamp.");
  if (observed > target) return reject("future_observation", "The observation is later than the target timestamp.");
  const ageMinutes = (target - observed) / 60_000;
  if (ageMinutes > maxAge)
    return reject("stale_beyond_max_age", `Observation is ${ageMinutes.toFixed(1)} minutes old; the market-state rule permits ${maxAge}.`);

  // --- contract existence ---
  const created = finite(candidate.contractCreatedAtMs);
  if (created !== null && created > target)
    return reject("contract_not_listed_at_target", `${candidate.instrumentName} was listed at ${new Date(created).toISOString()}, after the target.`);
  const expiry = finite(candidate.expiryTimestampMs);
  if (expiry === null || expiry <= target)
    return reject("expiry_not_after_target", "The contract had already expired at the target timestamp.");

  // --- value sanity ---
  const percent = finite(candidate.ivApiPercent);
  const decimal = finite(candidate.ivDecimal) ?? (percent === null ? null : percent / 100);
  if (decimal === null) return reject("missing_iv", "The print carries no exchange-supplied implied volatility.");
  if (decimal <= 0) return reject("non_positive_iv", "Implied volatility must be strictly positive.");
  const index = finite(candidate.indexPrice);
  if (index === null || index <= 0) return reject("missing_index_price", "The print carries no positive index price.");
  const underlying = finite(context.underlyingPrice);
  if (underlying === null || underlying <= 0) return reject("missing_index_price", "No positive causal underlying price was supplied for the target.");
  const strike = finite(candidate.strike);
  if (strike === null || strike <= 0) return reject("missing_index_price", "The contract carries no positive strike.");

  return {
    admitted: true,
    observation: {
      [MARKET_EVIDENCE_BRAND]: true,
      instrumentName: candidate.instrumentName,
      tradeId: candidate.tradeId ?? null,
      tradeSeq: finite(candidate.tradeSeq),
      strike, optionType: candidate.optionType,
      expiryTimestampMs: expiry,
      settlementPeriod: candidate.settlementPeriod ?? null,
      contractCreatedAtMs: created,
      observationTimestampMs: observed,
      targetTimestampMs: target,
      ageMinutes,
      ivDecimal: decimal,
      ivApiPercent: percent ?? decimal * 100,
      indexPrice: index,
      underlyingPrice: underlying,
      logMoneyness: Math.log(strike / underlying),
      actualDteDays: (expiry - target) / 86_400_000,
    },
  };
}

/** Runtime backstop at a domain boundary. Throws rather than degrading quietly. */
export function assertMarketEvidence(value: unknown, context: string): asserts value is AdmittedIvTrade {
  if (!value || typeof value !== "object" || (value as Record<PropertyKey, unknown>)[MARKET_EVIDENCE_BRAND] !== true)
    throw new Error(`${context} received a value that was never admitted as market IV evidence. Only admitMarketIvTrade may produce one.`);
}
export function isMarketEvidence(value: unknown): value is AdmittedIvTrade {
  return Boolean(value) && typeof value === "object" && (value as Record<PropertyKey, unknown>)[MARKET_EVIDENCE_BRAND] === true;
}

/* ============================ reference resolution ============================ */

export interface ReferenceIvInterpolationInput {
  readonly instrumentName: string;
  readonly tradeId: string | null;
  readonly strike: number;
  readonly logMoneyness: number;
  readonly ivDecimal: number;
  readonly observationTimestampMs: number;
  readonly ageMinutes: number;
}

export interface ReferenceIvResult {
  readonly status: "available" | "unavailable";
  readonly observationClass: MarketObservationClass | null;
  readonly ivDecimal: number | null;
  readonly referenceStrike: number | null;
  readonly logMoneyness: number | null;
  readonly observationTimestampMs: number | null;
  readonly ageMinutes: number | null;
  readonly maxAgeMinutes: number;
  readonly passesMarketStateRule: boolean;
  readonly underlyingPrice: number | null;
  readonly expiryTimestampMs: number | null;
  readonly actualDteDays: number | null;
  readonly sourceTradeIds: readonly string[];
  readonly interpolationInputs: readonly ReferenceIvInterpolationInput[];
  readonly ownLegsExcluded: boolean;
  readonly reasonCode: MarketIvRejectionCode | null;
  readonly methodVersion: string;
}

const asInput = (o: AdmittedIvTrade): ReferenceIvInterpolationInput => ({
  instrumentName: o.instrumentName, tradeId: o.tradeId, strike: o.strike,
  logMoneyness: o.logMoneyness, ivDecimal: o.ivDecimal,
  observationTimestampMs: o.observationTimestampMs, ageMinutes: o.ageMinutes,
});

const unavailableReference = (code: MarketIvRejectionCode, maxAge: number, ownLegsExcluded: boolean): ReferenceIvResult => ({
  status: "unavailable", observationClass: null, ivDecimal: null, referenceStrike: null,
  logMoneyness: null, observationTimestampMs: null, ageMinutes: null, maxAgeMinutes: maxAge,
  passesMarketStateRule: false, underlyingPrice: null, expiryTimestampMs: null, actualDteDays: null,
  sourceTradeIds: [], interpolationInputs: [], ownLegsExcluded, reasonCode: code,
  methodVersion: MARKET_IV_METHOD_VERSION,
});

/**
 * Resolve the reference IV for one expiry at one target, by the locked
 * hierarchy: exact ATM strike, then nearest admissible strike inside the
 * moneyness envelope, then interpolation between two bracketing observations.
 * Extrapolation is refused outright.
 *
 * `observations` must already have passed `admitMarketIvTrade`; the brand is
 * re-checked here so a consumer cannot bypass admission.
 */
export function resolveReferenceIv(
  observations: readonly AdmittedIvTrade[],
  input: {
    readonly underlyingPrice: number;
    readonly listedStrikes: readonly number[];
    readonly maxAgeMinutes?: number;
    readonly moneynessTolerance?: number;
    readonly ownLegsExcluded?: boolean;
  },
): ReferenceIvResult {
  const maxAge = input.maxAgeMinutes ?? MARKET_IV_MAX_AGE_MINUTES;
  const tolerance = input.moneynessTolerance ?? MARKET_IV_MONEYNESS_TOLERANCE;
  const ownLegsExcluded = input.ownLegsExcluded ?? false;
  for (const o of observations) assertMarketEvidence(o, "resolveReferenceIv");

  const usable = observations.filter(o => o.ageMinutes <= maxAge && o.ageMinutes >= 0);
  if (!usable.length) return unavailableReference("no_qualifying_observation", maxAge, ownLegsExcluded);

  const spot = input.underlyingPrice;
  // Freshest first, then deterministic by instrument then trade id.
  const rank = (a: AdmittedIvTrade, b: AdmittedIvTrade) =>
    a.ageMinutes - b.ageMinutes ||
    a.instrumentName.localeCompare(b.instrumentName) ||
    (a.tradeId ?? "").localeCompare(b.tradeId ?? "");

  const build = (o: AdmittedIvTrade, cls: MarketObservationClass): ReferenceIvResult => ({
    status: "available", observationClass: cls, ivDecimal: o.ivDecimal,
    referenceStrike: o.strike, logMoneyness: o.logMoneyness,
    observationTimestampMs: o.observationTimestampMs, ageMinutes: o.ageMinutes,
    maxAgeMinutes: maxAge, passesMarketStateRule: true,
    underlyingPrice: o.underlyingPrice, expiryTimestampMs: o.expiryTimestampMs,
    actualDteDays: o.actualDteDays,
    sourceTradeIds: o.tradeId ? [o.tradeId] : [], interpolationInputs: [asInput(o)],
    ownLegsExcluded, reasonCode: null, methodVersion: MARKET_IV_METHOD_VERSION,
  });

  // 1. exact ATM -- a print on the LISTED strike nearest the causal underlying.
  //    "At the money" means that strike, not a trade at exactly spot, which
  //    never happens.
  if (input.listedStrikes.length) {
    const atmStrike = [...input.listedStrikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b)[0]!;
    const atm = usable.filter(o => o.strike === atmStrike).sort(rank)[0];
    if (atm) return build(atm, "exact_atm");
  }

  // 2. nearest admissible strike inside the moneyness envelope.
  const inEnvelope = usable.filter(o => Math.abs(o.logMoneyness) <= tolerance);
  if (inEnvelope.length) {
    const nearest = [...inEnvelope].sort((a, b) =>
      Math.abs(a.logMoneyness) - Math.abs(b.logMoneyness) || rank(a, b))[0]!;
    return build(nearest, "nearest_strike_reference");
  }

  // 3. linear interpolation in log-moneyness between exactly two bracketing
  //    observed strikes. Never extrapolates.
  const below = usable.filter(o => o.logMoneyness <= 0).sort((a, b) => b.logMoneyness - a.logMoneyness || rank(a, b))[0];
  const above = usable.filter(o => o.logMoneyness >= 0).sort((a, b) => a.logMoneyness - b.logMoneyness || rank(a, b))[0];
  if (!below || !above) return unavailableReference("extrapolation_refused", maxAge, ownLegsExcluded);
  if (below.instrumentName === above.instrumentName)
    return unavailableReference("interpolation_inputs_not_bracketing", maxAge, ownLegsExcluded);

  const span = above.logMoneyness - below.logMoneyness;
  const weight = span === 0 ? 0 : (0 - below.logMoneyness) / span;
  const ivDecimal = below.ivDecimal + weight * (above.ivDecimal - below.ivDecimal);
  const age = Math.max(below.ageMinutes, above.ageMinutes);
  return {
    status: "available", observationClass: "local_interpolation", ivDecimal,
    referenceStrike: null, logMoneyness: 0,
    observationTimestampMs: Math.min(below.observationTimestampMs, above.observationTimestampMs),
    ageMinutes: age, maxAgeMinutes: maxAge, passesMarketStateRule: age <= maxAge,
    underlyingPrice: spot, expiryTimestampMs: below.expiryTimestampMs,
    actualDteDays: below.actualDteDays,
    sourceTradeIds: [below.tradeId, above.tradeId].filter((x): x is string => Boolean(x)),
    interpolationInputs: [asInput(below), asInput(above)],
    ownLegsExcluded, reasonCode: null, methodVersion: MARKET_IV_METHOD_VERSION,
  };
}

/* ============================ tenor resolution ============================ */

export interface TenorResolution {
  readonly nominal: NominalTenor;
  readonly nominalDays: number;
  readonly toleranceDays: number;
  readonly actualExpiryTimestampMs: number | null;
  readonly actualDteDays: number | null;
  readonly tenorTolerancePassed: boolean;
  readonly reasonCode: MarketIvRejectionCode | null;
}

/**
 * Pick the listed expiry nearest a nominal horizon, and state whether it falls
 * inside the locked tolerance.
 *
 * Deribit's cycle is Friday-anchored, so a nominal 7/14/30-day expiry frequently
 * does not exist: from a Monday entry the nearest weeklies sit at roughly 4.3
 * and 11.3 days. The actual expiry and actual DTE are therefore always carried,
 * and an out-of-tolerance match is reported as such rather than relabelled.
 */
export function resolveTenor(
  nominal: NominalTenor,
  targetTimestampMs: number,
  listedExpiries: readonly {expiryTimestampMs: number; createdAtMs?: number | null}[],
): TenorResolution {
  const {nominalDays, toleranceDays} = NOMINAL_TENORS[nominal];
  const admissible = listedExpiries
    .filter(e => e.expiryTimestampMs > targetTimestampMs)
    .filter(e => e.createdAtMs == null || e.createdAtMs <= targetTimestampMs);
  if (!admissible.length)
    return {nominal, nominalDays, toleranceDays, actualExpiryTimestampMs: null, actualDteDays: null,
      tenorTolerancePassed: false, reasonCode: "no_qualifying_observation"};
  const withDte = admissible.map(e => ({...e, dte: (e.expiryTimestampMs - targetTimestampMs) / 86_400_000}));
  const best = withDte.sort((a, b) =>
    Math.abs(a.dte - nominalDays) - Math.abs(b.dte - nominalDays) || a.expiryTimestampMs - b.expiryTimestampMs)[0]!;
  const passed = Math.abs(best.dte - nominalDays) <= toleranceDays;
  return {
    nominal, nominalDays, toleranceDays,
    actualExpiryTimestampMs: best.expiryTimestampMs, actualDteDays: best.dte,
    tenorTolerancePassed: passed,
    reasonCode: passed ? null : "tenor_tolerance_failed",
  };
}
