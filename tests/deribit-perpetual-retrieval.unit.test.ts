import test from "node:test";import assert from "node:assert/strict";
import {DeribitPerpetualHistoryService,PERPETUAL_FUNDING_SOURCE,PERPETUAL_REFERENCE_SOURCE} from "../scripts/deribit-perpetual-history.ts";

const HISTORY="https://history.deribit.com/api/v2/public",FUNDING="https://www.deribit.com/api/v2/public";
const HOUR=3_600_000,START=1_699_999_200_000;

/**
 * The recorded shapes of the four public endpoints this engine depends on,
 * captured from live responses: get_instrument, get_tradingview_chart_data,
 * get_funding_rate_history and get_last_trades_by_instrument_and_time.
 */
const INSTRUMENT={instrument_name:"BTC-PERPETUAL",kind:"future",settlement_period:"perpetual",future_type:"reversed",is_active:true,contract_size:10,tick_size:0.5,min_trade_amount:10,maker_commission:0.00015,taker_commission:0.00035,price_index:"btc_usd",settlement_currency:"BTC"};

function stub(handlers:Record<string,(url:URL)=>unknown>,log:string[]=[]){
 const fetcher=async(input:string|URL|Request)=>{
  const url=new URL(String(input));
  const method=url.pathname.split("/").pop()!;
  log.push(`${url.origin}${url.pathname}`);
  const handler=handlers[method];
  if(!handler)return new Response("Bad request",{status:400});
  return new Response(JSON.stringify({jsonrpc:"2.0",result:handler(url)}),{status:200,headers:{"content-type":"application/json"}});
 };
 return{fetcher:fetcher as unknown as typeof fetch,log};
}
const chart=(ticks:number[])=>({status:ticks.length?"ok":"no_data",ticks,
 open:ticks.map((_,i)=>100+i),high:ticks.map((_,i)=>101+i),low:ticks.map((_,i)=>99+i),close:ticks.map((_,i)=>100.5+i),volume:ticks.map(()=>5)});

test("instrument metadata is read from the venue, not assumed",async()=>{
 const{fetcher}=stub({get_instrument:()=>INSTRUMENT});
 const metadata=await new DeribitPerpetualHistoryService(HISTORY,FUNDING,fetcher).instrument("BTC-PERPETUAL","2024-01-01T00:00:00.000Z");
 assert.equal(metadata.settlementPeriod,"perpetual");
 assert.equal(metadata.futureType,"reversed");
 assert.equal(metadata.contractSizeUsd,10);
 assert.equal(metadata.takerCommission,0.00035);
 assert.equal(metadata.makerCommission,0.00015);
 assert.equal(metadata.priceIndex,"btc_usd");
 assert.equal(metadata.source,"deribit-get_instrument");
 assert.equal(metadata.authoritative,true);
});

test("hourly bars are parsed with their gaps named and never filled",async()=>{
 const ticks=[0,1,2,4].map(index=>START+index*HOUR); // the third hour is genuinely missing
 const{fetcher}=stub({get_tradingview_chart_data:()=>chart(ticks)});
 const{points,coverage}=await new DeribitPerpetualHistoryService(HISTORY,FUNDING,fetcher).referenceSeries("BTC-PERPETUAL",START,START+4*HOUR,60);
 assert.equal(points.length,4);
 assert.equal(coverage.source,PERPETUAL_REFERENCE_SOURCE);
 assert.equal(coverage.expectedPoints,5);
 assert.equal(coverage.receivedPoints,4);
 assert.equal(coverage.missingPoints,1);
 assert.deepEqual(coverage.missingTimestamps,[START+3*HOUR]);
 assert.equal(coverage.status,"partial");
 assert.equal(coverage.forwardFilled,false);
 assert.ok(!points.some(point=>point.timestamp===START+3*HOUR),"the missing hour stays missing");
 assert.equal(points[0].open,100);
 assert.equal(points[0].price,points[0].close,"the persisted price is the bar close");
});

test("an empty chart response is unavailable rather than an empty success",async()=>{
 const{fetcher}=stub({get_tradingview_chart_data:()=>chart([])});
 const{points,coverage}=await new DeribitPerpetualHistoryService(HISTORY,FUNDING,fetcher).referenceSeries("BTC-PERPETUAL",START,START+2*HOUR,60);
 assert.equal(points.length,0);
 assert.equal(coverage.status,"unavailable");
 assert.equal(coverage.apiStatus,"no_data");
});

