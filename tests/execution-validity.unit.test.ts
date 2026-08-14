import test from "node:test";
import assert from "node:assert/strict";
import { assessMakerOpportunity, buildExpiryCandidates, buildInventory, executionClock, generateDesiredSpreads, parseContractText, simulateTakerExit, simulateTakerSpread, summarizeEventExecutions, type ContractSeries } from "../app/lib/backtester.ts";

const instrument = (strike: number, direction: "buy" | "sell", trades: Array<[number, number]>) => buildInventory(trades.map(([timestamp, amount], index) => ({ name: String(index), trades: parseContractText(JSON.stringify({ timestamp, price: strike / 1_000_000, instrument_name: `BTC-30AUG26-${strike}-C`, index_price: 60000, direction, amount })) })))[0];
const clock = executionClock({ signalTimestamp: 1000, signalSourceTimestamp: 1000, signalTimePrecision: "trade", configuredLatencyMs: 100, maxFillWaitMs: 500 });

test("entry accepts only chronological post-order compatible prints and accumulates amount", () => {
  const sold = instrument(60000, "sell", [[900, 9], [1100, 9], [1101, .4], [1200, .6]]);
  const bought = instrument(61000, "buy", [[1099, 9], [1150, .5], [1250, .5]]);
  const result = simulateTakerSpread({ soldContract: sold, boughtContract: bought }, clock, 1, 10, 200);
  assert.equal(result.status, "filled");
  assert.deepEqual(result.sold.supportingTradeTimestamps, [1101, 1200]);
  assert.deepEqual(result.bought.supportingTradeTimestamps, [1150, 1250]);
  assert.ok(result.sold.supportingTradeTimestamps.every(timestamp => timestamp > clock.orderSubmittedAt));
  assert.equal(result.scenario, "taker-tape-proxy");
});

test("pre-signal and centered-window trades cannot fill entry", () => {
  const result = simulateTakerSpread({ soldContract: instrument(60000, "sell", [[900, 1]]), boughtContract: instrument(61000, "buy", [[1000, 1]]) }, clock, 1);
  assert.equal(result.status, "no-trade");
  assert.equal(result.sold.status, "no-fill");
  assert.equal(result.bought.status, "no-fill");
});

test("candle-only decisions wait for close and latency", () => {
  const resolved = executionClock({ signalTimestamp: 1000, signalSourceCandle: { openTime: 900, closeTime: 2000, open: 1, high: 2, low: 0, close: 1, volume: 1 }, signalTimePrecision: "candle", configuredLatencyMs: 50, maxFillWaitMs: 100 });
  assert.equal(resolved.decisionAvailableTimestamp, 2000);
  assert.equal(resolved.orderSubmittedAt, 2050);
  assert.deepEqual([resolved.fillSearchStart, resolved.fillSearchEnd], [2050, 2150]);
});

test("pre-trigger prints cannot close; post-trigger prints can", () => {
  const sold = instrument(60000, "buy", [[1090, 1], [1200, 1]]);
  const bought = instrument(61000, "sell", [[1090, 1], [1201, 1]]);
  const exit = simulateTakerExit({ soldContract: sold, boughtContract: bought }, clock, 1000, 1, 0, 10);
  assert.equal(exit.exitStatus, "filled");
  assert.deepEqual(exit.sold.supportingTradeTimestamps, [1200]);
  assert.ok(exit.triggerEvidenceTimestamp <= exit.exitOrderTimestamp && exit.exitOrderTimestamp < exit.exitFillTimestamp!);
});

test("trigger without closing evidence is triggered-unfilled with no PnL", () => {
  const exit = simulateTakerExit({}, clock, 1000, 1);
  assert.equal(exit.exitStatus, "triggered-unfilled");
  assert.equal(exit.exitFillTimestamp, undefined);
  assert.equal("pnl" in exit, false);
});

