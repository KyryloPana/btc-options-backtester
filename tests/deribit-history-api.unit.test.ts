import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CROSS_SECTION_RETRIEVAL_VERSION, DeribitHistoryService, LADDER_MAX_LOG_MONEYNESS,
  LADDER_NEIGHBOUR_DEPTH, resolveOrderedPair, sameExpiryLadder,
} from "../scripts/deribit-history-api.ts";

const entry = Date.parse("2024-01-01T08:00:00Z");
const expiry = entry + 7 * 86_400_000;
const instruments = [
  { instrument_name: "BTC-8JAN24-40000-P", expiration_timestamp: expiry, creation_timestamp: entry - 10_000, strike: 40000, option_type: "put", price_index: "btc_usd" },
  { instrument_name: "BTC-8JAN24-39000-P", expiration_timestamp: expiry, creation_timestamp: entry - 20_000, strike: 39000, option_type: "put", price_index: "btc_usd" },
];
function json(result: unknown, status = 200, headers?: Record<string,string>) { return new Response(JSON.stringify({ result }), { status, headers }); }
function trade(name: string, seq: number, timestamp = entry) { return { instrument_name:name, trade_seq:seq, timestamp, price:.01, iv:57.5, index_price:42000, direction:seq%2?"buy":"sell", amount:1 }; }

async function fixture(fetcher: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), "deribit-api-"));
  const service = new DeribitHistoryService("https://history.test/api/v2/public", join(dir,"manifest.json"), fetcher, 2);
  await service.startIndex(); await service.waitUntilReady();
  return { service, cleanup: () => rm(dir,{recursive:true,force:true}) };
}

test("combines and deduplicates expired/active manifests, retains creation time, and fetches only eligible resolved legs", async () => {
  const tradeNames: string[]=[];
  const fetcher = async (input: string|URL|Request) => {
    const u=new URL(String(input)); const method=u.pathname.split("/").at(-1);
    if(method==="get_delivery_prices") return json({data:[],records_total:0});
    if(method==="get_instruments") return json(u.searchParams.get("expired")==="true" ? [...instruments,{...instruments[0]}] : [...instruments,{ instrument_name:"BTC-21JAN24-50000-P",expiration_timestamp:entry+20*86_400_000,creation_timestamp:entry-1,strike:50000,option_type:"put" }]);
    const name=u.searchParams.get("instrument_name")!; tradeNames.push(name);
    if(u.searchParams.has("start_timestamp")) return json({trades:[trade(name,u.searchParams.get("sorting")==="asc"?10:11)]});
    return json({trades:[trade(name,10),trade(name,11),trade(name,11)]});
  };
  const {service,cleanup}=await fixture(fetcher as typeof fetch);
  try {
    assert.equal((await service.status()).contractsFound,3);
    const result=await service.resolve(entry,[{requestId:"r",targetDte:7,minDte:5,maxDte:10,soldStrike:40000,boughtStrike:39000,optionType:"P"}]);
    assert.equal(result.candidates.length,1); assert.equal(result.inventory.length,2);
    assert.equal(result.candidates[0].soldCreationTimestamp,entry-10_000);
    assert.deepEqual(new Set(tradeNames),new Set(["BTC-8JAN24-40000-P","BTC-8JAN24-39000-P"]));
    assert.equal(result.diagnostics.validTrades,4);
    assert.ok(result.inventory.every(series=>series.trades.every(row=>row.ivApiPercent===57.5&&row.ivDecimal===.575)));
  } finally { await cleanup(); }
});

test("joint nearest-strike resolution preserves distinct bear-call and bull-put ordering", () => {
  const chain = [127000, 130000].map(strike => ({ instrumentName:`BTC-30AUG26-${strike}-C`, expiryTimestamp:expiry, expiryLabel:"30AUG26", strike, optionType:"C" as const, status:"expired" as const, priceIndex:"btc_usd" }));
  const bear = resolveOrderedPair(chain, 127500, 128000)!;
  assert.deepEqual([bear.sold.strike, bear.bought.strike], [127000, 130000], "the next valid strike is used rather than resolving both legs to 127000");
  const bull = resolveOrderedPair(chain, 129000, 127500)!;
  assert.deepEqual([bull.sold.strike, bull.bought.strike], [130000, 127000]);
  assert.equal(resolveOrderedPair(chain, 127000, 127000), undefined, "equal desired strikes are invalid");
});

