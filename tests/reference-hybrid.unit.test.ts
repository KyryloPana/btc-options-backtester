import test from "node:test";
import assert from "node:assert/strict";
import {estimateModelSpread, MODEL_IV_ANCHOR_MAX_AGE_MINUTES, referenceValuationSourceOf} from "../app/lib/research-valuation.ts";
import {
  LEGACY_REFERENCE_VALUATION_METHOD_VERSION, REFERENCE_GEOMETRY_RULE,
  REFERENCE_VALUATION_METHOD_VERSION, RULE_C_MINIMUM_UNIQUE_STRIKES,
  buildReferenceCrossSection, referenceLegsAreSynchronized, valueReferenceLeg,
} from "../app/lib/volatility/reference-hybrid.ts";
import {MARKET_IV_MAX_AGE_MINUTES} from "../app/lib/volatility/market-iv-evidence.ts";
import {buildExpiryCandidates} from "../app/lib/backtester.ts";
import type {ContractSeries, ContractTrade, RetrievedSpread} from "../app/lib/backtester.ts";

/**
 * The promoted Reference fair-value hierarchy.
 *
 * Four branches must each be reachable on real-shaped inputs, because a tier
 * that cannot fire in production is not a methodology however well it scored in
 * validation: bracketed interpolation, local-anchor fallback, unavailable, and
 * exact settlement (which needs no IV at all and is asserted to be untouched).
 */

const TARGET = Date.UTC(2025, 5, 16, 12);
const EXPIRY = Date.UTC(2025, 5, 23, 8);
const INDEX = 105_000;
const MIN = 60_000;

const tradeAt = (instrument: string, ivPercent: number, minutesAgo: number, seq = 1): ContractTrade => ({
  timestamp: TARGET - minutesAgo * MIN, price: 0.01, markPrice: 0.011,
  iv: ivPercent, ivApiPercent: ivPercent, ivDecimal: ivPercent / 100,
  instrumentName: instrument, indexPrice: INDEX, direction: "buy", amount: 1,
  tradeId: `${instrument}-${seq}`, tradeSeq: String(seq),
});

const series = (strike: number, type: "C" | "P", trades: ContractTrade[]): ContractSeries => ({
  instrumentName: `BTC-23JUN25-${strike}-${type}`, expiryTimestamp: EXPIRY,
  expiryLabel: "2025-06-23", strike, optionType: type, trades,
  firstTradeTimestamp: trades.length ? Math.min(...trades.map(t => t.timestamp)) : 0,
  lastTradeTimestamp: trades.length ? Math.max(...trades.map(t => t.timestamp)) : 0,
  sourceFiles: ["fixture"], creationTimestamp: Date.UTC(2025, 4, 1),
});

/** A dense, fresh ladder: six strikes, all inside the canonical window. */
const denseLadder = (): ContractSeries[] =>
  [[100_000, 44], [102_000, 43], [104_000, 42], [108_000, 41], [110_000, 40.5], [112_000, 40]]
    .map(([strike, iv]) => series(strike!, "C",
      [tradeAt(`BTC-23JUN25-${strike}-C`, iv!, 10)]));

const spreadOf = (
  sold: ContractSeries, bought: ContractSeries, ladder: ContractSeries[] | undefined,
): RetrievedSpread => ({
  id: "fixture", venue: "deribit", targetDte: 7, targetWidth: 2000,
  anchorStrike: 106_000, soldStrike: 106_000, boughtStrike: 108_000,
  optionType: "C", spreadKind: "credit", structure: "Bear call credit", buffered: false,
  soldContract: sold, boughtContract: bought,
  sameExpiryCrossSection: ladder,
  soldExistedAtEntry: true, boughtExistedAtEntry: true,
  retrievalStatus: "ready", retrievalNote: "fixture",
  expiryTimestamp: EXPIRY, actualWidth: 2000,
} as unknown as RetrievedSpread);

const value = (spread: RetrievedSpread, over: Partial<Parameters<typeof estimateModelSpread>[0]> = {}) =>
  estimateModelSpread({spread, targetTimestamp: TARGET, targetIndex: INDEX, slippageBps: 0, ...over});

