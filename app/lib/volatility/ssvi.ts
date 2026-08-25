/**
 * SSVI — the surface (multi-maturity) competitor, for VALIDATION ONLY.
 *
 * Phase 2A.3 established that same-expiry sparsity almost never forces a
 * cross-expiry model: only 0.4% of path rows were `cross_expiry_supported` and
 * none was unidentifiable. So SSVI is NOT being built to fill thin slices. Its
 * one plausible advantage here is the WING: a shared shape function across
 * maturities regularizes the smile where a single expiry has no observed
 * strikes, and the calendar constraint keeps the extrapolation consistent with
 * neighbouring maturities instead of free.
 *
 * The question this exists to answer is therefore narrow and measurable:
 *
 *   does adding the maturity dimension materially improve reconstruction
 *   OUTSIDE the observed strike range, versus same-expiry SVI?
 *
 * Not "is SSVI more sophisticated". If the answer is no, the wing stays
 * unavailable, which is the honest outcome and costs nothing downstream.
 *
 * Parameterisation (Gatheral–Jacquier), in total implied variance:
 *
 *   w(k, theta) = (theta / 2) * (1 + rho * phi * k + sqrt((phi * k + rho)^2 + 1 - rho^2))
 *
 * with theta the ATM total variance at that maturity and a power-law
 * `phi(theta) = eta * theta^(-gamma)`. Two global shape parameters (rho, eta,
 * gamma) are shared across every maturity; each maturity contributes only its
 * own theta. That is exactly the regularization being tested — the wing shape
 * of a thin expiry is borrowed from the maturities that do have wings.
 *
 * Pure and deterministic, like every other estimator here.
 */

import type {AggregatedStrikeObservation} from "./strike-aggregation.ts";

export const SSVI_METHOD_VERSION = "ssvi_power_law_v1" as const;

/** Global shape parameters, shared across all maturities in one snapshot. */
export interface SsviParameters {
  readonly rho: number;
  readonly eta: number;
  readonly gamma: number;
  /** ATM total variance per expiry, keyed by expiry timestamp. */
  readonly theta: Readonly<Record<string, number>>;
}

export const ssviPhi = (theta: number, eta: number, gamma: number): number =>
  eta * Math.pow(Math.max(theta, 1e-12), -gamma);

/** SSVI total variance at log-moneyness `k` for a maturity with ATM variance `theta`. */
export function ssviTotalVariance(
  k: number, theta: number, rho: number, eta: number, gamma: number,
): number {
  const phi = ssviPhi(theta, eta, gamma);
  const x = phi * k + rho;
  return (theta / 2) * (1 + rho * phi * k + Math.sqrt(x * x + 1 - rho * rho));
}

/**
 * Gatheral–Jacquier sufficient conditions for a static-arbitrage-free SSVI
 * surface with a power-law phi.
 *
 * Checking these rather than only the fit quality is the whole point of using
 * SSVI in the wing: an unconstrained surface will happily extrapolate into
 * negative density, which is precisely the region being asked about.
 */
export function ssviConstraintsSatisfied(p: SsviParameters): {ok: boolean; violations: string[]} {
  const violations: string[] = [];
  if (!(Math.abs(p.rho) < 1)) violations.push("|rho| must be < 1");
  if (!(p.eta > 0)) violations.push("eta must be positive");
  if (!(p.gamma > 0 && p.gamma < 1)) violations.push("gamma must lie in (0, 1)");
  const thetas = Object.values(p.theta);
  if (!thetas.length) violations.push("no maturity has an ATM total variance");
  if (thetas.some(t => !(t > 0))) violations.push("every theta must be positive");
  // Butterfly-free sufficient condition: theta * phi * (1 + |rho|) < 4 for all
  // maturities, and theta * phi^2 * (1 + |rho|) <= 4.
  for (const theta of thetas) {
    const phi = ssviPhi(theta, p.eta, p.gamma);
    if (!(theta * phi * (1 + Math.abs(p.rho)) < 4))
      violations.push(`theta*phi*(1+|rho|) >= 4 at theta=${theta.toFixed(6)}`);
    if (!(theta * phi * phi * (1 + Math.abs(p.rho)) <= 4))
      violations.push(`theta*phi^2*(1+|rho|) > 4 at theta=${theta.toFixed(6)}`);
  }
  return {ok: violations.length === 0, violations};
}

