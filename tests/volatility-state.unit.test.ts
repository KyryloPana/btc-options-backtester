import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_VOLATILITY_STATE_METHOD_VERSION, STRUCTURE_VOLATILITY_STATE_METHOD_VERSION,
  buildEventVolatilityState, buildStructureVolatilityState,
  type EventVolatilityStateInput, type StructureVolatilityStateInput,
} from "../app/lib/volatility/volatility-state.ts";
import type {ReferenceSeriesRow} from "../app/lib/volatility/reference-series.ts";
import {REFERENCE_SERIES_ID} from "../app/lib/volatility/reference-series.ts";
import {HOUR_MS, type RealizedVolatilityResult} from "../app/lib/volatility/realized-volatility.ts";
import type {IvPercentileResult} from "../app/lib/volatility/iv-percentile.ts";
import {projectVolatilityAnalytics} from "../app/lib/volatility/volatility-analytics.ts";
import type {NominalTenor} from "../app/lib/volatility/market-iv-evidence.ts";

/**
 * The two canonical bundle volatility tables. These pin the rule that decides
 * every field: a metric is available only when its own evidence is available AND
 * passes the market-state rule, and a derived metric only when every input it
 * derives from is independently available. Missing is null with a reason.
 */

const T = Date.UTC(2025, 5, 16, 12);
const HASH = "abc123";

const referenceRow = (over: Partial<ReferenceSeriesRow> = {}): ReferenceSeriesRow => ({
  series_id: REFERENCE_SERIES_ID, method_version: "volatility-reference-series-v1",
  timestamp_utc: new Date(T).toISOString(), timestamp_ms: T,
  underlying_instrument: "BTC-PERPETUAL", underlying_price: 105_000,
  nominal_tenor: "7d",
  reference_expiry_timestamp_utc: new Date(T + 6 * 86_400_000).toISOString(),
  actual_dte_days: 6, tenor_tolerance_passed: true,
  reference_iv_decimal: 0.42, iv_units: "decimal", reference_strike: 105_000, log_moneyness: 0,
  observation_class: "exact_atm", observation_source: "deribit_trade_iv",
  observation_timestamp_utc: new Date(T - 10 * 60_000).toISOString(),
  age_minutes: 10, max_age_minutes: 60, passes_market_state_rule: true,
  diagnostic_age_minutes: 10, source_trade_ids: ["t1"], interpolation_inputs: [],
  contract_settlement_period: "week", own_legs_excluded: true,
  quality: "observed", unavailable_reason_code: null, ...over,
});

const rv = (over: Partial<RealizedVolatilityResult> = {}): RealizedVolatilityResult => ({
  status: "available", rvDecimal: 0.55, observationCount: 167, expectedCount: 168,
  coverageRatio: 167 / 168, windowStartMs: T - 168 * HOUR_MS, windowEndMs: T,
  underlyingSource: "BTC-PERPETUAL", annualizationFactor: 8760,
  methodVersion: "realized-volatility-hourly-log-v1", unavailableReason: null, ...over,
});

const percentileResult = (over: Partial<IvPercentileResult> = {}): IvPercentileResult => ({
  status: "available", percentile: 0.62, subjectIvDecimal: 0.42,
  priorObservationCount: 900, otherTenorObservationsExcluded: 1800,
  minimumPriorObservations: 720, tenor: "7d",
  historyStartMs: T - 900 * HOUR_MS, historyEndMs: T - HOUR_MS,
  referenceSeriesId: REFERENCE_SERIES_ID, referenceSeriesContentHash: HASH,
  methodVersion: "expanding-causal-iv-percentile-v1", unavailableReason: null, ...over,
});

