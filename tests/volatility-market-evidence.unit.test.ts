import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_IV_MAX_AGE_MINUTES, MARKET_IV_METHOD_VERSION, MODEL_ONLY_IV_SOURCES,
  admitMarketIvTrade, assertMarketEvidence, isMarketEvidence,
  assertSingleExpiry, resolveReferenceIv, resolveTenor,
  type AdmittedIvTrade, type RawIvTradeCandidate,
} from "../app/lib/volatility/market-iv-evidence.ts";
import {
  DVOL_HOST, DVOL_SERIES_ID, OPTION_HISTORY_HOST, REFERENCE_SERIES_ID,
  buildDvolRows, buildReferenceSeriesManifest, buildReferenceSeriesRows,
  dvolSeriesIdentity, referenceSeriesContentHash, refuseDvolSubstitution, shardIdFor,
} from "../app/lib/volatility/reference-series.ts";

/**
 * The market-IV evidence domain exists to make one mistake structurally hard:
 * a pricing-model output being consumed as evidence of market state. These tests
 * pin the admission gate, the reference hierarchy, the locked staleness rule and
 * the host routing the capability audit established.
 */

const T = Date.UTC(2025, 5, 16, 12);
const EXPIRY = Date.UTC(2025, 5, 23, 8);
const SPOT = 105_000;
const MIN = 60_000;

const trade = (over: Partial<RawIvTradeCandidate> = {}): RawIvTradeCandidate => ({
  instrumentName: "BTC-23JUN25-105000-C",
  tradeId: "t1", tradeSeq: 1,
  strike: 105_000, optionType: "C",
  expiryTimestampMs: EXPIRY, settlementPeriod: "week",
  contractCreatedAtMs: Date.UTC(2025, 4, 1),
  timestampMs: T - 10 * MIN,
  ivApiPercent: 42, indexPrice: SPOT,
  ...over,
});
const admit = (over: Partial<RawIvTradeCandidate> = {}, ctx: Partial<Parameters<typeof admitMarketIvTrade>[1]> = {}) =>
  admitMarketIvTrade(trade(over), {targetTimestampMs: T, underlyingPrice: SPOT, ...ctx});
const admitted = (over: Partial<RawIvTradeCandidate> = {}): AdmittedIvTrade => {
  const r = admit(over);
  assert.equal(r.admitted, true, "fixture should be admissible");
  return (r as {observation: AdmittedIvTrade}).observation;
};

/* ---------------- circularity: model IV can never be market evidence ---------------- */

test("CIRCULARITY: every pricing-model IV source is refused", () => {
  for (const source of MODEL_ONLY_IV_SOURCES) {
    const r = admit({ivSource: source});
    assert.equal(r.admitted, false, `${source} must not be admitted`);
    if (!r.admitted) assert.ok(["iv_source_is_model", "intrinsic_at_expiry"].includes(r.code), `${source} -> ${r.code}`);
  }
  // The one that started this: a carry-forward is not evidence of an unchanged market.
  const constant = admit({ivSource: "constant-entry-IV"});
  assert.equal(constant.admitted, false);
  if (!constant.admitted) assert.equal(constant.code, "iv_source_is_model");
});

test("CIRCULARITY: a reconstructed legVolatility observation is refused", () => {
  const r = admit({observation: "reconstructed"});
  assert.equal(r.admitted, false);
  if (!r.admitted) assert.equal(r.code, "observation_reconstructed");
  // and an explicitly observed one is fine
  assert.equal(admit({observation: "observed"}).admitted, true);
});

test("CIRCULARITY: IV inverted from a model-generated price is refused", () => {
  const r = admit({impliedFromModelPrice: true});
  assert.equal(r.admitted, false);
  if (!r.admitted) assert.equal(r.code, "iv_from_model_price");
});

test("CIRCULARITY: the brand cannot be forged and consumers assert on it", () => {
  const real = admitted();
  assert.equal(isMarketEvidence(real), true);
  // A structurally identical plain object is NOT evidence.
  const forged = {...JSON.parse(JSON.stringify(real))};
  assert.equal(isMarketEvidence(forged), false);
  assert.throws(() => assertMarketEvidence(forged, "test"), /never admitted as market IV evidence/);
  assert.throws(() => resolveReferenceIv([forged as unknown as AdmittedIvTrade],
    {underlyingPrice: SPOT, listedStrikes: [105_000]}), /never admitted/);
});