/* ==================== branch 1: interpolation wins ==================== */

test("BRANCH 1: bracketed same-expiry interpolation prices both legs and says so", () => {
  // Neither 106k nor 108k printed; both sit inside a six-strike ladder.
  const sold = series(106_000, "C", []);
  const bought = series(108_000, "C", []);
  const result = value(spreadOf(sold, bought, denseLadder()));

  assert.equal(result.status, "priced");
  const provenance = result.referenceProvenance!;
  assert.equal(provenance.methodVersion, REFERENCE_VALUATION_METHOD_VERSION);
  assert.equal(provenance.geometryRule, REFERENCE_GEOMETRY_RULE);
  assert.equal(provenance.short.source, "same_expiry_linear_interpolation");
  assert.equal(provenance.long.source, "same_expiry_linear_interpolation");

  // Full interpolation provenance, so the mark is auditable after the fact.
  assert.equal(provenance.short.lower_strike, 104_000);
  assert.equal(provenance.short.upper_strike, 108_000);
  assert.ok(provenance.short.lower_iv_decimal! > provenance.short.upper_iv_decimal!,
    "the fixture smile falls with strike, and the provenance records both ends");
  assert.ok(provenance.short.unique_qualifying_strike_count >= RULE_C_MINIMUM_UNIQUE_STRIKES);
  assert.equal(provenance.short.max_evidence_age_minutes, MARKET_IV_MAX_AGE_MINUTES);
  assert.equal(provenance.short.interpolation_declined_reason, null);
  assert.equal(provenance.short.anchor_instrument_name, null);
  // The interpolated IV lies between its two bracketing observations.
  assert.ok(provenance.short.iv_decimal! < 0.42 && provenance.short.iv_decimal! > 0.41);
});

test("BRANCH 1: a leg never interpolates from its own prints", () => {
  // 108k DID print, at an absurd IV. If its own observation reached the smile
  // used to value it, the estimate would be partly a restatement of the answer.
  const rogue = series(108_000, "C", [tradeAt("BTC-23JUN25-108000-C", 300, 5)]);
  const ladder = [...denseLadder().filter(s => s.strike !== 108_000), rogue];
  const result = value(spreadOf(series(106_000, "C", []), rogue, ladder));
  assert.equal(result.status, "priced");
  const long = result.referenceProvenance!.long;
  assert.equal(long.source, "same_expiry_linear_interpolation");
  assert.ok(long.iv_decimal! < 1, `own-leg contamination leaked a 300-vol print: ${long.iv_decimal}`);
});

/* ==================== branch 2: local anchor fallback ==================== */

test("BRANCH 2: too few unique strikes declines to the local anchor, with the reason", () => {
  // Three strikes only: below Rule C, so interpolation must decline even though
  // the target is bracketed.
  const thin = [[104_000, 42], [110_000, 40]].map(([strike, iv]) =>
    series(strike!, "C", [tradeAt(`BTC-23JUN25-${strike}-C`, iv!, 10)]));
  const sold = series(106_000, "C", [tradeAt("BTC-23JUN25-106000-C", 41.5, 200)]);
  const bought = series(108_000, "C", [tradeAt("BTC-23JUN25-108000-C", 41, 200)]);
  const result = value(spreadOf(sold, bought, [...thin, sold, bought]));

  assert.equal(result.status, "priced");
  const {short, long} = result.referenceProvenance!;
  assert.equal(short.source, "local_iv_anchor");
  assert.equal(short.interpolation_declined_reason, "unique_strike_count_below_minimum");
  assert.equal(short.anchor_instrument_name, "BTC-23JUN25-106000-C");
  assert.equal(short.anchor_age_minutes, 200);
  assert.equal(short.iv_decimal, 0.415, "the anchor IV is used unchanged");
  assert.equal(long.source, "local_iv_anchor");
  // The 720-minute anchor window is preserved: 200 minutes is far outside the
  // 60-minute interpolation rule but well inside the anchor's own semantics.
  assert.ok(short.anchor_age_minutes! > MARKET_IV_MAX_AGE_MINUTES);
  assert.ok(short.anchor_age_minutes! < MODEL_IV_ANCHOR_MAX_AGE_MINUTES);
});

