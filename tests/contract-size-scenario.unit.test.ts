import assert from "node:assert/strict";
import test from "node:test";
import { aggregateObservations, buildObservationExport, runEventBacktest, type StrategyVariantConfig } from "../app/lib/observation-ledger.ts";
import { calculateContractSizeScenario, openingCapitalRequirement, scenarioPathMetrics, validateScenarioAmount } from "../app/lib/contract-size-scenario.ts";
import type { BacktestEvent, Candle, ContractSeries, RetrievedSpread, TradeSide } from "../app/lib/backtester.ts";

const metadata = { minimumTradeAmount: .1, amountStep: .1, amountPrecision: 1, source: "deribit-instrument-metadata" as const };
const series = (name: string, strike: number, rows: Array<[number, number, TradeSide, number]>): ContractSeries => ({ instrumentName: name, strike, expiryTimestamp: 10_000, expiryLabel: "fixture", optionType: "C", amountMetadata: metadata, trades: rows.map(([timestamp, price, direction, amount], i) => ({ timestamp, price, direction, amount, instrumentName: name, indexPrice: 50_000, markPrice: price, tradeId: String(i) })), firstTradeTimestamp: rows[0][0], lastTradeTimestamp: rows.at(-1)![0], sourceFiles: ["cached"] });
const spread = (): RetrievedSpread => ({ id: "size", targetDte: 7, targetWidth: 1_000, anchorStrike: 50_000, soldStrike: 50_000, boughtStrike: 51_000, optionType: "C", spreadKind: "credit", structure: "fixture", buffered: false, expiryRank: 1, expiryTimestamp: 10_000, expiryLabel: "fixture", soldContract: series("S", 50_000, [[1020,.05,"sell",1],[1200,.15,"sell",1],[2120,.03,"buy",1],[2300,.05,"buy",1]]), boughtContract: series("B", 51_000, [[1025,.02,"buy",1],[1205,.06,"buy",1],[2125,.01,"sell",1],[2305,.02,"sell",1]]), soldExistedAtEntry: true, boughtExistedAtEntry: true, retrievalStatus: "ready", retrievalNote: "complete", dataStatus: "available", deliveryPrice: 52_000 });
const event: BacktestEvent = { id: "E", label: "E", direction: "long", entryDate: "1970-01-01", entryPrice: 50_000, entryTimestamp: 500, entryTimeSource: "resolved", vpocPrice: 50_500 };
const candles: Candle[] = [{ openTime: 0, closeTime: 1000, open: 50_000, high: 50_100, low: 49_900, close: 50_000, volume: 1 }, { openTime: 2000, closeTime: 2100, open: 50_000, high: 50_600, low: 50_000, close: 50_500, volume: 1 }];
const config: StrategyVariantConfig = { targetExpiryHorizonDays: 7, widthUsd: 1_000, spreadKind: "credit", expirySelectionPolicy: "liquidity-aware", candidateRankPolicy: "rank-1-only", amount: 1, primaryExecutionScenario: "taker-tape-proxy", latencyMs: 10, fillWaitMs: 500, synchronizationThresholdMs: 20, slippageBps: 0, exitPolicy: { rule: "vpoc-target", fallback: "settlement" }, requestedPackaging: "legs", executionRoute: "synchronized-leg-proxy", feeTier: "standard", marginModel: "segregated_sm" };

test("default scenario reproduces the canonical observation without changing primary results", () => {
  const candidate = spread(); const base = runEventBacktest({ event, candidates: [candidate], candles, config });
  const aggregates = structuredClone(aggregateObservations([base])); const exported = structuredClone(buildObservationExport([base], config, [event], "fixed"));
  const scenario = calculateContractSizeScenario({ event, candidates: [candidate], candles, baseConfig: config, amount: 1 });
  assert.deepEqual(scenario.observation, base); assert.deepEqual(aggregateObservations([base]), aggregates); assert.deepEqual(buildObservationExport([base], config, [event], "fixed"), exported);
});

