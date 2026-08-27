/**
 * Causal volatility-surface reconstruction models, for VALIDATION ONLY.
 *
 * Nothing here is promoted into production fair value. These are candidate
 * estimators to be scored against the frozen Phase 2A.3 holdouts; the current
 * local-IV reconstruction remains authoritative until one of them wins that
 * comparison on evidence.
 *
 * Three estimators share one interface so the comparison is apples-to-apples:
 *
 *   local_iv_anchor_v1              what production does today: the latest
 *                                   causal print on the SAME contract within
 *                                   720 minutes, repriced at the target index.
 *   same_expiry_linear_interpolation_v1
 *                                   deliberately simple: linear in total
 *                                   variance between the bracketing observed
 *                                   strikes. Never extrapolates.
 *   same_expiry_svi_v1              constrained, deterministic SVI in total
 *                                   variance.
 *
 * The interpolation baseline exists to answer the question that decides whether
 * SVI is worth its complexity: does SVI add anything beyond ordinary local
 * interpolation? A model that merely beats "no estimate at all" has proved
 * nothing.
 *
 * Every estimator is pure, deterministic and independent of strategy PnL. All
 * of them price through the existing `priceInverseOption`, so the project's
 * stated convention (forward = index, rate = 0) is preserved unchanged and no
 * new rate or forward assumption enters here.
 */

import {priceInverseOption} from "../inverse-option-pricing.ts";
import type {AggregatedStrikeObservation} from "./strike-aggregation.ts";

export const LOCAL_IV_ANCHOR_METHOD_VERSION = "local_iv_anchor_v2_expiry_forward" as const;
export const LINEAR_INTERPOLATION_METHOD_VERSION = "same_expiry_linear_interpolation_v2_expiry_forward" as const;
export const SVI_METHOD_VERSION = "same_expiry_svi_v1" as const;
export const SSVI_ESTIMATE_METHOD_VERSION = "ssvi_power_law_v1" as const;

/**
 * The production pricing-anchor age bound, mirrored from research-valuation.ts
 * (`MODEL_IV_ANCHOR_MAX_AGE_MINUTES`). It lives here rather than in a script so
 * that importing it cannot execute a retrieval run as a side effect.
 */
export const PRIOR_ANCHOR_MAX_AGE_MINUTES = 720 as const;

export type EstimateUnavailableReason =
  | "no_causal_anchor"
  | "target_outside_observed_strike_range"
  | "insufficient_observations"
  | "fit_did_not_converge"
  | "fit_economically_invalid"
  | "non_positive_total_variance"
  | "pricing_unavailable"
  | "forward_unavailable"
  | "surface_not_identifiable_final_day";

