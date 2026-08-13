import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInventory,
  generateDesiredSpreads,
  intrinsicPriceBtc,
  normalizeSpread,
  parseContractText,
  retrieveSpread,
} from "../app/lib/backtester.ts";

test("adds an independent $1k buffer branch inside the $100 boundary", () => {
  const spreads = generateDesiredSpreads({
    id: "event", label: "MR", direction: "long", entryDate: "2024-01-01", entryPrice: 60_000, extremePrice: 57_050,
  }, [7, 14, 30], [1000, 2000, 3000], "credit");
  assert.equal(spreads.length, 18);
  assert.deepEqual([...new Set(spreads.map(spread => spread.anchorStrike))], [57_000, 56_000]);
});

test("parses JSONL, selects the nearest expiry at or beyond target DTE, and respects maker-side prints", () => {
  const entry = Date.parse("2024-05-04T00:00:00Z");
  const expiry = Date.parse("2024-05-17T08:00:00Z");
  const rows = [
    { timestamp: entry - 60_000, price: 0.03, iv: 70, instrument_name: "BTC-17MAY24-56000-P", index_price: 63700, direction: "buy", amount: 1 },
    { timestamp: entry - 30_000, price: 0.025, iv: 69, instrument_name: "BTC-17MAY24-55000-P", index_price: 63710, direction: "sell", amount: 1 },
  ];
  const inventory = buildInventory(rows.map((row, index) => ({ name: `leg-${index}.jsonl`, trades: parseContractText(JSON.stringify(row)) })));
  const desired = generateDesiredSpreads({ id: "event", label: "MR", direction: "long", entryDate: "2024-05-04", entryPrice: 63700, extremePrice: 56540 }, [7], [1000], "credit")[0];
  const retrieved = retrieveSpread(desired, entry, inventory);
  assert.equal(retrieved.expiryTimestamp, expiry);
  assert.equal(retrieved.retrievalStatus, "ready");
  const normalized = normalizeSpread(retrieved, entry, 63700, "maker", 30);
  assert.ok(normalized);
  assert.equal(normalized.sold.schemaDirection, "buy");
  assert.equal(normalized.bought.schemaDirection, "sell");
  assert.equal(normalized.qualityFlag, "green");
});

test("uses inverse BTC intrinsic settlement", () => {
  assert.equal(intrinsicPriceBtc("C", 60_000, 55_000), 5_000 / 60_000);
  assert.equal(intrinsicPriceBtc("P", 50_000, 55_000), 5_000 / 50_000);
});