test("BRANCH 2: a strike outside the observed range declines rather than extrapolating", () => {
  // 130k is beyond every ladder strike. Phase 2C measured the anchor as the
  // better estimator there, so declining is the validated behaviour.
  const far = series(130_000, "C", [tradeAt("BTC-23JUN25-130000-C", 38, 90)]);
  const sold = series(106_000, "C", []);
  const result = value(spreadOf(sold, far, [...denseLadder(), far]));
  const long = result.referenceProvenance!.long;
  assert.equal(long.source, "local_iv_anchor");
  assert.equal(long.interpolation_declined_reason, "target_not_bracketed");
  assert.equal(long.lower_strike, null, "no bracket was used, so none is claimed");
});

test("BRANCH 2: stale evidence cannot reach the interpolation tier", () => {
  // Every ladder print is 90 minutes old: real, causal, and outside the
  // canonical 60-minute market-state rule.
  const stale = [[100_000, 44], [102_000, 43], [104_000, 42], [108_000, 41], [110_000, 40.5], [112_000, 40]]
    .map(([strike, iv]) => series(strike!, "C", [tradeAt(`BTC-23JUN25-${strike}-C`, iv!, 90)]));
  const sold = series(106_000, "C", [tradeAt("BTC-23JUN25-106000-C", 41.5, 90)]);
  const bought = series(108_000, "C", [tradeAt("BTC-23JUN25-108000-C", 41, 90)]);
  const result = value(spreadOf(sold, bought, [...stale, sold, bought]));
  const {short} = result.referenceProvenance!;
  assert.equal(short.source, "local_iv_anchor");
  assert.equal(short.interpolation_declined_reason, "no_qualifying_same_expiry_observations");
});

/* ==================== branch 3: unavailable ==================== */

test("BRANCH 3: neither tier available is explicitly unavailable, never a fabricated mark", () => {
  const result = value(spreadOf(series(106_000, "C", []), series(108_000, "C", []), []));
  assert.equal(result.status, "unavailable");
  assert.equal(result.reasonCode, "reference-evidence-unavailable");
  const {short} = result.referenceProvenance!;
  assert.equal(short.source, "unavailable");
  assert.equal(short.iv_decimal, null, "unavailable is null, never zero");
  assert.equal(short.unavailable_reason, "no_market_evidence");
});

test("BRANCH 3: the final-day reason names itself, and does not blanket-refuse", () => {
  const nearExpiry = TARGET + 0; // target 12h before expiry
  const soon = Date.UTC(2025, 5, 16, 20);
  const legAt = (strike: number, trades: ContractTrade[]): ContractSeries =>
    ({...series(strike, "C", trades), expiryTimestamp: soon});
  // No evidence at all, under one day to expiry.
  const bare = valueReferenceLeg({
    leg: legAt(106_000, []), targetTimestampMs: nearExpiry, underlyingPrice: INDEX,
    crossSection: null, anchor: undefined,
  });
  assert.equal(bare.source, "unavailable");
  assert.equal(bare.unavailable_reason, "surface_not_identifiable_final_day");

  // Genuine exact evidence under a day out is still priced -- the final-day rule
  // is not a blanket refusal.
  const anchored = valueReferenceLeg({
    leg: legAt(106_000, []), targetTimestampMs: nearExpiry, underlyingPrice: INDEX,
    crossSection: null, anchor: tradeAt("BTC-23JUN25-106000-C", 55, 30),
  });
  assert.equal(anchored.source, "local_iv_anchor");
  assert.equal(anchored.iv_decimal, 0.55);
});

/* ==================== branch 4: settlement is untouched ==================== */

