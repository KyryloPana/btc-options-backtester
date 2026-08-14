import assert from "node:assert/strict";
import test from "node:test";
import { runEventBacktest, validateObservationLedger, type StrategyVariantConfig } from "../app/lib/observation-ledger.ts";
import type { BacktestEvent, Candle, ContractSeries, RetrievedSpread, TradeSide } from "../app/lib/backtester.ts";

// Permanent regressions converted from the independent audit counterexamples.
const metadata = { minimumTradeAmount: 0.1, amountStep: 0.1, amountPrecision: 1, source: "deribit-instrument-metadata" as const };
const series = (name: string, strike: number, rows: Array<[number, number, TradeSide]>): ContractSeries => ({
  instrumentName: name, strike, expiryTimestamp: 10_000, expiryLabel: "fixture", optionType: "C", amountMetadata: metadata,
  trades: rows.map(([timestamp, price, direction], index) => ({ timestamp, price, direction, amount: 1, instrumentName: name, indexPrice: 50_000, markPrice: price, tradeId: String(index) })),
  firstTradeTimestamp: rows[0][0], lastTradeTimestamp: rows.at(-1)![0], sourceFiles: ["audit-fixture"],
});
const candidate: RetrievedSpread = {
  id: "audit", targetDte: 7, targetWidth: 1_000, anchorStrike: 50_000, soldStrike: 50_000, boughtStrike: 51_000,
  optionType: "C", spreadKind: "credit", structure: "fixture", buffered: false, expiryRank: 1, expiryTimestamp: 10_000, expiryLabel: "fixture",
  soldContract: series("S", 50_000, [[1020, 0.05, "sell"], [2120, 0.03, "buy"]]),
  boughtContract: series("B", 51_000, [[1025, 0.02, "buy"], [2125, 0.01, "sell"]]),
  soldExistedAtEntry: true, boughtExistedAtEntry: true, retrievalStatus: "ready", retrievalNote: "complete", dataStatus: "available", deliveryPrice: 52_000,
};
const event: BacktestEvent = { id: "audit", label: "audit", direction: "long", entryDate: "1970-01-01", entryPrice: 50_000, entryTimestamp: 500, entryTimeSource: "resolved", vpocPrice: 50_500 };
const candles: Candle[] = [
  { openTime: 0, closeTime: 1000, open: 50_000, high: 50_100, low: 49_900, close: 50_000, volume: 1 },
  { openTime: 2000, closeTime: 2100, open: 50_000, high: 50_600, low: 50_000, close: 50_500, volume: 1 },
];
const config: StrategyVariantConfig = { targetExpiryHorizonDays: 7, widthUsd: 1_000, spreadKind: "credit", expirySelectionPolicy: "liquidity-aware", candidateRankPolicy: "rank-1-only", amount: 1, primaryExecutionScenario: "taker-tape-proxy", latencyMs: 10, fillWaitMs: 500, synchronizationThresholdMs: 20, slippageBps: 0, exitPolicy: { rule: "vpoc-target", fallback: "settlement" }, requestedPackaging: "legs", executionRoute: "synchronized-leg-proxy", feeTier: "standard", marginModel: "segregated_sm" };

test("rejects altered fee inputs even when the capped total is unchanged", () => {
  const observation = structuredClone(runEventBacktest({ event, candidates: [candidate], candles, config }));
  assert.equal(validateObservationLedger([observation]).valid, true);
  observation.feeLedger!.opening.legs[0].fee.inputPriceBtc += 0.01;
  assert.notEqual(observation.feeLedger!.opening.legs[0].fee.inputPriceBtc, observation.entryExecution!.sold.fillPriceBtc);
  const validation = validateObservationLedger([observation]);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.code === "fee-input-mismatch"));
});

test("rejects a bare official-combo boolean as route evidence", () => {
  const observation = runEventBacktest({ event, candidates: [candidate], candles, config: { ...config, requestedPackaging: "combo", executionRoute: "official-combo", officialComboEvidence: true } });
  assert.equal(observation.feeLedger?.route, "official-combo");
  const validation = validateObservationLedger([observation]);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.code === "combo-evidence-required"));
});

test("rejects calculator data inserted into a primary observation", () => {
  const observation = runEventBacktest({ event, candidates: [candidate], candles, config }) as ReturnType<typeof runEventBacktest> & { calculatorScenario?: unknown };
  observation.calculatorScenario = { amount: 99, pnlUsd: 123_456 };
  const validation = validateObservationLedger([observation]);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.code === "unexpected-field" && error.path === "calculatorScenario"));
});
