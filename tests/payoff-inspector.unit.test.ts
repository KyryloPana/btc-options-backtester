import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {payoffInspectorSummary, netCreditUsdAtEntry} from "../app/lib/payoff-inspector.ts";
import {expiryPayoff, payoffExtrema, type ExpiryPayoffInput} from "../app/lib/expiry-payoff.ts";
import {canonicalStructuralLoss} from "../app/lib/maximum-economic-loss.ts";

/**
 * The Backtester expiration-payoff inspector used to render
 * `payoffExtrema(input, currency).maximumLoss` as a finite "Maximum profit /
 * loss". That number is a sample of the fee-inclusive payoff at an extreme
 * settlement index and is a maximum in neither currency mode:
 *
 *   bear call 100k/101k, usd-cash-flow  ->  -$2,702,159,776,982.30
 *   bull put   95k/94k,  btc-settlement ->  -10,638,297.87 BTC
 *
 * The first is the fixed BTC delivery fee converted at a huge index; the second
 * is the inverse intrinsic (K-S)/S diverging as the index approaches zero.
 */

const IDX = 100_000, EXPIRY = Date.UTC(2026, 0, 9);

const BEAR: ExpiryPayoffInput = {optionType: "C", shortStrike: 100_000, longStrike: 101_000,
  shortEntryPremiumBtc: .0180, longEntryPremiumBtc: .0130,
  entryIndex: IDX, amount: 1, openingFeesBtc: .0006, expiryTimestamp: EXPIRY};
const BULL: ExpiryPayoffInput = {optionType: "P", shortStrike: 95_000, longStrike: 94_000,
  shortEntryPremiumBtc: .0180, longEntryPremiumBtc: .0130,
  entryIndex: IDX, amount: 1, openingFeesBtc: .0006, expiryTimestamp: EXPIRY};

const width = (i: ExpiryPayoffInput) => Math.abs(i.shortStrike - i.longStrike);

/* ---------------- bear call: the trillion-dollar artifact ---------------- */

test("BEAR CALL: the displayed structural loss is finite and plausible", () => {
  const s = payoffInspectorSummary(BEAR);
  assert.equal(s.structuralLoss.status, "available");
  const usd = s.structuralLoss.usd!;
  assert.ok(Number.isFinite(usd) && usd > 0);
  // Bounded by the strike width this spread purchased.
  assert.ok(usd <= width(BEAR) * BEAR.amount * 1.0001, `structural loss ${usd} exceeds the $1,000 width`);
  assert.ok(usd < 1e4, `an ordinary $1,000-wide bear call cannot risk ${usd}`);
});

test("BEAR CALL: the ~2.7e12 fee artifact is gone and is not merely rescaled", () => {
  const artifact = payoffExtrema(BEAR, "usd-cash-flow").maximumLoss;
  // The old figure is still what the raw payoff utility reports; the inspector
  // simply must not present it as a maximum.
  assert.ok(Math.abs(artifact) > 1e12, "the underlying artifact still exists in the raw extremum");
  const usd = payoffInspectorSummary(BEAR).structuralLoss.usd!;
  assert.ok(Math.abs(usd) < 1e4);
  assert.notEqual(usd, Math.abs(artifact));
  assert.ok(Math.abs(usd) / Math.abs(artifact) < 1e-6, "not a rescaled version of the same tail");
});

test("BEAR CALL: an artificial extreme terminal index cannot alter the structural loss", () => {
  const base = payoffInspectorSummary(BEAR).structuralLoss.usd;
  // Sampling the curve anywhere, however absurd, is a scenario evaluation and
  // must not feed back into the structural figure.
  for (const index of [1, 1e6, 1e12, Number.MAX_SAFE_INTEGER]) {
    expiryPayoff(BEAR, index, "usd-cash-flow");
    assert.equal(payoffInspectorSummary(BEAR).structuralLoss.usd, base,
      `evaluating the payoff at ${index} changed the structural loss`);
  }
});

