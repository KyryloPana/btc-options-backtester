import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSurfaceSnapshot, observationsFor, type RawOptionPrint,
} from "../app/lib/volatility/cross-section.ts";
import {
  DEFAULT_SYNCHRONOUS_WINDOW_MINUTES, HOLDOUT_METHOD_VERSION,
  assertHoldoutIsClean, buildHoldoutCase, buildSingleContractHoldouts, buildSpreadHoldout,
  caseLogMoneyness, caseOptionType, dteBucket, moneynessBucket, summarizeHoldouts,
} from "../app/lib/volatility/holdout.ts";
import {OPTION_HISTORY_HOST} from "../app/lib/volatility/reference-series.ts";

/**
 * Hide-one-out validation cases.
 *
 * A holdout whose truth is still reachable from its fitting inputs measures
 * nothing, so the exclusion is what these tests are mostly about. The cases are
 * built before any model exists, which is the point: no threshold or cohort here
 * can have been chosen after seeing a result.
 */

const T = Date.UTC(2025, 5, 16, 12);
const EXPIRY = Date.UTC(2025, 5, 23, 8);
const FAR_EXPIRY = Date.UTC(2025, 6, 25, 8);
const SPOT = 105_000;
const MIN = 60_000;

const print = (over: Partial<RawOptionPrint> = {}): RawOptionPrint => ({
  instrumentName: "BTC-23JUN25-105000-C", tradeId: "t1", tradeSeq: 1,
  strike: 105_000, optionType: "C", expiryTimestampMs: EXPIRY,
  settlementPeriod: "week", contractCreatedAtMs: Date.UTC(2025, 4, 1),
  timestampMs: T - 10 * MIN, ivApiPercent: 42, indexPrice: SPOT,
  price: 0.01, markPrice: 0.011, amount: 1, direction: "buy",
  ...over,
});

const call = (strike: number, over: Partial<RawOptionPrint> = {}): RawOptionPrint => print({
  strike, instrumentName: `BTC-23JUN25-${strike}-C`, tradeId: `t-${strike}`, ...over,
});

const LADDER = [100_000, 102_000, 104_000, 106_000, 108_000, 110_000];
const snapshotOf = (prints: readonly RawOptionPrint[]) =>
  buildSurfaceSnapshot({prints, targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: OPTION_HISTORY_HOST});
const fullSnapshot = () => snapshotOf(LADDER.map(k => call(k)));

/* ---------------- exclusion is the whole point ---------------- */

test("HOLDOUT: the withheld contract is absent from the fitting inputs and present in truth", () => {
  const snapshot = fullSnapshot();
  const holdout = buildHoldoutCase({
    snapshot, expiryTimestampMs: EXPIRY, mode: "exact_target_contract",
    withheldInstruments: ["BTC-23JUN25-106000-C"],
    legs: [{leg: "short", strike: 106_000, optionType: "C", instrumentName: "BTC-23JUN25-106000-C"}],
  })!;
  assert.ok(holdout);
  assert.equal(holdout.fitting_inputs.length, LADDER.length - 1);
  assert.ok(!holdout.fitting_inputs.some(o => o.instrument_name === "BTC-23JUN25-106000-C"),
    "the held-out contract must not survive anywhere in the fitting inputs");
  assert.equal(holdout.truth.length, 1);
  assert.equal(holdout.truth[0]!.instrument_name, "BTC-23JUN25-106000-C");
  assert.equal(holdout.truth[0]!.true_iv_decimal, 0.42);
  assert.equal(holdout.truth[0]!.true_trade_price, 0.01);
  assert.equal(holdout.truth[0]!.mark_price, 0.011);
  assert.equal(holdout.method_version, HOLDOUT_METHOD_VERSION);
});