const eventInput = (over: Partial<EventVolatilityStateInput> = {}): EventVolatilityStateInput => ({
  eventId: "e1", entryTimestampMs: T, underlyingInstrument: "BTC-PERPETUAL",
  entryUnderlyingPrice: 105_000,
  referenceSeriesId: REFERENCE_SERIES_ID, referenceSeriesContentHash: HASH,
  referenceRows: [
    referenceRow({nominal_tenor: "7d", actual_dte_days: 6, reference_iv_decimal: 0.42}),
    referenceRow({nominal_tenor: "14d", actual_dte_days: 13, reference_iv_decimal: 0.46}),
    referenceRow({nominal_tenor: "30d", actual_dte_days: 27, reference_iv_decimal: 0.50}),
  ],
  realizedVolatility: {"1d": rv(), "3d": rv(), "7d": rv(), "14d": rv(), "30d": rv()},
  percentiles: {"7d": percentileResult(), "14d": percentileResult({tenor: "14d"}),
    "30d": percentileResult({tenor: "30d"})},
  ...over,
});

const tenorOf = (row: ReturnType<typeof buildEventVolatilityState>, t: NominalTenor) =>
  row.reference_iv.find(x => x.nominal_tenor === t)!;
const slopeOf = (row: ReturnType<typeof buildEventVolatilityState>, key: string) =>
  row.term_structure.find(x => x.slope === key)!;

/* ---------------- event state ---------------- */

test("EVENT: every tenor, horizon and slope is present, with identity on the row", () => {
  const row = buildEventVolatilityState(eventInput());
  assert.equal(row.method_version, EVENT_VOLATILITY_STATE_METHOD_VERSION);
  assert.equal(row.reference_series_id, REFERENCE_SERIES_ID);
  assert.equal(row.reference_series_content_hash, HASH);
  assert.deepEqual(row.reference_iv.map(x => x.nominal_tenor), ["7d", "14d", "30d"]);
  assert.deepEqual(row.realized_volatility.map(x => x.horizon), ["1d", "3d", "7d", "14d", "30d"]);
  assert.deepEqual(row.term_structure.map(x => x.slope), ["slope_7d_14d", "slope_14d_30d", "slope_7d_30d"]);
  assert.equal(row.entry_timestamp_utc, new Date(T).toISOString());
});

test("EVENT: a stale observation is unavailable, and its number is dropped rather than reported", () => {
  const row = buildEventVolatilityState(eventInput({
    referenceRows: [
      // A real print, but 200 minutes old: past the 60-minute market-state rule.
      referenceRow({nominal_tenor: "7d", age_minutes: 200, passes_market_state_rule: false}),
      referenceRow({nominal_tenor: "14d", actual_dte_days: 13, reference_iv_decimal: 0.46}),
      referenceRow({nominal_tenor: "30d", actual_dte_days: 27, reference_iv_decimal: 0.50}),
    ],
  }));
  const seven = tenorOf(row, "7d");
  assert.equal(seven.status, "unavailable");
  assert.equal(seven.iv_decimal, null, "a stale value is null, never reported with a caveat");
  assert.equal(seven.iv_units, null);
  assert.equal(seven.age_minutes, 200, "the age stays visible so the reason is auditable");
  assert.equal(seven.unavailable_reason_code, "stale_beyond_max_age");
});

test("EVENT: an out-of-tolerance tenor is unavailable, never relabelled", () => {
  const row = buildEventVolatilityState(eventInput({
    referenceRows: [
      referenceRow({nominal_tenor: "7d"}),
      referenceRow({nominal_tenor: "14d", actual_dte_days: 13, reference_iv_decimal: 0.46}),
      // 39 days is not a 30-day reference, whatever traded on it.
      referenceRow({nominal_tenor: "30d", actual_dte_days: 39, tenor_tolerance_passed: false,
        reference_iv_decimal: 0.50, unavailable_reason_code: "tenor_tolerance_failed"}),
    ],
  }));
  const thirty = tenorOf(row, "30d");
  assert.equal(thirty.status, "unavailable");
  assert.equal(thirty.iv_decimal, null);
  assert.equal(thirty.actual_dte_days, 39, "actual DTE is preserved, not the nominal label");
  assert.equal(thirty.unavailable_reason_code, "tenor_tolerance_failed");
});