test("trade pagination deduplicates, orders, and filters exact interval", async () => {
  const fetcher=async(input:string|URL|Request)=>{ const u=new URL(String(input)); if(u.pathname.endsWith("get_delivery_prices"))return json({data:[],records_total:0});if(u.pathname.endsWith("get_instruments")) return json([]); if(u.searchParams.has("start_timestamp")) return json({trades:[trade("X",u.searchParams.get("sorting")==="asc"?1:3,u.searchParams.get("sorting")==="asc"?entry:entry+2)]}); return json({trades:[trade("X",3,entry+2),trade("X",2,entry+1),trade("X",2,entry+1),trade("X",1,entry),trade("X",4,entry+100)]}); };
  const {service,cleanup}=await fixture(fetcher as typeof fetch); try { const rows=await service.fetchTradeRange("X",entry,entry+2); assert.deepEqual(rows.map(x=>x.tradeSeq),["1","2","3"]); } finally { await cleanup(); }
});

test("incomplete sequence coverage is detected", async()=>{
  const fetcher=async(input:string|URL|Request)=>{const u=new URL(String(input));if(u.pathname.endsWith("get_delivery_prices"))return json({data:[],records_total:0});if(u.pathname.endsWith("get_instruments"))return json([]);if(u.searchParams.has("start_timestamp"))return json({trades:[trade("X",u.searchParams.get("sorting")==="asc"?1:3)]});return json({trades:[trade("X",1),trade("X",3)]});};
  const {service,cleanup}=await fixture(fetcher as typeof fetch);try{await assert.rejects(service.fetchTradeRange("X",entry-1,entry+1),/Incomplete trade sequence coverage/);}finally{await cleanup();}
});

test("retryable responses are retried",async()=>{let attempts=0;const fetcher=async(input:string|URL|Request)=>{const u=new URL(String(input));if(u.pathname.endsWith("get_delivery_prices"))return json({data:[],records_total:0});if(u.pathname.endsWith("get_instruments")){attempts++;if(attempts===1)return new Response("",{status:429,headers:{"retry-after":"0"}});return json([]);}return json({trades:[]});};const {cleanup}=await fixture(fetcher as typeof fetch);try{assert.ok(attempts>=3);}finally{await cleanup();}});

test("failed contracts make affected candidates explicitly data-unavailable",async()=>{const fetcher=async(input:string|URL|Request)=>{const u=new URL(String(input));if(u.pathname.endsWith("get_delivery_prices"))return json({data:[],records_total:0});if(u.pathname.endsWith("get_instruments"))return json(u.searchParams.get("expired")==="true"?instruments:[]);const name=u.searchParams.get("instrument_name")!;if(name.includes("39000"))return new Response("bad",{status:400});if(u.searchParams.has("start_timestamp"))return json({trades:[trade(name,1)]});return json({trades:[trade(name,1)]});};const {service,cleanup}=await fixture(fetcher as typeof fetch);try{const r=await service.resolve(entry,[{requestId:"r",targetDte:7,minDte:5,maxDte:10,soldStrike:40000,boughtStrike:39000,optionType:"P"}]);assert.equal(r.complete,false);assert.deepEqual(r.diagnostics.failedContracts,["BTC-8JAN24-39000-P"]);assert.equal(r.diagnostics.contractsLoaded,1);assert.equal(r.candidates[0].dataStatus,"data-unavailable");assert.deepEqual(r.failures[0].requestIds,["r"]);assert.match(r.failures[0].cause,/Deribit HTTP 400/);assert.equal(r.failures[0].retryable,false);}finally{await cleanup();}});

