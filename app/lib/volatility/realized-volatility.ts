/**
 * Canonical trailing realized volatility.
 *
 * Locked by the Phase-2A methodology audit:
 *   - hourly close-to-close log returns, r_t = ln(S_t / S_(t-1))
 *   - annualization 8760 = 365 x 24, because BTC trades continuously
 *   - RV = sqrt(mean(r_t^2) * 8760), stored as a DECIMAL (0.62, not 62)
 *   - windows are strictly historical relative to the target
 *   - no forward filling, ever
 *   - coverage >= 95% of expected returns, else unavailable
 *
 * CANONICAL UNDERLYING: Deribit BTC-PERPETUAL 1h closes. The perpetual is NOT
 * the Deribit index -- it carries basis -- so `underlyingSource` travels with
 * every result and must stay visible rather than being assumed. Binance BTCUSDT
 * is deliberately not used: mixing venue and instrument type into a number that
 * is compared against Deribit IV would be a silent provenance error.
 *
 * Parkinson and other range estimators are explicitly out of scope.
 */

export const REALIZED_VOL_METHOD_VERSION = "realized-volatility-hourly-log-v1" as const;
export const CANONICAL_RV_UNDERLYING = "BTC-PERPETUAL" as const;
export const HOURS_PER_YEAR = 8760 as const;
export const HOUR_MS = 3_600_000 as const;
/** Minimum share of expected hourly returns before a window is usable. */
export const RV_MINIMUM_COVERAGE = 0.95 as const;

export const RV_HORIZON_HOURS = {
  "1d": 24, "3d": 72, "7d": 168, "14d": 336, "30d": 720,
} as const;
export type RvHorizon = keyof typeof RV_HORIZON_HOURS;
export const RV_HORIZONS = Object.keys(RV_HORIZON_HOURS) as readonly RvHorizon[];

export interface HourlyClose {
  readonly timestampMs: number;
  readonly close: number;
}

export type RvUnavailableReason =
  | "no_bars_in_window"
  | "insufficient_coverage"
  | "no_valid_returns"
  | "invalid_window";

export interface RealizedVolatilityResult {
  readonly horizon: RvHorizon;
  readonly status: "available" | "unavailable";
  /** Annualized realized volatility, decimal units. */
  readonly rvDecimal: number | null;
  readonly observationCount: number;
  readonly expectedCount: number;
  readonly coverageRatio: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly underlyingSource: string;
  readonly methodVersion: string;
  readonly annualizationFactor: number;
  readonly minimumCoverage: number;
  readonly unavailableReason: RvUnavailableReason | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Hourly log returns from consecutive closes.
 *
 * A return is only formed from bars exactly one hour apart. A gap yields no
 * return rather than a synthetic multi-hour one, which is what "no forward
 * filling" has to mean in practice: the missing hour reduces coverage instead of
 * being papered over by a larger return.
 */
export function hourlyLogReturns(bars: readonly HourlyClose[]): number[] {
  const sorted = [...bars]
    .filter(b => finite(b.timestampMs) && finite(b.close) && b.close > 0)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const returns: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!, current = sorted[i]!;
    if (current.timestampMs - previous.timestampMs !== HOUR_MS) continue;
    const r = Math.log(current.close / previous.close);
    if (Number.isFinite(r)) returns.push(r);
  }
  return returns;
}

/** RV = sqrt(mean(r^2) * 8760). Exported so tests can pin the formula itself. */
export function annualizedRealizedVolatility(returns: readonly number[]): number | null {
  if (!returns.length) return null;
  const meanSquare = returns.reduce((sum, r) => sum + r * r, 0) / returns.length;
  const rv = Math.sqrt(meanSquare * HOURS_PER_YEAR);
  return Number.isFinite(rv) ? rv : null;
}

/**
 * Trailing RV over `horizon`, ending strictly at or before `targetTimestampMs`.
 * The window is [target - horizon, target]; no bar at or after the target
 * contributes, so the result is causal by construction.
 */
export function realizedVolatility(input: {
  readonly bars: readonly HourlyClose[];
  readonly targetTimestampMs: number;
  readonly horizon: RvHorizon;
  readonly underlyingSource?: string;
}): RealizedVolatilityResult {
  const hours = RV_HORIZON_HOURS[input.horizon];
  const end = input.targetTimestampMs;
  const start = end - hours * HOUR_MS;
  const underlyingSource = input.underlyingSource ?? CANONICAL_RV_UNDERLYING;
  const expectedCount = hours;
  const base = {
    horizon: input.horizon, expectedCount, windowStartMs: start, windowEndMs: end,
    underlyingSource, methodVersion: REALIZED_VOL_METHOD_VERSION,
    annualizationFactor: HOURS_PER_YEAR, minimumCoverage: RV_MINIMUM_COVERAGE,
  } as const;

  if (!finite(end)) return {...base, status: "unavailable", rvDecimal: null, observationCount: 0,
    coverageRatio: 0, unavailableReason: "invalid_window"};

  // Strictly historical: a bar exactly at the target is excluded, so no
  // information from the target instant itself enters the window.
  const window = input.bars.filter(b => finite(b.timestampMs) && b.timestampMs >= start && b.timestampMs < end);
  if (!window.length) return {...base, status: "unavailable", rvDecimal: null, observationCount: 0,
    coverageRatio: 0, unavailableReason: "no_bars_in_window"};

  const returns = hourlyLogReturns(window);
  const coverageRatio = returns.length / expectedCount;
  if (!returns.length) return {...base, status: "unavailable", rvDecimal: null, observationCount: 0,
    coverageRatio: 0, unavailableReason: "no_valid_returns"};
  if (coverageRatio < RV_MINIMUM_COVERAGE)
    return {...base, status: "unavailable", rvDecimal: null, observationCount: returns.length,
      coverageRatio, unavailableReason: "insufficient_coverage"};

  const rv = annualizedRealizedVolatility(returns);
  if (rv === null) return {...base, status: "unavailable", rvDecimal: null, observationCount: returns.length,
    coverageRatio, unavailableReason: "no_valid_returns"};
  return {...base, status: "available", rvDecimal: rv, observationCount: returns.length,
    coverageRatio, unavailableReason: null};
}

/** Every canonical horizon at one target. */
export function realizedVolatilityProfile(input: {
  readonly bars: readonly HourlyClose[];
  readonly targetTimestampMs: number;
  readonly underlyingSource?: string;
}): Record<RvHorizon, RealizedVolatilityResult> {
  return Object.fromEntries(RV_HORIZONS.map(horizon =>
    [horizon, realizedVolatility({...input, horizon})],
  )) as Record<RvHorizon, RealizedVolatilityResult>;
}