test("CIRCULARITY: subject legs can be excluded to keep a reference self-reference-safe", () => {
  const own = "BTC-23JUN25-105000-C";
  const r = admit({}, {excludedInstruments: [own]});
  assert.equal(r.admitted, false);
  if (!r.admitted) assert.equal(r.code, "self_leg_excluded");
  // A different strike on the same expiry is still usable.
  assert.equal(admit({instrumentName: "BTC-23JUN25-104000-C", strike: 104_000},
    {excludedInstruments: [own]}).admitted, true);
});

test("CIRCULARITY: DVOL is refused as a same-expiry substitute", () => {
  const refusal = refuseDvolSubstitution("7d");
  assert.equal(refusal.status, "unavailable");
  assert.equal(refusal.reasonCode, "dvol_cannot_substitute");
  // The two series are distinct identities, which is what makes substitution detectable.
  assert.notEqual(DVOL_SERIES_ID, REFERENCE_SERIES_ID);
  const identity = dvolSeriesIdentity(buildDvolRows([{timestampMs: T, open: 40, high: 41, low: 39, close: 40}]));
  assert.equal(identity.series_id, DVOL_SERIES_ID);
  assert.notEqual(identity.method_version, MARKET_IV_METHOD_VERSION);
});

/* ---------------- causality and staleness ---------------- */

test("STALENESS: the market-state rule is 60 minutes, not the 720-minute pricing anchor", () => {
  assert.equal(MARKET_IV_MAX_AGE_MINUTES, 60);
  assert.equal(admit({timestampMs: T - 59 * MIN}).admitted, true);
  const stale = admit({timestampMs: T - 61 * MIN});
  assert.equal(stale.admitted, false);
  if (!stale.admitted) assert.equal(stale.code, "stale_beyond_max_age");
  // The pricing model's own threshold would have accepted this comfortably.
  const atPricingAnchor = admit({timestampMs: T - 700 * MIN});
  assert.equal(atPricingAnchor.admitted, false, "720-minute pricing tolerance must not leak in");
});

test("CAUSALITY: a future observation is refused", () => {
  const r = admit({timestampMs: T + MIN});
  assert.equal(r.admitted, false);
  if (!r.admitted) assert.equal(r.code, "future_observation");
  // Exactly at the target is causal and allowed.
  assert.equal(admit({timestampMs: T}).admitted, true);
});

test("LISTING: a contract is not evidence before its creation_timestamp", () => {
  // The daily-option trap: listed only days before expiry.
  const r = admit({contractCreatedAtMs: T + 2 * 86_400_000, settlementPeriod: "day"});
  assert.equal(r.admitted, false);
  if (!r.admitted) assert.equal(r.code, "contract_not_listed_at_target");
  const ok = admitted({contractCreatedAtMs: T - 86_400_000});
  assert.equal(ok.settlementPeriod, "week");
});

test("VALUE: missing, non-positive or expired inputs are refused with specific codes", () => {
  for (const [over, code] of [
    [{ivApiPercent: null, ivDecimal: null}, "missing_iv"],
    [{ivApiPercent: 0}, "non_positive_iv"],
    [{indexPrice: null}, "missing_index_price"],
    [{expiryTimestampMs: T - 1}, "expiry_not_after_target"],
  ] as const) {
    const r = admit(over as Partial<RawIvTradeCandidate>);
    assert.equal(r.admitted, false, JSON.stringify(over));
    if (!r.admitted) assert.equal(r.code, code);
  }
});

test("NORMALIZATION: exchange percent IV becomes a decimal with log-moneyness and actual DTE", () => {
  const o = admitted({ivApiPercent: 42, strike: 105_000});
  assert.equal(o.ivApiPercent, 42);
  assert.ok(Math.abs(o.ivDecimal - 0.42) < 1e-12);
  assert.ok(Math.abs(o.logMoneyness - Math.log(105_000 / SPOT)) < 1e-12);
  assert.ok(Math.abs(o.actualDteDays - (EXPIRY - T) / 86_400_000) < 1e-12);
  assert.equal(o.ageMinutes, 10);
});

/* ---------------- reference hierarchy ---------------- */

const strikes = [100_000, 102_000, 104_000, 105_000, 106_000, 110_000];

test("HIERARCHY: exact ATM is a print on the listed strike nearest the underlying", () => {
  const r = resolveReferenceIv([admitted({strike: 105_000, instrumentName: "atm"})],
    {underlyingPrice: SPOT, listedStrikes: strikes});
  assert.equal(r.status, "available");
  assert.equal(r.observationClass, "exact_atm");
  assert.equal(r.referenceStrike, 105_000);
  assert.equal(r.methodVersion, MARKET_IV_METHOD_VERSION);
});

