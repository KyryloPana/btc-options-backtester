import test from "node:test";
import assert from "node:assert/strict";
import {
  FRESHNESS_HALF_LIFE_MINUTES, OUTLIER_MAD_MULTIPLE, STRIKE_AGGREGATION_METHOD_VERSION,
  aggregateSlice, aggregateStrike, assessCallPutCompatibility,
  type AggregatedStrikeObservation,
} from "../app/lib/volatility/strike-aggregation.ts";
import {
  LINEAR_INTERPOLATION_METHOD_VERSION, LOCAL_IV_ANCHOR_METHOD_VERSION, SVI_METHOD_VERSION,
  SSVI_ESTIMATE_METHOD_VERSION, SVI_MINIMUM_STRIKES, durrlemanG, estimateLinearInterpolation,
  HYBRID_GEOMETRY_RULES, HYBRID_METHOD_VERSION, estimateHybrid, hybridEligibility,
  estimateLocalIvAnchor, estimateSsvi, estimateSvi, fitSvi, sviTotalVariance,
  type EstimationTarget, type SviParameters,
} from "../app/lib/volatility/surface-models.ts";
import {
  SSVI_MINIMUM_MATURITIES, atmTotalVariance, fitSsvi, ssviConstraintsSatisfied,
  ssviTotalVariance, ssviTotalVarianceAt,
} from "../app/lib/volatility/ssvi.ts";
import {
  MINIMUM_PRICE_FOR_RELATIVE_ERROR_BTC, leaveOneEventOut, summarizeBy, summarizeErrors,
  summarizeMethod, summarizeSpreads, type ScoredCase, type ScoredSpread,
} from "../app/lib/volatility/model-scoring.ts";
import {buildSurfaceSnapshot, observationsFor, type CrossSectionObservation, type RawOptionPrint}
  from "../app/lib/volatility/cross-section.ts";
import {OPTION_HISTORY_HOST} from "../app/lib/volatility/reference-series.ts";

/**
 * Candidate surface-reconstruction models, for validation only.
 *
 * The tests that matter most here are not "does it fit" but "does it refuse".
 * An unconstrained fitter always returns numbers; what makes a fit usable is
 * that an economically invalid one is rejected, that extrapolation is labelled
 * rather than hidden, and that a model which cannot answer is counted as
 * unavailable instead of silently vanishing from the denominator.
 */

const T = Date.UTC(2025, 5, 16, 12);
const EXPIRY = Date.UTC(2025, 5, 23, 8);
const SPOT = 105_000;
const MIN = 60_000;
const YEARS = (EXPIRY - T) / (365 * 24 * 3_600_000);

const print = (over: Partial<RawOptionPrint> = {}): RawOptionPrint => ({
  instrumentName: "BTC-23JUN25-105000-C", tradeId: "t1", tradeSeq: 1,
  strike: 105_000, optionType: "C", expiryTimestampMs: EXPIRY,
  settlementPeriod: "week", contractCreatedAtMs: Date.UTC(2025, 4, 1),
  timestampMs: T - 10 * MIN, ivApiPercent: 42, indexPrice: SPOT,
  price: 0.01, markPrice: 0.011, amount: 1, direction: "buy", ...over,
});

const observationsOf = (prints: readonly RawOptionPrint[]): CrossSectionObservation[] => {
  const snapshot = buildSurfaceSnapshot({
    prints, targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: OPTION_HISTORY_HOST,
  });
  return observationsFor(snapshot, EXPIRY);
};

/* ==================== strike aggregation ==================== */