export interface SurfaceEstimate {
  readonly method_version: string;
  readonly status: "available" | "unavailable";
  readonly iv_decimal: number | null;
  readonly total_implied_variance: number | null;
  readonly price_btc: number | null;
  readonly price_usd: number | null;
  /** True when the target strike sits outside the observed strike range. */
  readonly is_extrapolation: boolean;
  readonly observation_count: number;
  readonly unavailable_reason: EstimateUnavailableReason | null;
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

export interface EstimationTarget {
  readonly strike: number;
  readonly optionType: "C" | "P";
  readonly logMoneyness: number;
  readonly timeToExpiryYears: number;
  readonly underlyingPrice: number;
  readonly forwardPrice?: number;
  readonly targetTimestampMs: number;
  readonly expiryTimestampMs: number;
}

const unavailable = (
  methodVersion: string, reason: EstimateUnavailableReason,
  observationCount: number, diagnostics: Record<string, unknown> = {},
): SurfaceEstimate => ({
  method_version: methodVersion, status: "unavailable", iv_decimal: null,
  total_implied_variance: null, price_btc: null, price_usd: null,
  is_extrapolation: false, observation_count: observationCount,
  unavailable_reason: reason, diagnostics,
});

/**
 * Turn an IV into a price through the EXISTING pricing function, so no new
 * pricing methodology is introduced by this experiment.
 */
function priced(
  methodVersion: string, iv: number, target: EstimationTarget,
  isExtrapolation: boolean, observationCount: number,
  diagnostics: Record<string, unknown>,
): SurfaceEstimate {
  if (!Number.isFinite(iv) || iv <= 0)
    return unavailable(methodVersion, "non_positive_total_variance", observationCount, diagnostics);
  if (!(target.forwardPrice && Number.isFinite(target.forwardPrice) && target.forwardPrice > 0))
    return unavailable(methodVersion, "forward_unavailable", observationCount, diagnostics);
  const result = priceInverseOption({
    optionType: target.optionType === "C" ? "call" : "put",
    indexPrice: target.underlyingPrice, strike: target.strike,
    valuationTimestamp: target.targetTimestampMs, expiryTimestamp: target.expiryTimestampMs,
    ivDecimal: iv, forwardPrice: target.forwardPrice,
  });
  if (result.status !== "priced")
    return unavailable(methodVersion, "pricing_unavailable", observationCount,
      {...diagnostics, pricing_reason: result.reason});
  return {
    method_version: methodVersion, status: "available", iv_decimal: iv,
    total_implied_variance: iv * iv * target.timeToExpiryYears,
    price_btc: result.priceBtc, price_usd: result.priceUsd,
    is_extrapolation: isExtrapolation, observation_count: observationCount,
    unavailable_reason: null, diagnostics,
  };
}

/* ==================== 1. current production: local IV anchor ==================== */

export interface PriorAnchor {
  readonly instrument_name: string;
  readonly iv_decimal: number;
  readonly timestamp_ms: number;
  readonly age_minutes: number;
}

/**
 * What the current research fair-value methodology would produce.
 *
 * `selectIvAnchor` takes the latest causal print on the SAME contract within
 * `MODEL_IV_ANCHOR_MAX_AGE_MINUTES` (720) and reprices it at the target index.
 * On a holdout the canonical-window prints are withheld, so this method sees
 * only prints between 60 and 720 minutes old — which is exactly the situation
 * it faces in production when a contract has not traded recently.
 *
 * With no such anchor it is `unavailable`. That is not a failure of the
 * comparison; it is the gap surface reconstruction exists to fill, and it must
 * be counted rather than excused.
 */
export function estimateLocalIvAnchor(
  anchor: PriorAnchor | null, target: EstimationTarget, maxAgeMinutes = 720,
): SurfaceEstimate {
  if (!anchor || !Number.isFinite(anchor.iv_decimal) || anchor.iv_decimal <= 0)
    return unavailable(LOCAL_IV_ANCHOR_METHOD_VERSION, "no_causal_anchor", 0,
      {max_age_minutes: maxAgeMinutes});
  if (anchor.age_minutes < 0 || anchor.age_minutes > maxAgeMinutes)
    return unavailable(LOCAL_IV_ANCHOR_METHOD_VERSION, "no_causal_anchor", 0,
      {anchor_age_minutes: anchor.age_minutes, max_age_minutes: maxAgeMinutes});
  return priced(LOCAL_IV_ANCHOR_METHOD_VERSION, anchor.iv_decimal, target, false, 1, {
    anchor_instrument: anchor.instrument_name,
    anchor_age_minutes: anchor.age_minutes,
    anchor_timestamp_ms: anchor.timestamp_ms,
    max_age_minutes: maxAgeMinutes,
  });
}

/* ==================== 2. simple interpolation baseline ==================== */

/**
 * Linear interpolation in total implied variance against log-moneyness, between
 * the two nearest bracketing observed strikes.
 *
 * Total variance rather than IV because `w = IV^2 * T` is the quantity that is
 * additive and (under no-arbitrage) monotone in maturity; interpolating IV
 * directly is a different and less defensible curve. `T` is constant across one
 * expiry slice, so this is a genuine choice of interpolation variable rather
 * than a rescaling.
 *
 * Never extrapolates: a target outside the observed range is `unavailable`. It
 * has no parameters, so there is nothing to tune on holdout results.
 */
export function estimateLinearInterpolation(
  points: readonly AggregatedStrikeObservation[], target: EstimationTarget,
): SurfaceEstimate {
  const usable = points
    .filter(p => Number.isFinite(p.total_implied_variance) && p.total_implied_variance > 0)
    .sort((a, b) => a.log_moneyness - b.log_moneyness);
  if (usable.length < 2)
    return unavailable(LINEAR_INTERPOLATION_METHOD_VERSION, "insufficient_observations", usable.length);

  const k = target.logMoneyness;
  // An exact strike match is the observation itself, not an interpolation.
  const exact = usable.filter(p => p.log_moneyness === k);
  if (exact.length) {
    const w = exact.reduce((s, p) => s + p.total_implied_variance, 0) / exact.length;
    return priced(LINEAR_INTERPOLATION_METHOD_VERSION,
      Math.sqrt(w / target.timeToExpiryYears), target, false, usable.length,
      {bracket: "exact_strike", strikes_used: exact.length});
  }

  const below = usable.filter(p => p.log_moneyness < k).at(-1);
  const above = usable.find(p => p.log_moneyness > k);
  if (!below || !above)
    return unavailable(LINEAR_INTERPOLATION_METHOD_VERSION, "target_outside_observed_strike_range",
      usable.length, {min_log_moneyness: usable[0]!.log_moneyness,
        max_log_moneyness: usable[usable.length - 1]!.log_moneyness, target_log_moneyness: k});

  const span = above.log_moneyness - below.log_moneyness;
  const weight = (k - below.log_moneyness) / span;
  const w = below.total_implied_variance + weight * (above.total_implied_variance - below.total_implied_variance);
  if (!(w > 0))
    return unavailable(LINEAR_INTERPOLATION_METHOD_VERSION, "non_positive_total_variance", usable.length);
  return priced(LINEAR_INTERPOLATION_METHOD_VERSION,
    Math.sqrt(w / target.timeToExpiryYears), target, false, usable.length, {
      bracket: "linear_in_total_variance",
      lower_strike: below.strike, upper_strike: above.strike,
      lower_log_moneyness: below.log_moneyness, upper_log_moneyness: above.log_moneyness,
      interpolation_weight: weight,
    });
}

/* ==================== 3. constrained SVI ==================== */

export interface SviParameters {
  readonly a: number; readonly b: number; readonly rho: number;
  readonly m: number; readonly sigma: number;
}

/** Raw SVI total variance: w(k) = a + b(rho(k-m) + sqrt((k-m)^2 + sigma^2)). */
export const sviTotalVariance = (p: SviParameters, k: number): number =>
  p.a + p.b * (p.rho * (k - p.m) + Math.sqrt((k - p.m) * (k - p.m) + p.sigma * p.sigma));

/**
 * Durrleman's no-butterfly-arbitrage function.
 *
 * A smile can fit the observed points beautifully and still imply a negative
 * risk-neutral density between them, which would price a butterfly at less than
 * zero. Checking only that the fit passes near the data would miss exactly that,
 * so `g` is evaluated across the whole relevant range and a violation makes the
 * fit unusable rather than merely noted.
 */
export function durrlemanG(p: SviParameters, k: number): number {
  const w = sviTotalVariance(p, k);
  if (!(w > 0)) return -1;
  const root = Math.sqrt((k - p.m) * (k - p.m) + p.sigma * p.sigma);
  const wPrime = p.b * (p.rho + (k - p.m) / root);
  const wDoublePrime = p.b * p.sigma * p.sigma / (root * root * root);
  const term = 1 - k * wPrime / (2 * w);
  return term * term - (wPrime * wPrime / 4) * (1 / w + 0.25) + wDoublePrime / 2;
}

export interface SviFitDiagnostics {
  readonly parameters: SviParameters | null;
  readonly converged: boolean;
  readonly objective: number | null;
  readonly observation_count: number;
  readonly log_moneyness_min: number | null;
  readonly log_moneyness_max: number | null;
  readonly log_moneyness_span: number | null;
  readonly rms_residual_total_variance: number | null;
  readonly max_absolute_residual_total_variance: number | null;
  readonly rms_residual_iv: number | null;
  readonly max_absolute_residual_iv: number | null;
  readonly min_durrleman_g: number | null;
  readonly butterfly_arbitrage_free: boolean;
  readonly minimum_total_variance: number | null;
  readonly warnings: readonly string[];
  readonly unavailable_reason: EstimateUnavailableReason | null;
  readonly method_version: string;
}

/** Minimum aggregated strikes for a five-parameter smile not to be saturated. */
export const SVI_MINIMUM_STRIKES = 5 as const;
/** Grid resolution for the deterministic outer search over (m, sigma). */
export const SVI_GRID_STEPS = 17 as const;
export const SVI_REFINEMENT_ROUNDS = 3 as const;
/** Durrleman check resolution across the extended fitting range. */
export const SVI_ARBITRAGE_GRID_STEPS = 101 as const;

/**
 * Solve the inner linear problem for fixed (m, sigma).
 *
 * With y = (k-m)/sigma the model is linear: w = a + d*y + c*sqrt(y^2+1), where
 * c = b*sigma and d = rho*b*sigma. The Zeliade quasi-explicit constraints
 * (0 <= c <= 4 sigma, |d| <= c, |d| <= 4 sigma - c, 0 <= a <= max w) keep the
 * solution economically valid, so this is a CONSTRAINED least squares rather
 * than an unconstrained fit that happens to look plausible.
 *
 * Deterministic throughout: an exact normal-equations solve, then, only if that
 * lands outside the feasible set, a fixed number of projected-gradient steps.
 * No randomness, no adaptive stopping, so the same inputs always give the same
 * parameters.
 */
function solveInner(
  k: readonly number[], w: readonly number[], weights: readonly number[],
  m: number, sigma: number,
): {a: number; d: number; c: number; objective: number} | null {
  const n = k.length;
  const y = k.map(x => (x - m) / sigma);
  const z = y.map(v => Math.sqrt(v * v + 1));
  const basis = (i: number): [number, number, number] => [1, y[i]!, z[i]!];

  // Weighted normal equations for the 3x3 system.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rhs = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    const g = basis(i), weight = weights[i]!;
    for (let r = 0; r < 3; r += 1) {
      rhs[r]! += weight * g[r]! * w[i]!;
      for (let cIdx = 0; cIdx < 3; cIdx += 1) A[r]![cIdx]! += weight * g[r]! * g[cIdx]!;
    }
  }
  const solved = solve3(A, rhs);
  const maxW = Math.max(...w);
  const objective = (a: number, d: number, c: number) => {
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      const residual = a + d * y[i]! + c * z[i]! - w[i]!;
      total += weights[i]! * residual * residual;
    }
    return total;
  };
  const project = (a: number, d: number, c: number): [number, number, number] => {
    const cc = Math.min(Math.max(c, 0), 4 * sigma);
    const bound = Math.min(cc, 4 * sigma - cc);
    const dd = Math.min(Math.max(d, -bound), bound);
    const aa = Math.min(Math.max(a, 0), Math.max(maxW, 1e-12));
    return [aa, dd, cc];
  };

  let [a, d, c] = solved ? project(solved[0]!, solved[1]!, solved[2]!) : project(maxW, 0, 0);
  if (solved) {
    const feasible = solved[0]! === a && solved[1]! === d && solved[2]! === c;
    if (!feasible) {
      // Projected gradient with a Lipschitz-derived fixed step. 400 iterations,
      // always 400, so the result never depends on a convergence race.
      let lipschitz = 0;
      for (let i = 0; i < n; i += 1) {
        const g = basis(i);
        lipschitz += weights[i]! * (g[0]! * g[0]! + g[1]! * g[1]! + g[2]! * g[2]!);
      }
      const step = lipschitz > 0 ? 1 / (2 * lipschitz) : 0;
      for (let iteration = 0; iteration < 400; iteration += 1) {
        let ga = 0, gd = 0, gc = 0;
        for (let i = 0; i < n; i += 1) {
          const residual = a + d * y[i]! + c * z[i]! - w[i]!;
          const weight = weights[i]!;
          ga += 2 * weight * residual;
          gd += 2 * weight * residual * y[i]!;
          gc += 2 * weight * residual * z[i]!;
        }
        [a, d, c] = project(a - step * ga, d - step * gd, c - step * gc);
      }
    }
  }
  const value = objective(a, d, c);
  return Number.isFinite(value) ? {a, d, c, objective: value} : null;
}

