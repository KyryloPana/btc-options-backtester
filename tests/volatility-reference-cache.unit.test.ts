import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  VolatilityReferenceRetrieval, hourlyClosesFromPerpetualSeries,
  listCachedShards, readReferenceManifest, readReferenceShard,
  writeDvolShards, writeReferenceShards,
} from "../scripts/volatility-reference-cache.ts";
import {
  DVOL_HOST, DVOL_SERIES_ID, OPTION_HISTORY_HOST, REFERENCE_SERIES_ID,
  buildReferenceSeriesRows, type ReferenceSeriesRow,
} from "../app/lib/volatility/reference-series.ts";
import type {RawIvTradeCandidate} from "../app/lib/volatility/market-iv-evidence.ts";

/**
 * Retrieval routing and the monthly shard cache. A stub fetcher records every
 * URL, so the audited host asymmetry is asserted rather than assumed, and no
 * test touches the network.
 */

const T = Date.UTC(2025, 5, 16, 12);
const EXPIRY = Date.UTC(2025, 5, 23, 8);
const SPOT = 105_000;

interface Call {url: string; method: string}
function stub(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    const method = new URL(url).pathname.split("/").pop() ?? "";
    calls.push({url, method});
    return new Response(JSON.stringify({result: responses[method] ?? null}),
      {status: 200, headers: {"content-type": "application/json"}});
  };
  return {calls, fetcher: fetcher as unknown as ConstructorParameters<typeof VolatilityReferenceRetrieval>[0]["fetcher"]};
}

/* ---------------- host routing ---------------- */

test("ROUTING: option instruments and trades go to the history mirror", async () => {
  const {calls, fetcher} = stub({
    get_instruments: [{instrument_name: "BTC-23JUN25-105000-C", strike: 105000, option_type: "call",
      expiration_timestamp: EXPIRY, creation_timestamp: Date.UTC(2025, 4, 1), settlement_period: "week"}],
    get_last_trades_by_instrument_and_time: {trades: [{timestamp: T - 600_000, iv: 42, price: 0.01,
      mark_price: 0.011, index_price: SPOT, trade_id: "t1", trade_seq: 5, direction: "buy", amount: 1}]},
  });
  const service = new VolatilityReferenceRetrieval({fetcher});
  const manifest = await service.instrumentManifest();
  const trades = await service.ivTrades("BTC-23JUN25-105000-C", T - 3_600_000, T);
  // www serves only the latest expiry batch and no expired trades, so every one
  // of these calls must reach the history mirror.
  for (const call of calls) assert.ok(call.url.startsWith(OPTION_HISTORY_HOST), `${call.method} -> ${call.url}`);
  assert.equal(manifest.length, 2, "expired and active manifests are both requested");
  assert.equal(manifest[0]!.optionType, "C");
  assert.equal(manifest[0]!.settlementPeriod, "week");
  assert.equal(manifest[0]!.createdAtMs, Date.UTC(2025, 4, 1));
  assert.equal(trades[0]!.ivApiPercent, 42);
  assert.equal(trades[0]!.markPrice, 0.011, "the mark price riding on the trade is preserved");
});

test("ROUTING: DVOL goes to the main host, which is the only one that serves it", async () => {
  const {calls, fetcher} = stub({get_volatility_index_data: {data: [[T, 40, 41, 39, 40.5]]}});
  const service = new VolatilityReferenceRetrieval({fetcher});
  const points = await service.dvolRange(T - 3_600_000, T);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.startsWith(DVOL_HOST), "the history mirror answers HTTP 400 for this method");
  assert.ok(!calls[0]!.url.startsWith(OPTION_HISTORY_HOST));
  assert.equal(points.length, 1);
  assert.equal(points[0]!.close, 40.5);
});

test("ROUTING: repeated trade windows are served from the in-memory cache", async () => {
  const {calls, fetcher} = stub({get_last_trades_by_instrument_and_time: {trades: []}});
  const service = new VolatilityReferenceRetrieval({fetcher});
  await service.ivTrades("BTC-23JUN25-105000-C", T - 3_600_000, T);
  await service.ivTrades("BTC-23JUN25-105000-C", T - 3_600_000, T);
  assert.equal(calls.length, 1, "the same window must not be refetched");
  await service.ivTrades("BTC-23JUN25-105000-C", T - 7_200_000, T);
  assert.equal(calls.length, 2, "a different window is a genuine new request");
});

/* ---------------- realized-volatility underlying ---------------- */

test("UNDERLYING: hourly closes come from the existing perpetual series shape", () => {
  const closes = hourlyClosesFromPerpetualSeries([
    {timestamp: T - 7_200_000, close: 100},
    {timestamp: T - 3_600_000, close: 101},
    {timestamp: T - 1_800_000, price: 102},
    {timestamp: T, close: null},
  ]);
  assert.deepEqual(closes.map(c => c.close), [100, 101, 102]);
  assert.ok(closes[0]!.timestampMs < closes[1]!.timestampMs, "sorted ascending");
});

/* ---------------- shard cache ---------------- */

const candidate = (over: Partial<RawIvTradeCandidate> = {}): RawIvTradeCandidate => ({
  instrumentName: "BTC-23JUN25-105000-C", tradeId: "t1", tradeSeq: 1,
  strike: 105_000, optionType: "C", expiryTimestampMs: EXPIRY,
  settlementPeriod: "week", contractCreatedAtMs: Date.UTC(2025, 4, 1),
  timestampMs: T - 600_000, ivApiPercent: 42, indexPrice: SPOT, ...over,
});