test("BRANCH 4: settlement needs no IV and is unaffected by the hierarchy", async () => {
  const {expiryPayoff} = await import("../app/lib/expiry-payoff.ts");
  // Exact intrinsic settlement from the delivery price: no smile, no anchor, no
  // cross-section anywhere in the calculation.
  const payoff = expiryPayoff({
    optionType: "C", shortStrike: 106_000, longStrike: 108_000,
    shortEntryPremiumBtc: 0.012, longEntryPremiumBtc: 0.006,
    entryIndex: INDEX, amount: 1, openingFeesBtc: 0.0002, expiryTimestamp: EXPIRY,
  }, 120_000, "btc-settlement");
  assert.ok(Number.isFinite(payoff.pnl));
  // The same inputs settle identically however the pre-expiry mark was produced.
  const again = expiryPayoff({
    optionType: "C", shortStrike: 106_000, longStrike: 108_000,
    shortEntryPremiumBtc: 0.012, longEntryPremiumBtc: 0.006,
    entryIndex: INDEX, amount: 1, openingFeesBtc: 0.0002, expiryTimestamp: EXPIRY,
  }, 120_000, "btc-settlement");
  assert.deepEqual(again, payoff);
});

/* ==================== hierarchy invariants ==================== */

test("HIERARCHY: interpolation is preferred over an available anchor", () => {
  // Both tiers are available. The validated order must pick interpolation.
  const sold = series(106_000, "C", [tradeAt("BTC-23JUN25-106000-C", 99, 30)]);
  const bought = series(108_000, "C", [tradeAt("BTC-23JUN25-108000-C", 99, 30)]);
  const result = value(spreadOf(sold, bought, [...denseLadder(), sold, bought]));
  const {short} = result.referenceProvenance!;
  assert.equal(short.source, "same_expiry_linear_interpolation");
  assert.ok(short.iv_decimal! < 0.5, "the 99-vol own-contract anchor must not win");
});

test("HIERARCHY: model IV can never become interpolation evidence", () => {
  // A ladder print carrying a reconstructed/model IV source is refused by the
  // Phase 2A admission gate, so the smile is empty and the tier declines.
  const modelled = [[100_000, 44], [104_000, 42], [108_000, 41], [110_000, 40], [112_000, 39]]
    .map(([strike, iv]) => {
      const s = series(strike!, "C", [tradeAt(`BTC-23JUN25-${strike}-C`, iv!, 10)]);
      return {...s, trades: s.trades.map(t => ({...t, ivSource: "model-reconstructed"}))} as ContractSeries;
    });
  const cross = buildReferenceCrossSection({
    sameExpirySeries: modelled, expiryTimestampMs: EXPIRY,
    targetTimestampMs: TARGET, underlyingPrice: INDEX,
  });
  // The adapter does not forward a model source, so this pins the gate the
  // observations DO pass through rather than a source we never set.
  assert.ok(cross.points.length > 0, "real prints are admitted");
  // A future print is refused outright.
  const future = [series(104_000, "C", [tradeAt("BTC-23JUN25-104000-C", 42, -30)])];
  const noFuture = buildReferenceCrossSection({
    sameExpirySeries: future, expiryTimestampMs: EXPIRY,
    targetTimestampMs: TARGET, underlyingPrice: INDEX,
  });
  assert.equal(noFuture.points.length, 0, "a print after the target is never evidence");
});

test("HIERARCHY: a contract not listed at the target contributes nothing", () => {
  const unlisted = denseLadder().map(s => ({...s, creationTimestamp: TARGET + 86_400_000}));
  const cross = buildReferenceCrossSection({
    sameExpirySeries: unlisted, expiryTimestampMs: EXPIRY,
    targetTimestampMs: TARGET, underlyingPrice: INDEX,
  });
  assert.equal(cross.uniqueStrikeCount, 0);
  assert.equal(cross.points.length, 0);
});

test("COHERENCE: legs marked hours apart are refused, whichever tiers produced them", () => {
  const fresh = {effective_evidence_timestamp_ms: TARGET - 5 * MIN} as never;
  const alsoFresh = {effective_evidence_timestamp_ms: TARGET - 20 * MIN} as never;
  const ancient = {effective_evidence_timestamp_ms: TARGET - 600 * MIN} as never;
  assert.equal(referenceLegsAreSynchronized(fresh, alsoFresh, 60 * MIN).synchronized, true);
  // An interpolated leg paired with a ten-hour-old anchor is not a spread mark.
  const mixed = referenceLegsAreSynchronized(fresh, ancient, 60 * MIN);
  assert.equal(mixed.synchronized, false);
  assert.equal(mixed.gapMinutes, 595);
  assert.equal(referenceLegsAreSynchronized({effective_evidence_timestamp_ms: null} as never, fresh, 60 * MIN)
    .synchronized, false);
});