/** Gaussian elimination with partial pivoting on a 3x3 system. */
function solve3(A: number[][], b: number[]): number[] | null {
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < 3; r += 1) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-14) return null;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let r = 0; r < 3; r += 1) {
      if (r === col) continue;
      const factor = M[r]![col]! / M[col]![col]!;
      for (let cIdx = col; cIdx < 4; cIdx += 1) M[r]![cIdx]! -= factor * M[col]![cIdx]!;
    }
  }
  const out = [M[0]![3]! / M[0]![0]!, M[1]![3]! / M[1]![1]!, M[2]![3]! / M[2]![2]!];
  return out.every(Number.isFinite) ? out : null;
}

/**
 * Fit SVI to one expiry slice.
 *
 * Deterministic grid over (m, sigma) with an exactly-solved constrained inner
 * problem, then a fixed number of refinement rounds narrowing around the best
 * cell. A failed or economically invalid fit is `unavailable` — never forced to
 * converge, and never returned merely because the optimizer produced numbers.
 */
export function fitSvi(points: readonly AggregatedStrikeObservation[]): SviFitDiagnostics {
  const base = {method_version: SVI_METHOD_VERSION} as const;
  // Sorted canonically before anything is accumulated. Floating-point addition
  // is not associative, so an unsorted input would move the fit in the last few
  // bits purely with the order the caller happened to supply -- enough to break
  // a content hash or a reproducibility check for no reason.
  const usable = points.filter(p =>
    Number.isFinite(p.log_moneyness) && Number.isFinite(p.total_implied_variance) && p.total_implied_variance > 0)
    .slice()
    .sort((a, b) => a.log_moneyness - b.log_moneyness
      || a.option_type.localeCompare(b.option_type)
      || a.strike - b.strike);
  const distinctStrikes = new Set(usable.map(p => p.log_moneyness)).size;

  const fail = (reason: EstimateUnavailableReason, warnings: string[] = []): SviFitDiagnostics => ({
    ...base, parameters: null, converged: false, objective: null,
    observation_count: usable.length,
    log_moneyness_min: usable.length ? Math.min(...usable.map(p => p.log_moneyness)) : null,
    log_moneyness_max: usable.length ? Math.max(...usable.map(p => p.log_moneyness)) : null,
    log_moneyness_span: usable.length
      ? Math.max(...usable.map(p => p.log_moneyness)) - Math.min(...usable.map(p => p.log_moneyness)) : null,
    rms_residual_total_variance: null, max_absolute_residual_total_variance: null,
    rms_residual_iv: null, max_absolute_residual_iv: null,
    min_durrleman_g: null, butterfly_arbitrage_free: false, minimum_total_variance: null,
    warnings, unavailable_reason: reason,
  });

  if (distinctStrikes < SVI_MINIMUM_STRIKES) return fail("insufficient_observations",
    [`${distinctStrikes} distinct strikes is below the ${SVI_MINIMUM_STRIKES} needed for a five-parameter smile`]);

  const k = usable.map(p => p.log_moneyness);
  const w = usable.map(p => p.total_implied_variance);
  const weights = usable.map(p => p.fitting_weight);
  const kMin = Math.min(...k), kMax = Math.max(...k), span = kMax - kMin;
  const years = usable[0]!.time_to_expiry_years;

  let best: {a: number; d: number; c: number; objective: number; m: number; sigma: number} | null = null;
  let mLow = kMin - span, mHigh = kMax + span;
  let sigmaLow = Math.max(1e-4, span / 50), sigmaHigh = Math.max(span * 5, 1);

  for (let round = 0; round < SVI_REFINEMENT_ROUNDS; round += 1) {
    for (let i = 0; i < SVI_GRID_STEPS; i += 1) {
      const m = mLow + (mHigh - mLow) * i / (SVI_GRID_STEPS - 1);
      for (let j = 0; j < SVI_GRID_STEPS; j += 1) {
        // Geometric in sigma: scale matters more than absolute step here.
        const sigma = sigmaLow * Math.pow(sigmaHigh / sigmaLow, j / (SVI_GRID_STEPS - 1));
        const inner = solveInner(k, w, weights, m, sigma);
        if (!inner) continue;
        if (!best || inner.objective < best.objective) best = {...inner, m, sigma};
      }
    }
    if (!best) return fail("fit_did_not_converge", ["no feasible (m, sigma) cell produced a finite objective"]);
    const mStep = (mHigh - mLow) / (SVI_GRID_STEPS - 1);
    const sigmaRatio = Math.pow(sigmaHigh / sigmaLow, 1 / (SVI_GRID_STEPS - 1));
    mLow = best.m - mStep; mHigh = best.m + mStep;
    sigmaLow = Math.max(1e-5, best.sigma / sigmaRatio); sigmaHigh = best.sigma * sigmaRatio;
  }
  if (!best) return fail("fit_did_not_converge");

  const b = best.c / best.sigma;
  const rho = best.c === 0 ? 0 : best.d / best.c;
  const parameters: SviParameters = {a: best.a, b, rho, m: best.m, sigma: best.sigma};
  const warnings: string[] = [];

  if (!(b >= 0)) warnings.push("b is negative");
  if (!(Math.abs(rho) <= 1)) warnings.push("|rho| exceeds 1");
  if (!(best.sigma > 0)) warnings.push("sigma is not positive");
  const minimumW = parameters.a + parameters.b * parameters.sigma * Math.sqrt(Math.max(0, 1 - rho * rho));
  if (!(minimumW >= 0)) warnings.push("minimum total variance is negative");

  // Residuals in both spaces: total variance is what was fitted, IV is what a
  // reader can judge.
  let sumSquared = 0, maxAbsolute = 0, sumSquaredIv = 0, maxAbsoluteIv = 0;
  for (let i = 0; i < usable.length; i += 1) {
    const modelW = sviTotalVariance(parameters, k[i]!);
    const residual = modelW - w[i]!;
    sumSquared += residual * residual;
    maxAbsolute = Math.max(maxAbsolute, Math.abs(residual));
    const modelIv = modelW > 0 ? Math.sqrt(modelW / years) : 0;
    const ivResidual = modelIv - usable[i]!.iv_decimal;
    sumSquaredIv += ivResidual * ivResidual;
    maxAbsoluteIv = Math.max(maxAbsoluteIv, Math.abs(ivResidual));
  }

  // Durrleman across the observed range extended by one span each side, so the
  // check covers the region a wing estimate would actually use.
  let minG = Infinity;
  for (let i = 0; i < SVI_ARBITRAGE_GRID_STEPS; i += 1) {
    const kk = (kMin - span) + (kMax + span - (kMin - span)) * i / (SVI_ARBITRAGE_GRID_STEPS - 1);
    minG = Math.min(minG, durrlemanG(parameters, kk));
  }
  const arbitrageFree = minG >= 0;
  if (!arbitrageFree) warnings.push(`butterfly arbitrage: min Durrleman g = ${minG.toFixed(6)}`);

  const invalid = warnings.length > 0;
  return {
    ...base, parameters, converged: true, objective: best.objective,
    observation_count: usable.length,
    log_moneyness_min: kMin, log_moneyness_max: kMax, log_moneyness_span: span,
    rms_residual_total_variance: Math.sqrt(sumSquared / usable.length),
    max_absolute_residual_total_variance: maxAbsolute,
    rms_residual_iv: Math.sqrt(sumSquaredIv / usable.length),
    max_absolute_residual_iv: maxAbsoluteIv,
    min_durrleman_g: minG, butterfly_arbitrage_free: arbitrageFree,
    minimum_total_variance: minimumW,
    warnings,
    // An economically invalid fit is unusable. Returning it "with a warning"
    // would let a negative-density smile price a spread.
    unavailable_reason: invalid ? "fit_economically_invalid" : null,
  };
}