test("HIERARCHY: nearest-strike reference is used when the ATM strike did not trade", () => {
  const r = resolveReferenceIv([
    admitted({strike: 104_000, instrumentName: "a", ivApiPercent: 44}),
    admitted({strike: 110_000, instrumentName: "b", ivApiPercent: 55}),
  ], {underlyingPrice: SPOT, listedStrikes: strikes});
  assert.equal(r.observationClass, "nearest_strike_reference");
  assert.equal(r.referenceStrike, 104_000, "104k is inside the 5% envelope; 110k is not");
  assert.ok(Math.abs(r.ivDecimal! - 0.44) < 1e-12);
});

test("HIERARCHY: interpolation is linear in log-moneyness between two bracketing prints", () => {
  // Both sit outside the +/-5% log-moneyness envelope, so rank 2 cannot apply.
  const below = admitted({strike: 90_000, instrumentName: "lo", tradeId: "lo-1", ivApiPercent: 40});
  const above = admitted({strike: 125_000, instrumentName: "hi", tradeId: "hi-1", ivApiPercent: 50});
  const r = resolveReferenceIv([below, above], {underlyingPrice: SPOT, listedStrikes: []});
  assert.equal(r.observationClass, "local_interpolation");
  const weight = (0 - below.logMoneyness) / (above.logMoneyness - below.logMoneyness);
  assert.ok(Math.abs(r.ivDecimal! - (0.40 + weight * (0.50 - 0.40))) < 1e-12);
  assert.equal(r.interpolationInputs.length, 2, "both observed inputs travel with the result");
  assert.deepEqual([...r.sourceTradeIds].sort(), ["hi-1", "lo-1"], "provenance traces to both real trade ids");
  assert.equal(r.logMoneyness, 0);
});

test("HIERARCHY: extrapolation is refused rather than approximated", () => {
  // Both observations sit on the same side of the underlying and outside the envelope.
  const r = resolveReferenceIv([
    admitted({strike: 125_000, instrumentName: "a"}),
    admitted({strike: 135_000, instrumentName: "b"}),
  ], {underlyingPrice: SPOT, listedStrikes: []});
  assert.equal(r.status, "unavailable");
  assert.equal(r.reasonCode, "extrapolation_refused");
  assert.equal(r.ivDecimal, null, "unavailable is null, never zero");
});

test("HIERARCHY: no qualifying observation stays unavailable with a reason", () => {
  const r = resolveReferenceIv([], {underlyingPrice: SPOT, listedStrikes: strikes});
  assert.equal(r.status, "unavailable");
  assert.equal(r.reasonCode, "no_qualifying_observation");
  assert.equal(r.passesMarketStateRule, false);
});

/* ------- REGRESSION: same-expiry resolution rejects a mixed-expiry input ------- */

const LATER_EXPIRY = Date.UTC(2025, 6, 25, 8); // ~5 weeks further out

test("SAME-EXPIRY REGRESSION: a mixed-expiry input throws instead of resolving", () => {
  // A caller reading a multi-expiry cache without grouping first. Without the
  // guard this resolves happily and returns ONE expiry label for a blend.
  const observations = [
    admitted({strike: 104_000, instrumentName: "near", tradeId: "n-1", ivApiPercent: 40}),
    admitted({strike: 106_000, instrumentName: "far", tradeId: "f-1", ivApiPercent: 62,
      expiryTimestampMs: LATER_EXPIRY}),
  ];
  assert.throws(() => resolveReferenceIv(observations, {underlyingPrice: SPOT, listedStrikes: strikes}),
    /requires a single expiry, received 2/);
});

test("SAME-EXPIRY REGRESSION: interpolation cannot blend across expiries", () => {
  // The dangerous case: two bracketing strikes that WOULD interpolate cleanly,
  // but sit on different expiries. A 40-vol 7-day print and a 62-vol 5-week
  // print average to a number that no listed contract ever traded at.
  const below = admitted({strike: 90_000, instrumentName: "lo", tradeId: "lo-1", ivApiPercent: 40});
  const above = admitted({strike: 125_000, instrumentName: "hi", tradeId: "hi-1", ivApiPercent: 62,
    expiryTimestampMs: LATER_EXPIRY});
  assert.throws(() => resolveReferenceIv([below, above], {underlyingPrice: SPOT, listedStrikes: []}),
    /Group observations by expiry/);
  // Same two strikes on ONE expiry remain a legitimate interpolation.
  const sameExpiry = resolveReferenceIv(
    [below, admitted({strike: 125_000, instrumentName: "hi", tradeId: "hi-1", ivApiPercent: 62})],
    {underlyingPrice: SPOT, listedStrikes: []});
  assert.equal(sameExpiry.observationClass, "local_interpolation");
  assert.equal(sameExpiry.expiryTimestampMs, EXPIRY);
});

