import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  CROSS_SECTION_METHOD_VERSION, DENSE_MINIMUM_PER_SIDE, DENSE_MINIMUM_STRIKES,
  FORWARD_CONVENTION, HISTORICAL_OPTION_IV_DATASET_ID, YEAR_MS,
  admitCrossSection, buildSurfaceSnapshot, classifyLeg, classifySurfaceReadiness,
  dedupePrints, expirySliceDiagnostics, maturityCoverage, observationsFor, sliceFor,
  snapshotContentHash, tradeIdentityKey,
  type RawOptionPrint,
} from "../app/lib/volatility/cross-section.ts";
import {
  CROSS_SECTION_CACHE_ROOT, CrossSectionRetrieval, causalUnderlyingPrice,
  listCrossSectionShards, listedExpiriesAt, readCrossSectionManifest,
  readCrossSectionObservations, readCrossSectionSnapshots, writeCrossSectionShards,
} from "../scripts/cross-section-cache.ts";
import {OPTION_HISTORY_HOST} from "../app/lib/volatility/reference-series.ts";
import {priceInverseOption} from "../app/lib/inverse-option-pricing.ts";

/**
 * The causal cross-sectional IV observation layer.
 *
 * The dataset exists to answer whether a surface is IDENTIFIABLE from real
 * historical tape, so these tests pin the two things that would quietly
 * invalidate that answer: evidence entering that should not (model IV, future
 * prints, contracts not yet listed, duplicated pages), and geometry being
 * reported as stronger than it is (extrapolation dressed as interpolation, a
 * one-sided slice called ATM-bracketed).
 */

const T = Date.UTC(2025, 5, 16, 12);
const EXPIRY = Date.UTC(2025, 5, 23, 8);
const FAR_EXPIRY = Date.UTC(2025, 6, 25, 8);
const SPOT = 105_000;
const MIN = 60_000;
const HOST = OPTION_HISTORY_HOST;

const print = (over: Partial<RawOptionPrint> = {}): RawOptionPrint => ({
  instrumentName: "BTC-23JUN25-105000-C", tradeId: "t1", tradeSeq: 1,
  strike: 105_000, optionType: "C", expiryTimestampMs: EXPIRY,
  settlementPeriod: "week", contractCreatedAtMs: Date.UTC(2025, 4, 1),
  timestampMs: T - 10 * MIN, ivApiPercent: 42, indexPrice: SPOT,
  price: 0.01, markPrice: 0.011, amount: 1, direction: "buy", tickDirection: 2,
  ...over,
});

/** A strike ladder on one expiry, one print each. */
const ladder = (strikes: readonly number[], over: Partial<RawOptionPrint> = {}): RawOptionPrint[] =>
  strikes.map((strike, i) => print({
    strike, instrumentName: `BTC-23JUN25-${strike}-C`, tradeId: `t-${strike}-${i}`,
    ...over,
  }));

const snapshotOf = (prints: readonly RawOptionPrint[], over: Partial<Parameters<typeof buildSurfaceSnapshot>[0]> = {}) =>
  buildSurfaceSnapshot({prints, targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: HOST, ...over});

/* ---------------- admission: causality and circularity ---------------- */

test("CAUSALITY: a print at or after the target never enters the cross-section", () => {
  const result = admitCrossSection({
    prints: [print({timestampMs: T + MIN, tradeId: "future"}), print({tradeId: "past"})],
    targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: HOST,
  });
  assert.equal(result.admitted, 1);
  assert.equal(result.observations[0]!.trade_id, "past");
  assert.equal(result.rejected.future_observation, 1);
});