test("an unrelated complete candidate remains available in an explicitly incomplete response",async()=>{const secondExpiry=entry+8*86_400_000;const all=[...instruments,{instrument_name:"BTC-9JAN24-40000-P",expiration_timestamp:secondExpiry,creation_timestamp:entry-1,strike:40000,option_type:"put"},{instrument_name:"BTC-9JAN24-39000-P",expiration_timestamp:secondExpiry,creation_timestamp:entry-1,strike:39000,option_type:"put"}];const fetcher=async(input:string|URL|Request)=>{const u=new URL(String(input));if(u.pathname.endsWith("get_delivery_prices"))return json({data:[],records_total:0});if(u.pathname.endsWith("get_instruments"))return json(u.searchParams.get("expired")==="true"?all:[]);const name=u.searchParams.get("instrument_name")!;if(name==="BTC-8JAN24-39000-P")return new Response("bad",{status:400});if(u.searchParams.has("start_timestamp"))return json({trades:[trade(name,1)]});return json({trades:[trade(name,1)]});};const {service,cleanup}=await fixture(fetcher as typeof fetch);try{const r=await service.resolve(entry,[{requestId:"r",targetDte:7,minDte:5,maxDte:10,soldStrike:40000,boughtStrike:39000,optionType:"P"}]);assert.equal(r.complete,false);assert.equal(r.candidates.find(candidate=>candidate.expiryTimestamp===expiry)?.dataStatus,"data-unavailable");assert.equal(r.candidates.find(candidate=>candidate.expiryTimestamp===secondExpiry)?.dataStatus,"available");assert.ok(r.inventory.some(series=>series.instrumentName==="BTC-9JAN24-39000-P"));}finally{await cleanup();}});

test("delivery-price pagination resolves a required date beyond the first page and caches it", async () => {
  const target = "2024-01-08";
  let calls = 0;
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({ date: `2023-01-${String(index % 28 + 1).padStart(2, "0")}`, delivery_price: index + 1 }));
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("get_instruments")) return json([]);
    if (url.pathname.endsWith("get_delivery_prices")) {
      calls += 1;
      return json({ data: Number(url.searchParams.get("offset")) === 0 ? firstPage : [{ date: target, delivery_price: 42_123 }], records_total: 1001 });
    }
    return json({ trades: [] });
  };
  const { service, cleanup } = await fixture(fetcher as typeof fetch);
  try {
    assert.equal((await service.fetchDeliveryPrices("btc_usd", [target])).get(target), 42_123);
    assert.equal(calls, 2);
    assert.equal((await service.fetchDeliveryPrices("btc_usd", [target])).get(target), 42_123);
    assert.equal(calls, 2, "cached delivery price avoids another API request");
  } finally { await cleanup(); }
});

test("delivery-price retrieval failures remain explicit without fallback", async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("get_instruments")) return json([]);
    if (url.pathname.endsWith("get_delivery_prices")) return new Response("bad", { status: 400 });
    return json({ trades: [] });
  };
  const { service, cleanup } = await fixture(fetcher as typeof fetch);
  try { await assert.rejects(service.fetchDeliveryPrices("btc_usd", ["2024-01-08"]), /Deribit HTTP 400/); }
  finally { await cleanup(); }
});

/* ==================== same-expiry cross-section ladder ==================== */

/** A dense listed ladder on one expiry, both option types. */
const ladderChain = (strikes: number[], created = entry - 60_000) => strikes.flatMap(strike =>
  (["C", "P"] as const).map(type => ({
    instrumentName: `BTC-8JAN24-${strike}-${type}`, expiryTimestamp: expiry,
    expiryLabel: "2024-01-08", creationTimestamp: created, strike,
    optionType: type, status: "expired" as const, priceIndex: "btc_usd",
    metadataSource: "deribit-get-instruments" as const,
    metadataRetrievedAtUtc: "2024-01-01T00:00:00.000Z", authoritative: true as const,
  })));

test("LADDER: it reaches N listed strikes either side of the structure own strikes", () => {
  const strikes = [34000, 35000, 36000, 37000, 38000, 39000, 40000, 41000, 42000, 43000, 44000, 45000, 46000];
  const ladder = sameExpiryLadder(ladderChain(strikes), [39000, 40000], 3);
  // Three listed strikes below 39000 and three above 40000, plus the two targets.
  assert.deepEqual(ladder.strikes, [36000, 37000, 38000, 39000, 40000, 41000, 42000, 43000]);
  assert.equal(ladder.neighbourDepth, 3);
  assert.equal(ladder.version, CROSS_SECTION_RETRIEVAL_VERSION);
  // Both option types, because a put and a call on one strike are two
  // observations of the same total-variance curve.
  assert.equal(ladder.instrumentNames.length, ladder.strikes.length * 2);
  assert.ok(ladder.instrumentNames.includes("BTC-8JAN24-42000-C"));
  assert.ok(ladder.instrumentNames.includes("BTC-8JAN24-42000-P"));
  // Sorted, so ladder identity does not depend on manifest order.
  assert.deepEqual([...ladder.instrumentNames].sort(), ladder.instrumentNames);
});