/** Evaluate a fitted SVI smile at one target. */
export function estimateSvi(
  fit: SviFitDiagnostics, points: readonly AggregatedStrikeObservation[], target: EstimationTarget,
): SurfaceEstimate {
  const diagnostics = {
    fit_objective: fit.objective, fit_warnings: fit.warnings,
    rms_residual_iv: fit.rms_residual_iv, min_durrleman_g: fit.min_durrleman_g,
    parameters: fit.parameters, log_moneyness_span: fit.log_moneyness_span,
  };
  if (!fit.parameters || fit.unavailable_reason)
    return unavailable(SVI_METHOD_VERSION, fit.unavailable_reason ?? "fit_did_not_converge",
      fit.observation_count, diagnostics);

  const strikes = points.map(p => p.log_moneyness);
  const isExtrapolation = strikes.length > 0
    && (target.logMoneyness < Math.min(...strikes) || target.logMoneyness > Math.max(...strikes));
  const w = sviTotalVariance(fit.parameters, target.logMoneyness);
  if (!(w > 0))
    return unavailable(SVI_METHOD_VERSION, "non_positive_total_variance", fit.observation_count, diagnostics);
  const iv = Math.sqrt(w / target.timeToExpiryYears);
  return priced(SVI_METHOD_VERSION, iv, target, isExtrapolation, fit.observation_count, {
    ...diagnostics,
    extrapolation_distance_log_moneyness: isExtrapolation
      ? Math.min(Math.abs(target.logMoneyness - Math.min(...strikes)),
        Math.abs(target.logMoneyness - Math.max(...strikes)))
      : 0,
  });
}