test("EVENT: a missing tenor row is unavailable rather than absent or zero", () => {
  const row = buildEventVolatilityState(eventInput({referenceRows: []}));
  for (const t of row.reference_iv) {
    assert.equal(t.status, "unavailable");
    assert.equal(t.iv_decimal, null, "never 0 for missing");
    assert.equal(t.unavailable_reason_code, "no_qualifying_observation");
  }
});

/* ---------------- derived quantities ---------------- */

test("SLOPE: it is per ACTUAL day, because the nominal labels are approximations", () => {
  const row = buildEventVolatilityState(eventInput());
  const s = slopeOf(row, "slope_7d_14d");
  assert.equal(s.status, "available");
  assert.ok(Math.abs(s.value! - (0.46 - 0.42)) < 1e-12);
  // 6 and 13 actual days, not 7 and 14.
  assert.equal(s.from_actual_dte_days, 6);
  assert.equal(s.to_actual_dte_days, 13);
  assert.ok(Math.abs(s.value_per_day! - (0.46 - 0.42) / 7) < 1e-12);
});

test("SLOPE: one unavailable endpoint makes the slope unavailable, never a one-sided estimate", () => {
  const row = buildEventVolatilityState(eventInput({
    referenceRows: [
      referenceRow({nominal_tenor: "7d", passes_market_state_rule: false}),
      referenceRow({nominal_tenor: "14d", actual_dte_days: 13, reference_iv_decimal: 0.46}),
      referenceRow({nominal_tenor: "30d", actual_dte_days: 27, reference_iv_decimal: 0.50}),
    ],
  }));
  const s = slopeOf(row, "slope_7d_14d");
  assert.equal(s.status, "unavailable");
  assert.equal(s.value, null);
  assert.equal(s.value_per_day, null);
  assert.equal(s.unavailable_reason, "endpoint_unavailable");
  // The pair that survives is still computed.
  assert.equal(slopeOf(row, "slope_14d_30d").status, "available");
});

test("SLOPE: two tenors resolving to the SAME listed expiry give no per-day slope", () => {
  // A real Deribit condition on a thin cycle, not a divide-by-zero to hide.
  const row = buildEventVolatilityState(eventInput({
    referenceRows: [
      referenceRow({nominal_tenor: "7d", actual_dte_days: 10, reference_iv_decimal: 0.42}),
      referenceRow({nominal_tenor: "14d", actual_dte_days: 10, reference_iv_decimal: 0.42}),
      referenceRow({nominal_tenor: "30d", actual_dte_days: 27, reference_iv_decimal: 0.50}),
    ],
  }));
  const s = slopeOf(row, "slope_7d_14d");
  assert.equal(s.status, "unavailable");
  assert.equal(s.unavailable_reason, "degenerate_tenor_span");
  assert.equal(s.value_per_day, null);
  assert.equal(s.value, 0, "the raw difference is still stated; only the per-day rate is undefined");
});

test("IV-RV: the spread needs both sides; an unavailable RV is not treated as zero", () => {
  const available = buildEventVolatilityState(eventInput());
  const seven = available.iv_minus_rv.find(x => x.nominal_tenor === "7d")!;
  assert.ok(Math.abs(seven.value! - (0.42 - 0.55)) < 1e-12);
  assert.ok(seven.value! < 0, "IV below RV is a real, signed result");

  const thin = buildEventVolatilityState(eventInput({
    realizedVolatility: {"7d": rv({status: "unavailable", rvDecimal: null,
      unavailableReason: "insufficient_coverage", coverageRatio: 0.5})},
  }));
  const missing = thin.iv_minus_rv.find(x => x.nominal_tenor === "7d")!;
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.value, null, "an unavailable RV must not read as RV = 0");
});