export interface SsviMaturityInput {
  readonly expiryTimestampMs: number;
  readonly timeToExpiryYears: number;
  readonly points: readonly AggregatedStrikeObservation[];
}

export interface SsviFitDiagnostics {
  readonly parameters: SsviParameters | null;
  readonly converged: boolean;
  readonly objective: number | null;
  readonly maturity_count: number;
  readonly observation_count: number;
  readonly rms_residual_total_variance: number | null;
  readonly rms_residual_iv: number | null;
  readonly calendar_monotone: boolean;
  readonly constraint_violations: readonly string[];
  readonly warnings: readonly string[];
  readonly unavailable_reason: string | null;
  readonly method_version: string;
}

/** At least this many maturities, or there is no term structure to borrow from. */
export const SSVI_MINIMUM_MATURITIES = 2 as const;
export const SSVI_MINIMUM_TOTAL_POINTS = 10 as const;
export const SSVI_GRID_STEPS = 13 as const;
export const SSVI_REFINEMENT_ROUNDS = 3 as const;

/**
 * ATM total variance for one maturity, by interpolation at k = 0.
 *
 * Deliberately not "the nearest strike's variance": on a skewed smile the
 * nearest observed strike can sit well off the money, and theta anchors the
 * whole SSVI shape for that maturity. Where k = 0 is not bracketed the maturity
 * contributes no theta and is dropped, rather than being anchored on an
 * extrapolated guess.
 */
export function atmTotalVariance(points: readonly AggregatedStrikeObservation[]): number | null {
  const usable = [...points]
    .filter(p => p.total_implied_variance > 0)
    .sort((a, b) => a.log_moneyness - b.log_moneyness);
  if (usable.length < 2) return null;
  const below = usable.filter(p => p.log_moneyness <= 0).at(-1);
  const above = usable.find(p => p.log_moneyness >= 0);
  if (!below || !above) return null;
  if (below.log_moneyness === above.log_moneyness) return below.total_implied_variance;
  const weight = (0 - below.log_moneyness) / (above.log_moneyness - below.log_moneyness);
  return below.total_implied_variance + weight * (above.total_implied_variance - below.total_implied_variance);
}

/**
 * Fit the shared shape parameters across every maturity at one snapshot.
 *
 * theta is measured per maturity rather than fitted, so the optimizer searches
 * only the three global parameters. That keeps the fit deterministic and
 * cheap, and it is what makes the wing of a thin expiry genuinely inherited
 * from the maturities that carry information.
 */