/* ==================== 4. SSVI, the wing competitor ==================== */

/**
 * Evaluate a fitted SSVI surface at one target.
 *
 * Structurally identical to the SVI evaluator so the comparison is fair: same
 * pricing function, same extrapolation labelling, same refusal on an
 * economically invalid fit. Only the source of the total variance differs.
 */
export function estimateSsvi(
  totalVariance: number | null,
  points: readonly AggregatedStrikeObservation[],
  target: EstimationTarget,
  diagnostics: Record<string, unknown>,
  unavailableReason: EstimateUnavailableReason | null,
): SurfaceEstimate {
  if (unavailableReason !== null || totalVariance === null)
    return unavailable(SSVI_ESTIMATE_METHOD_VERSION,
      unavailableReason ?? "non_positive_total_variance", points.length, diagnostics);
  const strikes = points.map(p => p.log_moneyness);
  const isExtrapolation = strikes.length > 0
    && (target.logMoneyness < Math.min(...strikes) || target.logMoneyness > Math.max(...strikes));
  const iv = Math.sqrt(totalVariance / target.timeToExpiryYears);
  return priced(SSVI_ESTIMATE_METHOD_VERSION, iv, target, isExtrapolation, points.length, {
    ...diagnostics,
    extrapolation_distance_log_moneyness: isExtrapolation
      ? Math.min(Math.abs(target.logMoneyness - Math.min(...strikes)),
        Math.abs(target.logMoneyness - Math.max(...strikes)))
      : 0,
  });
}