test("BEAR CALL: the fee-inclusive USD maximum is disclosed as Unbounded", () => {
  const fees = payoffInspectorSummary(BEAR).settlementFees;
  assert.equal(fees.globalFeeInclusiveMaximum, "unbounded");
  assert.equal(fees.includedInStructuralLoss, false);
  assert.match(fees.globalFeeInclusiveMaximumReason!, /without bound|unbounded/i);
  // The scenario fee itself is still reported, at a NAMED settlement scenario.
  assert.ok(fees.scenarioFeesBtc! >= 0);
  assert.ok(fees.scenarioLabel, "the delivery fee names the scenario it belongs to");
  assert.notEqual(fees.scenarioIndex, null);
});

/* ---------------- bull put: finite, and the BTC-mode artifact ---------------- */

test("BULL PUT: finite structural loss with a bounded settlement-fee treatment", () => {
  const s = payoffInspectorSummary(BULL);
  const usd = s.structuralLoss.usd!;
  assert.ok(Number.isFinite(usd) && usd > 0);
  assert.ok(usd <= width(BULL) * BULL.amount * 1.0001);
  // Both legs are out of the money above the short strike, so the fee-inclusive
  // USD maximum genuinely is bounded here.
  assert.equal(s.settlementFees.globalFeeInclusiveMaximum, "bounded");
  assert.equal(s.settlementFees.includedInStructuralLoss, false);
});

test("BULL PUT: the BTC-mode inverse-intrinsic divergence never reaches the display", () => {
  // (K-S)/S diverges as S -> 0, so the raw BTC extremum is ~10.6 million BTC.
  const artifact = payoffExtrema(BULL, "btc-settlement").maximumLoss;
  assert.ok(Math.abs(artifact) > 1e6, "the raw BTC extremum is the divergent tail");
  const btc = payoffInspectorSummary(BULL).structuralLoss.btcAtReferenceIndex!;
  assert.ok(Math.abs(btc) < 1, `displayed BTC structural loss ${btc} is implausible`);
  assert.notEqual(btc, artifact);
});

/* ---------------- BTC representation carries its basis ---------------- */

test("BTC mode: structural loss is the USD loss at an explicit reference index", () => {
  for (const input of [BEAR, BULL]) {
    const s = payoffInspectorSummary(input).structuralLoss;
    assert.equal(s.referenceIndex, input.entryIndex, "the conversion basis is the entry/reference index");
    // The BTC number is a representation at that index, not a separate maximum.
    assert.ok(Math.abs(s.btcAtReferenceIndex! - s.usd! / s.referenceIndex!) < 1e-12);
  }
});

/* ---------------- quantity scaling ---------------- */

test("SCALING: structural loss scales linearly with the contract amount", () => {
  const one = payoffInspectorSummary(BEAR).structuralLoss.usd!;
  for (const amount of [2, 5, 10]) {
    const scaled = payoffInspectorSummary({...BEAR, amount,
      openingFeesBtc: BEAR.openingFeesBtc * amount}).structuralLoss.usd!;
    assert.ok(Math.abs(scaled - one * amount) < 1e-6 * amount,
      `amount ${amount}: expected ~${one * amount}, got ${scaled}`);
  }
});

/* ---------------- fee separation ---------------- */

test("FEES: changing the delivery-fee assumption does not redefine structural loss", () => {
  // A daily option carries a different delivery-fee treatment. The scenario fee
  // disclosure and finite payoff points may move; the structural loss may not.
  const standard = payoffInspectorSummary(BEAR);
  const daily = payoffInspectorSummary({...BEAR, dailyOption: true} as ExpiryPayoffInput);
  assert.equal(daily.structuralLoss.usd, standard.structuralLoss.usd,
    "delivery fees are reported beside the structural loss, never inside it");
  assert.equal(daily.structuralLoss.btcAtReferenceIndex, standard.structuralLoss.btcAtReferenceIndex);
  // The scenario payoff at a finite index legitimately still includes fees.
  const point = expiryPayoff(BEAR, 120_000, "usd-cash-flow");
  assert.ok(point.settlementFeesBtc > 0, "the plotted curve keeps its delivery fees");
});