test("HOLDOUT: withholding removes the contract at EVERY maturity, not only its own", () => {
  // A model handed the same contract at another expiry could recover the answer
  // straight through the term structure.
  const snapshot = snapshotOf([
    ...LADDER.map(k => call(k)),
    print({strike: 106_000, expiryTimestampMs: FAR_EXPIRY,
      instrumentName: "BTC-23JUN25-106000-C", tradeId: "far-106"}),
  ]);
  const holdout = buildHoldoutCase({
    snapshot, expiryTimestampMs: EXPIRY, mode: "exact_target_contract",
    withheldInstruments: ["BTC-23JUN25-106000-C"],
    legs: [{leg: "short", strike: 106_000, optionType: "C", instrumentName: "BTC-23JUN25-106000-C"}],
  })!;
  assert.ok(!holdout.fitting_inputs.some(o => o.instrument_name === "BTC-23JUN25-106000-C"),
    "the withheld instrument must not survive at any expiry");
});

test("HOLDOUT: a leaked truth is detected and refused, not quietly tolerated", () => {
  const snapshot = fullSnapshot();
  const holdout = buildHoldoutCase({
    snapshot, expiryTimestampMs: EXPIRY, mode: "exact_target_contract",
    withheldInstruments: ["BTC-23JUN25-106000-C"],
    legs: [{leg: "short", strike: 106_000, optionType: "C", instrumentName: "BTC-23JUN25-106000-C"}],
  })!;
  assert.doesNotThrow(() => assertHoldoutIsClean(holdout));

  // Reintroduce the withheld contract: the guard must catch it.
  const leaked = {...holdout, fitting_inputs: [...holdout.fitting_inputs, ...observationsFor(snapshot, EXPIRY)
    .filter(o => o.instrument_name === "BTC-23JUN25-106000-C")]};
  assert.throws(() => assertHoldoutIsClean(leaked), /leaked/);
});

test("HOLDOUT: a contract that never printed is not a case, because there is no truth", () => {
  const snapshot = fullSnapshot();
  const none = buildHoldoutCase({
    snapshot, expiryTimestampMs: EXPIRY, mode: "exact_target_contract",
    withheldInstruments: ["BTC-23JUN25-999000-C"],
    legs: [{leg: "short", strike: 999_000, optionType: "C", instrumentName: "BTC-23JUN25-999000-C"}],
  });
  assert.equal(none, null);
});

/* ---------------- geometry AFTER the holdout ---------------- */

test("HOLDOUT: readiness is recomputed on what REMAINS, not on the full cross-section", () => {
  const snapshot = fullSnapshot();
  // Withhold both strikes adjacent to the leg above it, so the remaining slice
  // no longer brackets it -- the case must report that, not the pre-holdout view.
  const holdout = buildHoldoutCase({
    snapshot, expiryTimestampMs: EXPIRY, mode: "structure_both_legs",
    withheldInstruments: ["BTC-23JUN25-108000-C", "BTC-23JUN25-110000-C"],
    legs: [{leg: "short", strike: 109_000, optionType: "C", instrumentName: "BTC-23JUN25-109000-C"}],
  })!;
  assert.equal(holdout.remaining_slice!.unique_strike_count, 4);
  assert.equal(holdout.remaining_slice!.max_strike, 106_000);
  assert.equal(holdout.remaining_leg_evidence[0]!.classification, "extrapolation_required",
    "with both strikes above it removed, the leg is beyond the remaining evidence");
  assert.equal(holdout.remaining_readiness.readiness, "extrapolation_required");
});

test("HOLDOUT: removing an interior contract leaves it an interpolation candidate", () => {
  const snapshot = fullSnapshot();
  const holdout = buildHoldoutCase({
    snapshot, expiryTimestampMs: EXPIRY, mode: "exact_target_contract",
    withheldInstruments: ["BTC-23JUN25-106000-C"],
    legs: [{leg: "short", strike: 106_000, optionType: "C", instrumentName: "BTC-23JUN25-106000-C"}],
  })!;
  const leg = holdout.remaining_leg_evidence[0]!;
  assert.equal(leg.classification, "interpolation_candidate");
  assert.equal(leg.exact_observed, false, "the truth is hidden, so it cannot read as observed");
  assert.equal(leg.observed_strikes_below, 3);
  assert.equal(leg.observed_strikes_above, 2);
  assert.equal(holdout.remaining_readiness.readiness, "same_expiry_dense");
});