test("RV: an unavailable horizon keeps its coverage evidence and drops only the value", () => {
  const row = buildEventVolatilityState(eventInput({
    realizedVolatility: {"1d": rv({status: "unavailable", rvDecimal: null, observationCount: 12,
      expectedCount: 24, coverageRatio: 0.5, unavailableReason: "insufficient_coverage"})},
  }));
  const one = row.realized_volatility.find(x => x.horizon === "1d")!;
  assert.equal(one.rv_decimal, null);
  assert.equal(one.observation_count, 12, "the shortfall stays visible");
  assert.equal(one.expected_count, 24);
  assert.equal(one.unavailable_reason, "insufficient_coverage");
  // A horizon the pipeline never produced is still a row, and still unavailable.
  const absent = row.realized_volatility.find(x => x.horizon === "30d")!;
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.rv_decimal, null);
});

test("PERCENTILE: the per-tenor exclusion count survives into the exported row", () => {
  const row = buildEventVolatilityState(eventInput());
  const seven = row.reference_iv_percentile.find(x => x.nominal_tenor === "7d")!;
  assert.equal(seven.percentile, 0.62);
  assert.equal(seven.other_tenor_observations_excluded, 1800,
    "the row must show that other tenors were excluded, not pooled");
  assert.equal(seven.minimum_prior_observations, 720);
  assert.equal(seven.reference_series_content_hash, HASH);
});

test("DVOL: broad context is separate and permanently refuses to substitute", () => {
  const row = buildEventVolatilityState(eventInput());
  assert.equal(row.broad_volatility_index.status, "unavailable");
  assert.equal(row.broad_volatility_index.value_decimal, null);
  assert.equal(row.broad_volatility_index.substitution_permitted, false);
  // It is not one of the same-expiry tenors and cannot be mistaken for one.
  assert.ok(!row.reference_iv.some(x => String(x.nominal_tenor).includes("dvol")));
});

/* ---------------- structure state ---------------- */

const structureInput = (over: Partial<StructureVolatilityStateInput> = {}): StructureVolatilityStateInput => ({
  eventId: "e1", candidateId: "c1", entryTimestampMs: T,
  actualExpiryTimestampMs: T + 6 * 86_400_000, actualDteDays: 6,
  shortStrike: 110_000, longStrike: 112_000, optionType: "C",
  shortInstrument: "BTC-23JUN25-110000-C", longInstrument: "BTC-23JUN25-112000-C",
  referenceSeriesId: REFERENCE_SERIES_ID, referenceSeriesContentHash: HASH,
  shortLeg: {ivDecimal: 0.48, ivApiPercent: 48, ivSource: "local-observed-IV",
    ivSourceTimestampMs: T - 5 * 60_000, observation: "observed"},
  longLeg: {ivDecimal: 0.51, ivApiPercent: 51, ivSource: "local-observed-IV",
    ivSourceTimestampMs: T - 8 * 60_000, observation: "observed"},
  reference: referenceRow(),
  ...over,
});

const legOf = (row: ReturnType<typeof buildStructureVolatilityState>, leg: "short" | "long") =>
  row.legs.find(l => l.leg === leg)!;
const diffOf = (row: ReturnType<typeof buildStructureVolatilityState>, kind: string) =>
  row.differentials.find(d => d.differential === kind)!;

test("STRUCTURE: identity, both legs and all three differentials travel on the row", () => {
  const row = buildStructureVolatilityState(structureInput());
  assert.equal(row.method_version, STRUCTURE_VOLATILITY_STATE_METHOD_VERSION);
  assert.equal(row.candidate_id, "c1");
  assert.equal(row.short_strike, 110_000);
  assert.equal(row.actual_dte_days, 6);
  assert.deepEqual(row.legs.map(l => l.leg), ["short", "long"]);
  assert.deepEqual(row.differentials.map(d => d.differential),
    ["short_minus_reference_iv", "long_minus_reference_iv", "short_minus_long_iv"]);
  assert.ok(Math.abs(diffOf(row, "short_minus_long_iv").value! - (0.48 - 0.51)) < 1e-12);
  assert.ok(Math.abs(diffOf(row, "short_minus_reference_iv").value! - (0.48 - 0.42)) < 1e-12);
});

