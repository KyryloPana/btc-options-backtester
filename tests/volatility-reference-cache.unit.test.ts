import test from "node:test";
import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  VolatilityReferenceRetrieval, hourlyClosesFromPerpetualSeries,
  listCachedShards, readReferenceManifest, readReferenceShard,
  VOLATILITY_RETRIEVAL_VERSION, writeDvolShards, writeReferenceShards,
} from "../scripts/volatility-reference-cache.ts";
import {
  DERIBIT_OPTION_INDEX_UNDERLYING, DVOL_HOST, DVOL_SERIES_ID, OPTION_HISTORY_HOST, REFERENCE_SERIES_ID, REFERENCE_SERIES_METHOD_VERSION,
  buildReferenceSeriesRows, isReferenceTimestampComplete, type ReferenceSeriesRow,
} from "../app/lib/volatility/reference-series.ts";
import type {RawIvTradeCandidate} from "../app/lib/volatility/market-iv-evidence.ts";
import {materializeVolatilityStates,MINIMUM_PRIOR_OBSERVATIONS} from "../scripts/materialize-volatility-states.ts";
import {store as selectionStore,ts as ENTRY} from "./fixtures/research-selection-store.ts";

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

test("COMPLETENESS: >1000 exact-instrument and currency trades are fully retrieved, ordered, deduplicated and cached",async()=>{
 const total=1505,start=T,end=T+total-1,all=Array.from({length:total},(_,i)=>({instrument_name:"BTC-X",timestamp:start+i,iv:40,trade_id:`t${i}`,trade_seq:i,index_price:SPOT}));let calls=0;
 const fetcher=async(input:string|URL|Request)=>{calls+=1;const url=new URL(String(input)),a=Number(url.searchParams.get("start_timestamp")),b=Number(url.searchParams.get("end_timestamp")),matching=all.filter(x=>x.timestamp>=a&&x.timestamp<=b),page=matching.slice(0,1000);return new Response(JSON.stringify({result:{trades:[...page,page[0]].filter(Boolean),has_more:matching.length>1000}}),{status:200})};
 const service=new VolatilityReferenceRetrieval({fetcher:fetcher as never}),exact=await service.ivTrades("BTC-X",start,end),afterExact=calls,currency=await service.ivTradesByCurrency(start,end);
 assert.equal(exact.length,total);assert.equal(currency.length,total);assert.equal(exact.at(-1)!.tradeId,`t${total-1}`);assert.equal(new Set(exact.map(x=>x.tradeId)).size,total);assert.ok(exact.every((x,i)=>i===0||exact[i-1]!.timestampMs<=x.timestampMs));
 await service.ivTrades("BTC-X",start,end);await service.ivTradesByCurrency(start,end);assert.equal(calls,afterExact+(afterExact),"both complete interval results are reused from memory");
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
    timestampMs, underlyingInstrument: DERIBIT_OPTION_INDEX_UNDERLYING, underlyingPrice: SPOT,
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
    assert.deepEqual(result.manifest.source_endpoints,
      ["get_instruments", "get_last_trades_by_currency_and_time"]);
    assert.equal(VOLATILITY_RETRIEVAL_VERSION, "volatility-reference-retrieval-v2");
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

const historyRows=()=>Array.from({length:721},(_,i)=>ENTRY-(720-i)*3_600_000).flatMap(timestampMs=>buildReferenceSeriesRows({timestampMs,underlyingInstrument:DERIBIT_OPTION_INDEX_UNDERLYING,underlyingPrice:100,listedExpiries:[7,14,30].map(days=>({expiryTimestampMs:timestampMs+days*86_400_000,createdAtMs:timestampMs-86_400_000,settlementPeriod:"week",strikes:[100]})),candidates:[7,14,30].map((days,j)=>({instrumentName:`BTC-${days}D-100-C`,tradeId:`${timestampMs}-${days}`,tradeSeq:j,strike:100,optionType:"C" as const,expiryTimestampMs:timestampMs+days*86_400_000,settlementPeriod:"week",contractCreatedAtMs:timestampMs-86_400_000,timestampMs:timestampMs-60_000,ivApiPercent:40+days/10,indexPrice:100})),tenors:["7d","14d","30d"]}).rows);

test("PERCENTILE CACHE: a genuine 720-hour same-tenor series is reused and makes percentiles available",async()=>withTempRoot(async root=>{
 assert.equal(MINIMUM_PRIOR_OBSERVATIONS,720);await writeReferenceShards({rows:historyRows(),root});let currencyCalls=0;
 const fake={instrumentManifest:async()=>[{instrumentName:"unused",strike:100,optionType:"C" as const,expiryTimestampMs:ENTRY+40*86_400_000,createdAtMs:ENTRY-40*86_400_000,settlementPeriod:"month"}],ivTrades:async()=>[],ivTradesByCurrency:async()=>{currencyCalls+=1;return[]},dvolRange:async()=>[]};
 const state=await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:720,perpetualBars:async()=>[]});
 assert.equal(currencyCalls,0,"complete hourly targets must prevent equivalent historical refetch");assert.ok(state.events!.every(e=>e.reference_iv_percentile.every(p=>p.status==="available"&&p.prior_observation_count===720)));
}));