test("HOLDOUT: identity is deterministic and tracks the withheld set", () => {
  const snapshot = fullSnapshot();
  const make = (withheld: string[]) => buildHoldoutCase({
    snapshot, expiryTimestampMs: EXPIRY, mode: "exact_target_contract",
    withheldInstruments: withheld,
    legs: [{leg: "short", strike: 106_000, optionType: "C", instrumentName: "BTC-23JUN25-106000-C"}],
  })!;
  assert.equal(make(["BTC-23JUN25-106000-C"]).case_id, make(["BTC-23JUN25-106000-C"]).case_id);
  assert.notEqual(make(["BTC-23JUN25-106000-C"]).content_hash, make(["BTC-23JUN25-104000-C"]).content_hash);
  // Order of the withheld list must not change identity.
  assert.equal(make(["BTC-23JUN25-106000-C", "BTC-23JUN25-104000-C"]).content_hash,
    make(["BTC-23JUN25-104000-C", "BTC-23JUN25-106000-C"]).content_hash);
});

test("HOLDOUT: one case per observed contract, covering the whole slice", () => {
  const cases = buildSingleContractHoldouts({snapshot: fullSnapshot(), expiryTimestampMs: EXPIRY, eventId: "e1"});
  assert.equal(cases.length, LADDER.length);
  assert.deepEqual([...new Set(cases.map(c => c.mode))], ["exact_target_contract"]);
  for (const c of cases) assert.doesNotThrow(() => assertHoldoutIsClean(c));
  assert.deepEqual([...new Set(cases.map(c => c.event_id))], ["e1"]);
});

/* ---------------- vertical-spread holdouts ---------------- */

const spreadRequest = (over: Partial<Parameters<typeof buildSpreadHoldout>[0]> = {}) => ({
  snapshot: fullSnapshot(), expiryTimestampMs: EXPIRY,
  eventId: "e1", candidateId: "c1", optionType: "C",
  shortStrike: 106_000, longStrike: 108_000,
  shortInstrument: "BTC-23JUN25-106000-C", longInstrument: "BTC-23JUN25-108000-C",
  ...over,
});

test("SPREAD: both legs withheld, both truths kept, and the observed credit is real", () => {
  const spread = buildSpreadHoldout(spreadRequest({
    snapshot: snapshotOf([
      ...LADDER.filter(k => k !== 106_000 && k !== 108_000).map(k => call(k)),
      call(106_000, {price: 0.030}), call(108_000, {price: 0.018}),
    ]),
  }))!;
  assert.equal(spread.paired_truth_class, "synchronous");
  assert.equal(spread.short_truth!.instrument_name, "BTC-23JUN25-106000-C");
  assert.equal(spread.long_truth!.instrument_name, "BTC-23JUN25-108000-C");
  // Credit is short premium minus long premium, from two REAL prints.
  assert.ok(Math.abs(spread.observed_spread_credit_native! - (0.030 - 0.018)) < 1e-12);
  assert.equal(spread.synchronization_gap_minutes, 0);
  assert.equal(spread.holdout.mode, "structure_both_legs");
  assert.ok(!spread.holdout.fitting_inputs.some(o =>
    o.instrument_name === "BTC-23JUN25-106000-C" || o.instrument_name === "BTC-23JUN25-108000-C"));
});

test("SPREAD: asynchronous legs keep their gap and are classified, never synthesized", () => {
  const spread = buildSpreadHoldout(spreadRequest({
    snapshot: snapshotOf([
      ...LADDER.filter(k => k !== 106_000 && k !== 108_000).map(k => call(k)),
      call(106_000, {timestampMs: T - 5 * MIN, price: 0.030}),
      call(108_000, {timestampMs: T - 45 * MIN, price: 0.018}),
    ]),
  }))!;
  assert.equal(spread.paired_truth_class, "asynchronous_within_window");
  assert.equal(spread.synchronization_gap_minutes, 40);
  assert.ok(spread.synchronization_gap_minutes! > DEFAULT_SYNCHRONOUS_WINDOW_MINUTES);
  assert.equal(spread.max_observation_age_minutes, 45);
  // A credit computed from two prints 40 minutes apart is still stated, but the
  // classification is what tells a consumer how much to trust it.
  assert.ok(spread.observed_spread_credit_native !== null);
});