test("CAUSALITY: the canonical window is 60 minutes, and 240 is diagnostic only", () => {
  const result = admitCrossSection({
    prints: [print({timestampMs: T - 30 * MIN, tradeId: "fresh"}),
      print({timestampMs: T - 120 * MIN, tradeId: "stale"})],
    targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: HOST,
  });
  assert.equal(result.admitted, 1, "the 120-minute print is outside the canonical window");
  assert.equal(result.rejected.stale_beyond_max_age, 1);

  // Widening is possible, but the widened observation must still declare that
  // it failed the canonical rule -- it cannot be laundered into canonical
  // readiness by asking for a longer window.
  const wide = admitCrossSection({
    prints: [print({timestampMs: T - 120 * MIN, tradeId: "stale"})],
    targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: HOST, maxAgeMinutes: 240,
  });
  assert.equal(wide.admitted, 1);
  assert.equal(wide.observations[0]!.passes_market_state_rule, false,
    "a 120-minute-old print is outside the canonical 60-minute rule whatever window retrieved it");
  assert.equal(wide.observations[0]!.within_diagnostic_window, true);
});

test("CAUSALITY: a contract not yet listed at the target is refused", () => {
  const result = admitCrossSection({
    // The daily-option trap: listed three days before it expires, so it cannot
    // be evidence at an earlier target however real its later prints are.
    prints: [print({contractCreatedAtMs: T + 86_400_000, settlementPeriod: "day"})],
    targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: HOST,
  });
  assert.equal(result.admitted, 0);
  assert.equal(result.rejected.contract_not_listed_at_target, 1);
});

test("CIRCULARITY: model-sourced IV can never become a cross-sectional observation", () => {
  for (const source of ["constant-entry-IV", "model-reconstructed", "intrinsic-at-expiry",
    "surface_extrapolation", "dvol_anchored_smile_proxy"]) {
    const result = admitCrossSection({
      prints: [print({ivSource: source})],
      targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: HOST,
    });
    assert.equal(result.admitted, 0, `${source} must not be admitted`);
    assert.equal(result.observations.length, 0);
  }
  // IV recovered by inverting a model price is refused even with no source tag.
  const inverted = admitCrossSection({
    prints: [print({impliedFromModelPrice: true})],
    targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: HOST,
  });
  assert.equal(inverted.admitted, 0);
  assert.equal(inverted.rejected.iv_from_model_price, 1);
  // A reconstructed leg observation is refused too.
  const reconstructed = admitCrossSection({
    prints: [print({observation: "reconstructed"})],
    targetTimestampMs: T, underlyingPrice: SPOT, sourceHost: HOST,
  });
  assert.equal(reconstructed.admitted, 0);
});

/* ---------------- deduplication ---------------- */

test("DEDUPE: a repeated page collapses, but two genuinely separate prints survive", () => {
  const a = print({tradeId: "x1"});
  const repeated = dedupePrints([a, {...a}, {...a}]);
  assert.equal(repeated.prints.length, 1);
  assert.equal(repeated.duplicatesRemoved, 2);
  assert.equal(repeated.duplicatesByInstrument["BTC-23JUN25-105000-C"], 2);

  // Same instrument, same millisecond, DIFFERENT trade ids: two real fills.
  const separate = dedupePrints([print({tradeId: "x1"}), print({tradeId: "x2"})]);
  assert.equal(separate.prints.length, 2, "distinct trade ids are distinct prints");
  assert.equal(separate.duplicatesRemoved, 0);
});

test("DEDUPE: identity falls back to full coordinates when no trade id exists", () => {
  const noId = print({tradeId: null});
  assert.match(tradeIdentityKey(noId), /^coord\|/);
  assert.match(tradeIdentityKey(print({tradeId: "x"})), /^id:x$/);
  // Differing on any coordinate keeps them separate.
  const result = dedupePrints([noId, {...noId}, {...noId, price: 0.02}]);
  assert.equal(result.prints.length, 2);
  assert.equal(result.duplicatesRemoved, 1);
});

test("DEDUPE: duplicates are removed BEFORE counting, so no diagnostic is inflated", () => {
  const one = print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-C", tradeId: "a"});
  const snapshot = snapshotOf([one, {...one}, {...one}, print({strike: 106_000, instrumentName: "BTC-23JUN25-106000-C", tradeId: "b"})]);
  assert.equal(snapshot.duplicates_removed, 2);
  assert.equal(snapshot.admitted_count, 2, "the repeated page must not inflate the trade count");
  assert.equal(snapshot.slices[0]!.qualifying_trade_count, 2);
  assert.equal(snapshot.slices[0]!.unique_strike_count, 2);
});

