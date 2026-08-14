import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRoutedFees, buildOptionSettlementLedger, calculateDeliveryFee, calculateOptionFee, STANDARD_INVERSE_BTC_OPTION_FEE } from "../app/lib/accounting.ts";
import { DEFAULT_DEPLOYMENT, estimateStandardOptionMargin, portfolioMarginResult } from "../app/lib/margin.ts";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("Standard inverse option fees are versioned, capped, and maker/taker equal", () => {
  const maker = calculateOptionFee(0.001, 2, "maker", STANDARD_INVERSE_BTC_OPTION_FEE);
  const taker = calculateOptionFee(0.001, 2, "taker", STANDARD_INVERSE_BTC_OPTION_FEE);
  close(maker.finalFee, 0.00025);
  assert.equal(maker.finalFee, taker.finalFee);
  assert.equal(maker.tier, "standard");
  assert.equal(maker.discount, 0);
  assert.equal(maker.scheduleEffectiveDate, STANDARD_INVERSE_BTC_OPTION_FEE.effectiveDate);
  close(calculateOptionFee(0.1, 2, "taker", STANDARD_INVERSE_BTC_OPTION_FEE).finalFee, 0.0006);
});

test("only official combos waive the smaller directional fee group", () => {
  const legs = [
    { side: "buy" as const, fee: calculateOptionFee(0.001, 1, "taker", STANDARD_INVERSE_BTC_OPTION_FEE) },
    { side: "sell" as const, fee: calculateOptionFee(0.1, 1, "taker", STANDARD_INVERSE_BTC_OPTION_FEE) },
  ];
  close(aggregateRoutedFees(legs, "separate-legs").finalFee, 0.000425);
  close(aggregateRoutedFees(legs, "synchronized-leg-proxy").finalFee, 0.000425);
  const combo = aggregateRoutedFees(legs, "official-combo");
  close(combo.finalFee, 0.0003);
  assert.equal(combo.waivedDirectionalGroup, "buy");
});

test("delivery fees implement daily exemption, ordinary rate, and value cap", () => {
  assert.equal(calculateDeliveryFee(0.1, 2, true).finalFeeBtc, 0);
  close(calculateDeliveryFee(0.1, 2, false).finalFeeBtc, 0.0003);
  close(calculateDeliveryFee(0.0001, 1, false).finalFeeBtc, 0.0000125);
});

test("settlement boundary preserves legacy and creates post-boundary futures", () => {
  const base = { optionType: "C" as const, side: "long" as const, amount: 2, strike: 50_000, deliveryPrice: 60_000, dailyOption: false };
  const old = buildOptionSettlementLedger({ ...base, expiryTimestamp: Date.parse("2026-07-31T08:00:00Z") });
  assert.equal(old.version, "legacy-direct-cash");
  assert.equal(old.entries[0].type, "direct-cash-settlement");
  const current = buildOptionSettlementLedger({ ...base, expiryTimestamp: Date.parse("2026-08-01T00:00:00Z") });
  assert.equal(current.version, "option-to-future");
  assert.equal(current.generatedFutureUsd, 100_000);
  assert.equal(current.entries[1].deliveryFeeBtc, 0, "generated future must not pay a second delivery fee");
  close(current.futureEconomicPnlBtc, current.intrinsicValueBtc);
});

test("call/put and long/short future directions preserve economic PnL", () => {
  for (const [optionType, deliveryPrice] of [["C", 60_000], ["P", 40_000]] as const) {
    for (const side of ["long", "short"] as const) {
      const ledger = buildOptionSettlementLedger({ expiryTimestamp: Date.parse("2026-08-02T08:00:00Z"), optionType, side, amount: 1.5, strike: 50_000, deliveryPrice, dailyOption: false });
      close(ledger.futureEconomicPnlBtc, ledger.intrinsicValueBtc);
      assert.equal(Math.sign(ledger.generatedFutureUsd), (side === "long" ? 1 : -1) * (optionType === "C" ? 1 : -1));
    }
  }
});

test("OTM expiry emits only expiry and explicit existing-future netting defaults to zero", () => {
  const otm = buildOptionSettlementLedger({ expiryTimestamp: Date.parse("2026-08-02T08:00:00Z"), optionType: "C", side: "long", amount: 1, strike: 70_000, deliveryPrice: 60_000, dailyOption: false });
  assert.deepEqual(otm.entries.map(entry => entry.type), ["expiry"]);
  assert.equal(otm.existingFutureUsd, 0);
  const netted = buildOptionSettlementLedger({ expiryTimestamp: Date.parse("2026-08-02T08:00:00Z"), optionType: "C", side: "long", amount: 1, strike: 50_000, deliveryPrice: 60_000, dailyOption: false, existingFutureUsd: -50_000 });
  assert.equal(netted.netFutureUsd, 0);
});

test("maximum loss remains separate from versioned SM outputs and missing causal inputs stay unavailable", () => {
  const missing = estimateStandardOptionMargin({ side: "short", optionType: "C", amount: 1, strike: 60_000, observationTimestamp: 1, theoreticalMaximumSpreadLossBtc: 0.02 });
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.initialMarginBtc, undefined);
  const result = estimateStandardOptionMargin({ side: "short", optionType: "C", amount: 1, strike: 60_000, indexPrice: 50_000, markPriceBtc: 0.01, observationTimestamp: 2, theoreticalMaximumSpreadLossBtc: 0.02 });
  assert.equal(result.deployment.model, "segregated_sm");
  assert.equal(result.deployment.collateralCurrency, "BTC");
  assert.equal(result.deployment.marginSource, "formula-estimate");
  assert.notEqual(result.theoreticalMaximumSpreadLossBtc, result.initialMarginBtc);
});

test("PM simulation exports active model, account state, timestamp, and deployment result set", () => {
  const deployment = { ...DEFAULT_DEPLOYMENT, model: "cross_pm" as const, marginSource: "portfolio-simulation" as const };
  const result = portfolioMarginResult({ deployment, theoreticalMaximumSpreadLossBtc: 0.1, response: { margin_model: "deribit_pm_v3", initial_margin: 0.2, maintenance_margin: 0.1, margin_balance: 1, available_funds: 0.8 }, accountState: { positions: [] }, simulationTimestamp: 123 });
  assert.equal(result.activeMarginModel, "deribit_pm_v3");
  assert.equal(result.simulationTimestamp, 123);
  assert.equal(result.deployment.model, "cross_pm");
  assert.deepEqual(result.accountState, { positions: [] });
});