test("larger size accumulates cached tape, changing VWAP and fill timestamp rather than multiplying PnL", () => {
  const candidate = spread(); const one = calculateContractSizeScenario({ event, candidates: [candidate], candles, baseConfig: config, amount: 1 }); const two = calculateContractSizeScenario({ event, candidates: [candidate], candles, baseConfig: config, amount: 2 });
  assert.equal(one.observation.entryExecution?.sold.fillPriceBtc, .05); assert.equal(two.observation.entryExecution?.sold.fillPriceBtc, .1); assert.equal(two.observation.entryExecution?.sold.fillTimestamp, 1200); assert.notEqual(two.observation.netPnl?.btc, (one.observation.netPnl?.btc ?? 0) * 2);
  assert.ok(two.observation.feeLedger!.opening.finalFee > one.observation.feeLedger!.opening.finalFee);
});

test("unsupported printed amount is explicitly not executable", () => {
  const result = calculateContractSizeScenario({ event, candidates: [spread()], candles, baseConfig: config, amount: 3 });
  assert.equal(result.executable, false); assert.equal(result.observation.entryExecution?.sold.status, "insufficient-amount"); assert.equal(result.pathMetrics.bestUnrealized, undefined);
});

test("metadata validation permits decimals but rejects invalid increments and precision", () => {
  assert.equal(validateScenarioAmount(.2, metadata, metadata), undefined); assert.match(validateScenarioAmount(.25, metadata, metadata)!, /increment|decimal/); assert.match(validateScenarioAmount(0, metadata, metadata)!, /positive/); assert.match(validateScenarioAmount(1, undefined, metadata)!, /metadata/);
});

test("path metrics preserve missing values and grid count is independent of amount", () => {
  const path = [{ timestamp: 1, ivPnlUsd: 4 }, { timestamp: 2 }, { timestamp: 3, ivPnlUsd: -2 }] as never;
  assert.deepEqual(scenarioPathMetrics(path, 20), { bestUnrealized: 4, maxAdverse: -2, gridPoints: 3, series: "ivPnlUsd", amount: 20 }); assert.equal(scenarioPathMetrics([{ timestamp: 1 }] as never, 1).bestUnrealized, undefined);
});

test("independent filled PnL uses recalculated entry, closing fees, and selected amount", () => {
  const result = calculateContractSizeScenario({ event, candidates: [spread()], candles, baseConfig: config, amount: 2 }); const outcome = result.outcomes.find(x => x.rule === "VPOC target");
  assert.equal(outcome?.status, "filled"); assert.equal(outcome?.pnlUsd, result.observation.netPnl?.usd); assert.match(result.observation.netPnl!.identity, /opening fees.*closing fees/);
});

test("triggered but unfilled outcome never exposes hypothetical profit and settlement includes delivery fees", () => {
  const candidate = spread(); candidate.soldContract!.trades = candidate.soldContract!.trades.filter(x => x.direction === "sell"); candidate.boughtContract!.trades = candidate.boughtContract!.trades.filter(x => x.direction === "buy");
  const result = calculateContractSizeScenario({ event, candidates: [candidate], candles, baseConfig: config, amount: 1 });
  assert.deepEqual(result.outcomes.find(x => x.rule === "VPOC target"), { rule: "VPOC target", status: "triggered-unfilled" }); assert.ok(result.observation.settlementLedger!.deliveryFeesBtc > 0); assert.equal(result.outcomes.find(x => x.rule === "Expiry settlement")?.pnlUsd, result.observation.netPnl?.usd);
});

test("opening balance subtracts received cash once, keeps maximum loss separate, and rejects PM without simulation", () => {
  const observation = calculateContractSizeScenario({ event, candidates: [spread()], candles, baseConfig: config, amount: 1 }).observation; const capital = openingCapitalRequirement(observation);
  assert.equal(capital.minimumStartingBalance, Math.max(observation.entryExecution!.bought.fillPriceBtc! + observation.feeLedger!.opening.buyAggregate, observation.marginResult!.initialMarginBtc! - observation.entryCashFlow!.netBtc)); assert.notEqual(capital.minimumStartingBalance, observation.marginResult!.initialMarginBtc! + observation.marginResult!.theoreticalMaximumSpreadLossBtc);
  const pm = openingCapitalRequirement({ ...observation, marginResult: { ...observation.marginResult!, deployment: { ...observation.marginResult!.deployment, model: "segregated_pm" } } }); assert.equal(pm.calculationSource, "unavailable");
});