test("SPREAD: a one-sided pair has no observed credit invented for it", () => {
  const spread = buildSpreadHoldout(spreadRequest({
    snapshot: snapshotOf([...LADDER.filter(k => k !== 108_000).map(k => call(k))]),
  }))!;
  assert.equal(spread.paired_truth_class, "single_leg_only");
  assert.equal(spread.long_truth, null);
  assert.equal(spread.observed_spread_credit_native, null,
    "an unobserved leg must never be filled in to complete a credit");
  assert.ok(spread.short_truth);
});

test("SPREAD: neither leg observed is not a case at all", () => {
  const spread = buildSpreadHoldout(spreadRequest({
    snapshot: snapshotOf(LADDER.filter(k => k !== 106_000 && k !== 108_000).map(k => call(k))),
  }));
  assert.equal(spread, null);
});

/* ---------------- composition ---------------- */

test("COMPOSITION: the sample is summarized across mode, readiness, type, DTE and moneyness", () => {
  const cases = buildSingleContractHoldouts({snapshot: fullSnapshot(), expiryTimestampMs: EXPIRY, eventId: "e1"});
  const summary = summarizeHoldouts(cases);
  assert.equal(summary.total_cases, LADDER.length);
  assert.equal(summary.cases_by_option_type.C, LADDER.length);
  assert.equal(summary.distinct_events, 1);
  assert.equal(summary.distinct_snapshots, 1);
  assert.equal(Object.values(summary.cases_by_readiness).reduce((a, b) => a + b, 0), LADDER.length);
  assert.equal(Object.keys(summary.cases_by_dte_bucket)[0], "3-7d", "the fixture expiry is 6.8 days out");
});

/* ------- REGRESSION: the two denominators are separate and both stated ------- */

test("DENOMINATOR: a case is one withheld instrument; truths are its individual prints", () => {
  // One strike printed five times, the rest once. One CASE hides that
  // instrument; five TRUTH OBSERVATIONS come with it. Reporting 5 beside 6
  // without saying which is which is what produced two inconsistent universes
  // in the Phase 2A.3 report.
  const busy = [0, 1, 2, 3, 4].map(i => call(106_000, {tradeId: `busy-${i}`, timestampMs: T - (10 + i) * MIN}));
  const snapshot = snapshotOf([...LADDER.filter(k => k !== 106_000).map(k => call(k)), ...busy]);
  const cases = buildSingleContractHoldouts({snapshot, expiryTimestampMs: EXPIRY, eventId: "e1"});
  const summary = summarizeHoldouts(cases);

  assert.equal(summary.total_cases, LADDER.length, "six instruments, six cases");
  assert.equal(summary.total_truth_observations, LADDER.length - 1 + busy.length,
    "the busy strike contributes five truths from one case");
  assert.notEqual(summary.total_cases, summary.total_truth_observations,
    "the fixture must actually exercise the divergence");

  // Case-level tallies sum to the case count.
  for (const tally of [summary.cases_by_mode, summary.cases_by_readiness,
    summary.cases_by_option_type, summary.cases_by_dte_bucket, summary.cases_by_moneyness_bucket])
    assert.equal(Object.values(tally).reduce((a, b) => a + b, 0), summary.total_cases);

  // Observation-level tallies sum to the truth count.
  for (const tally of [summary.truth_observations_by_option_type,
    summary.truth_observations_by_moneyness_bucket])
    assert.equal(Object.values(tally).reduce((a, b) => a + b, 0), summary.total_truth_observations);

  assert.equal(summary.truth_observations_per_case.max, busy.length);
  assert.equal(summary.truth_observations_per_case.min, 1);
  assert.ok(summary.truth_observations_per_case.mean > 1);
});