test("AGGREGATION: one point per expiry x strike x option type, whatever the print count", () => {
  const busy = Array.from({length: 40}, (_, i) => print({
    strike: 106_000, instrumentName: "BTC-23JUN25-106000-C",
    tradeId: `busy-${i}`, timestampMs: T - (5 + i % 20) * MIN,
  }));
  const quiet = [print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-C", tradeId: "q1"}),
    print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-C", tradeId: "q2"})];
  const points = aggregateSlice(observationsOf([...busy, ...quiet]));

  assert.equal(points.length, 2, "forty prints and two prints are two strikes, not forty-two points");
  const heavy = points.find(p => p.strike === 106_000)!;
  const light = points.find(p => p.strike === 104_000)!;
  assert.equal(heavy.print_count, 40);
  assert.equal(light.print_count, 2);
  // The decisive property: the busy strike does not outvote the quiet one.
  assert.equal(heavy.fitting_weight, light.fitting_weight);
  assert.equal(heavy.fitting_weight, 1);
  assert.equal(heavy.method_version, STRIKE_AGGREGATION_METHOD_VERSION);
});

test("AGGREGATION: calls and puts on one strike stay separate observations", () => {
  const points = aggregateSlice(observationsOf([
    print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-C", optionType: "C", tradeId: "c", ivApiPercent: 40}),
    print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-P", optionType: "P", tradeId: "p", ivApiPercent: 44}),
  ]));
  assert.equal(points.length, 2, "a call and a put are two observations, never blended into one");
  assert.deepEqual(points.map(p => p.option_type).sort(), ["C", "P"]);
  assert.ok(Math.abs(points.find(p => p.option_type === "C")!.iv_decimal - 0.40) < 1e-9);
  assert.ok(Math.abs(points.find(p => p.option_type === "P")!.iv_decimal - 0.44) < 1e-9);
});

test("AGGREGATION: fresher prints weigh more, by the documented half-life", () => {
  // One print at the target, one a half-life old: weights 1 and 0.5, so the
  // aggregate sits a third of the way toward the older value.
  const points = aggregateSlice(observationsOf([
    print({strike: 106_000, instrumentName: "BTC-23JUN25-106000-C", tradeId: "fresh",
      timestampMs: T, ivApiPercent: 40}),
    print({strike: 106_000, instrumentName: "BTC-23JUN25-106000-C", tradeId: "old",
      timestampMs: T - FRESHNESS_HALF_LIFE_MINUTES * MIN, ivApiPercent: 46}),
  ]));
  const expected = (1 * 0.40 + 0.5 * 0.46) / 1.5;
  assert.ok(Math.abs(points[0]!.iv_decimal - expected) < 1e-9,
    `expected ${expected}, got ${points[0]!.iv_decimal}`);
  assert.ok(points[0]!.iv_decimal < 0.43, "the freshest print pulls the aggregate toward itself");
  assert.ok(points[0]!.effective_age_minutes > 0 && points[0]!.effective_age_minutes < FRESHNESS_HALF_LIFE_MINUTES);
});

test("AGGREGATION: a wild print is excluded but counted, and never on a two-print strike", () => {
  const normal = [40, 41, 40, 41, 40].map((iv, i) => print({
    strike: 106_000, instrumentName: "BTC-23JUN25-106000-C", tradeId: `n${i}`, ivApiPercent: iv,
  }));
  const rogue = print({strike: 106_000, instrumentName: "BTC-23JUN25-106000-C", tradeId: "rogue", ivApiPercent: 300});
  const points = aggregateSlice(observationsOf([...normal, rogue]));
  assert.equal(points[0]!.print_count, 6, "the outlier is still counted");
  assert.equal(points[0]!.outliers_excluded, 1);
  assert.ok(points[0]!.iv_decimal < 0.45, "a 300-vol block must not drag the smile point");
  assert.equal(points[0]!.iv_max, 3.0, "the raw dispersion stays visible");
  assert.equal(OUTLIER_MAD_MULTIPLE, 3);

  // Two prints: "robust" would just mean discarding one, so nothing is excluded.
  const pair = aggregateSlice(observationsOf([
    print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-C", tradeId: "a", ivApiPercent: 40}),
    print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-C", tradeId: "b", ivApiPercent: 300}),
  ]));
  assert.equal(pair[0]!.outliers_excluded, 0);
});

test("AGGREGATION: total variance is IV^2 * T and carries the slice maturity", () => {
  const points = aggregateSlice(observationsOf([print({ivApiPercent: 50})]));
  const p = points[0]!;
  assert.ok(Math.abs(p.total_implied_variance - 0.5 * 0.5 * p.time_to_expiry_years) < 1e-15);
  assert.ok(Math.abs(p.time_to_expiry_years - YEARS) < 1e-9);
  assert.equal(aggregateStrike([]), null);
});

test("COMPATIBILITY: matched call/put strikes are measured rather than assumed equal", () => {
  const compat = assessCallPutCompatibility(aggregateSlice(observationsOf([
    print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-C", optionType: "C", tradeId: "c1", ivApiPercent: 40}),
    print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-P", optionType: "P", tradeId: "p1", ivApiPercent: 41}),
    print({strike: 106_000, instrumentName: "BTC-23JUN25-106000-C", optionType: "C", tradeId: "c2", ivApiPercent: 42}),
  ])));
  assert.equal(compat.matched_strike_count, 1, "only 104k has both a call and a put");
  assert.ok(Math.abs(compat.mean_absolute_iv_difference! - 0.01) < 1e-9);
  assert.ok(Math.abs(compat.mean_signed_iv_difference! + 0.01) < 1e-9, "signed difference exposes a systematic offset");
  assert.equal(assessCallPutCompatibility([]).matched_strike_count, 0);
  assert.equal(assessCallPutCompatibility([]).mean_absolute_iv_difference, null);
});

/* ==================== interpolation baseline ==================== */

const point = (k: number, iv: number): AggregatedStrikeObservation => ({
  expiry_timestamp_ms: EXPIRY, strike: SPOT * Math.exp(k), option_type: "C",
  log_moneyness: k, time_to_expiry_years: YEARS, iv_decimal: iv,
  total_implied_variance: iv * iv * YEARS,
  effective_timestamp_ms: T - 5 * MIN, effective_age_minutes: 5,
  print_count: 1, outliers_excluded: 0, iv_mad: 0, iv_min: iv, iv_max: iv,
  underlying_price: SPOT, fitting_weight: 1, method_version: "test",
});

const targetAt = (k: number): EstimationTarget => ({
  strike: SPOT * Math.exp(k), optionType: "C", logMoneyness: k,
  timeToExpiryYears: YEARS, underlyingPrice: SPOT,
  targetTimestampMs: T, expiryTimestampMs: EXPIRY,
});

test("BASELINE: interpolation is linear in TOTAL VARIANCE, not in IV", () => {
  const points = [point(-0.05, 0.40), point(0.05, 0.60)];
  const estimate = estimateLinearInterpolation(points, targetAt(0));
  assert.equal(estimate.status, "available");
  // Midpoint in w, then back to IV -- which is NOT the midpoint in IV.
  const w = (0.40 * 0.40 * YEARS + 0.60 * 0.60 * YEARS) / 2;
  assert.ok(Math.abs(estimate.iv_decimal! - Math.sqrt(w / YEARS)) < 1e-12);
  assert.ok(Math.abs(estimate.iv_decimal! - 0.50) > 1e-4, "the IV midpoint would be a different curve");
  assert.equal(estimate.method_version, LINEAR_INTERPOLATION_METHOD_VERSION);
  assert.equal(estimate.is_extrapolation, false);
});

test("BASELINE: it refuses to extrapolate, in either direction", () => {
  const points = [point(-0.05, 0.40), point(0.00, 0.42), point(0.05, 0.60)];
  for (const k of [-0.20, 0.20]) {
    const estimate = estimateLinearInterpolation(points, targetAt(k));
    assert.equal(estimate.status, "unavailable");
    assert.equal(estimate.unavailable_reason, "target_outside_observed_strike_range");
    assert.equal(estimate.iv_decimal, null, "never a number outside the observed range");
  }
  assert.equal(estimateLinearInterpolation([point(0, 0.4)], targetAt(0.01)).unavailable_reason,
    "insufficient_observations");
});

test("BASELINE: an exact strike match returns the observation, not an interpolation", () => {
  const estimate = estimateLinearInterpolation([point(-0.05, 0.40), point(0.02, 0.45), point(0.05, 0.60)],
    targetAt(0.02));
  assert.equal(estimate.status, "available");
  assert.ok(Math.abs(estimate.iv_decimal! - 0.45) < 1e-12);
  assert.equal(estimate.diagnostics.bracket, "exact_strike");
});

test("BASELINE: it prices through the existing inverse-option function", () => {
  const estimate = estimateLinearInterpolation([point(-0.05, 0.40), point(0.05, 0.60)], targetAt(0));
  assert.ok(estimate.price_btc !== null && estimate.price_btc > 0);
  assert.ok(Math.abs(estimate.price_usd! - estimate.price_btc! * SPOT) < 1e-6,
    "USD is the BTC premium at the index, per the project's inverse convention");
});

/* ==================== SVI ==================== */

const TRUE_SVI: SviParameters = {a: 0.0012, b: 0.09, rho: -0.35, m: 0.02, sigma: 0.12};
const sviPoint = (k: number): AggregatedStrikeObservation => {
  const w = sviTotalVariance(TRUE_SVI, k);
  return point(k, Math.sqrt(w / YEARS));
};
const SVI_KS = [-0.25, -0.18, -0.12, -0.07, -0.03, 0, 0.03, 0.07, 0.12, 0.18, 0.25];

test("SVI: it recovers known parameters from a clean smile", () => {
  const fit = fitSvi(SVI_KS.map(sviPoint));
  assert.equal(fit.converged, true);
  assert.equal(fit.unavailable_reason, null);
  assert.deepEqual(fit.warnings, []);
  const p = fit.parameters!;
  assert.ok(Math.abs(p.b - TRUE_SVI.b) < 5e-3, `b ${p.b}`);
  assert.ok(Math.abs(p.rho - TRUE_SVI.rho) < 5e-2, `rho ${p.rho}`);
  assert.ok(Math.abs(p.sigma - TRUE_SVI.sigma) < 1e-2, `sigma ${p.sigma}`);
  assert.ok(fit.rms_residual_iv! < 1e-3, `rms IV residual ${fit.rms_residual_iv}`);
  assert.equal(fit.butterfly_arbitrage_free, true);
});

test("SVI: the fit is deterministic — identical inputs give identical parameters", () => {
  const points = SVI_KS.map(sviPoint);
  const a = fitSvi(points), b = fitSvi(points), c = fitSvi([...points].reverse());
  assert.deepEqual(a.parameters, b.parameters);
  assert.deepEqual(a.parameters, c.parameters, "input order must not move the fit");
  assert.equal(a.objective, b.objective);
});

test("SVI: too few distinct strikes is unavailable, never a saturated five-parameter fit", () => {
  const fit = fitSvi([-0.05, 0, 0.05, 0.1].map(sviPoint));
  assert.equal(fit.parameters, null);
  assert.equal(fit.unavailable_reason, "insufficient_observations");
  assert.equal(fit.converged, false);
  assert.equal(SVI_MINIMUM_STRIKES, 5);
  const estimate = estimateSvi(fit, [], targetAt(0));
  assert.equal(estimate.status, "unavailable");
  assert.equal(estimate.iv_decimal, null);
});

test("SVI: Durrleman g detects a butterfly-arbitrageable smile", () => {
  // A deliberately arbitrageable parameter set: huge b with extreme rho.
  const bad: SviParameters = {a: 0.001, b: 3.0, rho: -0.99, m: 0.0, sigma: 0.005};
  let minG = Infinity;
  for (let i = 0; i <= 100; i += 1) minG = Math.min(minG, durrlemanG(bad, -0.3 + 0.6 * i / 100));
  assert.ok(minG < 0, `this parameter set should violate no-butterfly, got min g = ${minG}`);
  // And a sane one does not.
  let goodMin = Infinity;
  for (let i = 0; i <= 100; i += 1) goodMin = Math.min(goodMin, durrlemanG(TRUE_SVI, -0.3 + 0.6 * i / 100));
  assert.ok(goodMin >= 0, `a well-behaved smile should be arbitrage-free, got ${goodMin}`);
});

test("SVI: an economically invalid fit is unavailable, not returned with a warning", () => {
  // Total variance decreasing then increasing sharply with a kink the model
  // cannot represent without violating constraints.
  const hostile = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map((k, i) =>
    point(k, [2.5, 0.05, 2.4, 0.06, 2.3, 0.07, 2.6][i]!));
  const fit = fitSvi(hostile);
  if (fit.unavailable_reason !== null) {
    assert.equal(estimateSvi(fit, hostile, targetAt(0.05)).status, "unavailable");
    assert.ok(fit.warnings.length > 0, "an invalid fit must say why");
  }
  // Whatever the outcome, an available estimate must be arbitrage-free.
  const estimate = estimateSvi(fit, hostile, targetAt(0.05));
  if (estimate.status === "available") assert.equal(fit.butterfly_arbitrage_free, true);
});

test("SVI: a target outside the observed strikes is LABELLED extrapolation", () => {
  const points = SVI_KS.map(sviPoint);
  const fit = fitSvi(points);
  const inside = estimateSvi(fit, points, targetAt(0.05));
  const outside = estimateSvi(fit, points, targetAt(0.40));
  assert.equal(inside.is_extrapolation, false);
  assert.equal(outside.is_extrapolation, true, "the wing must never masquerade as interpolation");
  assert.ok((outside.diagnostics.extrapolation_distance_log_moneyness as number) > 0.1);
  assert.equal(inside.diagnostics.extrapolation_distance_log_moneyness, 0);
});

test("SVI: interpolating a held-out interior strike beats linear interpolation on a curved smile", () => {
  const held = 0.05;
  const without = SVI_KS.filter(k => k !== held).map(sviPoint);
  const truthIv = Math.sqrt(sviTotalVariance(TRUE_SVI, held) / YEARS);
  const svi = estimateSvi(fitSvi(without), without, targetAt(held));
  const linear = estimateLinearInterpolation(without, targetAt(held));
  assert.equal(svi.status, "available");
  assert.equal(linear.status, "available");
  // Not a claim about real markets -- only that the fitter reproduces the curve
  // it was given, which is the precondition for the real comparison meaning
  // anything.
  assert.ok(Math.abs(svi.iv_decimal! - truthIv) < Math.abs(linear.iv_decimal! - truthIv),
    "on a genuinely SVI-shaped smile the SVI fit must recover the held-out point better");
});

/* ==================== local IV anchor baseline ==================== */

test("LOCAL-IV: it uses the stale same-contract anchor, and is unavailable without one", () => {
  const anchor = {instrument_name: "BTC-23JUN25-106000-C", iv_decimal: 0.44,
    timestamp_ms: T - 300 * MIN, age_minutes: 300};
  const estimate = estimateLocalIvAnchor(anchor, targetAt(0.01), 720);
  assert.equal(estimate.status, "available");
  assert.equal(estimate.iv_decimal, 0.44, "the anchor IV is repriced, not re-derived");
  assert.equal(estimate.diagnostics.anchor_age_minutes, 300);
  assert.equal(estimate.observation_count, 1);

  assert.equal(estimateLocalIvAnchor(null, targetAt(0.01)).status, "unavailable");
  assert.equal(estimateLocalIvAnchor(null, targetAt(0.01)).unavailable_reason, "no_causal_anchor");
  assert.equal(estimate.method_version, LOCAL_IV_ANCHOR_METHOD_VERSION);
});

test("LOCAL-IV: an anchor beyond the 720-minute bound, or from the future, is refused", () => {
  const stale = {instrument_name: "x", iv_decimal: 0.44, timestamp_ms: T - 900 * MIN, age_minutes: 900};
  assert.equal(estimateLocalIvAnchor(stale, targetAt(0)).status, "unavailable");
  const future = {instrument_name: "x", iv_decimal: 0.44, timestamp_ms: T + 10 * MIN, age_minutes: -10};
  assert.equal(estimateLocalIvAnchor(future, targetAt(0)).status, "unavailable",
    "a negative age is a causality breach and can never be an anchor");
});

/* ==================== scoring ==================== */

const scored = (over: Partial<ScoredCase> = {}): ScoredCase => ({
  case_id: "c1", method_version: SVI_METHOD_VERSION, event_id: "e1", snapshot_id: "s1",
  target_timestamp_ms: T, expiry_timestamp_ms: EXPIRY, actual_dte_days: 6.8,
  option_type: "C", log_moneyness: 0.01, readiness: "same_expiry_dense",
  same_expiry_strike_count: 12, truth_age_minutes: 10, hours_since_entry: 0, role: "entry",
  status: "available", unavailable_reason: null, is_extrapolation: false,
  iv_error_vol_points: 1, price_error_btc: 0.001, price_error_usd: 105,
  relative_price_error: 0.1, truth_iv_decimal: 0.42, truth_price_btc: 0.01,
  estimate_iv_decimal: 0.43, estimate_price_btc: 0.011, ...over,
});

test("SCORING: availability is measured against the FROZEN cohort, not the answered subset", () => {
  const cases = [scored({case_id: "a"}), scored({case_id: "b"}),
    scored({case_id: "c", status: "unavailable", unavailable_reason: "no_causal_anchor",
      iv_error_vol_points: null, price_error_btc: null})];
  const result = summarizeMethod(cases, 10);
  assert.equal(result.total_cohort, 10);
  assert.equal(result.eligible, 2);
  assert.equal(result.unavailable, 1);
  assert.equal(result.availability, 0.2, "2 of 10, not 2 of 3");
  assert.equal(result.unavailable_reasons.no_causal_anchor, 1);
  assert.equal(result.iv_vol_points.count, 2, "unavailable cases contribute no error");
});

test("SCORING: grouped metrics stop one busy smile from outvoting the rest", () => {
  // Sixty cases from one smile all wrong by 10; two from another wrong by 0.
  const many = Array.from({length: 60}, (_, i) => scored({
    case_id: `m${i}`, snapshot_id: "s1", target_timestamp_ms: 1, iv_error_vol_points: 10,
  }));
  const few = Array.from({length: 2}, (_, i) => scored({
    case_id: `f${i}`, snapshot_id: "s2", target_timestamp_ms: 2, iv_error_vol_points: 0,
  }));
  const result = summarizeMethod([...many, ...few], 62);
  assert.equal(result.group_count, 2);
  assert.ok(Math.abs(result.iv_vol_points.mae! - (60 * 10) / 62) < 1e-9,
    "observation-weighted is dominated by the busy smile");
  assert.equal(result.grouped_iv_vol_points.mae, 5, "grouped gives each smile one vote");
  assert.notEqual(result.iv_vol_points.mae, result.grouped_iv_vol_points.mae);
});

test("SCORING: error statistics are computed, not assumed", () => {
  const summary = summarizeErrors([-2, -1, 0, 1, 4]);
  assert.equal(summary.count, 5);
  assert.equal(summary.mean_signed, 0.4);
  assert.equal(summary.mae, (2 + 1 + 0 + 1 + 4) / 5);
  assert.equal(summary.median_absolute, 1);
  assert.equal(summary.worst_absolute, 4);
  assert.ok(Math.abs(summary.rmse! - Math.sqrt((4 + 1 + 0 + 1 + 16) / 5)) < 1e-12);
  assert.equal(summarizeErrors([]).count, 0);
  assert.equal(summarizeErrors([]).mae, null, "no data is null, never 0");
});

test("SCORING: leave-one-event-out re-ranks without the excluded event", () => {
  const byMethod = {
    good: [scored({event_id: "e1", iv_error_vol_points: 10}), scored({event_id: "e2", iv_error_vol_points: 1})],
    bad: [scored({event_id: "e1", iv_error_vol_points: 1}), scored({event_id: "e2", iv_error_vol_points: 9})],
  };
  const folds = leaveOneEventOut(byMethod);
  assert.equal(folds.length, 2);
  const withoutE1 = folds.find(f => f.excluded_event === "e1")!;
  assert.equal(withoutE1.ranking[0]!.method_version, "good", "without e1, good wins");
  const withoutE2 = folds.find(f => f.excluded_event === "e2")!;
  assert.equal(withoutE2.ranking[0]!.method_version, "bad", "the ranking genuinely flips");
});

test("SCORING: a spread credit sign flip is counted, and relative error is withheld on dust", () => {
  const spreads: ScoredSpread[] = [
    {case_id: "s1", method_version: SVI_METHOD_VERSION, event_id: "e1", candidate_id: "c1",
      snapshot_id: "x", target_timestamp_ms: T, actual_dte_days: 6, paired_truth_class: "synchronous",
      synchronization_gap_minutes: 1, status: "available", unavailable_reason: null,
      observed_credit_btc: 0.004, estimated_credit_btc: -0.001, credit_error_btc: -0.005,
      relative_credit_error: -1.25, credit_sign_flip: true},
    {case_id: "s2", method_version: SVI_METHOD_VERSION, event_id: "e1", candidate_id: "c2",
      snapshot_id: "x", target_timestamp_ms: T, actual_dte_days: 6, paired_truth_class: "synchronous",
      synchronization_gap_minutes: 1, status: "available", unavailable_reason: null,
      observed_credit_btc: 0.004, estimated_credit_btc: 0.005, credit_error_btc: 0.001,
      relative_credit_error: 0.25, credit_sign_flip: false},
  ];
  const result = summarizeSpreads(spreads, 4);
  assert.equal(result.eligible, 2);
  assert.equal(result.availability, 0.5);
  assert.equal(result.sign_flips, 1);
  assert.equal(result.sign_flip_rate, 0.5);
  assert.equal(result.credit_btc.mae, 0.003);
  assert.ok(MINIMUM_PRICE_FOR_RELATIVE_ERROR_BTC > 0,
    "relative error needs a floor, or a one-tick miss on dust reads as a total failure");
});

test("SCORING: breakdowns partition the cases exactly once", () => {
  const cases = [scored({case_id: "a", actual_dte_days: 0.5}), scored({case_id: "b", actual_dte_days: 6}),
    scored({case_id: "c", actual_dte_days: 20})];
  const byDte = summarizeBy(cases, c => c.actual_dte_days < 1 ? "0-1d" : c.actual_dte_days < 14 ? "1-14d" : "14d+");
  assert.deepEqual(Object.keys(byDte).sort(), ["0-1d", "14d+", "1-14d"].sort());
  assert.equal(Object.values(byDte).reduce((sum, r) => sum + r.total_cohort, 0), cases.length);
});

/* ==================== SSVI ==================== */

test("SSVI: it reproduces a surface generated from its own parameterization", () => {
  const rho = -0.3, eta = 1.2, gamma = 0.4;
  const maturities = [0.02, 0.08, 0.25].map(years => {
    const theta = 0.16 * years;
    return {
      expiryTimestampMs: Math.round(T + years * 365 * 24 * 3_600_000),
      timeToExpiryYears: years,
      points: [-0.2, -0.1, -0.03, 0, 0.03, 0.1, 0.2].map(k => {
        const w = ssviTotalVariance(k, theta, rho, eta, gamma);
        return {...point(k, Math.sqrt(w / years)), time_to_expiry_years: years,
          total_implied_variance: w};
      }),
    };
  });
  const fit = fitSsvi(maturities);
  assert.equal(fit.converged, true);
  assert.equal(fit.maturity_count, 3);
  assert.equal(fit.calendar_monotone, true, "ATM total variance rises with maturity here");
  assert.ok(fit.rms_residual_iv! < 0.02, `rms IV residual ${fit.rms_residual_iv}`);
  // Global shape parameters are shared across every maturity -- that sharing is
  // the only thing SSVI offers over a per-expiry fit.
  assert.equal(Object.keys(fit.parameters!.theta).length, 3);
});

test("SSVI: fewer than two maturities is unavailable — there is no term structure to borrow", () => {
  const one = [{expiryTimestampMs: EXPIRY, timeToExpiryYears: YEARS,
    points: [-0.1, 0, 0.1].map(k => point(k, 0.5))}];
  const fit = fitSsvi(one);
  assert.equal(fit.parameters, null);
  assert.equal(fit.unavailable_reason, "insufficient_maturities");
  assert.equal(SSVI_MINIMUM_MATURITIES, 2);
  assert.equal(ssviTotalVarianceAt(fit, EXPIRY, 0), null);
});

test("SSVI: a maturity whose ATM is not bracketed contributes no theta", () => {
  // Every strike above the money: theta would have to be extrapolated, and the
  // whole slice shape hangs off theta, so the maturity is dropped instead.
  assert.equal(atmTotalVariance([point(0.05, 0.5), point(0.10, 0.5), point(0.20, 0.5)]), null);
  assert.equal(atmTotalVariance([point(-0.20, 0.5), point(-0.10, 0.5)]), null);
  const bracketed = atmTotalVariance([point(-0.05, 0.40), point(0.05, 0.60)]);
  assert.ok(bracketed !== null && bracketed > 0);
  assert.equal(atmTotalVariance([point(0, 0.5)]), null, "one point is not a bracket");
});

test("SSVI: static-arbitrage conditions are enforced, not merely recorded", () => {
  const good = {rho: -0.3, eta: 1.0, gamma: 0.4, theta: {"1": 0.01}};
  assert.equal(ssviConstraintsSatisfied(good).ok, true);
  // eta far too large: theta*phi^2*(1+|rho|) blows past 4.
  const bad = {rho: -0.3, eta: 500, gamma: 0.9, theta: {"1": 0.05}};
  const verdict = ssviConstraintsSatisfied(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.some(v => v.includes("theta*phi")), verdict.violations.join("; "));
  // Out-of-domain shape parameters are refused outright.
  assert.equal(ssviConstraintsSatisfied({rho: 1.5, eta: 1, gamma: 0.4, theta: {"1": 0.01}}).ok, false);
  assert.equal(ssviConstraintsSatisfied({rho: 0, eta: 1, gamma: 1.5, theta: {"1": 0.01}}).ok, false);
  assert.equal(ssviConstraintsSatisfied({rho: 0, eta: 1, gamma: 0.4, theta: {}}).ok, false);
});

test("SSVI: an economically invalid surface yields no estimate", () => {
  const invalid = {
    parameters: {rho: -0.3, eta: 500, gamma: 0.9, theta: {[String(EXPIRY)]: 0.05}},
    converged: true, objective: 0, maturity_count: 2, observation_count: 20,
    rms_residual_total_variance: 0, rms_residual_iv: 0, calendar_monotone: true,
    constraint_violations: ["theta*phi^2"], warnings: [], method_version: "ssvi_power_law_v1",
    unavailable_reason: "fit_economically_invalid",
  };
  assert.equal(ssviTotalVarianceAt(invalid, EXPIRY, 0), null);
  const estimate = estimateSsvi(null, [point(0, 0.5)], targetAt(0), {}, "fit_economically_invalid");
  assert.equal(estimate.status, "unavailable");
  assert.equal(estimate.iv_decimal, null);
  assert.equal(estimate.method_version, SSVI_ESTIMATE_METHOD_VERSION);
});

test("SSVI: wing evaluations are labelled extrapolation, exactly as SVI's are", () => {
  const points = [-0.1, -0.05, 0, 0.05, 0.1].map(k => point(k, 0.5));
  const inside = estimateSsvi(0.5 * 0.5 * YEARS, points, targetAt(0.02), {}, null);
  const outside = estimateSsvi(0.5 * 0.5 * YEARS, points, targetAt(0.40), {}, null);
  assert.equal(inside.is_extrapolation, false);
  assert.equal(outside.is_extrapolation, true);
  assert.ok((outside.diagnostics.extrapolation_distance_log_moneyness as number) > 0.25);
});

/* ==================== the candidate hybrid ==================== */

const anchorAt = (iv: number, ageMinutes: number) => ({
  instrument_name: "BTC-23JUN25-105500-C", iv_decimal: iv,
  timestamp_ms: T - ageMinutes * MIN, age_minutes: ageMinutes,
});
const LADDER = [-0.10, -0.05, 0, 0.05, 0.10].map(k => point(k, 0.50));

test("HYBRID: interpolation wins when the target is bracketed and the geometry qualifies", () => {
  const h = estimateHybrid({points: LADDER, anchor: anchorAt(0.90, 300), target: targetAt(0.02),
    rule: "rule_c_min_5_strikes"});
  assert.equal(h.tier, "interpolation");
  assert.equal(h.status, "available");
  assert.equal(h.fallback_reason, null);
  assert.equal(h.method_version, HYBRID_METHOD_VERSION);
  // The anchor's 90-vol reading is available but must not have been used.
  assert.ok(Math.abs(h.iv_decimal! - 0.50) < 1e-9, "the bracketing observations decide, not the stale anchor");
  assert.equal(h.diagnostics.tier, "interpolation");
});

test("HYBRID: the local anchor serves when the target is not bracketed", () => {
  const oneSided = [0.02, 0.05, 0.10, 0.15, 0.20].map(k => point(k, 0.50));
  const h = estimateHybrid({points: oneSided, anchor: anchorAt(0.61, 300), target: targetAt(-0.05),
    rule: "rule_a_bracketed"});
  assert.equal(h.tier, "local_anchor");
  assert.equal(h.status, "available");
  assert.equal(h.eligibility.bracketed, false);
  assert.equal(h.fallback_reason, "target_not_bracketed");
  assert.equal(h.iv_decimal, 0.61);
  assert.equal(h.is_extrapolation, false, "the anchor is an exact-contract reading, never an extrapolation");
});

test("HYBRID: it NEVER extrapolates, whichever rule is in force", () => {
  for (const rule of HYBRID_GEOMETRY_RULES) {
    const h = estimateHybrid({points: LADDER, anchor: null, target: targetAt(0.40), rule});
    assert.notEqual(h.tier, "interpolation", `${rule} must refuse a target outside the observed range`);
    assert.equal(h.status, "unavailable", "with no anchor there is nothing left to report");
    assert.equal(h.iv_decimal, null);
    assert.equal(h.eligibility.bracketed, false);
  }
});

test("HYBRID: the geometry rule genuinely gates the interpolation tier", () => {
  // Bracketed, but only three distinct strikes.
  const thin = [-0.05, 0, 0.05].map(k => point(k, 0.50));
  const target = targetAt(0.02);
  assert.equal(estimateHybrid({points: thin, anchor: anchorAt(0.61, 300), target,
    rule: "rule_a_bracketed"}).tier, "interpolation");
  assert.equal(estimateHybrid({points: thin, anchor: anchorAt(0.61, 300), target,
    rule: "rule_b_min_3_strikes"}).tier, "interpolation", "three strikes satisfies rule B exactly");
  const ruleC = estimateHybrid({points: thin, anchor: anchorAt(0.61, 300), target, rule: "rule_c_min_5_strikes"});
  assert.equal(ruleC.tier, "local_anchor", "rule C requires five, so the anchor serves");
  assert.equal(ruleC.fallback_reason, "unique_strike_count_below_5");
  assert.equal(ruleC.eligibility.unique_strike_count, 3);
  assert.deepEqual([...HYBRID_GEOMETRY_RULES], ["rule_a_bracketed", "rule_b_min_3_strikes", "rule_c_min_5_strikes"]);
});

test("HYBRID: unavailable when neither tier qualifies, with an explicit reason", () => {
  const h = estimateHybrid({points: [], anchor: null, target: targetAt(0.02), rule: "rule_a_bracketed"});
  assert.equal(h.tier, "unavailable");
  assert.equal(h.status, "unavailable");
  assert.equal(h.iv_decimal, null, "never zero, never fabricated");
  assert.equal(h.unavailable_reason, "no_causal_anchor");
  assert.equal(h.fallback_reason, "no_qualifying_same_expiry_observations");
});

test("HYBRID: the final day reports its own reason rather than a generic miss", () => {
  const h = estimateHybrid({points: [], anchor: null, target: targetAt(0.02),
    rule: "rule_a_bracketed", isFinalDay: true});
  assert.equal(h.unavailable_reason, "surface_not_identifiable_final_day");
  // A missing pre-expiry mark is not a missing settlement payoff.
  assert.equal(h.diagnostics.final_day, true);
  // With genuine local evidence the final day still values normally.
  const withAnchor = estimateHybrid({points: [], anchor: anchorAt(0.61, 120), target: targetAt(0.02),
    rule: "rule_a_bracketed", isFinalDay: true});
  assert.equal(withAnchor.tier, "local_anchor");
  assert.equal(withAnchor.status, "available");
});

test("HYBRID: a stale anchor beyond 720 minutes cannot rescue an unbracketed target", () => {
  const oneSided = [0.05, 0.10, 0.15].map(k => point(k, 0.50));
  const h = estimateHybrid({points: oneSided, anchor: anchorAt(0.61, 900),
    target: targetAt(-0.05), rule: "rule_a_bracketed"});
  assert.equal(h.tier, "unavailable");
  assert.equal(h.unavailable_reason, "no_causal_anchor");
});

test("HYBRID: no SVI or SSVI branch exists in the hierarchy", () => {
  const versions = new Set<string>();
  for (const rule of HYBRID_GEOMETRY_RULES)
    for (const [points, anchor] of [[LADDER, anchorAt(0.61, 300)], [[], anchorAt(0.61, 300)], [[], null]] as const)
      versions.add(estimateHybrid({points, anchor, target: targetAt(0.02), rule}).method_version);
  assert.deepEqual([...versions], [HYBRID_METHOD_VERSION]);
  // The tier vocabulary itself admits only the three validated outcomes.
  const tiers = new Set(HYBRID_GEOMETRY_RULES.map(rule =>
    estimateHybrid({points: LADDER, anchor: null, target: targetAt(0.02), rule}).tier));
  for (const tier of tiers) assert.ok(["interpolation", "local_anchor", "unavailable"].includes(tier));
});

test("HYBRID: provenance is deterministic and states the geometry it relied on", () => {
  const h = estimateHybrid({points: LADDER, anchor: anchorAt(0.61, 300), target: targetAt(0.02),
    rule: "rule_c_min_5_strikes"});
  const again = estimateHybrid({points: [...LADDER].reverse(), anchor: anchorAt(0.61, 300),
    target: targetAt(0.02), rule: "rule_c_min_5_strikes"});
  assert.equal(again.iv_decimal, h.iv_decimal, "input order must not change the estimate");
  assert.equal(h.geometry_rule, "rule_c_min_5_strikes");
  assert.equal(h.eligibility.unique_strike_count, 5);
  assert.equal(h.eligibility.nearest_below_strike, LADDER[2]!.strike);
  assert.equal(h.eligibility.nearest_above_strike, LADDER[3]!.strike);
  assert.ok(h.eligibility.neighbour_distance_below! > 0 && h.eligibility.neighbour_distance_above! > 0);
  assert.ok(h.eligibility.max_observation_age_minutes !== null);
});

test("HYBRID: an exact observed strike counts as bracketed and is not extrapolation", () => {
  const e = hybridEligibility(LADDER, targetAt(0), "rule_c_min_5_strikes");
  assert.equal(e.bracketed, true);
  assert.equal(e.eligible, true);
  const h = estimateHybrid({points: LADDER, anchor: null, target: targetAt(0), rule: "rule_c_min_5_strikes"});
  assert.equal(h.tier, "interpolation");
  assert.equal(h.is_extrapolation, false);
});