/* ==================== 5. the candidate hybrid ==================== */

export const HYBRID_METHOD_VERSION = "hybrid_bracketed_interpolation_anchor_v2_expiry_forward" as const;

/**
 * Structural eligibility rules for the interpolation tier.
 *
 * A small PREDECLARED family, not a hyperparameter search. Phase 2B observed
 * that interpolation behaves badly below about five same-expiry strikes, but
 * that observation came out of the validation results — so hard-coding five and
 * calling it validated would be fitting the rule to the answer. Testing three
 * simple rules answers a different and better question: does the hybrid stay
 * superior across a broad range of reasonable definitions, or only at one
 * number?
 *
 * If the conclusion reverses between adjacent rules, no rule is promoted.
 */
export type HybridGeometryRule = "rule_a_bracketed" | "rule_b_min_3_strikes" | "rule_c_min_5_strikes";

export const HYBRID_GEOMETRY_RULES: readonly HybridGeometryRule[] =
  ["rule_a_bracketed", "rule_b_min_3_strikes", "rule_c_min_5_strikes"];

export const HYBRID_RULE_MINIMUM_STRIKES: Readonly<Record<HybridGeometryRule, number>> = {
  rule_a_bracketed: 2,
  rule_b_min_3_strikes: 3,
  rule_c_min_5_strikes: 5,
};

