import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_RV_UNDERLYING, HOURS_PER_YEAR, HOUR_MS, RV_HORIZON_HOURS, RV_MINIMUM_COVERAGE,
  annualizedRealizedVolatility, hourlyLogReturns, realizedVolatility, realizedVolatilityProfile,
  type HourlyClose,
} from "../app/lib/volatility/realized-volatility.ts";
import {
  MINIMUM_PRIOR_OBSERVATIONS, causalIvPercentile, empiricalPercentile,
} from "../app/lib/volatility/iv-percentile.ts";

/**
 * Canonical realized volatility and the causal expanding IV percentile. Both are
 * pure, so these tests pin the locked formulas and the causality guarantees
 * without touching the network.
 */

const T = Date.UTC(2025, 5, 16, 12);

/** `count` hourly bars ending strictly before `end`, at a constant log return. */
function bars(count: number, end: number, perBarLogReturn = 0.001, start = 100_000): HourlyClose[] {
  const rows: HourlyClose[] = [];
  for (let i = count; i >= 1; i -= 1)
    rows.push({timestampMs: end - i * HOUR_MS, close: start * Math.exp((count - i) * perBarLogReturn)});
  return rows;
}

/* ---------------- returns and the annualization constant ---------------- */

test("RV: hourly log returns are close-to-close and skip gaps rather than bridging them", () => {
  const rows: HourlyClose[] = [
    {timestampMs: T - 4 * HOUR_MS, close: 100},
    {timestampMs: T - 3 * HOUR_MS, close: 110},
    // one-hour gap here
    {timestampMs: T - 1 * HOUR_MS, close: 121},
  ];
  const returns = hourlyLogReturns(rows);
  assert.equal(returns.length, 1, "a missing bar yields no return, never a synthetic two-hour one");
  assert.ok(Math.abs(returns[0]! - Math.log(110 / 100)) < 1e-12);
});

test("RV: the annualization constant is 8760 and the estimator is sqrt(mean(r^2)*8760)", () => {
  assert.equal(HOURS_PER_YEAR, 8760);
  assert.equal(HOURS_PER_YEAR, 365 * 24);
  const returns = [0.01, -0.01, 0.02, -0.02];
  const meanSquare = returns.reduce((s, r) => s + r * r, 0) / returns.length;
  assert.ok(Math.abs(annualizedRealizedVolatility(returns)! - Math.sqrt(meanSquare * 8760)) < 1e-15);
  assert.equal(annualizedRealizedVolatility([]), null);
});

test("RV: a constant hourly log return reproduces |r|*sqrt(8760) in decimal units", () => {
  const r = 0.001;
  const result = realizedVolatility({bars: bars(24, T, r), targetTimestampMs: T, horizon: "1d"});
  assert.equal(result.status, "available");
  assert.ok(Math.abs(result.rvDecimal! - Math.abs(r) * Math.sqrt(8760)) < 1e-9);
  assert.ok(result.rvDecimal! < 1, "decimal units, not percent");
});

/* ---------------- window, coverage and causality ---------------- */

test("RV: every horizon uses its locked hour count", () => {
  assert.deepEqual(RV_HORIZON_HOURS, {"1d": 24, "3d": 72, "7d": 168, "14d": 336, "30d": 720});
  const profile = realizedVolatilityProfile({bars: bars(800, T), targetTimestampMs: T});
  for (const [horizon, hours] of Object.entries(RV_HORIZON_HOURS)) {
    const r = profile[horizon as keyof typeof RV_HORIZON_HOURS];
    assert.equal(r.expectedCount, hours);
    assert.equal(r.windowEndMs - r.windowStartMs, hours * HOUR_MS);
    assert.equal(r.status, "available", horizon);
  }
});

test("RV: the window is strictly historical and ignores bars at or after the target", () => {
  const historical = bars(24, T);
  const contaminated = [...historical,
    {timestampMs: T, close: 999_999},
    {timestampMs: T + HOUR_MS, close: 999_999}];
  const clean = realizedVolatility({bars: historical, targetTimestampMs: T, horizon: "1d"});
  const withFuture = realizedVolatility({bars: contaminated, targetTimestampMs: T, horizon: "1d"});
  assert.equal(withFuture.rvDecimal, clean.rvDecimal, "a future bar must not move a trailing statistic");
  assert.equal(withFuture.windowEndMs, T);
});

test("RV: coverage below 95% is unavailable, never a value computed from a short window", () => {
  assert.equal(RV_MINIMUM_COVERAGE, 0.95);
  // 24 bars give 23 returns against 24 expected = 95.8%: available.
  const ok = realizedVolatility({bars: bars(24, T), targetTimestampMs: T, horizon: "1d"});
  assert.equal(ok.status, "available");
  assert.ok(ok.coverageRatio >= 0.95);
  // 20 bars give 19 returns = 79%: unavailable with a reason, not a number.
  const thin = realizedVolatility({bars: bars(20, T), targetTimestampMs: T, horizon: "1d"});
  assert.equal(thin.status, "unavailable");
  assert.equal(thin.rvDecimal, null);
  assert.equal(thin.unavailableReason, "insufficient_coverage");
  assert.ok(thin.coverageRatio < 0.95 && thin.coverageRatio > 0);
  assert.equal(thin.observationCount, 19, "the shortfall stays visible rather than being hidden");
});

