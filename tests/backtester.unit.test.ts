import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExpiryCandidates,
  buildInventory,
  buildValuation,
  generateDesiredSpreads,
  intrinsicPriceBtc,
  parseContractText,
} from "../app/lib/backtester.ts";

function close(actual: number | undefined, expected: number) {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-10, `${actual} should be close to ${expected}`);
}

function valuationFixture(kind: "credit" | "debit", comboExecution = false) {
  const entry = Date.parse("2024-04-10T03:00:00Z");
  const expiry = Date.parse("2024-04-17T08:00:00Z");
  const soldName = "BTC-17APR24-60000-P";
  const boughtName = "BTC-17APR24-59000-P";
  const soldPrice = kind === "credit" ? 0.03 : 0.01;
  const boughtPrice = kind === "credit" ? 0.01 : 0.03;
  const rows = [
    { timestamp: entry, price: soldPrice, iv: 70, instrument_name: soldName, index_price: 60000, direction: "buy", amount: 2 },
    { timestamp: entry, price: boughtPrice, iv: 65, instrument_name: boughtName, index_price: 60000, direction: "sell", amount: 2 },
  ];
  const inventory = buildInventory(rows.map((row, index) => ({ name: `fixture-${index}`, trades: parseContractText(JSON.stringify(row)) })));
  const spread = {
    id: `fixture-${kind}`, targetDte: 7, targetWidth: 1000, anchorStrike: 60000, soldStrike: 60000, boughtStrike: 59000,
    optionType: "P" as const, spreadKind: kind, structure: `${kind} put spread`, buffered: false,
    expiryTimestamp: expiry, expiryLabel: "17APR24", actualDte: 7, actualWidth: 1000,
    soldContract: inventory.find(item => item.instrumentName === soldName), boughtContract: inventory.find(item => item.instrumentName === boughtName),
    soldExistedAtEntry: true, boughtExistedAtEntry: true, retrievalStatus: "ready" as const, retrievalNote: "fixture",
  };
  const event = { id: "event", label: "fixture", direction: "long" as const, entryDate: "2024-04-10", entryTimestamp: entry, entryPrice: 60000 };
  const candles = [
    { openTime: entry, closeTime: entry + 3_599_999, open: 60000, high: 60000, low: 60000, close: 60000, volume: 1 },
    { openTime: expiry, closeTime: expiry + 3_599_999, open: 50000, high: 50000, low: 50000, close: 50000, volume: 1 },
  ];
  return buildValuation(spread, event, candles, "maker", 2, comboExecution);
}

test("adds an independent $1k buffer branch inside the $100 boundary", () => {
  const spreads = generateDesiredSpreads({
    id: "event", label: "MR", direction: "long", entryDate: "2024-01-01", entryPrice: 60_000, extremePrice: 57_050,
  }, [7, 14, 30], [1000, 2000, 3000], "credit");
  assert.equal(spreads.length, 18);
  assert.deepEqual([...new Set(spreads.map(spread => spread.anchorStrike))], [57_000, 56_000]);
});

test("liquidity-aware ranking prefers Green evidence and retains one viable alternative", () => {
  const entry = Date.parse("2024-04-10T03:12:00Z");
  const closerExpiry = Date.parse("2024-04-23T08:00:00Z");
  const liquidExpiry = Date.parse("2024-04-25T08:00:00Z");
  const rows = [
    { timestamp: entry - 60 * 60_000, price: 0.03, iv: 70, instrument_name: "BTC-23APR24-56000-P", index_price: 63700, direction: "buy", amount: 1 },
    { timestamp: entry - 50 * 60_000, price: 0.025, iv: 69, instrument_name: "BTC-23APR24-55000-P", index_price: 63710, direction: "sell", amount: 1 },
    { timestamp: entry - 10 * 60_000, price: 0.032, iv: 71, instrument_name: "BTC-25APR24-56000-P", index_price: 63700, direction: "buy", amount: 4 },
    { timestamp: entry - 5 * 60_000, price: 0.026, iv: 69, instrument_name: "BTC-25APR24-55000-P", index_price: 63705, direction: "sell", amount: 3 },
  ];
  const inventory = buildInventory(rows.map((row, index) => ({ name: `leg-${index}.jsonl`, trades: parseContractText(JSON.stringify(row)) })));
  const desired = generateDesiredSpreads({ id: "event", label: "MR", direction: "long", entryDate: "2024-04-10", entryPrice: 63700, extremePrice: 56540 }, [14], [1000], "credit")[0];
  const manifests = [
    { requestId: desired.id, targetDte: 14, minDte: 11, maxDte: 18, desiredSoldStrike: 56000, desiredBoughtStrike: 55000, expiryTimestamp: closerExpiry, expiryLabel: "23APR24", actualDte: (closerExpiry - entry) / 86_400_000, soldInstrumentName: "BTC-23APR24-56000-P", boughtInstrumentName: "BTC-23APR24-55000-P", soldStrike: 56000, boughtStrike: 55000, soldCreationTimestamp: entry - 1, boughtCreationTimestamp: entry - 1, strikeResolutionSensible: true, strikeResolutionNote: "Resolved." },
    { requestId: desired.id, targetDte: 14, minDte: 11, maxDte: 18, desiredSoldStrike: 56000, desiredBoughtStrike: 55000, expiryTimestamp: liquidExpiry, expiryLabel: "25APR24", actualDte: (liquidExpiry - entry) / 86_400_000, soldInstrumentName: "BTC-25APR24-56000-P", boughtInstrumentName: "BTC-25APR24-55000-P", soldStrike: 56000, boughtStrike: 55000, soldCreationTimestamp: entry - 1, boughtCreationTimestamp: entry - 1, strikeResolutionSensible: true, strikeResolutionNote: "Resolved." },
  ];
  const liquidityAware = buildExpiryCandidates([desired], manifests, entry, 63700, inventory, "maker", "liquidity-aware");
  assert.equal(liquidityAware[0].expiryTimestamp, liquidExpiry);
  assert.equal(liquidityAware[0].entryLiquidityQuality, "green");
  assert.equal(liquidityAware[0].candidateStatus, "recommended");
  assert.equal(liquidityAware[1].candidateStatus, "alternative");
  assert.ok(liquidityAware.every(candidate => candidate.selectedForTest));
  const closest = buildExpiryCandidates([desired], manifests, entry, 63700, inventory, "maker", "closest-dte");
  assert.equal(closest[0].expiryTimestamp, closerExpiry);
  assert.equal(closest[0].entryLiquidityQuality, "yellow");
  assert.equal(closest.filter(candidate => candidate.selectedForTest).length, 1);
});