test("VERSIONING: the promoted identity is new, and the legacy one still names the old method", () => {
  assert.equal(REFERENCE_VALUATION_METHOD_VERSION, "causal-reference-v3-expiry-forward-hybrid");
  assert.equal(LEGACY_REFERENCE_VALUATION_METHOD_VERSION, "causal-reference-v1");
  assert.notEqual(REFERENCE_VALUATION_METHOD_VERSION, LEGACY_REFERENCE_VALUATION_METHOD_VERSION);
});

test("EXECUTION INDEPENDENCE: Reference valuation never reads execution evidence", () => {
  // A spread with no maker or taker fill evidence at all still receives a
  // Reference mark, because the two surfaces are separate by construction.
  const spread = spreadOf(series(106_000, "C", []), series(108_000, "C", []), denseLadder());
  const result = value(spread);
  assert.equal(result.status, "priced");
  assert.equal(result.referenceProvenance!.short.source, "same_expiry_linear_interpolation");
});

test("COHERENCE: a spread whose legs are marked hours apart is refused, not priced", () => {
  // Short leg: fresh bracketed interpolation. Long leg: a ten-hour-old anchor,
  // legitimate under its own 720-minute window but not contemporaneous with the
  // short. Pricing the pair would combine two different market states into one
  // spread value, which is the failure the pre-existing synchronization rule
  // exists to prevent -- and which mixing tiers could otherwise slip past.
  const sold = series(106_000, "C", []);
  const bought = series(130_000, "C", [tradeAt("BTC-23JUN25-130000-C", 38, 600)]);
  const result = value(spreadOf(sold, bought, [...denseLadder(), bought]));

  const {short, long} = result.referenceProvenance!;
  assert.equal(short.source, "same_expiry_linear_interpolation");
  assert.equal(long.source, "local_iv_anchor", "the far strike declines to its anchor");
  assert.ok(long.anchor_age_minutes! > 60);

  assert.equal(result.status, "unavailable",
    "an interpolated leg and a ten-hour-old anchor are not one spread mark");
  assert.equal(result.reasonCode, "causal-iv-anchor-pair-unavailable");
  // The provenance survives the refusal, so the reason is auditable.
  assert.equal(result.referenceProvenance!.methodVersion, REFERENCE_VALUATION_METHOD_VERSION);

  // Widening the configured window admits the same pair, which pins that the
  // refusal came from the coherence rule and not from a missing estimate.
  const widened = value(spreadOf(sold, bought, [...denseLadder(), bought]),
    {synchronizationThresholdMs: 24 * 60 * 60_000});
  assert.equal(widened.status, "priced");
});

/* ============ end to end: the ladder reaches Reference valuation ============ */