export function fitSsvi(maturities: readonly SsviMaturityInput[]): SsviFitDiagnostics {
  const base = {method_version: SSVI_METHOD_VERSION} as const;
  const usable: {expiry: number; theta: number; years: number; points: AggregatedStrikeObservation[]}[] = [];
  for (const m of maturities) {
    const theta = atmTotalVariance(m.points);
    const points = m.points.filter(p => p.total_implied_variance > 0);
    if (theta === null || !(theta > 0) || points.length < 2) continue;
    usable.push({expiry: m.expiryTimestampMs, theta, years: m.timeToExpiryYears, points: [...points]
      .sort((a, b) => a.log_moneyness - b.log_moneyness || a.option_type.localeCompare(b.option_type))});
  }
  usable.sort((a, b) => a.years - b.years);
  const totalPoints = usable.reduce((s, m) => s + m.points.length, 0);

  const fail = (reason: string, warnings: string[] = []): SsviFitDiagnostics => ({
    ...base, parameters: null, converged: false, objective: null,
    maturity_count: usable.length, observation_count: totalPoints,
    rms_residual_total_variance: null, rms_residual_iv: null,
    calendar_monotone: false, constraint_violations: [], warnings, unavailable_reason: reason,
  });

  if (usable.length < SSVI_MINIMUM_MATURITIES)
    return fail("insufficient_maturities", [`${usable.length} usable maturities`]);
  if (totalPoints < SSVI_MINIMUM_TOTAL_POINTS)
    return fail("insufficient_observations", [`${totalPoints} points across all maturities`]);

  // Calendar monotonicity of ATM total variance is a necessary condition for a
  // calendar-arbitrage-free surface. A violation is reported, never repaired by
  // reordering.
  const calendarMonotone = usable.every((m, i) => i === 0 || m.theta >= usable[i - 1]!.theta - 1e-12);

  const objectiveOf = (rho: number, eta: number, gamma: number): number => {
    let total = 0;
    for (const m of usable) for (const p of m.points) {
      const model = ssviTotalVariance(p.log_moneyness, m.theta, rho, eta, gamma);
      const residual = model - p.total_implied_variance;
      total += residual * residual;
    }
    return total;
  };

  let best: {rho: number; eta: number; gamma: number; objective: number} | null = null;
  let rhoLow = -0.95, rhoHigh = 0.95;
  let etaLow = 0.05, etaHigh = 20;
  let gammaLow = 0.05, gammaHigh = 0.95;

  for (let round = 0; round < SSVI_REFINEMENT_ROUNDS; round += 1) {
    for (let i = 0; i < SSVI_GRID_STEPS; i += 1) {
      const rho = rhoLow + (rhoHigh - rhoLow) * i / (SSVI_GRID_STEPS - 1);
      for (let j = 0; j < SSVI_GRID_STEPS; j += 1) {
        // Geometric in eta: it spans orders of magnitude.
        const eta = etaLow * Math.pow(etaHigh / etaLow, j / (SSVI_GRID_STEPS - 1));
        for (let l = 0; l < SSVI_GRID_STEPS; l += 1) {
          const gamma = gammaLow + (gammaHigh - gammaLow) * l / (SSVI_GRID_STEPS - 1);
          const objective = objectiveOf(rho, eta, gamma);
          if (!Number.isFinite(objective)) continue;
          if (!best || objective < best.objective) best = {rho, eta, gamma, objective};
        }
      }
    }
    if (!best) return fail("fit_did_not_converge");
    const rhoStep = (rhoHigh - rhoLow) / (SSVI_GRID_STEPS - 1);
    const etaRatio = Math.pow(etaHigh / etaLow, 1 / (SSVI_GRID_STEPS - 1));
    const gammaStep = (gammaHigh - gammaLow) / (SSVI_GRID_STEPS - 1);
    rhoLow = Math.max(-0.999, best.rho - rhoStep); rhoHigh = Math.min(0.999, best.rho + rhoStep);
    etaLow = Math.max(1e-3, best.eta / etaRatio); etaHigh = best.eta * etaRatio;
    gammaLow = Math.max(1e-3, best.gamma - gammaStep); gammaHigh = Math.min(0.999, best.gamma + gammaStep);
  }
  if (!best) return fail("fit_did_not_converge");

  const parameters: SsviParameters = {
    rho: best.rho, eta: best.eta, gamma: best.gamma,
    theta: Object.fromEntries(usable.map(m => [String(m.expiry), m.theta])),
  };
  const constraints = ssviConstraintsSatisfied(parameters);

  let sumSquared = 0, sumSquaredIv = 0, count = 0;
  for (const m of usable) for (const p of m.points) {
    const model = ssviTotalVariance(p.log_moneyness, m.theta, best.rho, best.eta, best.gamma);
    sumSquared += (model - p.total_implied_variance) ** 2;
    const modelIv = model > 0 ? Math.sqrt(model / m.years) : 0;
    sumSquaredIv += (modelIv - p.iv_decimal) ** 2;
    count += 1;
  }

  const warnings = [...constraints.violations];
  if (!calendarMonotone) warnings.push("ATM total variance is not monotone in maturity");
  return {
    ...base, parameters, converged: true, objective: best.objective,
    maturity_count: usable.length, observation_count: totalPoints,
    rms_residual_total_variance: Math.sqrt(sumSquared / count),
    rms_residual_iv: Math.sqrt(sumSquaredIv / count),
    calendar_monotone: calendarMonotone,
    constraint_violations: constraints.violations,
    warnings,
    // Static-arbitrage violations make the surface unusable, exactly as for SVI.
    // Calendar non-monotonicity is reported but does not by itself invalidate a
    // same-expiry evaluation, since that slice is read at its own theta.
    unavailable_reason: constraints.ok ? null : "fit_economically_invalid",
  };
}

/** Evaluate a fitted SSVI surface for one expiry at one log-moneyness. */
export function ssviTotalVarianceAt(
  fit: SsviFitDiagnostics, expiryTimestampMs: number, k: number,
): number | null {
  if (!fit.parameters || fit.unavailable_reason) return null;
  const theta = fit.parameters.theta[String(expiryTimestampMs)];
  if (theta === undefined || !(theta > 0)) return null;
  const w = ssviTotalVariance(k, theta, fit.parameters.rho, fit.parameters.eta, fit.parameters.gamma);
  return w > 0 ? w : null;
}