export type HybridTier = "interpolation" | "local_anchor" | "unavailable";

export interface HybridEligibility {
  readonly eligible: boolean;
  readonly bracketed: boolean;
  readonly unique_strike_count: number;
  readonly minimum_required: number;
  readonly nearest_below_strike: number | null;
  readonly nearest_above_strike: number | null;
  readonly neighbour_distance_below: number | null;
  readonly neighbour_distance_above: number | null;
  readonly max_observation_age_minutes: number | null;
  readonly reason: string | null;
}

/**
 * Is the interpolation tier structurally eligible?
 *
 * Bracketing is required on BOTH sides — an exact strike match counts, since the
 * observation is then the answer. Anything else would be extrapolation wearing
 * an interpolation label, which §7 forbids outright and which Phase 2B measured
 * as unreliable under every method.
 */
export function hybridEligibility(
  points: readonly AggregatedStrikeObservation[],
  target: EstimationTarget,
  rule: HybridGeometryRule,
): HybridEligibility {
  const usable = points
    .filter(p => Number.isFinite(p.total_implied_variance) && p.total_implied_variance > 0)
    .sort((a, b) => a.log_moneyness - b.log_moneyness);
  const strikes = [...new Set(usable.map(p => p.strike))];
  const minimum = HYBRID_RULE_MINIMUM_STRIKES[rule];
  const k = target.logMoneyness;

  const exact = usable.some(p => p.log_moneyness === k);
  const below = usable.filter(p => p.log_moneyness < k).at(-1) ?? null;
  const above = usable.find(p => p.log_moneyness > k) ?? null;
  const bracketed = exact || (below !== null && above !== null);
  const ages = usable.map(p => p.effective_age_minutes);

  const base = {
    bracketed, unique_strike_count: strikes.length, minimum_required: minimum,
    nearest_below_strike: below?.strike ?? null, nearest_above_strike: above?.strike ?? null,
    neighbour_distance_below: below ? Math.abs(target.strike - below.strike) : null,
    neighbour_distance_above: above ? Math.abs(above.strike - target.strike) : null,
    max_observation_age_minutes: ages.length ? Math.max(...ages) : null,
  } as const;

  if (!usable.length) return {...base, eligible: false, reason: "no_qualifying_same_expiry_observations"};
  if (!bracketed) return {...base, eligible: false, reason: "target_not_bracketed"};
  if (strikes.length < minimum)
    return {...base, eligible: false, reason: `unique_strike_count_below_${minimum}`};
  return {...base, eligible: true, reason: null};
}