test("PERCENTILE CACHE: missing hourly targets are populated once and monthly shards prevent a second refetch",async()=>withTempRoot(async root=>{
 let currencyCalls=0;const expiries=[7,14,30].map(days=>({instrumentName:`BTC-${days}D-100-C`,strike:100,optionType:"C" as const,expiryTimestampMs:ENTRY+days*86_400_000,createdAtMs:ENTRY-40*86_400_000,settlementPeriod:"week"}));
 const fake={instrumentManifest:async()=>expiries,ivTrades:async()=>[],ivTradesByCurrency:async(_start:number,end:number)=>{currencyCalls+=1;return expiries.map((m,i)=>({instrumentName:m.instrumentName,tradeId:`${end}-${i}`,tradeSeq:i,timestampMs:end-60_000,ivApiPercent:40+i,indexPrice:100,price:null,markPrice:null,direction:null,amount:null}))},dvolRange:async()=>[]};
 const first=await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:2,perpetualBars:async()=>[]});assert.equal(currencyCalls,3);assert.ok(first.events!.every(e=>e.underlying_instrument==="deribit_btc_usd_index"));assert.ok((await readReferenceShard("2026-08",root)).every(r=>r.underlying_instrument==="deribit_btc_usd_index"));currencyCalls=0;
 await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:2,perpetualBars:async()=>[]});assert.equal(currencyCalls,0);assert.equal((await readReferenceShard("2026-08",root)).length,9);
}));

test("PERCENTILE BACKFILL: sparse attempted hours extend until 720 valid observations",async()=>withTempRoot(async root=>{
 const max=900,metas=Array.from({length:max+1},(_,h)=>[7,14,30].map(days=>({instrumentName:`H${h}-${days}`,strike:100,optionType:"C" as const,expiryTimestampMs:ENTRY-h*3_600_000+days*86_400_000,createdAtMs:ENTRY-(max+24)*3_600_000,settlementPeriod:"week"}))).flat(),byExpiry=new Map(metas.map(x=>[x.expiryTimestampMs,x]));let calls=0;
 const fake={instrumentManifest:async()=>metas,ivTrades:async()=>[],ivTradesByCurrency:async(_start:number,end:number)=>{calls+=1;const h=Math.round((ENTRY-end)/3_600_000);if(h>0&&h<=100)return[];return[7,14,30].map((days,i)=>{const m=byExpiry.get(end+days*86_400_000)!;return{instrumentName:m.instrumentName,tradeId:`${end}-${days}`,tradeSeq:i,timestampMs:end-60_000,ivApiPercent:40+i,indexPrice:100,price:null,markPrice:null,direction:null,amount:null}})},dvolRange:async()=>[]};
 const state=await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:max,perpetualBars:async()=>[]});assert.ok(calls>760,"attempt count must extend when attempted hours are invalid");assert.ok(calls<max+1,"backfill stops after all tenors reach 720 valid rows");assert.ok(state.events!.every(e=>e.reference_iv_percentile.every(p=>p.status==="available"&&p.prior_observation_count>=720)));
}));

test("PERCENTILE PERFORMANCE: widely separated events retrieve a union of local windows, not the calendar gap",async()=>withTempRoot(async root=>{
 const fixture=structuredClone(selectionStore),january=Date.UTC(2026,0,15),june=Date.UTC(2026,5,15);for(const [event,timestamp] of fixture.events.map((event,i)=>[event,i?june:january] as const)){(event.sourceRun as {event:{entryTimestamp:number}}).event.entryTimestamp=timestamp;event.generationSnapshot.underlyingHourlyPath=[]}let calls=0;
 const fake={instrumentManifest:async()=>[{instrumentName:"boundary",strike:100,optionType:"C" as const,expiryTimestampMs:june+60*86_400_000,createdAtMs:january-10*86_400_000,settlementPeriod:"month"}],ivTrades:async()=>[],ivTradesByCurrency:async()=>{calls+=1;return[]},dvolRange:async()=>[]};
 await materializeVolatilityStates(fixture,root,{retrieval:fake,historyHours:2,perpetualBars:async()=>[]});assert.equal(calls,6,"two three-hour local scans must not fill January through June");
}));

test("CACHE COMPLETENESS: canonical unavailable tenor rows are not repeatedly retrieved",async()=>withTempRoot(async root=>{
 let calls=0;const expiry=ENTRY+7*86_400_000,meta={instrumentName:"BTC-U",strike:100,optionType:"C" as const,expiryTimestampMs:expiry,createdAtMs:ENTRY-86_400_000,settlementPeriod:"week"},fake={instrumentManifest:async()=>[meta],ivTrades:async()=>[],ivTradesByCurrency:async(_start:number,end:number)=>{calls+=1;return[{instrumentName:meta.instrumentName,tradeId:`u-${end}`,tradeSeq:1,timestampMs:end-1,ivApiPercent:null,indexPrice:100,price:null,markPrice:null,direction:null,amount:null}]},dvolRange:async()=>[]};
 await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:0,perpetualBars:async()=>[]});assert.equal(calls,1);calls=0;await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:0,perpetualBars:async()=>[]});assert.equal(calls,0);
}));


