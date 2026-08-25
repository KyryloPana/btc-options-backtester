import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSurfaceSnapshot, observationsFor, type RawOptionPrint,
} from "../app/lib/volatility/cross-section.ts";
import {
  DEFAULT_SYNCHRONOUS_WINDOW_MINUTES, HOLDOUT_METHOD_VERSION,
  assertHoldoutIsClean, buildHoldoutCase, buildSingleContractHoldouts, buildSpreadHoldout,
  dteBucket, moneynessBucket, summarizeHoldouts,
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
  assert.equal(summary.calls, LADDER.length);
  assert.equal(summary.puts, 0);
  assert.equal(summary.distinct_events, 1);
  assert.equal(summary.distinct_snapshots, 1);
  assert.ok(Object.values(summary.by_readiness).reduce((a, b) => a + b, 0) === LADDER.length);
  assert.equal(Object.keys(summary.by_dte_bucket)[0], "3-7d", "the fixture expiry is 6.8 days out");
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