test("SAME-EXPIRY REGRESSION: the optional expiry pin catches a wholesale wrong-expiry group", () => {
  // Every observation agrees with itself but the whole group is the wrong
  // expiry -- undetectable from the observations alone.
  const wrongGroup = [admitted({strike: 105_000, instrumentName: "atm", expiryTimestampMs: LATER_EXPIRY})];
  assert.throws(() => resolveReferenceIv(wrongGroup,
    {underlyingPrice: SPOT, listedStrikes: strikes, expectedExpiryTimestampMs: EXPIRY}),
    /expected expiry/);
  // The pin passes when it matches, and is optional.
  const right = resolveReferenceIv([admitted({strike: 105_000, instrumentName: "atm"})],
    {underlyingPrice: SPOT, listedStrikes: strikes, expectedExpiryTimestampMs: EXPIRY});
  assert.equal(right.status, "available");
  assert.equal(right.expiryTimestampMs, EXPIRY);
});

test("SAME-EXPIRY REGRESSION: single-expiry and empty inputs are unaffected", () => {
  assert.doesNotThrow(() => assertSingleExpiry([]));
  assert.doesNotThrow(() => assertSingleExpiry([admitted(), admitted({strike: 104_000, instrumentName: "b"})]));
  // An empty group cannot contradict a pin it has no observations for.
  assert.doesNotThrow(() => assertSingleExpiry([], EXPIRY));
});

/* ---------------- tenor resolution on actual DTE ---------------- */

test("TENOR: nearest listed expiry wins and actual DTE is preserved, not the nominal label", () => {
  // Deribit's Friday cycle: from a Monday the weeklies sit at 4.3 and 11.3 days.
  const monday = Date.UTC(2025, 5, 16);
  const listed = [4.3, 11.3, 18.3, 39.3].map(d => ({expiryTimestampMs: monday + d * 86_400_000}));
  const seven = resolveTenor("7d", monday, listed);
  assert.ok(Math.abs(seven.actualDteDays! - 4.3) < 1e-9);
  assert.equal(seven.tenorTolerancePassed, true, "4.3d is inside the locked +/-3d tolerance");
  assert.notEqual(seven.actualDteDays, 7, "the nominal label is never asserted as the actual DTE");

  const thirty = resolveTenor("30d", monday, listed);
  assert.ok(Math.abs(thirty.actualDteDays! - 39.3) < 1e-9);
  assert.equal(thirty.tenorTolerancePassed, false, "39.3d is outside the locked +/-8d tolerance");
  assert.equal(thirty.reasonCode, "tenor_tolerance_failed");
});

test("TENOR: an expiry not yet listed at the target cannot serve a tenor", () => {
  const target = Date.UTC(2025, 5, 16);
  const listed = [
    {expiryTimestampMs: target + 7 * 86_400_000, createdAtMs: target + 86_400_000},
    {expiryTimestampMs: target + 12 * 86_400_000, createdAtMs: target - 30 * 86_400_000},
  ];
  const seven = resolveTenor("7d", target, listed);
  assert.ok(Math.abs(seven.actualDteDays! - 12) < 1e-9, "the unlisted 7d expiry is skipped");
});

/* ---------------- series build, identity, host routing ---------------- */

const listedExpiries = [{expiryTimestampMs: EXPIRY, createdAtMs: Date.UTC(2025, 4, 1), settlementPeriod: "week", strikes}];

test("SERIES: rows are built only from admitted evidence and count their rejections", () => {
  const result = buildReferenceSeriesRows({
    timestampMs: T, underlyingInstrument: "BTC-PERPETUAL", underlyingPrice: SPOT,
    listedExpiries,
    candidates: [
      trade({instrumentName: "good", strike: 105_000}),
      trade({instrumentName: "model", ivSource: "constant-entry-IV"}),
      trade({instrumentName: "future", timestampMs: T + MIN}),
      trade({instrumentName: "stale", timestampMs: T - 200 * MIN}),
    ],
    tenors: ["7d"],
  });
  assert.equal(result.admitted, 1);
  assert.equal(result.rejected.iv_source_is_model, 1);
  assert.equal(result.rejected.future_observation, 1);
  assert.equal(result.rejected.stale_beyond_max_age, 1);
  const row = result.rows[0]!;
  assert.equal(row.observation_class, "exact_atm");
  assert.equal(row.quality, "observed");
  assert.equal(row.iv_units, "decimal");
  assert.equal(row.series_id, REFERENCE_SERIES_ID);
});