test("CACHE COMPATIBILITY: v1 rows cannot complete the v2 series and are rebuilt separately",async()=>withTempRoot(async root=>{
 const v1="deribit-btc-same-expiry-reference-v1", timestamp=ENTRY;
 const stale=buildReferenceSeriesRows({timestampMs:timestamp,underlyingInstrument:"BTC-PERPETUAL",underlyingPrice:100,listedExpiries:[7,14,30].map(days=>({expiryTimestampMs:timestamp+days*86_400_000,createdAtMs:timestamp-86_400_000,settlementPeriod:"week",strikes:[100]})),candidates:[],tenors:["7d","14d","30d"]}).rows.map(row=>({...row,series_id:v1,method_version:"volatility-reference-series-v1",underlying_instrument:"BTC-PERPETUAL"}));
 await mkdir(join(root,v1),{recursive:true});await writeFile(join(root,v1,"2026-08.jsonl"),stale.map(JSON.stringify).join("\n")+"\n");
 assert.equal(isReferenceTimestampComplete(stale,timestamp),false);
 const metas=[7,14,30].map(days=>({instrumentName:`V2-${days}`,strike:100,optionType:"C" as const,expiryTimestampMs:timestamp+days*86_400_000,createdAtMs:timestamp-86_400_000,settlementPeriod:"week"}));let calls=0;
 const fake={instrumentManifest:async()=>metas,ivTrades:async()=>[],ivTradesByCurrency:async(_s:number,end:number)=>{calls++;return metas.map((m,i)=>({instrumentName:m.instrumentName,tradeId:`v2-${i}`,tradeSeq:i,timestampMs:end-1,ivApiPercent:40,indexPrice:100,price:null,markPrice:null,direction:null,amount:null}))},dvolRange:async()=>[]};
 await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:0,perpetualBars:async()=>[]});assert.equal(calls,1);const current=await readReferenceShard("2026-08",root);assert.equal(isReferenceTimestampComplete(current,timestamp),true);assert.ok(current.every(row=>row.series_id===REFERENCE_SERIES_ID&&row.method_version===REFERENCE_SERIES_METHOD_VERSION&&row.underlying_instrument===DERIBIT_OPTION_INDEX_UNDERLYING));
}));

for(const [name,trades] of [["empty tape",[]],["missing causal index",[{indexPrice:null}]]] as const)test(`CACHE COMPLETENESS: ${name} is honestly unavailable and reused`,async()=>withTempRoot(async root=>{
 let calls=0;const meta={instrumentName:"BTC-E",strike:100,optionType:"C" as const,expiryTimestampMs:ENTRY+7*86_400_000,createdAtMs:ENTRY-86_400_000,settlementPeriod:"week"};
 const fake={instrumentManifest:async()=>[meta],ivTrades:async()=>[],ivTradesByCurrency:async(_s:number,end:number)=>{calls++;return trades.map((x,i)=>({instrumentName:meta.instrumentName,tradeId:`e-${i}`,tradeSeq:i,timestampMs:end-1,ivApiPercent:42,indexPrice:x.indexPrice,price:null,markPrice:null,direction:null,amount:null}))},dvolRange:async()=>[]};
 await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:0,perpetualBars:async()=>[]});assert.equal(calls,1);const rows=await readReferenceShard("2026-08",root);assert.equal(rows.length,3);assert.ok(rows.every(row=>row.reference_iv_decimal===null&&row.quality==="unavailable"&&row.unavailable_reason_code==="missing_index_price"));assert.equal(isReferenceTimestampComplete(rows,ENTRY),true);
 calls=0;await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:0,perpetualBars:async()=>[]});assert.equal(calls,0);
}));

test("CACHE COMPLETENESS: failed currency retrieval writes no unavailable rows and retries",async()=>withTempRoot(async root=>{
 let calls=0;const meta={instrumentName:"BTC-F",strike:100,optionType:"C" as const,expiryTimestampMs:ENTRY+7*86_400_000,createdAtMs:ENTRY-86_400_000,settlementPeriod:"week"};const fake={instrumentManifest:async()=>[meta],ivTrades:async()=>[],ivTradesByCurrency:async()=>{calls++;throw new Error("network failure")},dvolRange:async()=>[]};
 await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:0,perpetualBars:async()=>[]});assert.equal(calls,1);assert.deepEqual(await readReferenceShard("2026-08",root),[]);
 await materializeVolatilityStates(selectionStore,root,{retrieval:fake,historyHours:0,perpetualBars:async()=>[]});assert.equal(calls,2);
}));