const rowsAt = (timestampMs: number, ivApiPercent = 42): readonly ReferenceSeriesRow[] =>
  buildReferenceSeriesRows({
    timestampMs, underlyingInstrument: "BTC-PERPETUAL", underlyingPrice: SPOT,
    listedExpiries: [{expiryTimestampMs: EXPIRY, createdAtMs: Date.UTC(2025, 4, 1),
      settlementPeriod: "week", strikes: [104_000, 105_000, 106_000]}],
    candidates: [candidate({timestampMs: timestampMs - 600_000, ivApiPercent})],
    tenors: ["7d"],
  }).rows;

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "vol-cache-"));
  try { return await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}

test("CACHE: rows land in monthly shards with a manifest carrying series identity", async () => {
  await withTempRoot(async root => {
    const result = await writeReferenceShards({rows: rowsAt(T), root, generatedAtUtc: "2026-01-01T00:00:00.000Z"});
    assert.deepEqual([...result.shardsWritten], ["2025-06"]);
    assert.equal(result.manifest.series_id, REFERENCE_SERIES_ID);
    assert.equal(result.manifest.row_count, 1);
    assert.ok(result.manifest.content_hash);
    assert.deepEqual(await listCachedShards(REFERENCE_SERIES_ID, root), ["2025-06"]);
    const persisted = await readReferenceShard("2025-06", root);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.observation_class, "exact_atm");
    const manifest = await readReferenceManifest(root);
    assert.equal(manifest!.content_hash, result.manifest.content_hash);
  });
});

test("CACHE: an unchanged shard is reused rather than rewritten", async () => {
  await withTempRoot(async root => {
    const rows = rowsAt(T);
    await writeReferenceShards({rows, root, generatedAtUtc: "2026-01-01T00:00:00.000Z"});
    const again = await writeReferenceShards({rows, root, generatedAtUtc: "2026-02-02T00:00:00.000Z"});
    assert.deepEqual([...again.shardsWritten], [], "identical evidence must not rewrite the shard");
    assert.deepEqual([...again.shardsReused], ["2025-06"]);
    // Expanding the sample into a NEW month reuses the old shard and adds one.
    const july = await writeReferenceShards({rows: rowsAt(Date.UTC(2025, 6, 14, 12)), root});
    assert.deepEqual([...july.shardsWritten], ["2025-07"]);
    assert.deepEqual(await listCachedShards(REFERENCE_SERIES_ID, root), ["2025-06", "2025-07"]);
    assert.equal(july.manifest.row_count, 2, "the manifest describes the whole series, not one write");
  });
});

test("CACHE: regenerating one target replaces its row instead of duplicating it", async () => {
  await withTempRoot(async root => {
    await writeReferenceShards({rows: rowsAt(T, 42), root});
    const updated = await writeReferenceShards({rows: rowsAt(T, 43), root});
    const persisted = await readReferenceShard("2025-06", root);
    assert.equal(persisted.length, 1, "row identity is (timestamp, tenor)");
    assert.ok(Math.abs(persisted[0]!.reference_iv_decimal! - 0.43) < 1e-12);
    assert.deepEqual([...updated.shardsWritten], ["2025-06"], "changed content is genuinely rewritten");
  });
});

test("CACHE: the manifest content hash is stable across regeneration but tracks content", async () => {
  await withTempRoot(async root => {
    const first = await writeReferenceShards({rows: rowsAt(T, 42), root, generatedAtUtc: "2026-01-01T00:00:00.000Z"});
    const same = await writeReferenceShards({rows: rowsAt(T, 42), root, generatedAtUtc: "2026-03-03T00:00:00.000Z"});
    assert.equal(same.manifest.content_hash, first.manifest.content_hash);
    const changed = await writeReferenceShards({rows: rowsAt(T, 44), root});
    assert.notEqual(changed.manifest.content_hash, first.manifest.content_hash);
  });
});

test("CACHE: DVOL is stored under its own series id, never mixed with the reference series", async () => {
  await withTempRoot(async root => {
    await writeReferenceShards({rows: rowsAt(T), root});
    const dvol = await writeDvolShards({points: [{timestampMs: T, open: 40, high: 41, low: 39, close: 40.5}], root});
    assert.equal(dvol.seriesId, DVOL_SERIES_ID);
    assert.notEqual(dvol.seriesId, REFERENCE_SERIES_ID);
    // Physically separate directories, so one can never be read as the other.
    assert.deepEqual(await listCachedShards(DVOL_SERIES_ID, root), ["2025-06"]);
    assert.deepEqual(await listCachedShards(REFERENCE_SERIES_ID, root), ["2025-06"]);
    const identity = JSON.parse(await readFile(join(root, DVOL_SERIES_ID, "manifest.json"), "utf8")) as Record<string, unknown>;
    assert.equal(identity.series_id, DVOL_SERIES_ID);
    assert.equal(identity.source_host, DVOL_HOST);
    const referenceManifest = await readReferenceManifest(root);
    assert.equal(referenceManifest!.source_host, OPTION_HISTORY_HOST);
    assert.notEqual(referenceManifest!.method_version, identity.method_version);
  });
});

test("CACHE: a missing cache reads as empty rather than throwing", async () => {
  await withTempRoot(async root => {
    assert.deepEqual(await listCachedShards(REFERENCE_SERIES_ID, root), []);
    assert.deepEqual(await readReferenceShard("1999-01", root), []);
    assert.equal(await readReferenceManifest(root), null);
  });
});