test("SERIES: an out-of-tolerance tenor is unavailable, never relabelled", () => {
  const far = Date.UTC(2025, 6, 25, 8);
  const result = buildReferenceSeriesRows({
    timestampMs: T, underlyingInstrument: "BTC-PERPETUAL", underlyingPrice: SPOT,
    listedExpiries: [{expiryTimestampMs: far, createdAtMs: Date.UTC(2025, 4, 1), strikes}],
    candidates: [trade({expiryTimestampMs: far})],
    tenors: ["30d"],
  });
  const row = result.rows[0]!;
  assert.equal(row.observation_class, "unavailable");
  assert.equal(row.unavailable_reason_code, "tenor_tolerance_failed");
  assert.equal(row.reference_iv_decimal, null);
  assert.ok(row.actual_dte_days! > 38, "the actual DTE is still reported honestly");
});

test("IDENTITY: the content hash is deterministic and ignores generation time", () => {
  const build = () => buildReferenceSeriesRows({
    timestampMs: T, underlyingInstrument: "BTC-PERPETUAL", underlyingPrice: SPOT,
    listedExpiries, candidates: [trade()], tenors: ["7d"],
  }).rows;
  assert.equal(referenceSeriesContentHash(build()), referenceSeriesContentHash(build()));
  const a = buildReferenceSeriesManifest({rows: build(), underlyingInstrument: "BTC-PERPETUAL", generatedAtUtc: "2026-01-01T00:00:00.000Z"});
  const b = buildReferenceSeriesManifest({rows: build(), underlyingInstrument: "BTC-PERPETUAL", generatedAtUtc: "2026-09-09T09:09:09.000Z"});
  assert.equal(a.content_hash, b.content_hash, "regenerating identical evidence must hash identically");
  assert.notEqual(a.generated_at_utc, b.generated_at_utc);
  // A changed observation changes the hash.
  const changed = buildReferenceSeriesRows({
    timestampMs: T, underlyingInstrument: "BTC-PERPETUAL", underlyingPrice: SPOT,
    listedExpiries, candidates: [trade({ivApiPercent: 43})], tenors: ["7d"],
  }).rows;
  assert.notEqual(referenceSeriesContentHash(changed), a.content_hash);
});

test("IDENTITY: the manifest records methodology configuration and host provenance", () => {
  const rows = buildReferenceSeriesRows({
    timestampMs: T, underlyingInstrument: "BTC-PERPETUAL", underlyingPrice: SPOT,
    listedExpiries, candidates: [trade()], tenors: ["7d"],
  }).rows;
  const m = buildReferenceSeriesManifest({rows, underlyingInstrument: "BTC-PERPETUAL", generatedAtUtc: "2026-01-01T00:00:00.000Z"});
  assert.equal(m.series_id, REFERENCE_SERIES_ID);
  assert.equal(m.configuration.max_age_minutes, 60);
  assert.equal(m.configuration.moneyness_tolerance, 0.05);
  assert.equal(m.source_host, OPTION_HISTORY_HOST);
  assert.deepEqual([...m.shard_ids], ["2025-06"]);
  assert.equal(shardIdFor(T), "2025-06");
});

test("HOSTS: option history and DVOL are routed to the hosts that actually serve them", () => {
  // Established by live probe: www returns one expiry batch and no expired
  // trades; the history mirror answers HTTP 400 for the volatility index.
  assert.match(OPTION_HISTORY_HOST, /history\.deribit\.com/);
  assert.match(DVOL_HOST, /www\.deribit\.com/);
  assert.notEqual(OPTION_HISTORY_HOST, DVOL_HOST);
  const rows = buildDvolRows([{timestampMs: T, open: 40, high: 41, low: 39, close: 40}]);
  assert.equal(rows[0]!.source_host, DVOL_HOST);
  assert.ok(Math.abs(rows[0]!.dvol_decimal - 0.40) < 1e-12, "DVOL percent is carried alongside a decimal");
});