test("STRUCTURE: no synthesized spread IV exists, and the row says so explicitly", () => {
  const row = buildStructureVolatilityState(structureInput());
  assert.equal(row.synthesized_spread_iv, null);
  assert.match(row.synthesized_spread_iv_note, /no single implied volatility/);
});

test("CIRCULARITY: a reconstructed leg is never market evidence, whatever IV it carries", () => {
  const row = buildStructureVolatilityState(structureInput({
    shortLeg: {ivDecimal: 0.48, ivSource: "model-reconstructed",
      ivSourceTimestampMs: T - 5 * 60_000, observation: "reconstructed"},
  }));
  const short = legOf(row, "short");
  assert.equal(short.status, "unavailable");
  assert.equal(short.iv_decimal, null, "the model number must not reach a market-evidence consumer");
  assert.equal(short.observation, "reconstructed", "the classification is preserved for audit");
  assert.match(short.unavailable_reason!, /pricing state, not market evidence/);
  // Every differential that depended on it collapses too.
  assert.equal(diffOf(row, "short_minus_reference_iv").status, "unavailable");
  assert.equal(diffOf(row, "short_minus_long_iv").status, "unavailable");
  assert.equal(diffOf(row, "long_minus_reference_iv").status, "available", "the clean leg survives");
});

test("CIRCULARITY: constant-entry-IV is a pricing fallback, not evidence IV was unchanged", () => {
  const row = buildStructureVolatilityState(structureInput({
    shortLeg: {ivDecimal: 0.48, ivSource: "constant-entry-IV",
      ivSourceTimestampMs: T - 5 * 60_000, observation: "constant-entry-IV"},
  }));
  assert.equal(legOf(row, "short").status, "unavailable");
  assert.equal(legOf(row, "short").iv_decimal, null);
});

test("SELF-REFERENCE: a reference that included the subject legs is not differenced against them", () => {
  const row = buildStructureVolatilityState(structureInput({
    reference: referenceRow({own_legs_excluded: false}),
  }));
  assert.equal(row.same_expiry_reference.status, "available", "the reference itself is a real observation");
  assert.equal(row.same_expiry_reference.excluded_own_legs, false);
  assert.equal(diffOf(row, "short_minus_reference_iv").status, "unavailable",
    "measuring a leg against a reference containing it measures it against itself");
  assert.equal(diffOf(row, "short_minus_reference_iv").value, null);
  // The leg-to-leg differential is untouched: it never involved the reference.
  assert.equal(diffOf(row, "short_minus_long_iv").status, "available");
});

test("STALENESS: a leg outside the 60-minute window is unavailable and keeps its age", () => {
  const row = buildStructureVolatilityState(structureInput({
    longLeg: {ivDecimal: 0.51, ivSource: "local-observed-IV",
      ivSourceTimestampMs: T - 200 * 60_000, observation: "observed"},
  }));
  const long = legOf(row, "long");
  assert.equal(long.status, "unavailable");
  assert.equal(long.iv_decimal, null);
  assert.equal(long.age_minutes, 200);
  assert.equal(long.passes_market_state_rule, false);
  assert.match(long.unavailable_reason!, /outside the 60-minute market-state window/);
});

test("STALENESS: a leg sourced AFTER entry is refused, since it could not have been known", () => {
  const row = buildStructureVolatilityState(structureInput({
    shortLeg: {ivDecimal: 0.48, ivSource: "local-observed-IV",
      ivSourceTimestampMs: T + 5 * 60_000, observation: "observed"},
  }));
  assert.equal(legOf(row, "short").status, "unavailable");
  assert.equal(legOf(row, "short").age_minutes, -5, "the negative age exposes the causality breach");
});