export interface HybridEstimate extends SurfaceEstimate {
  readonly tier: HybridTier;
  readonly geometry_rule: HybridGeometryRule;
  readonly eligibility: HybridEligibility;
  /** Why the interpolation tier was not used, when the anchor served instead. */
  readonly fallback_reason: string | null;
}

/**
 * The candidate: bracketed same-expiry interpolation, then the existing local
 * exact-contract anchor, then unavailable.
 *
 * The hierarchy is fixed and reads no outcome, PnL or strategy result. Neither
 * tier's own logic is altered — `estimateLinearInterpolation` and
 * `estimateLocalIvAnchor` are called exactly as Phase 2B scored them, so a win
 * here cannot come from quietly improving a component.
 *
 * No SVI, no SSVI, no DVOL, no cross-expiry or wing extrapolation, no fabricated
 * constant IV, no future data.
 */
export function estimateHybrid(input: {
  readonly points: readonly AggregatedStrikeObservation[];
  readonly anchor: PriorAnchor | null;
  readonly target: EstimationTarget;
  readonly rule: HybridGeometryRule;
  readonly anchorMaxAgeMinutes?: number;
  /** Remaining DTE < 1 day, which changes only the terminal unavailable reason. */
  readonly isFinalDay?: boolean;
}): HybridEstimate {
  const eligibility = hybridEligibility(input.points, input.target, input.rule);
  const shared = {geometry_rule: input.rule, eligibility} as const;

  if (eligibility.eligible) {
    const interpolated = estimateLinearInterpolation(input.points, input.target);
    // Defence in depth, and deliberately redundant TODAY: the interpolator
    // already refuses an out-of-range target, so this branch is unreachable
    // under the current implementation and a mutation removing it changes no
    // test. It stays because §7's no-extrapolation rule is methodological, and
    // the tier must not start extrapolating if the interpolator ever does.
    if (interpolated.status === "available" && !interpolated.is_extrapolation)
      return {...interpolated, method_version: HYBRID_METHOD_VERSION, ...shared,
        tier: "interpolation", fallback_reason: null,
        diagnostics: {...interpolated.diagnostics, tier: "interpolation",
          interpolation_method: LINEAR_INTERPOLATION_METHOD_VERSION}};
  }

  const fallbackReason = eligibility.eligible
    ? "interpolation_tier_returned_no_value" : eligibility.reason;
  const anchored = estimateLocalIvAnchor(input.anchor, input.target,
    input.anchorMaxAgeMinutes ?? PRIOR_ANCHOR_MAX_AGE_MINUTES);
  if (anchored.status === "available")
    return {...anchored, method_version: HYBRID_METHOD_VERSION, ...shared,
      tier: "local_anchor", fallback_reason: fallbackReason,
      diagnostics: {...anchored.diagnostics, tier: "local_anchor",
        anchor_method: LOCAL_IV_ANCHOR_METHOD_VERSION, fallback_reason: fallbackReason}};

  return {
    method_version: HYBRID_METHOD_VERSION, status: "unavailable",
    iv_decimal: null, total_implied_variance: null, price_btc: null, price_usd: null,
    is_extrapolation: false, observation_count: input.points.length,
    // The final-day distinction is about a missing pre-expiry MARK, never about
    // a missing settlement payoff, which needs no IV at all.
    unavailable_reason: input.isFinalDay ? "surface_not_identifiable_final_day" : "no_causal_anchor",
    diagnostics: {tier: "unavailable", fallback_reason: fallbackReason,
      anchor_reason: anchored.unavailable_reason, final_day: Boolean(input.isFinalDay)},
    ...shared, tier: "unavailable", fallback_reason: fallbackReason,
  };
}