test("DENOMINATOR: the cohort hash identifies the case SET, independent of order", () => {
  const cases = buildSingleContractHoldouts({snapshot: fullSnapshot(), expiryTimestampMs: EXPIRY, eventId: "e1"});
  const forward = summarizeHoldouts(cases).cohort_content_hash;
  assert.equal(summarizeHoldouts([...cases].reverse()).cohort_content_hash, forward,
    "the frozen cohort identity must not depend on build order");
  assert.notEqual(summarizeHoldouts(cases.slice(1)).cohort_content_hash, forward,
    "dropping a case must change the cohort identity");
  assert.ok(forward.length > 0);
});

test("IDENTITY: a case id survives a round trip through storage order", () => {
  // The shard cache stores observations sorted; the original build saw them in
  // admission order. An order-sensitive identity would give the same case two
  // different ids depending on where it was loaded from, which would make the
  // frozen cohort impossible to verify -- and did, until this was fixed.
  const busy = [0, 1, 2, 3].map(i => call(106_000, {tradeId: `b-${i}`, timestampMs: T - (5 + i) * MIN,
    ivApiPercent: 42 + i}));
  const others = LADDER.filter(k => k !== 106_000).map(k => call(k));
  const build = (prints: readonly RawOptionPrint[]) => buildHoldoutCase({
    snapshot: snapshotOf(prints), expiryTimestampMs: EXPIRY, mode: "exact_target_contract",
    withheldInstruments: ["BTC-23JUN25-106000-C"],
    legs: [{leg: "short", strike: 106_000, optionType: "C", instrumentName: "BTC-23JUN25-106000-C"}],
  })!;

  const asBuilt = build([...others, ...busy]);
  const asStored = build([...others, ...[...busy].reverse()]);
  assert.equal(asBuilt.truth.length, busy.length, "the fixture must actually hide several prints");
  assert.equal(asStored.case_id, asBuilt.case_id,
    "the same hidden evidence in a different order is the same case");
  assert.equal(asStored.content_hash, asBuilt.content_hash);
  // The truth itself is emitted in a canonical order too, so a consumer reading
  // truth[0] gets the same print either way.
  assert.deepEqual(asStored.truth.map(t => t.trade_id), asBuilt.truth.map(t => t.trade_id));

  // Genuinely different hidden evidence is still a different case.
  const different = build([...others, ...busy.slice(1)]);
  assert.notEqual(different.case_id, asBuilt.case_id);
});

test("DENOMINATOR: a case always carries at least one truth, so its type is well defined", () => {
  const cases = buildSingleContractHoldouts({snapshot: fullSnapshot(), expiryTimestampMs: EXPIRY, eventId: "e1"});
  for (const c of cases) {
    assert.ok(c.truth.length >= 1, "a case with no truth would score nothing and must not exist");
    assert.equal(new Set(c.truth.map(t => t.instrument_name)).size, 1,
      "every truth in a case is the same instrument, which is what makes the case-level type well defined");
    assert.equal(caseOptionType(c), c.truth[0]!.option_type);
    assert.equal(caseLogMoneyness(c), c.truth[0]!.log_moneyness);
  }
  assert.equal(summarizeHoldouts([]).total_cases, 0);
  assert.equal(summarizeHoldouts([]).truth_observations_per_case.median, 0);
});

test("COMPOSITION: bucket boundaries are explicit and side-aware", () => {
  assert.equal(dteBucket(1), "0-3d");
  assert.equal(dteBucket(6.8), "3-7d");
  assert.equal(dteBucket(20), "14-30d");
  assert.equal(dteBucket(37), "30d+");
  assert.equal(moneynessBucket(0), "atm");
  assert.equal(moneynessBucket(0.01), "atm");
  assert.equal(moneynessBucket(0.04), "above_near");
  assert.equal(moneynessBucket(-0.04), "below_near");
  assert.equal(moneynessBucket(-0.20), "below_far");
});