test("funding is chunked across the venue's response cap and read from the funding host",async()=>{
 const requested:Array<[number,number]>=[];
 const{fetcher,log}=stub({get_funding_rate_history:url=>{
  const start=Number(url.searchParams.get("start_timestamp")),end=Number(url.searchParams.get("end_timestamp"));
  requested.push([start,end]);
  const rows=[];
  for(let hour=start+HOUR;hour<=end;hour+=HOUR)rows.push({timestamp:hour,index_price:100,prev_index_price:99.5,interest_1h:1e-6,interest_8h:8e-6});
  return rows.slice(-744);
 }});
 const service=new DeribitPerpetualHistoryService(HISTORY,FUNDING,fetcher);
 const{points,coverage}=await service.fundingHistory("BTC-PERPETUAL",START,START+60*86_400_000);
 assert.ok(requested.length>1,"a 60-day window cannot be one request against a 744-row cap");
 assert.ok(requested.every(([start,end])=>end-start<=28*86_400_000));
 assert.ok(log.every(entry=>entry.startsWith(FUNDING)),"funding is not requested from the history mirror, which does not serve it");
 assert.equal(coverage.source,PERPETUAL_FUNDING_SOURCE);
 assert.equal(coverage.rateField,"interest_1h");
 assert.equal(coverage.assumedZeroWhenMissing,false);
 assert.equal(coverage.status,"complete");
 assert.equal(points.length,coverage.expectedPoints);
 assert.equal(points[0].rate,1e-6);
 assert.equal(points[0].rate8h,8e-6);
});

test("missing funding hours are reported, never substituted with zero",async()=>{
 const{fetcher}=stub({get_funding_rate_history:url=>{
  const start=Number(url.searchParams.get("start_timestamp")),end=Number(url.searchParams.get("end_timestamp"));
  const rows=[];
  for(let hour=start+HOUR;hour<=end;hour+=HOUR)if(hour!==START+2*HOUR)rows.push({timestamp:hour,interest_1h:1e-6,interest_8h:8e-6,index_price:100});
  return rows;
 }});
 const{points,coverage}=await new DeribitPerpetualHistoryService(HISTORY,FUNDING,fetcher).fundingHistory("BTC-PERPETUAL",START,START+4*HOUR);
 assert.equal(coverage.status,"partial");
 assert.equal(coverage.missingPoints,1);
 assert.deepEqual(coverage.missingTimestamps,[START+2*HOUR]);
 assert.ok(!points.some(point=>point.timestamp===START+2*HOUR));
 assert.ok(points.every(point=>point.rate!==0));
});

test("a composed baseline keeps price, funding and execution evidence independent",async()=>{
 const ticks=[0,1,2].map(index=>START+index*HOUR);
 const{fetcher}=stub({
  get_instrument:()=>INSTRUMENT,
  get_tradingview_chart_data:()=>chart(ticks),
  get_funding_rate_history:()=>{throw new Error("unused")},
  get_last_trades_by_instrument_and_time:()=>({has_more:false,trades:[
   {trade_id:"1",trade_seq:1,timestamp:START+500,price:100.1,mark_price:100.05,index_price:100,direction:"sell",amount:100},
   {trade_id:"2",trade_seq:2,timestamp:START+900,price:100.2,mark_price:100.15,index_price:100,direction:"buy",amount:200},
  ]}),
 });
 const{snapshot,diagnostics}=await new DeribitPerpetualHistoryService(HISTORY,FUNDING,fetcher)
  .baseline({instrument:"BTC-PERPETUAL",start:START,end:START+2*HOUR,orderTimestamp:START,direction:"long"});
 assert.equal(snapshot.instrumentKind,"perpetual");
 assert.equal(snapshot.priceBasis,"traded_ohlc");
 assert.equal(snapshot.reference.length,3,"a funding outage does not cost us the price series");
 assert.equal(snapshot.funding,undefined);
 assert.equal(snapshot.fundingCoverage,null);
 assert.equal(snapshot.feeRate,0.00035);
 assert.equal(snapshot.trades?.[0].tradeId,"2","the first print on the side the strategy would take");
 assert.equal(snapshot.trades?.[0].direction,"buy");
 assert.deepEqual(diagnostics.errors.map(error=>error.stage),["funding"]);
 assert.ok(diagnostics.apiRequestCount>=3);
});

test("a non-perpetual instrument is labelled for what it is",async()=>{
 const{fetcher}=stub({
  get_instrument:()=>({...INSTRUMENT,instrument_name:"BTC-27JUN25",settlement_period:"month"}),
  get_tradingview_chart_data:()=>chart([START]),
  get_funding_rate_history:()=>[],
 });
 const{snapshot}=await new DeribitPerpetualHistoryService(HISTORY,FUNDING,fetcher)
  .baseline({instrument:"BTC-27JUN25",start:START,end:START+HOUR});
 assert.equal(snapshot.instrumentKind,"dated_future","a dated future is never persisted as the perpetual identity");
});

test("an invalid retrieval window is rejected before any request is made",async()=>{
 const{fetcher,log}=stub({});
 await assert.rejects(()=>new DeribitPerpetualHistoryService(HISTORY,FUNDING,fetcher).baseline({instrument:"BTC-PERPETUAL",start:START,end:START}),/valid perpetual retrieval window/);
 assert.equal(log.length,0);
});
