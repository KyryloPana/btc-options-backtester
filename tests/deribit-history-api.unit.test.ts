import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeribitHistoryService } from "../scripts/deribit-history-api.ts";

const entry = Date.parse("2024-01-01T08:00:00Z");
const expiry = entry + 7 * 86_400_000;
const instruments = [
  { instrument_name: "BTC-8JAN24-40000-P", expiration_timestamp: expiry, creation_timestamp: entry - 10_000, strike: 40000, option_type: "put", price_index: "btc_usd" },
  { instrument_name: "BTC-8JAN24-39000-P", expiration_timestamp: expiry, creation_timestamp: entry - 20_000, strike: 39000, option_type: "put", price_index: "btc_usd" },
];
function json(result: unknown, status = 200, headers?: Record<string,string>) { return new Response(JSON.stringify({ result }), { status, headers }); }
function trade(name: string, seq: number, timestamp = entry) { return { instrument_name:name, trade_seq:seq, timestamp, price:.01, index_price:42000, direction:seq%2?"buy":"sell", amount:1 }; }

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
  } finally { await cleanup(); }
});

test("trade pagination deduplicates, orders, and filters exact interval", async () => {
  const fetcher=async(input:string|URL|Request)=>{ const u=new URL(String(input)); if(u.pathname.endsWith("get_delivery_prices"))return json({data:[],records_total:0});if(u.pathname.endsWith("get_instruments")) return json([]); if(u.searchParams.has("start_timestamp")) return json({trades:[trade("X",u.searchParams.get("sorting")==="asc"?1:3,u.searchParams.get("sorting")==="asc"?entry:entry+2)]}); return json({trades:[trade("X",3,entry+2),trade("X",2,entry+1),trade("X",2,entry+1),trade("X",1,entry),trade("X",4,entry+100)]}); };
  const {service,cleanup}=await fixture(fetcher as typeof fetch); try { const rows=await service.fetchTradeRange("X",entry,entry+2); assert.deepEqual(rows.map(x=>x.tradeId),["1","2","3"]); } finally { await cleanup(); }
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