/* ---------------- surface coordinates ---------------- */

test("COORDINATES: log-moneyness, actual DTE and total implied variance are exact", () => {
  const snapshot = snapshotOf([print({strike: 110_000, instrumentName: "BTC-23JUN25-110000-C", ivApiPercent: 50})]);
  const o = snapshot.observations[0]!;
  assert.ok(Math.abs(o.log_moneyness - Math.log(110_000 / o.forward_price)) < 1e-12);
  assert.ok(Math.abs(o.actual_dte_days - (EXPIRY - T) / 86_400_000) < 1e-12);
  const years = (EXPIRY - T) / YEAR_MS;
  assert.ok(Math.abs(o.time_to_expiry_years - years) < 1e-15);
  // w = IV^2 * T, the quantity SVI and SSVI are parameterised in.
  assert.ok(Math.abs(o.total_implied_variance - 0.5 * 0.5 * years) < 1e-15);
  assert.equal(o.iv_units, "decimal");
  assert.equal(o.variance_units, "decimal_squared_years");
  assert.equal(o.iv_decimal, 0.5);
});

test("COORDINATES: the forward convention is stated, not implied", () => {
  const snapshot = snapshotOf([print()]);
  assert.equal(snapshot.forward_convention, FORWARD_CONVENTION);
  assert.equal(snapshot.observations[0]!.forward_convention, "causal_option_trade_implied_expiry_forward");
  assert.equal(snapshot.observations[0]!.dataset_id, HISTORICAL_OPTION_IV_DATASET_ID);
  assert.equal(snapshot.observations[0]!.method_version, CROSS_SECTION_METHOD_VERSION);
});

test("ENVELOPE: an explicit log-moneyness bound excludes and COUNTS, never silently drops", () => {
  const prints = ladder([60_000, 104_000, 105_000, 106_000, 200_000]);
  const bounded = snapshotOf(prints, {logMoneynessEnvelope: 0.1});
  assert.equal(bounded.excluded_by_envelope, 2, "the two far strikes are outside +/-0.1");
  assert.equal(bounded.log_moneyness_envelope, 0.1);
  assert.equal(bounded.admitted_count, 3);
  // No envelope by default: the full cross-section is preserved so a smile can be learned.
  const full = snapshotOf(prints);
  assert.equal(full.log_moneyness_envelope, null);
  assert.equal(full.excluded_by_envelope, 0);
  assert.equal(full.admitted_count, 5);
});

/* ---------------- slice geometry ---------------- */

test("GEOMETRY: calls and puts are preserved separately and never averaged", () => {
  const snapshot = snapshotOf([
    print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-C", optionType: "C", tradeId: "c1", ivApiPercent: 40}),
    print({strike: 104_000, instrumentName: "BTC-23JUN25-104000-P", optionType: "P", tradeId: "p1", ivApiPercent: 44}),
  ]);
  const slice = snapshot.slices[0]!;
  assert.equal(slice.call_count, 1);
  assert.equal(slice.put_count, 1);
  assert.equal(slice.unique_strike_count, 1, "one strike, two contracts");
  assert.equal(slice.unique_instrument_count, 2);
  const ivs = snapshot.observations.map(o => o.iv_decimal).sort();
  assert.deepEqual(ivs, [0.4, 0.44], "both IVs survive; nothing is blended into 0.42");
});

test("GEOMETRY: ATM bracketing requires observed strikes on BOTH sides of the underlying", () => {
  const oneSided = expirySliceDiagnostics(snapshotOf(ladder([106_000, 108_000, 110_000])).observations, SPOT);
  assert.equal(oneSided.atm_bracketed, false, "three strikes, all above spot, is not bracketed");
  assert.equal(oneSided.observations_above_atm, 3);
  assert.equal(oneSided.observations_below_atm, 0);

  const bracketed = expirySliceDiagnostics(snapshotOf(ladder([100_000, 104_000, 108_000])).observations, SPOT);
  assert.equal(bracketed.atm_bracketed, true);
  assert.equal(bracketed.min_strike, 100_000);
  assert.equal(bracketed.max_strike, 108_000);
});