test("uses inverse BTC intrinsic settlement", () => {
  assert.equal(intrinsicPriceBtc("C", 60_000, 55_000), 5_000 / 60_000);
  assert.equal(intrinsicPriceBtc("P", 50_000, 55_000), 5_000 / 50_000);
});

test("builds a complete credit opening ledger and uses it for immediate-close PnL", () => {
  const run = valuationFixture("credit");
  const ledger = run.entryLedgers!.raw;
  assert.equal(ledger.soldInstrumentName, "BTC-17APR24-60000-P");
  assert.equal(ledger.boughtInstrumentName, "BTC-17APR24-59000-P");
  assert.equal(ledger.contractAmount, 2);
  assert.equal(ledger.soldPriceBtcPerContract, 0.03);
  assert.equal(ledger.soldProceedsBtc, 0.06);
  assert.equal(ledger.boughtPriceBtcPerContract, 0.01);
  assert.equal(ledger.boughtCostBtc, 0.02);
  close(ledger.grossEntryBtcPerContract, 0.02);
  close(ledger.grossEntryTotalBtc, 0.04);
  assert.equal(ledger.soldLegFeeBtc, 0.0006);
  assert.equal(ledger.boughtLegFeeBtc, 0.0006);
  assert.equal(ledger.totalOpeningFeesBtc, 0.0012);
  close(ledger.netOpeningCashFlowBtc, 0.0388);
  close(ledger.netOpeningCashFlowUsd, 2328);
  close(run.path[0].rawPnlBtc, -0.0024); // immediate close pays opening and closing fees
  close(run.path[0].rawPnlUsd, -144);
  assert.equal(ledger.qualityFlag, "green");
  assert.match(ledger.qualityReason, /Both legs/);
});

test("mirrors debit cash-flow signs and identifies a combo fee", () => {
  const run = valuationFixture("debit", true);
  const ledger = run.entryLedgers!.raw;
  close(ledger.grossEntryBtcPerContract, 0.02);
  close(ledger.grossEntryTotalBtc, 0.04);
  assert.equal(ledger.boughtLegFeeBtc, undefined);
  assert.equal(ledger.comboFeeBtc, 0.0006);
  assert.equal(ledger.totalOpeningFeesBtc, 0.0006);
  close(ledger.netOpeningCashFlowBtc, -0.0406);
  close(run.path[0].rawPnlBtc, -0.0012);
});

test("entry ledgers survive exported JSON without recomputation or unit loss", () => {
  const run = valuationFixture("credit");
  const exported = JSON.parse(JSON.stringify({ results: [{ entryLedgers: run.entryLedgers, path: run.path }] }));
  assert.equal(exported.results[0].entryLedgers.raw.soldInstrumentName, run.entryLedgers!.raw.soldInstrumentName);
  assert.equal(exported.results[0].entryLedgers.raw.netOpeningCashFlowBtc, run.entryLedgers!.raw.netOpeningCashFlowBtc);
  assert.equal(exported.results[0].entryLedgers.iv.qualityReason, run.entryLedgers!.iv.qualityReason);
  assert.equal(exported.results[0].path[0].rawPnlUsd, run.path[0].rawPnlUsd);
});

test("expiry USD PnL converts opening and closing cash flows at their own indexes", () => {
  const run = valuationFixture("credit");
  const expiry = run.path.at(-1)!;
  close(expiry.rawPnlBtc, -0.0012);
  // $2,400 opening gross - $72 opening fees - $2,000 intrinsic close at the $50k expiry index.
  close(expiry.rawPnlUsd, 328);
  assert.notEqual(expiry.rawPnlUsd, expiry.rawPnlBtc! * expiry.btcIndex);
});