test("STRUCTURE: an entirely missing reference is unavailable, and every reference differential with it", () => {
  const row = buildStructureVolatilityState(structureInput({reference: null}));
  assert.equal(row.same_expiry_reference.status, "unavailable");
  assert.equal(row.same_expiry_reference.iv_decimal, null);
  assert.equal(row.same_expiry_reference.method, "unavailable");
  assert.equal(diffOf(row, "short_minus_reference_iv").status, "unavailable");
  assert.equal(diffOf(row, "long_minus_reference_iv").status, "unavailable");
  assert.equal(diffOf(row, "short_minus_long_iv").status, "available");
});

/* ---------------- analytics projection and coverage ---------------- */

test("COVERAGE: absent tables project to zero coverage rather than to an error", () => {
  const p = projectVolatilityAnalytics({});
  assert.equal(p.coverage.eventCount, 0);
  assert.equal(p.coverage.structureCount, 0);
  assert.equal(p.hasMarketEvidence, false);
  assert.equal(p.coverage.referenceIvByTenor["7d"].ratio, null, "no denominator is null, not 0/0 = 0");
});

test("COVERAGE: availability is measured per tenor with the reasons for every miss", () => {
  const good = buildEventVolatilityState(eventInput());
  const bad = buildEventVolatilityState(eventInput({
    eventId: "e2",
    referenceRows: [referenceRow({nominal_tenor: "7d", passes_market_state_rule: false, age_minutes: 300})],
  }));
  const p = projectVolatilityAnalytics({
    event_volatility_state: [good, bad] as unknown as Readonly<Record<string, unknown>>[],
    structure_volatility_state: [buildStructureVolatilityState(structureInput())] as unknown as Readonly<Record<string, unknown>>[],
  });
  assert.equal(p.coverage.eventCount, 2);
  assert.equal(p.coverage.eventsWithAnyReferenceIv, 1, "one event had no usable tenor at all");
  assert.equal(p.coverage.referenceIvByTenor["7d"].available, 1);
  assert.equal(p.coverage.referenceIvByTenor["7d"].total, 2);
  assert.equal(p.coverage.referenceIvByTenor["7d"].ratio, 0.5);
  assert.equal(p.coverage.referenceIvByTenor["7d"].reasons.stale_beyond_max_age, 1,
    "the reason for the miss is counted, not just the miss");
  assert.equal(p.coverage.referenceIvByTenor["30d"].available, 1, "e2 had no 30d row at all");
  assert.equal(p.coverage.referenceIvByTenor["30d"].total, 2);
  assert.equal(p.hasMarketEvidence, true);
  // Actual DTE is collected so the nominal-label gap stays measurable.
  assert.deepEqual([...p.coverage.actualDteByTenor["7d"]], [6, 6]);
  assert.equal(p.coverage.legs.available, 2);
  assert.equal(p.coverage.legObservations.observed, 2);
});

test("COVERAGE: model-classified legs are counted as evidence misses, not as evidence", () => {
  const p = projectVolatilityAnalytics({
    structure_volatility_state: [buildStructureVolatilityState(structureInput({
      shortLeg: {ivDecimal: 0.48, ivSource: "model-reconstructed",
        ivSourceTimestampMs: T - 60_000, observation: "reconstructed"},
    }))] as unknown as Readonly<Record<string, unknown>>[],
  });
  assert.equal(p.coverage.legs.available, 1, "only the genuinely observed leg counts");
  assert.equal(p.coverage.legs.total, 2);
  assert.equal(p.coverage.legObservations.reconstructed, 1);
  assert.equal(p.coverage.differentials.short_minus_long_iv.available, 0);
});