test("GEOMETRY: age statistics report the real distribution, freshest to P95", () => {
  const snapshot = snapshotOf([1, 5, 20, 40, 55].map((age, i) =>
    print({timestampMs: T - age * MIN, strike: 100_000 + i * 1000,
      instrumentName: `BTC-23JUN25-${100_000 + i * 1000}-C`, tradeId: `t${i}`})));
  const slice = snapshot.slices[0]!;
  assert.equal(slice.freshest_age_minutes, 1);
  assert.equal(slice.median_age_minutes, 20);
  assert.equal(slice.p95_age_minutes, 55);
  assert.equal(slice.qualifying_trade_count, 5);
});

test("GROUPING: observations are grouped by expiry, and each slice sees only its own", () => {
  const snapshot = snapshotOf([
    ...ladder([104_000, 106_000]),
    print({strike: 104_000, expiryTimestampMs: FAR_EXPIRY, instrumentName: "BTC-25JUL25-104000-C", tradeId: "f1"}),
  ]);
  assert.equal(snapshot.slices.length, 2);
  assert.equal(sliceFor(snapshot, EXPIRY)!.qualifying_trade_count, 2);
  assert.equal(sliceFor(snapshot, FAR_EXPIRY)!.qualifying_trade_count, 1);
  assert.equal(sliceFor(snapshot, Date.UTC(2030, 0, 1)), null);
  assert.equal(observationsFor(snapshot, FAR_EXPIRY).length, 1);
  // Slices are ordered by maturity, which is what makes the term structure readable.
  assert.ok(snapshot.slices[0]!.expiry_timestamp_ms < snapshot.slices[1]!.expiry_timestamp_ms);
});

/* ---------------- leg classification ---------------- */

const legOf = (strike: number, prints: readonly RawOptionPrint[], instrument: string | null = null) => {
  const snapshot = snapshotOf(prints);
  return classifyLeg({
    leg: "short", strike, optionType: "C", instrumentName: instrument,
    underlyingPrice: SPOT, slice: sliceFor(snapshot, EXPIRY),
    observations: observationsFor(snapshot, EXPIRY),
  });
};

test("LEG: a print on the exact contract is exact_observed, and no surface is needed", () => {
  const leg = legOf(106_000, ladder([104_000, 106_000, 108_000]), "BTC-23JUN25-106000-C");
  assert.equal(leg.classification, "exact_observed");
  assert.equal(leg.exact_observed, true);
  assert.equal(leg.exact_observation_count, 1);
  assert.equal(leg.nearest_observed_strike_distance, 0);
});

test("LEG: a strike bracketed on both sides is an interpolation candidate", () => {
  const leg = legOf(105_500, ladder([104_000, 106_000, 108_000]), "BTC-23JUN25-105500-C");
  assert.equal(leg.classification, "interpolation_candidate");
  assert.equal(leg.exact_observed, false);
  assert.equal(leg.observed_strikes_below, 1);
  assert.equal(leg.observed_strikes_above, 2);
  assert.equal(leg.inside_observed_strike_range, true);
  assert.equal(leg.nearest_observed_strike, 106_000);
  assert.equal(leg.nearest_observed_strike_distance, 500);
});

test("LEG: a strike beyond every observation requires extrapolation, however dense the slice", () => {
  // Twenty strikes, all below the leg. Density does not create information on
  // the side where none was observed.
  const dense = ladder(Array.from({length: 20}, (_, i) => 90_000 + i * 500));
  const leg = legOf(130_000, dense, "BTC-23JUN25-130000-C");
  assert.equal(leg.classification, "extrapolation_required");
  assert.equal(leg.observed_strikes_above, 0);
  assert.equal(leg.inside_observed_strike_range, false);
  assert.equal(leg.observed_strikes_below, 20, "the density is still reported, it just does not help");
});

