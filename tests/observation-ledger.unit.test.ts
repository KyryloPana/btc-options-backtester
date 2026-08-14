import assert from "node:assert/strict";
import test from "node:test";
import { aggregateObservations, buildObservationExport, runEventBacktest, type StrategyVariantConfig } from "../app/lib/observation-ledger.ts";
import { splitSeriesAtMissing } from "../app/lib/valuation-chart.ts";
import type { BacktestEvent, Candle, ContractSeries, RetrievedSpread, TradeSide } from "../app/lib/backtester.ts";

const candle = (openTime: number, closeTime: number, low = 49_000, high = 51_000): Candle => ({ openTime, closeTime, open: 50_000, high, low, close: 50_000, volume: 1 });
const series = (name: string, strike: number, expiryTimestamp: number, rows: Array<[number, number, TradeSide, number]>): ContractSeries => ({ instrumentName: name, strike, expiryTimestamp, expiryLabel: "fixture", optionType: "C", trades: rows.map(([timestamp, price, direction, amount], index) => ({ timestamp, price, direction, amount, instrumentName: name, indexPrice: 50_000, markPrice: price, tradeId: String(index) })), firstTradeTimestamp: rows[0]?.[0] ?? 0, lastTradeTimestamp: rows.at(-1)?.[0] ?? 0, sourceFiles: ["deterministic-fixture"] });
const event = (id: string): BacktestEvent => ({ id, label: id, direction: "long", entryDate: "1970-01-01", entryPrice: 50_000, entryTimestamp: 500, entryTimeSource: "resolved", extremePrice: 50_000, vpocPrice: 50_500 });
const config: StrategyVariantConfig = { targetExpiryHorizonDays: 7, widthUsd: 1_000, spreadKind: "credit", expirySelectionPolicy: "liquidity-aware", candidateRankPolicy: "rank-1-only", amount: 1, primaryExecutionScenario: "taker-tape-proxy", latencyMs: 10, fillWaitMs: 500, synchronizationThresholdMs: 20, slippageBps: 0, exitPolicy: { rule: "vpoc-target", fallback: "settlement" }, requestedPackaging: "legs", executionRoute: "synchronized-leg-proxy", feeTier: "standard", marginModel: "segregated_sm" };
function spread(id: string, rows = true, retrievalStatus: RetrievedSpread["retrievalStatus"] = "ready", expiryTimestamp = 10_000): RetrievedSpread { return { id, targetDte: 7, targetWidth: 1_000, anchorStrike: 50_000, soldStrike: 50_000, boughtStrike: 51_000, optionType: "C", spreadKind: "credit", structure: "fixture", buffered: false, expiryRank: 1, expiryTimestamp, expiryLabel: "fixture", actualDte: 7, soldContract: rows ? series(`${id}-S`, 50_000, expiryTimestamp, [[900,.2,"sell",1], [1020,.05,"sell",1], [1900,.01,"buy",1], [2120,.01,"buy",1]]) : series(`${id}-S`, 50_000, expiryTimestamp, [[900,.2,"sell",1]]), boughtContract: rows ? series(`${id}-B`, 51_000, expiryTimestamp, [[900,.1,"buy",1], [1025,.02,"buy",1], [1900,.005,"sell",1], [2125,.005,"sell",1]]) : series(`${id}-B`, 51_000, expiryTimestamp, [[900,.1,"buy",1]]), soldExistedAtEntry: true, boughtExistedAtEntry: true, retrievalStatus, retrievalNote: retrievalStatus === "ready" ? "complete" : "partial retrieval", dataStatus: retrievalStatus === "partial" ? "data-unavailable" : "available", deliveryPrice: 50_000, selectedForTest: true } }
const candles = [candle(0, 1000), candle(2000, 2100, 50_400, 50_600)];

test("UI orchestration boundary produces executed Event A solely from post-order fills", () => {
  const observation = runEventBacktest({ event: event("A"), candidates: [spread("primary"), { ...spread("alternative"), expiryRank: 2 }], candles, config });
  assert.equal(observation.signalClock.decisionAvailableTimestamp, 1000, "hourly touch is actionable at candle close, not open");
  assert.equal(observation.signalClock.orderSubmittedAt, 1010);
  assert.equal(observation.entryExecution?.sold.fillTimestamp, 1020, "pre-order print was ignored");
  assert.equal(observation.selectedExitLifecycle?.orderTimestamp, 2110);
  assert.equal(observation.selectedExitLifecycle?.fillTimestamp, 2125, "pre-trigger close print was ignored");
  assert.equal(observation.eventOutcome, "executed");
  assert.ok(Math.abs(observation.entryCashFlow!.grossBtc - .03) < 1e-12);
  assert.ok(Math.abs(observation.netPnl!.btc - .0238) < 1e-12, observation.netPnl?.identity);
  assert.equal(observation.marginResult?.state, "ok");
  assert.equal(observation.candidateAttempts.length, 2);
  assert.equal(observation.candidateAttempts.filter(a => a.executable).length, 1);
});

