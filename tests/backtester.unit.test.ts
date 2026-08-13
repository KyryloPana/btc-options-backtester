import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExpiryCandidates,
  buildInventory,
  generateDesiredSpreads,
  intrinsicPriceBtc,
  parseContractText,
} from "../app/lib/backtester.ts";

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
    { requestId: desired.id, targetDte: 14, minDte: 11, maxDte: 18, desiredSoldStrike: 56000, desiredBoughtStrike: 55000, expiryTimestamp: closerExpiry, expiryLabel: "23APR24", actualDte: (closerExpiry - entry) / 86_400_000, soldInstrumentName: "BTC-23APR24-56000-P", boughtInstrumentName: "BTC-23APR24-55000-P", soldStrike: 56000, boughtStrike: 55000, strikeResolutionSensible: true, strikeResolutionNote: "Resolved." },
    { requestId: desired.id, targetDte: 14, minDte: 11, maxDte: 18, desiredSoldStrike: 56000, desiredBoughtStrike: 55000, expiryTimestamp: liquidExpiry, expiryLabel: "25APR24", actualDte: (liquidExpiry - entry) / 86_400_000, soldInstrumentName: "BTC-25APR24-56000-P", boughtInstrumentName: "BTC-25APR24-55000-P", soldStrike: 56000, boughtStrike: 55000, strikeResolutionSensible: true, strikeResolutionNote: "Resolved." },
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