test("maker-compatible prints remain an optimistic opportunity", () => {
  const maker = assessMakerOpportunity(instrument(60000, "sell", [[1200, 5]]), "buy", clock, 1, .07, 2);
  assert.equal(maker.status, "opportunity-only");
  assert.match(maker.reason, /Assumed queue ahead.*assumption/i);
});

test("insufficient and absent liquidity remain explicit rather than filled", () => {
  const insufficient = simulateTakerSpread({ soldContract: instrument(60000, "sell", [[1200, .5]]), boughtContract: instrument(61000, "buy", [[1200, 1]]) }, clock, 1);
  assert.equal(insufficient.sold.status, "insufficient-amount");
  const absent = simulateTakerSpread({ soldContract: instrument(60000, "sell", []), boughtContract: instrument(61000, "buy", []) }, clock, 1);
  assert.equal(absent.status, "no-trade");
});

test("event denominator retains no-trades while unavailable PnL stays missing", () => {
  const summary = summarizeEventExecutions([
    { eventId: "1", outcome: "executed", pnl: 10, dataComplete: true, reason: "filled" },
    { eventId: "2", outcome: "no-trade:no-entry-fill", dataComplete: true, reason: "zero liquidity" },
    { eventId: "3", outcome: "data-unavailable", dataComplete: false, reason: "API failed" },
  ]);
  assert.deepEqual({ total: summary.totalSignals, complete: summary.completeEvents, executed: summary.executedTrades, noTrades: summary.noTrades, unavailable: summary.unavailableEvents }, { total: 3, complete: 2, executed: 1, noTrades: 1, unavailable: 1 });
  assert.equal(summary.averagePnlPerCompleteSignal, 5);
  assert.equal(summary.averagePnlPerExecutedTrade, 10);
  assert.equal(summary.coverageRate, 2 / 3);
});

test("missing values are not forward-filled", () => {
  const empty = undefined as ContractSeries | undefined;
  const result = simulateTakerSpread({ soldContract: empty, boughtContract: empty }, clock, 1);
  assert.equal(result.sold.fillPriceBtc, undefined);
  assert.equal(result.bought.fillPriceBtc, undefined);
});

test("candidate ranking cannot use prints arriving after selection", () => {
  const entry = Date.parse("2026-08-14T00:00:00Z");
  const expiry = Date.parse("2026-08-30T08:00:00Z");
  const desired = generateDesiredSpreads({ id: "signal", label: "signal", direction: "short", entryDate: "2026-08-14", entryPrice: 60_000, extremePrice: 60_000 }, [14], [1000], "credit")[0];
  const inventory = buildInventory([
    { name: "future-sold", trades: parseContractText(JSON.stringify({ timestamp: entry + 1, price: .02, instrument_name: "BTC-30AUG26-60000-C", index_price: 60000, direction: "buy", amount: 10 })) },
    { name: "future-bought", trades: parseContractText(JSON.stringify({ timestamp: entry + 1, price: .01, instrument_name: "BTC-30AUG26-61000-C", index_price: 60000, direction: "sell", amount: 10 })) },
  ]);
  const [candidate] = buildExpiryCandidates([desired], [{ requestId: desired.id, targetDte: 14, minDte: 11, maxDte: 18, desiredSoldStrike: 60000, desiredBoughtStrike: 61000, expiryTimestamp: expiry, expiryLabel: "30AUG26", actualDte: (expiry-entry)/86_400_000, soldInstrumentName: "BTC-30AUG26-60000-C", boughtInstrumentName: "BTC-30AUG26-61000-C", soldStrike: 60000, boughtStrike: 61000, soldCreationTimestamp: entry - 1, boughtCreationTimestamp: entry - 1, strikeResolutionSensible: true, strikeResolutionNote: "resolved" }], entry, 60000, inventory, "maker", "liquidity-aware");
  assert.equal(candidate.selectedForTest, false);
  assert.equal(candidate.entryLiquidity?.viable, false);
});