test("LEG: no observed geometry at all is unidentifiable, not extrapolation", () => {
  const leg = legOf(106_000, [], "BTC-23JUN25-106000-C");
  assert.equal(leg.classification, "unidentifiable");
  assert.equal(leg.nearest_observed_strike, null);
  assert.equal(leg.observed_strikes_below, 0);
  assert.equal(leg.observed_strikes_above, 0);
});

test("LEG: option type is honoured -- a put print does not identify a call leg", () => {
  const puts = ladder([104_000, 106_000, 108_000], {optionType: "P"})
    .map(p => ({...p, instrumentName: p.instrumentName.replace("-C", "-P")}));
  const snapshot = snapshotOf(puts);
  const leg = classifyLeg({
    leg: "short", strike: 106_000, optionType: "C", instrumentName: "BTC-23JUN25-106000-C",
    underlyingPrice: SPOT, slice: sliceFor(snapshot, EXPIRY), observations: observationsFor(snapshot, EXPIRY),
  });
  assert.equal(leg.exact_observed, false, "a put on the same strike is not this call");
  assert.equal(leg.classification, "interpolation_candidate", "the put ladder still gives strike geometry");
});

/* ---------------- readiness ---------------- */

const readinessOf = (legStrikes: readonly [number, number], observed: readonly number[],
  adjacent: readonly number[][] = []) => {
  const snapshot = snapshotOf([
    ...ladder(observed),
    ...adjacent.flatMap((strikes, i) => strikes.map(strike => {const expiry=FAR_EXPIRY+i*86_400_000,priced=priceInverseOption({optionType:"call",indexPrice:SPOT,strike,valuationTimestamp:T-10*MIN,expiryTimestamp:expiry,ivDecimal:.42,forwardPrice:SPOT});return print({
      strike, expiryTimestampMs: expiry, price:priced.status==="priced"?priced.priceBtc:null,
      instrumentName: `BTC-ADJ${i}-${strike}-C`, tradeId: `adj-${i}-${strike}`,
    })})),
  ]);
  const slice = sliceFor(snapshot, EXPIRY);
  const observations = observationsFor(snapshot, EXPIRY);
  const legs = (["short", "long"] as const).map((leg, i) => classifyLeg({
    leg, strike: legStrikes[i]!, optionType: "C",
    instrumentName: `BTC-23JUN25-${legStrikes[i]}-C`,
    underlyingPrice: SPOT, slice, observations,
  }));
  return classifySurfaceReadiness({
    slice, legs, adjacentSlices: snapshot.slices.filter(s => s.expiry_timestamp_ms !== EXPIRY),
  });
};

test("READINESS: dense requires enough strikes AND two-sided support around every leg", () => {
  assert.equal(DENSE_MINIMUM_STRIKES, 5);
  assert.equal(DENSE_MINIMUM_PER_SIDE, 2);
  const dense = readinessOf([105_500, 106_500],
    [100_000, 102_000, 104_000, 105_000, 107_000, 108_000, 110_000]);
  assert.equal(dense.readiness, "same_expiry_dense");
  assert.equal(dense.same_expiry_strike_count, 7);
  assert.equal(dense.any_leg_extrapolation_required, false);
});

test("READINESS: enough strikes but one-sided support around a leg is only sparse", () => {
  // Seven strikes, but just one observed strike above the long leg.
  const verdict = readinessOf([104_500, 109_000],
    [100_000, 101_000, 102_000, 103_000, 104_000, 108_000, 110_000]);
  assert.equal(verdict.readiness, "same_expiry_sparse");
  assert.equal(verdict.same_expiry_strike_count, 7,
    "the count is high; the geometry around the leg is what disqualifies it");
});

test("READINESS: extrapolation outranks density, so a rich but one-sided slice is not dense", () => {
  const verdict = readinessOf([105_500, 130_000],
    [96_000, 98_000, 100_000, 102_000, 104_000, 106_000, 108_000]);
  assert.equal(verdict.readiness, "extrapolation_required");
  assert.equal(verdict.any_leg_extrapolation_required, true);
  assert.equal(verdict.all_legs_inside_observed_range, false);
});