test("LADDER: it yields enough unique strikes for the five-strike rule to be satisfiable", () => {
  const strikes = [36000, 37000, 38000, 39000, 40000, 41000, 42000, 43000, 44000];
  const ladder = sameExpiryLadder(ladderChain(strikes), [39000, 40000], LADDER_NEIGHBOUR_DEPTH);
  assert.ok(ladder.strikes.length >= 5,
    `Rule C needs at least 5 unique strikes; the ladder offered ${ladder.strikes.length}`);
  // And the structure strikes are genuinely bracketed on both sides.
  assert.ok(ladder.strikes.some(s => s < 39000), "no strike below the short leg");
  assert.ok(ladder.strikes.some(s => s > 40000), "no strike above the long leg");
});

test("LADDER: the log-moneyness cap stops a sparse ladder reaching absurdly far", () => {
  // Neighbours exist, but they are an order of magnitude away.
  const ladder = sameExpiryLadder(ladderChain([5000, 39000, 40000, 300000]), [39000, 40000], 3);
  assert.deepEqual(ladder.strikes, [39000, 40000],
    "a strike eight times away carries no information about the target");
  assert.equal(ladder.maxLogMoneyness, LADDER_MAX_LOG_MONEYNESS);
});

test("LADDER: contracts not yet listed at the target are never in the ladder", () => {
  // The chain handed to the ladder is creation-gated by the caller; this pins
  // that a future-listed contract cannot appear even if the manifest holds it.
  const listed = ladderChain([38000, 39000, 40000, 41000]);
  const future = ladderChain([42000], entry + 86_400_000);
  const gated = [...listed, ...future].filter(x => (x.creationTimestamp ?? 0) <= entry);
  const ladder = sameExpiryLadder(gated, [39000, 40000], 3);
  assert.ok(!ladder.strikes.includes(42000), "a contract created after the target is not evidence");
  assert.ok(!ladder.instrumentNames.some(n => n.includes("42000")));
});

test("LADDER: no structure strikes, or no listed chain, yields an empty ladder", () => {
  assert.deepEqual(sameExpiryLadder(ladderChain([39000, 40000]), []).strikes, []);
  assert.deepEqual(sameExpiryLadder([], [39000, 40000]).strikes, []);
  assert.deepEqual(sameExpiryLadder([], []).instrumentNames, []);
});

test("RETRIEVAL: the ladder is fetched once per expiry and reused by every candidate", async () => {
  const chain = ladderChain([37000, 38000, 39000, 40000, 41000, 42000]);
  const fetched: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const u = new URL(String(input)); const method = u.pathname.split("/").at(-1);
    if (method === "get_delivery_prices") return json({data: [], records_total: 0});
    if (method === "get_instruments") return json(u.searchParams.get("expired") === "true"
      ? chain.map(x => ({instrument_name: x.instrumentName, expiration_timestamp: x.expiryTimestamp,
        creation_timestamp: x.creationTimestamp, strike: x.strike,
        option_type: x.optionType === "C" ? "call" : "put", price_index: "btc_usd"}))
      : []);
    const name = u.searchParams.get("instrument_name")!;
    fetched.push(name);
    return json({trades: [trade(name, 10)]});
  };
  const {service, cleanup} = await fixture(fetcher as typeof fetch);
  try {
    // Three width variants sharing one short strike -- the exact case that would
    // otherwise refetch the same expiry ladder three times over.
    const result = await service.resolve(entry, [
      {requestId: "w1", targetDte: 7, minDte: 5, maxDte: 10, soldStrike: 40000, boughtStrike: 39000, optionType: "P"},
      {requestId: "w2", targetDte: 7, minDte: 5, maxDte: 10, soldStrike: 40000, boughtStrike: 38000, optionType: "P"},
      {requestId: "w3", targetDte: 7, minDte: 5, maxDte: 10, soldStrike: 40000, boughtStrike: 37000, optionType: "P"},
    ]);
    assert.equal(result.candidates.length, 3);
    assert.equal(result.crossSection.enabled, true);
    assert.equal(result.crossSection.expiriesCovered, 1, "one expiry, one ladder");
    assert.equal(result.crossSection.candidateLegSlots, 6);
    assert.ok(result.crossSection.instrumentsRetrieved > result.crossSection.legInstrumentCount,
      "the ladder must add strikes beyond the four chosen legs");

    // The decisive assertion: every instrument is retrieved a bounded number of
    // times even though three candidates and both legs of each consume the same
    // ladder. Two boundary probes plus one page is the honest floor.
    const counts = fetched.reduce<Record<string, number>>((m, n) => (m[n] = (m[n] ?? 0) + 1, m), {});
    assert.ok(Object.keys(counts).length >= 5, `expected a real ladder, got ${Object.keys(counts).length}`);
    for (const [name, count] of Object.entries(counts))
      assert.ok(count <= 3, `${name} was fetched ${count} times; the ladder must be retrieved once`);

    // Surrounding strikes genuinely reach the inventory the valuation layer reads.
    const names = new Set(result.inventory.map(s => s.instrumentName));
    assert.ok(names.has("BTC-8JAN24-41000-P"), "a non-leg ladder strike must reach the inventory");
    assert.ok(names.has("BTC-8JAN24-40000-C"), "the opposite option type must reach the inventory too");
  } finally { await cleanup(); }
});