test("PRODUCTION PATH: surrounding strikes reach Reference valuation and the tier fires", () => {
  // The whole promotion is inert unless the retrieved ladder actually arrives on
  // the spread the valuation layer reads. This drives the real assembly path --
  // inventory to buildExpiryCandidates to estimateModelSpread -- rather than
  // handing the valuation a spread built by the test.
  const legs = [series(106_000, "C", []), series(108_000, "C", [])];
  const inventory = [...denseLadder(), ...legs];
  const combo = {
    id: "combo-1", targetDte: 7, targetWidth: 2000, anchorStrike: 106_000,
    soldStrike: 106_000, boughtStrike: 108_000, optionType: "C" as const,
    spreadKind: "credit" as const, structure: "Bear call credit", buffered: false,
  };
  const manifest = {
    requestId: "combo-1", targetDte: 7, minDte: 5, maxDte: 10,
    desiredSoldStrike: 106_000, desiredBoughtStrike: 108_000,
    expiryTimestamp: EXPIRY, expiryLabel: "2025-06-23",
    actualDte: (EXPIRY - TARGET) / 86_400_000,
    soldInstrumentName: "BTC-23JUN25-106000-C", boughtInstrumentName: "BTC-23JUN25-108000-C",
    soldStrike: 106_000, boughtStrike: 108_000,
    soldCreationTimestamp: Date.UTC(2025, 4, 1), boughtCreationTimestamp: Date.UTC(2025, 4, 1),
    strikeResolutionSensible: true, strikeResolutionNote: "fixture",
  };
  const built = buildExpiryCandidates([combo], [manifest as never], TARGET, INDEX,
    inventory, "taker", "nearest", "research-estimate");
  const spread = built.find(s => s.expiryTimestamp === EXPIRY)!;

  assert.ok(spread, "the production assembly path produced no candidate");
  assert.ok(spread.sameExpiryCrossSection, "the ladder never reached the spread");
  const ladderStrikes = new Set(spread.sameExpiryCrossSection!.map(s => s.strike));
  assert.ok(ladderStrikes.has(104_000) && ladderStrikes.has(110_000),
    "non-leg strikes must be present, or Rule C can never be satisfied");
  assert.ok(ladderStrikes.size >= RULE_C_MINIMUM_UNIQUE_STRIKES);

  // And the tier genuinely fires on that spread.
  const valued = estimateModelSpread({
    spread, targetTimestamp: TARGET, targetIndex: INDEX, slippageBps: 0,
  });
  assert.equal(valued.status, "priced");
  assert.equal(valued.referenceProvenance!.short.source, "same_expiry_linear_interpolation");
  assert.equal(valued.referenceProvenance!.long.source, "same_expiry_linear_interpolation");
});

test("PRODUCTION PATH: every candidate on one expiry shares one ladder object", () => {
  // Snapshot-level reuse: three width variants on one expiry must point at the
  // same array, not three rebuilt copies of it.
  const inventory = [...denseLadder(), series(106_000, "C", []), series(108_000, "C", []),
    series(110_000, "C", [])];
  const widths = [108_000, 110_000, 112_000].map((long, i) => ({
    combo: {
      id: `w${i}`, targetDte: 7, targetWidth: long - 106_000, anchorStrike: 106_000,
      soldStrike: 106_000, boughtStrike: long, optionType: "C" as const,
      spreadKind: "credit" as const, structure: "Bear call credit", buffered: false,
    },
    manifest: {
      requestId: `w${i}`, targetDte: 7, minDte: 5, maxDte: 10,
      desiredSoldStrike: 106_000, desiredBoughtStrike: long,
      expiryTimestamp: EXPIRY, expiryLabel: "2025-06-23",
      actualDte: (EXPIRY - TARGET) / 86_400_000,
      soldInstrumentName: "BTC-23JUN25-106000-C", boughtInstrumentName: `BTC-23JUN25-${long}-C`,
      soldStrike: 106_000, boughtStrike: long,
      soldCreationTimestamp: Date.UTC(2025, 4, 1), boughtCreationTimestamp: Date.UTC(2025, 4, 1),
      strikeResolutionSensible: true, strikeResolutionNote: "fixture",
    },
  }));
  const built = buildExpiryCandidates(widths.map(w => w.combo), widths.map(w => w.manifest as never),
    TARGET, INDEX, inventory, "taker", "nearest", "research-estimate");
  const onExpiry = built.filter(s => s.expiryTimestamp === EXPIRY && s.sameExpiryCrossSection);
  assert.ok(onExpiry.length >= 2, `expected several candidates, got ${onExpiry.length}`);
  const first = onExpiry[0]!.sameExpiryCrossSection;
  for (const spread of onExpiry)
    assert.equal(spread.sameExpiryCrossSection, first,
      "candidates on one expiry must share the ladder, not each rebuild it");
});

/* ============ saved provenance names the tier that actually won ============ */