test("READINESS: a thin same expiry falls back to adjacent maturities, and says so", () => {
  const verdict = readinessOf([105_000, 106_000], [],
    [[100_000, 104_000, 106_000, 110_000], [99_000, 103_000, 107_000, 111_000]]);
  assert.equal(verdict.readiness, "cross_expiry_supported");
  assert.equal(verdict.adjacent_usable_expiry_count, 2);
  assert.match(verdict.rationale, /adjacent maturities/);
});

test("READINESS: no same-expiry and no usable adjacent maturity is unidentifiable", () => {
  const verdict = readinessOf([105_000, 106_000], []);
  assert.equal(verdict.readiness, "surface_unidentifiable");
  assert.equal(verdict.same_expiry_strike_count, 0);
  assert.equal(verdict.adjacent_usable_expiry_count, 0);
});

test("READINESS: the classification is deterministic and order-independent", () => {
  const observed = [100_000, 102_000, 104_000, 106_000, 108_000, 110_000];
  const forward = readinessOf([105_000, 107_000], observed);
  const reversed = readinessOf([105_000, 107_000], [...observed].reverse());
  assert.equal(forward.readiness, reversed.readiness);
  assert.deepEqual({...forward}, {...reversed}, "input order must not change the verdict");
  // Repeating the identical call yields the identical verdict.
  assert.deepEqual({...readinessOf([105_000, 107_000], observed)}, {...forward});
});

/* ---------------- maturity coverage ---------------- */

test("MATURITY: an expiry is bracketed only with usable slices on both sides in time", () => {
  const near = Date.UTC(2025, 5, 20, 8), mid = EXPIRY, far = FAR_EXPIRY;
  const snapshot = snapshotOf([near, mid, far].flatMap((expiry, i) =>
    [100_000, 104_000, 106_000, 110_000].map(strike => print({
      strike, expiryTimestampMs: expiry, instrumentName: `BTC-E${i}-${strike}-C`,
      tradeId: `e${i}-${strike}`,
    }))));
  const bracketed = maturityCoverage(snapshot.slices, mid);
  assert.equal(bracketed.target_expiry_bracketed_in_maturity, true);
  assert.equal(bracketed.usable_expiry_count, 3);
  assert.ok(bracketed.nearest_expiry_below_dte_days! < bracketed.nearest_expiry_above_dte_days!);

  // The furthest maturity has nothing beyond it, so it is not bracketed.
  const edge = maturityCoverage(snapshot.slices, far);
  assert.equal(edge.target_expiry_bracketed_in_maturity, false);
  assert.equal(edge.nearest_expiry_above_utc, null);
  assert.ok(edge.largest_maturity_gap_days! > 0);
});

test("MATURITY: a maturity too thin to be usable is not counted as support", () => {
  const snapshot = snapshotOf([
    ...ladder([100_000, 104_000, 106_000, 110_000]),
    print({strike: 104_000, expiryTimestampMs: FAR_EXPIRY, instrumentName: "BTC-FAR-104000-C", tradeId: "far1"}),
  ]);
  const coverage = maturityCoverage(snapshot.slices, EXPIRY);
  assert.equal(coverage.usable_expiry_count, 1, "a one-strike maturity carries no cross-sectional information");
  assert.equal(coverage.target_expiry_bracketed_in_maturity, false);
});

/* ---------------- snapshot identity ---------------- */

test("IDENTITY: the content hash tracks evidence and ignores presentation order", () => {
  const prints = ladder([104_000, 106_000, 108_000]);
  const a = snapshotOf(prints), b = snapshotOf([...prints].reverse());
  assert.equal(a.content_hash, b.content_hash, "the same evidence in any order is the same snapshot");
  assert.equal(a.snapshot_id, b.snapshot_id);
  const changed = snapshotOf([...prints, print({strike: 112_000, instrumentName: "BTC-23JUN25-112000-C", tradeId: "new"})]);
  assert.notEqual(changed.content_hash, a.content_hash, "different evidence is a different snapshot");
  assert.match(a.snapshot_id, new RegExp(`^${HISTORICAL_OPTION_IV_DATASET_ID}~`));
});

