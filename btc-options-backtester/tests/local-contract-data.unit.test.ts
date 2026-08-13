import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalContractService } from "../scripts/local-contract-data.ts";

test("indexes filenames once and parses only contracts required by the spread matrix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-contract-index-"));
  try {
    const entryTimestamp = Date.parse("2024-08-01T00:00:00Z");
    const rows = [
      { timestamp: entryTimestamp - 60_000, price: 0.03, iv: 70, instrument_name: "BTC-30AUG24-60000-P", index_price: 64_000, direction: "buy", amount: 1 },
      { timestamp: entryTimestamp - 30_000, price: 0.02, iv: 69, instrument_name: "BTC-30AUG24-59000-P", index_price: 64_010, direction: "sell", amount: 1 },
    ];
    await writeFile(join(directory, "BTC-30AUG24-60000-P.jsonl"), JSON.stringify(rows[0]), "utf8");
    await writeFile(join(directory, "BTC-30AUG24-59000-P.jsonl"), JSON.stringify(rows[1]), "utf8");
    await writeFile(join(directory, "unrelated.json"), "{}", "utf8");

    const cachePath = join(directory, "cache", "contracts-index.json");
    const service = new LocalContractService(directory, cachePath);
    await service.startIndex();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await service.status();
      if (status.phase === "ready") break;
      if (status.phase === "error") throw new Error(status.error);
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const result = await service.resolve(entryTimestamp, [{ targetDte: 7, soldStrike: 60_000, boughtStrike: 59_000, optionType: "P" }]);
    assert.equal(result.inventory.length, 2);
    assert.equal(result.diagnostics.filesRead, 2);
    assert.equal(result.diagnostics.validTrades, 2);
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(cache.contracts.length, 2);
    assert.equal(cache.unrecognizedFiles, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