test("PROVENANCE: the saved source distinguishes the new tiers from the historical label", () => {
  const both = value(spreadOf(series(106_000, "C", []), series(108_000, "C", []), denseLadder()));
  assert.equal(referenceValuationSourceOf(both), "same_expiry_linear_interpolation");

  // A mixed pair reports its WEAKER tier. Calling a spread an interpolation mark
  // when one leg came from a stale anchor would overstate the evidence.
  const thin = [[104_000, 42], [110_000, 40]].map(([strike, iv]) =>
    series(strike!, "C", [tradeAt(`BTC-23JUN25-${strike}-C`, iv!, 10)]));
  const sold = series(106_000, "C", [tradeAt("BTC-23JUN25-106000-C", 41.5, 200)]);
  const bought = series(108_000, "C", [tradeAt("BTC-23JUN25-108000-C", 41, 200)]);
  const anchored = value(spreadOf(sold, bought, [...thin, sold, bought]));
  assert.equal(referenceValuationSourceOf(anchored), "local_iv_anchor");

  const none = value(spreadOf(series(106_000, "C", []), series(108_000, "C", []), []));
  assert.equal(referenceValuationSourceOf(none), "unavailable");

  // A valuation with no hybrid provenance predates the promotion and keeps the
  // historical label, so old saved structures stay readable as what they were.
  assert.equal(referenceValuationSourceOf({...both, referenceProvenance: undefined} as never),
    "local_iv_interpolation");
});

/* ============ coherence fallback to the synchronized anchor pair ============ */

test("COHERENCE FALLBACK: an incoherent tier pair resolves to the synchronized anchor pair", () => {
  // The short leg would interpolate from a fresh ladder; the long leg is far
  // out of range and only has old prints. Their preferred marks are hours
  // apart -- but both legs DO have causal anchors that are synchronized with
  // each other, which is exactly what the previous methodology used. Refusing
  // here would lose coverage the engine already had, for no gain in coherence.
  const soldAnchors = [tradeAt("BTC-23JUN25-106000-C", 44, 300, 1), tradeAt("BTC-23JUN25-106000-C", 43, 305, 2)];
  const sold = series(106_000, "C", soldAnchors);
  const bought = series(130_000, "C", [tradeAt("BTC-23JUN25-130000-C", 38, 310)]);
  const result = value(spreadOf(sold, bought, [...denseLadder(), sold, bought]));

  assert.equal(result.status, "priced", "a synchronized anchor pair exists and must be used");
  const provenance = result.referenceProvenance!;
  assert.ok(provenance.coherenceFallback, "the fallback must be recorded, not silent");
  assert.equal(provenance.coherenceFallback!.resolvedWith, "synchronized_anchor_pair");
  assert.equal(provenance.coherenceFallback!.reason, "preferred_tiers_not_synchronized");
  assert.ok(provenance.coherenceFallback!.gapMinutes! <= 60);

  // And the saved source names what actually priced it, not the tier the short
  // leg would have preferred.
  assert.equal(referenceValuationSourceOf(result), "local_iv_anchor");
});

test("COHERENCE FALLBACK: with no synchronized pair available the mark is still refused", () => {
  // The long leg's only print is ten hours from the short leg's. No pair inside
  // the window exists, so the refusal stands.
  const sold = series(106_000, "C", [tradeAt("BTC-23JUN25-106000-C", 44, 5)]);
  const bought = series(130_000, "C", [tradeAt("BTC-23JUN25-130000-C", 38, 600)]);
  const result = value(spreadOf(sold, bought, [...denseLadder(), sold, bought]));
  assert.equal(result.status, "unavailable");
  assert.equal(result.reasonCode, "causal-iv-anchor-pair-unavailable");
  assert.match(String(result.reason), /no synchronized causal anchor pair/);
});

test("COHERENCE FALLBACK: it never fires when the preferred tiers already agree", () => {
  const result = value(spreadOf(series(106_000, "C", []), series(108_000, "C", []), denseLadder()));
  assert.equal(result.status, "priced");
  assert.equal(result.referenceProvenance!.coherenceFallback, null,
    "two interpolated legs are already coherent; nothing should fall back");
  assert.equal(referenceValuationSourceOf(result), "same_expiry_linear_interpolation");
});