test("IDENTITY: the hash covers observations, not derived diagnostics", () => {
  const prints = ladder([104_000, 106_000]);
  const snapshot = snapshotOf(prints);
  assert.equal(snapshotContentHash(snapshot.observations), snapshot.content_hash);
});

/* ---------------- retrieval helpers ---------------- */

test("RETRIEVAL: the causal underlying is the index on the freshest qualifying print", () => {
  const prints = [
    print({timestampMs: T - 40 * MIN, indexPrice: 104_000, tradeId: "old"}),
    print({timestampMs: T - 5 * MIN, indexPrice: 105_500, tradeId: "new"}),
    print({timestampMs: T + MIN, indexPrice: 999_999, tradeId: "future"}),
  ];
  assert.equal(causalUnderlyingPrice(prints, T), 105_500, "a future print cannot set the causal underlying");
  assert.equal(causalUnderlyingPrice([], T), null);
});

test("RETRIEVAL: listed expiries are creation-gated and exclude settled contracts", () => {
  const manifest = [
    {instrumentName: "a", strike: 100_000, optionType: "C" as const, expiryTimestampMs: EXPIRY,
      createdAtMs: Date.UTC(2025, 4, 1), settlementPeriod: "week"},
    {instrumentName: "b", strike: 105_000, optionType: "C" as const, expiryTimestampMs: EXPIRY,
      createdAtMs: Date.UTC(2025, 4, 1), settlementPeriod: "week"},
    // Not yet listed at the target.
    {instrumentName: "c", strike: 106_000, optionType: "C" as const, expiryTimestampMs: FAR_EXPIRY,
      createdAtMs: T + 86_400_000, settlementPeriod: "week"},
    // Already expired at the target.
    {instrumentName: "d", strike: 99_000, optionType: "C" as const, expiryTimestampMs: T - 86_400_000,
      createdAtMs: Date.UTC(2025, 3, 1), settlementPeriod: "week"},
  ];
  const expiries = listedExpiriesAt(manifest, T);
  assert.equal(expiries.length, 1);
  assert.equal(expiries[0]!.expiryTimestampMs, EXPIRY);
  assert.deepEqual([...expiries[0]!.strikes].sort((a, b) => a - b), [100_000, 105_000]);
});

test("RETRIEVAL: a window is fetched once and reused, and clearing releases it", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("get_instruments")
      ? {result: [{instrument_name: "BTC-23JUN25-105000-C", strike: 105_000, option_type: "call",
        expiration_timestamp: EXPIRY, creation_timestamp: Date.UTC(2025, 4, 1), settlement_period: "week"}]}
      : {result: {trades: [{instrument_name: "BTC-23JUN25-105000-C", trade_id: "t1", timestamp: T - MIN,
        iv: 42, index_price: SPOT, price: 0.01, amount: 1, direction: "buy"}]}};
    return new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;

  const retrieval = new CrossSectionRetrieval({fetcher});
  await retrieval.optionPrints(T - 60 * MIN, T);
  const before = retrieval.requestCount;
  await retrieval.optionPrints(T - 60 * MIN, T);
  assert.equal(retrieval.requestCount, before, "the same window must not be refetched");
  retrieval.clearWindowCache();
  await retrieval.optionPrints(T - 60 * MIN, T);
  assert.ok(retrieval.requestCount > before, "clearing the cache genuinely releases the window");
  // Only the history mirror serves expired option history.
  for (const url of calls) assert.ok(url.startsWith(OPTION_HISTORY_HOST), url);
  // The manifest is fetched once and survives a window-cache clear.
  const manifestCalls = calls.filter(u => u.includes("get_instruments")).length;
  assert.equal(manifestCalls, 2, "expired and active manifests, once each");
});