/* ---------------- maximum profit ---------------- */

test("PROFIT: the maximum is the bounded net opening credit at the entry index", () => {
  for (const input of [BEAR, BULL]) {
    const s = payoffInspectorSummary(input).maximumProfit;
    assert.ok(Number.isFinite(s.usd!) && s.usd! > 0);
    assert.equal(s.equalsNetCreditAtEntry, true,
      "the profitable extremum leaves both legs out of the money, so it carries no delivery fee");
    assert.ok(Math.abs(s.usd! - netCreditUsdAtEntry(input)!) < 1e-6);
    assert.ok(Math.abs(s.btcAtReferenceIndex! - s.usd! / input.entryIndex) < 1e-12);
  }
});

/* ---------------- exporter reconciliation ---------------- */

test("RECONCILIATION: the inspector uses the same canonical helper as the exporter", () => {
  for (const input of [BEAR, BULL]) {
    // The exporter fills structure_economics.maximum_structural_loss_usd from
    // exactly this call, so the two cannot disagree for one structure. The
    // canonical value is not restated here as a literal.
    const canonical = canonicalStructuralLoss(input);
    const shown = payoffInspectorSummary(input).structuralLoss;
    assert.equal(shown.usd, canonical.usd);
    assert.equal(shown.btcAtReferenceIndex, canonical.btcAtReferenceIndex);
    assert.equal(shown.referenceIndex, canonical.referenceIndex);
    assert.equal(shown.settlementIndex, canonical.worstStructuralIndex);
    assert.equal(shown.methodVersion, canonical.methodVersion);
  }
});

test("UNAVAILABLE: a structure that is not a credit vertical reports a reason, not a number", () => {
  // A bear call requires the short strike BELOW the long strike; inverted
  // strikes are not a credit vertical at all.
  const inverted = {...BEAR, shortStrike: 101_000, longStrike: 100_000};
  const s = payoffInspectorSummary(inverted);
  assert.equal(s.structuralLoss.status, "unavailable");
  assert.equal(s.structuralLoss.usd, null);
  assert.equal(s.structuralLoss.btcAtReferenceIndex, null);
  assert.ok(s.structuralLoss.reason, "an explicit reason replaces the figure");
  assert.equal(s.settlementFees.scenarioFeesBtc, null);
  assert.match(s.settlementFees.globalFeeInclusiveMaximumReason!, /not evaluated/i);
});

/* ---------------- rendered wording ---------------- */

test("DISPLAY: the inspector states structural risk and keeps the scenario point separate", () => {
  const source = readFileSync(new URL("../app/options-backtester.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Maximum profit \/ loss/, "the conflated label is gone");
  assert.doesNotMatch(source, /Maximum economic loss/i);
  assert.doesNotMatch(source, /payoffExtrema/, "the page no longer reads a fee-inclusive extremum");
  assert.match(source, /Maximum structural loss/);
  assert.match(source, /Maximum structural profit/);
  assert.match(source, /Fee-inclusive USD maximum/);
  assert.match(source, /Settlement fees/);
  // The scenario payoff stays explicitly a scenario payoff.
  assert.match(source, /Payoff at selected terminal index/);
  assert.doesNotMatch(source, /<small>Selected point<\/small>/);
  // The plotted curve is untouched: still expiryPayoff at each sampled index.
  assert.match(source, /expiryPayoff\(input,expirationIndex,currency\)/);
  assert.match(source, /const selected=selectedIndex===undefined\?undefined:expiryPayoff\(input,selectedIndex,currency\)/);
});