test("RV: an empty window is unavailable with its own reason", () => {
  const r = realizedVolatility({bars: [], targetTimestampMs: T, horizon: "7d"});
  assert.equal(r.status, "unavailable");
  assert.equal(r.unavailableReason, "no_bars_in_window");
  assert.equal(r.coverageRatio, 0);
});

test("RV: every result carries its underlying source and method version", () => {
  const r = realizedVolatility({bars: bars(24, T), targetTimestampMs: T, horizon: "1d"});
  assert.equal(r.underlyingSource, CANONICAL_RV_UNDERLYING);
  assert.equal(r.underlyingSource, "BTC-PERPETUAL");
  assert.match(r.methodVersion, /realized-volatility/);
  assert.equal(r.annualizationFactor, 8760);
  // The perpetual is not the index, so an alternative source must stay labelled.
  const other = realizedVolatility({bars: bars(24, T), targetTimestampMs: T, horizon: "1d", underlyingSource: "btc_usd_index"});
  assert.equal(other.underlyingSource, "btc_usd_index");
});

/* ---------------- causal expanding percentile ---------------- */

const history = (count: number, end: number, iv = (i: number) => 0.30 + i * 0.0002) =>
  Array.from({length: count}, (_, i) => ({timestampMs: end - (count - i) * HOUR_MS, ivDecimal: iv(i)}));

const percentile = (subject: number | null, rows: {timestampMs: number; ivDecimal: number}[], min?: number) =>
  causalIvPercentile({
    subjectIvDecimal: subject, targetTimestampMs: T, history: rows,
    referenceSeriesId: "series-1", referenceSeriesContentHash: "hash-1",
    ...(min === undefined ? {} : {minimumPriorObservations: min}),
  });

test("PERCENTILE: the empirical convention splits ties at the midpoint", () => {
  assert.equal(empiricalPercentile([1, 2, 3, 4], 0), 0);
  assert.equal(empiricalPercentile([1, 2, 3, 4], 5), 1);
  assert.equal(empiricalPercentile([1, 1, 1, 1], 1), 0.5, "an exact duplicate sits at the midpoint");
  assert.equal(empiricalPercentile([1, 2, 3, 4], 3), 0.625);
});

test("PERCENTILE: only observations strictly before the target participate", () => {
  const prior = history(MINIMUM_PRIOR_OBSERVATIONS, T);
  const future = [
    ...prior,
    {timestampMs: T, ivDecimal: 9.99},
    {timestampMs: T + HOUR_MS, ivDecimal: 9.99},
  ];
  const a = percentile(0.35, prior), b = percentile(0.35, future);
  assert.equal(a.status, "available");
  assert.equal(b.percentile, a.percentile, "a future observation cannot move a causal percentile");
  assert.equal(b.priorObservationCount, a.priorObservationCount);
  assert.ok(a.historyEndMs! < T, "the history ends strictly before the target");
});

test("PERCENTILE: below 720 prior observations the result is unavailable, not a confident number", () => {
  assert.equal(MINIMUM_PRIOR_OBSERVATIONS, 720);
  const thin = percentile(0.35, history(719, T));
  assert.equal(thin.status, "unavailable");
  assert.equal(thin.percentile, null);
  assert.equal(thin.unavailableReason, "insufficient_prior_history");
  assert.equal(thin.priorObservationCount, 719, "the shortfall is reported, not hidden");
  const enough = percentile(0.35, history(720, T));
  assert.equal(enough.status, "available");
  assert.equal(enough.priorObservationCount, 720);
});

test("PERCENTILE: it ranks against the broad series, so an extreme subject lands at an extreme", () => {
  const rows = history(MINIMUM_PRIOR_OBSERVATIONS, T);
  assert.equal(percentile(0.01, rows).percentile, 0, "far below every prior observation");
  assert.equal(percentile(9.99, rows).percentile, 1, "far above every prior observation");
  const middle = percentile(rows[Math.floor(rows.length / 2)]!.ivDecimal, rows).percentile!;
  assert.ok(middle > 0.4 && middle < 0.6);
});

test("PERCENTILE: identity and missingness travel with the result", () => {
  const r = percentile(0.35, history(720, T));
  assert.equal(r.referenceSeriesId, "series-1");
  assert.equal(r.referenceSeriesContentHash, "hash-1");
  assert.match(r.methodVersion, /expanding-causal/);
  const noSubject = percentile(null, history(720, T));
  assert.equal(noSubject.status, "unavailable");
  assert.equal(noSubject.unavailableReason, "subject_value_unavailable");
  const noHistory = percentile(0.35, []);
  assert.equal(noHistory.unavailableReason, "no_prior_observations");
  assert.equal(noHistory.historyStartMs, null);
});