/* ---------------- shard cache ---------------- */

async function withTempRoot<R>(run: (root: string) => Promise<R>): Promise<R> {
  const root = await mkdtemp(join(tmpdir(), "xsec-"));
  try { return await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}

test("CACHE: snapshots and observations land in separate monthly shards with a manifest", async () => {
  await withTempRoot(async root => {
    const snapshot = snapshotOf(ladder([104_000, 106_000]));
    const result = await writeCrossSectionShards({snapshots: [snapshot], root, generatedAtUtc: "2026-01-01T00:00:00.000Z"});
    assert.deepEqual(result.shardsWritten, ["2025-06"]);
    assert.equal(result.manifest.dataset_id, HISTORICAL_OPTION_IV_DATASET_ID);
    assert.equal(result.manifest.snapshot_count, 1);
    assert.equal(result.manifest.observation_count, 2);
    assert.equal(result.manifest.source_host, OPTION_HISTORY_HOST);
    assert.deepEqual(await listCrossSectionShards(root), ["2025-06"]);

    const snapshots = await readCrossSectionSnapshots("2025-06", root);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.observations, undefined,
      "the snapshot row carries identity and geometry; evidence lives in its own file");
    const observations = await readCrossSectionObservations("2025-06", root);
    assert.equal(observations.length, 2);
    assert.equal((await readCrossSectionManifest(root))!.content_hash, result.manifest.content_hash);
  });
});

test("CACHE: an unchanged snapshot is reused, and a changed one is rewritten", async () => {
  await withTempRoot(async root => {
    const prints = ladder([104_000, 106_000]);
    await writeCrossSectionShards({snapshots: [snapshotOf(prints)], root});
    const again = await writeCrossSectionShards({snapshots: [snapshotOf(prints)], root});
    assert.deepEqual(again.shardsWritten, [], "identical evidence must not rewrite the shard");
    assert.deepEqual(again.shardsReused, ["2025-06"]);

    const changed = await writeCrossSectionShards({
      snapshots: [snapshotOf([...prints, print({strike: 110_000, instrumentName: "BTC-23JUN25-110000-C", tradeId: "z"})])],
      root,
    });
    assert.deepEqual(changed.shardsWritten, ["2025-06"]);
    // Same target timestamp: the row is replaced, not duplicated.
    assert.equal((await readCrossSectionSnapshots("2025-06", root)).length, 1);
    assert.equal(changed.manifest.observation_count, 3);
  });
});

test("CACHE: the manifest hash is stable across regeneration but tracks content", async () => {
  await withTempRoot(async root => {
    const prints = ladder([104_000, 106_000]);
    const first = await writeCrossSectionShards({snapshots: [snapshotOf(prints)], root, generatedAtUtc: "2026-01-01T00:00:00.000Z"});
    const same = await writeCrossSectionShards({snapshots: [snapshotOf(prints)], root, generatedAtUtc: "2026-09-09T00:00:00.000Z"});
    assert.equal(same.manifest.content_hash, first.manifest.content_hash,
      "generation time must not change identity");
    const other = await writeCrossSectionShards({
      snapshots: [buildSurfaceSnapshot({prints, targetTimestampMs: T + 3_600_000,
        underlyingPrice: SPOT, sourceHost: HOST})],
      root,
    });
    assert.notEqual(other.manifest.content_hash, first.manifest.content_hash);
    assert.equal(other.manifest.snapshot_count, 2, "a new target is a new snapshot, not a replacement");
  });
});

test("CACHE: a missing cache reads as empty rather than throwing", async () => {
  await withTempRoot(async root => {
    assert.deepEqual(await listCrossSectionShards(root), []);
    assert.deepEqual(await readCrossSectionSnapshots("1999-01", root), []);
    assert.deepEqual(await readCrossSectionObservations("1999-01", root), []);
    assert.equal(await readCrossSectionManifest(root), null);
  });
  assert.equal(CROSS_SECTION_CACHE_ROOT, ".local-cache/historical-option-iv");
});