test("Events B and C retain denominator semantics and complete export", () => {
  const a = runEventBacktest({ event: event("A"), candidates: [spread("a")], candles, config });
  const b = runEventBacktest({ event: event("B"), candidates: [spread("b", false)], candles, config });
  const c = runEventBacktest({ event: event("C"), candidates: [spread("c", true, "partial")], candles, config });
  assert.equal(b.eventOutcome, "no-trade:no-entry-fill"); assert.equal(b.netPnl?.btc, 0);
  assert.equal(c.eventOutcome, "data-unavailable"); assert.equal(c.netPnl, undefined);
  const aggregate = aggregateObservations([a,b,c])[0];
  assert.deepEqual([aggregate.totalOriginalSignals, aggregate.completeEvents, aggregate.executedTrades, aggregate.noTrades, aggregate.unavailableEvents], [3,2,1,1,1]);
  const exported = buildObservationExport([a,b,c], config, [event("A"),event("B"),event("C")], "2026-08-14T00:00:00Z");
  assert.equal(exported.valid, true); assert.deepEqual(exported.observations.map(o => o.eventOutcome), ["executed","no-trade:no-entry-fill","data-unavailable"]);
  assert.equal(exported.observations[0].marginResult?.deployment.model, "segregated_sm");
});

test("combo request cannot waive fees absent official evidence", () => {
  const requested = runEventBacktest({ event: event("request"), candidates: [spread("request")], candles, config: { ...config, requestedPackaging: "combo", executionRoute: "official-combo", officialComboEvidence: false } });
  const proven = runEventBacktest({ event: event("proven"), candidates: [spread("proven")], candles, config: { ...config, requestedPackaging: "combo", executionRoute: "official-combo", officialComboEvidence: true } });
  assert.equal(requested.feeLedger?.route, "synchronized-leg-proxy"); assert.equal(requested.feeLedger?.opening.finalFee, .0006);
  assert.equal(proven.feeLedger?.route, "official-combo"); assert.equal(proven.feeLedger?.opening.finalFee, .0003);
});

test("triggered-unfilled positions fall back to versioned settlement with delivery fees", () => {
  const noClose = spread("settle"); noClose.soldContract!.trades = noClose.soldContract!.trades.filter(t => t.direction === "sell"); noClose.boughtContract!.trades = noClose.boughtContract!.trades.filter(t => t.direction === "buy"); noClose.deliveryPrice = 52_000;
  const legacy = runEventBacktest({ event: event("legacy"), candidates: [noClose], candles, config });
  assert.equal(legacy.eventOutcome, "settled"); assert.equal(legacy.selectedExitLifecycle?.reasonCode, "triggered-unfilled-carried-to-settlement"); assert.equal(legacy.settlementLedger?.legs[0].version, "legacy-direct-cash"); assert.ok(legacy.settlementLedger!.deliveryFeesBtc > 0); assert.match(legacy.netPnl!.identity, /delivery fees/);
  const modernSpread = spread("modern", true, "ready", Date.parse("2026-08-02T08:00:00Z")); modernSpread.deliveryPrice = 52_000; modernSpread.soldContract!.trades = noClose.soldContract!.trades; modernSpread.boughtContract!.trades = noClose.boughtContract!.trades;
  const modern = runEventBacktest({ event: event("modern"), candidates: [modernSpread], candles, config });
  assert.equal(modern.settlementLedger?.legs[0].version, "option-to-future");
});

test("chart series split at missing observations", () => {
  const path = [{ timestamp: 1, rawPnlUsd: 1 }, { timestamp: 2 }, { timestamp: 3, rawPnlUsd: 3 }] as never;
  assert.deepEqual(splitSeriesAtMissing(path, "rawPnlUsd").map(segment => segment.map(p => p.timestamp)), [[1],[3]]);
});