test("RETRIEVAL: the cross-section can be switched off, restoring legs-only behaviour", async () => {
  const chain = ladderChain([38000, 39000, 40000, 41000]);
  const fetched: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const u = new URL(String(input)); const method = u.pathname.split("/").at(-1);
    if (method === "get_delivery_prices") return json({data: [], records_total: 0});
    if (method === "get_instruments") return json(u.searchParams.get("expired") === "true"
      ? chain.map(x => ({instrument_name: x.instrumentName, expiration_timestamp: x.expiryTimestamp,
        creation_timestamp: x.creationTimestamp, strike: x.strike,
        option_type: x.optionType === "C" ? "call" : "put", price_index: "btc_usd"}))
      : []);
    const name = u.searchParams.get("instrument_name")!; fetched.push(name);
    return json({trades: [trade(name, 10)]});
  };
  const {service, cleanup} = await fixture(fetcher as typeof fetch);
  try {
    const result = await service.resolve(entry, [
      {requestId: "r", targetDte: 7, minDte: 5, maxDte: 10, soldStrike: 40000, boughtStrike: 39000, optionType: "P"},
    ], false);
    assert.equal(result.crossSection.enabled, false);
    assert.deepEqual(result.crossSection.ladders, []);
    assert.deepEqual(new Set(fetched), new Set(["BTC-8JAN24-40000-P", "BTC-8JAN24-39000-P"]),
      "with the cross-section disabled only the two chosen legs are retrieved");
  } finally { await cleanup(); }
});

test("RETRIEVAL: a ladder strike listed after the target is never fetched", async () => {
  // 41000 exists in the manifest but was created a day AFTER entry. It sits well
  // inside the ladder band, so only the service creation gate keeps it out.
  const listed = ladderChain([38000, 39000, 40000, 42000]);
  const future = ladderChain([41000], entry + 86_400_000);
  const chain = [...listed, ...future];
  const fetched: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const u = new URL(String(input)); const method = u.pathname.split("/").at(-1);
    if (method === "get_delivery_prices") return json({data: [], records_total: 0});
    if (method === "get_instruments") return json(u.searchParams.get("expired") === "true"
      ? chain.map(x => ({instrument_name: x.instrumentName, expiration_timestamp: x.expiryTimestamp,
        creation_timestamp: x.creationTimestamp, strike: x.strike,
        option_type: x.optionType === "C" ? "call" : "put", price_index: "btc_usd"}))
      : []);
    const name = u.searchParams.get("instrument_name")!; fetched.push(name);
    return json({trades: [trade(name, 10)]});
  };
  const {service, cleanup} = await fixture(fetcher as typeof fetch);
  try {
    const result = await service.resolve(entry, [
      {requestId: "r", targetDte: 7, minDte: 5, maxDte: 10, soldStrike: 40000, boughtStrike: 39000, optionType: "P"},
    ]);
    const ladder = result.crossSection.ladders[0]!;
    assert.ok(!ladder.strikes.includes(41000),
      "a contract created after the target was not evidence at that target");
    assert.ok(!fetched.some(n => n.includes("41000")), "and it must not even be retrieved");
    // The genuinely listed neighbours are still there, so this is a gate rather
    // than an empty ladder.
    assert.ok(ladder.strikes.includes(38000) && ladder.strikes.includes(42000));
  } finally { await cleanup(); }
});
