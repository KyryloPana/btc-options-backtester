import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildExpiryCandidates,
  buildInventory,
  buildValuation,
  generateDesiredSpreads,
  generateShortStrikeResearchSpreads,
  intrinsicPriceBtc,
  latestCompletedCandleAtOrBefore,
  normalizeLeg,
  evaluateExits,
  parseContractText,
  valuationTimestamps,
  type ValuationPoint,
} from "../app/lib/backtester.ts";
import { CHART_GEOMETRY, CHART_SERIES, hitExitGroups, nearestPoint, timestampAtX, timeX, uniqueCanonicalSpreads, visibleMatrixSpreads } from "../app/lib/valuation-chart.ts";
import { estimateResearchSpread } from "../app/lib/research-valuation.ts";
import { historyRequests } from "../app/lib/history-requests.ts";
import { controlledResearchRole, materializeShortStrikeReference } from "../app/lib/short-strike/materialize.ts";

function close(actual: number | undefined, expected: number) {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-10, `${actual} should be close to ${expected}`);
}

test("valuation grid and special timestamps are strictly entry-to-expiry bounded",()=>{
  const entry=Date.UTC(2025,9,1,8),fourHours=4*3_600_000,unalignedExpiry=entry+9*3_600_000;
  assert.deepEqual(valuationTimestamps(entry,entry,[entry-fourHours,entry+fourHours]),[entry]);
  assert.deepEqual(valuationTimestamps(entry,unalignedExpiry,[entry-fourHours,entry+2*3_600_000,unalignedExpiry+fourHours]),[entry,entry+2*3_600_000,entry+fourHours,entry+2*fourHours,unalignedExpiry]);
  assert.ok(!valuationTimestamps(entry,entry+7*86_400_000,[entry+8*86_400_000]).includes(entry+8*86_400_000));
});

function valuationFixture(kind: "credit" | "debit", comboExecution = false) {
  const entry = Date.parse("2024-04-10T03:00:00Z");
  const expiry = Date.parse("2024-04-17T08:00:00Z");
  const soldName = "BTC-17APR24-60000-P";
  const boughtName = "BTC-17APR24-59000-P";
  const soldPrice = kind === "credit" ? 0.03 : 0.01;
  const boughtPrice = kind === "credit" ? 0.01 : 0.03;
  const rows = [
    { timestamp: entry, price: soldPrice, iv: 70, instrument_name: soldName, index_price: 60000, direction: "buy", amount: 2 },
    { timestamp: entry, price: soldPrice, iv: 70, instrument_name: soldName, index_price: 60000, direction: "sell", amount: 2 },
    { timestamp: entry, price: boughtPrice, iv: 65, instrument_name: boughtName, index_price: 60000, direction: "sell", amount: 2 },
    { timestamp: entry, price: boughtPrice, iv: 65, instrument_name: boughtName, index_price: 60000, direction: "buy", amount: 2 },
  ];
  const inventory = buildInventory(rows.map((row, index) => ({ name: `fixture-${index}`, trades: parseContractText(JSON.stringify(row)) })));
  const spread = {
    id: `fixture-${kind}`, targetDte: 7, targetWidth: 1000, anchorStrike: 60000, soldStrike: 60000, boughtStrike: 59000,
    optionType: "P" as const, spreadKind: kind, structure: `${kind} put spread`, buffered: false,
    expiryTimestamp: expiry, expiryLabel: "17APR24", actualDte: 7, actualWidth: 1000,
    soldContract: inventory.find(item => item.instrumentName === soldName), boughtContract: inventory.find(item => item.instrumentName === boughtName),
    soldExistedAtEntry: true, boughtExistedAtEntry: true, retrievalStatus: "ready" as const, retrievalNote: "fixture",
    priceIndex: "btc_usd", deliveryPrice: 50000, deliveryPriceDate: "2024-04-17", deliveryPriceSource: "deribit-get_delivery_prices" as const,
  };
  const event = { id: "event", label: "fixture", direction: "long" as const, entryDate: "2024-04-10", entryTimestamp: entry, entryPrice: 60000 };
  const candles = [
    { openTime: entry, closeTime: entry + 3_599_999, open: 60000, high: 60000, low: 60000, close: 60000, volume: 1 },
    { openTime: expiry, closeTime: expiry + 3_599_999, open: 50000, high: 50000, low: 50000, close: 50000, volume: 1 },
  ];
  return buildValuation(spread, event, candles, "maker", 2, comboExecution);
}

test("production adds an independent $1k buffer branch only inside the historical $100 boundary", () => {
  const spreads = generateDesiredSpreads({
    id: "event", label: "MR", direction: "long", entryDate: "2024-01-01", entryPrice: 60_000, extremePrice: 57_050,
  }, [7, 14, 30], [1000, 2000, 3000], "credit");
  assert.equal(spreads.length, 18);
  assert.deepEqual([...new Set(spreads.map(spread => spread.anchorStrike))], [57_000, 56_000]);
});

test("production $100 rule and research-only $500 rule are isolated for calls and puts",()=>{
  const event=(direction:"long"|"short",extremePrice:number)=>({id:"e",label:"MR",direction,entryDate:"2024-01-01",entryPrice:96_000,extremePrice});
  const production=(direction:"long"|"short",extremePrice:number)=>generateDesiredSpreads(event(direction,extremePrice),[7],[2_000],"credit");
  const research=(direction:"long"|"short",extremePrice:number)=>generateShortStrikeResearchSpreads(event(direction,extremePrice),[7],[2_000],"credit");
  assert.deepEqual(production("short",95_700).map(x=>x.anchorStrike),[96_000]);
  assert.deepEqual(production("long",95_300).map(x=>x.anchorStrike),[95_000]);
  assert.deepEqual(production("short",95_950).map(x=>x.anchorStrike),[96_000,97_000]);
  assert.deepEqual(production("long",95_050).map(x=>x.anchorStrike),[95_000,94_000]);
  assert.deepEqual(research("short",95_501).map(x=>x.anchorStrike),[96_000,97_000]);
  assert.deepEqual(research("short",95_500).map(x=>x.anchorStrike),[96_000]);
  assert.deepEqual(research("long",95_499).map(x=>x.anchorStrike),[95_000,94_000]);
  assert.deepEqual(research("long",95_500).map(x=>x.anchorStrike),[95_000]);
  for(const rows of [research("short",95_700),research("long",95_300)])assert.ok(rows.every(x=>Math.abs(x.soldStrike-x.boughtStrike)===2_000));
});

test("controlled materialization resolves the $100-$499 cohort without entering production requests",()=>{
 const entry=Date.parse("2026-08-16T00:00:00Z"),expiry=entry+7*86_400_000,windows={7:{min:6,max:8}};
 for(const [direction,extreme,entryPrice,type] of [["short",95_700,95_000,"C"],["long",95_300,96_000,"P"]] as const){
  const event={id:`${direction}-event`,label:"MR",direction,entryDate:"2026-08-16",entryTimestamp:entry,entryPrice,extremePrice:extreme};
  const production=generateDesiredSpreads(event,[7],[2_000],"credit"),research=generateShortStrikeResearchSpreads(event,[7],[2_000],"credit");
  const productionRequests=historyRequests(production,windows),researchRequests=historyRequests(research,windows),buffered=research.find(x=>x.buffered)!;
  assert.equal(production.some(x=>x.buffered),false);assert.equal(productionRequests.some(x=>x.requestId===buffered.id),false);assert.equal(researchRequests.some(x=>x.requestId===buffered.id),true);
  const manifests=research.map(desired=>({requestId:desired.id,targetDte:7,minDte:6,maxDte:8,desiredSoldStrike:desired.soldStrike,desiredBoughtStrike:desired.boughtStrike,expiryTimestamp:expiry,expiryLabel:"23AUG26",actualDte:7,soldInstrumentName:`BTC-23AUG26-${desired.soldStrike}-${type}`,boughtInstrumentName:`BTC-23AUG26-${desired.boughtStrike}-${type}`,soldStrike:desired.soldStrike,boughtStrike:desired.boughtStrike,soldCreationTimestamp:entry-86_400_000,boughtCreationTimestamp:entry-86_400_000,strikeResolutionSensible:true,strikeResolutionNote:"exact"}));
  const strikes=[...new Set(research.flatMap(desired=>[desired.soldStrike,desired.boughtStrike]))],inventory=buildInventory(strikes.flatMap((strike,i)=>(["C","P"] as const).map((optionType,j)=>({name:`${direction}-${i}-${j}`,trades:parseContractText(JSON.stringify({timestamp:entry-60_000-j,price:.02+(optionType==="C"?Math.max(entryPrice-strike,0):Math.max(strike-entryPrice,0))/entryPrice,iv:60,instrument_name:`BTC-23AUG26-${strike}-${optionType}`,index_price:entryPrice,direction:j?"sell":"buy",amount:2,trade_id:`${direction}-${i}-${j}`}))})))).map(series=>({...series,creationTimestamp:entry-86_400_000}));
  const candles=[{openTime:entry-3_600_000,closeTime:entry-1,open:entryPrice,high:entryPrice,low:entryPrice,close:entryPrice,volume:1},{openTime:expiry,closeTime:expiry+3_599_999,open:entryPrice,high:entryPrice,low:entryPrice,close:entryPrice,volume:1}];
  const controlled=materializeShortStrikeReference({event,dtes:[7],widths:[2_000],spreadKind:"credit",manifests,inventory,entryTimestamp:entry,candles,amount:1,executionMode:"maker",expirySelectionMode:"all-eligible",pricingAssumption:"research-estimate"});
  assert.equal(controlled.length,2);assert.deepEqual(controlled.map(x=>controlledResearchRole(x.spread)).sort(),["short_strike_buffered","short_strike_technical"]);assert.ok(controlled.some(x=>x.spread.buffered&&x.spread.anchorStrike===buffered.anchorStrike));assert.ok(controlled.every(x=>x.spread.actualWidth===2_000));assert.ok(controlled.every(x=>x.spread.soldContract&&x.spread.boughtContract&&x.spread.retrievalStatus==="ready"));assert.ok(controlled.every(x=>x.researchEntry.status==="priced"||x.researchEntry.reason.length>0),"Reference is calculated or explicitly unavailable; it is never fabricated");
 }
});

test("runtime keeps production observation and controlled Reference seams separate",()=>{
 const source=readFileSync(new URL("../app/options-backtester.tsx",import.meta.url),"utf8");
 assert.match(source,/requests: productionHistoryRequests/);
 assert.match(source,/requests:researchHistoryRequests/);
 assert.match(source,/materializeShortStrikeReference\(/);
 assert.match(source,/buildAndRunObservationRequests\(\s*selectedEvent,\s*canonicalRetrievedSpreads,/);
 assert.doesNotMatch(source,/canonicalRetrievedSpreads\.flatMap\(candidate=>buildAndRunObservationRequests/);
 assert.match(source,/setResearchMaterializations\(controlledAttempt\.controlled\)/);
 assert.match(source,/executionScenarios:\{maker:notEvaluated,taker:notEvaluated\}/);
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

  const incomplete = buildExpiryCandidates([desired], [{ ...manifests[0], dataStatus: "data-unavailable" as const, failedInstruments: [manifests[0].boughtInstrumentName!] }, manifests[1]], entry, 63700, inventory, "maker", "liquidity-aware");
  const unavailable = incomplete.find(candidate => candidate.dataStatus === "data-unavailable")!;
  assert.equal(unavailable.selectedForTest, false);
  assert.equal(unavailable.expiryRank, undefined);
  assert.equal(unavailable.entryLiquidityQuality, undefined, "retrieval failure is not counted as Red liquidity");
  assert.equal(incomplete.find(candidate => candidate.dataStatus === "available")?.candidateStatus, "recommended");
});

test("all-Red bounded candidates remain Research-eligible and rank by evidence before DTE", () => {
  const entry = Date.parse("2026-08-15T00:00:00Z");
  const desired = { id:"bear", targetDte:14, targetWidth:3000, anchorStrike:127000, soldStrike:127000, boughtStrike:130000, optionType:"C" as const, spreadKind:"credit" as const, structure:"127000/130000 C", buffered:false };
  const make = (suffix:string, expiry:number, soldGap:number, boughtGap:number) => {
    const names = [`BTC-${suffix}-127000-C`, `BTC-${suffix}-130000-C`];
    const rows = [
      { timestamp:entry+soldGap*60_000, price:.04, iv:70, instrument_name:names[0], index_price:120000, direction:"sell", amount:1 },
      { timestamp:entry+boughtGap*60_000, price:.02, iv:72, instrument_name:names[1], index_price:120100, direction:"buy", amount:1 },
    ];
    return { inventory:buildInventory(rows.map((row,index)=>({name:`${suffix}-${index}`,trades:parseContractText(JSON.stringify(row))}))), manifest:{requestId:desired.id,targetDte:14,minDte:10,maxDte:20,desiredSoldStrike:127000,desiredBoughtStrike:130000,expiryTimestamp:expiry,expiryLabel:suffix,actualDte:(expiry-entry)/86_400_000,soldInstrumentName:names[0],boughtInstrumentName:names[1],soldStrike:127000,boughtStrike:130000,strikeResolutionSensible:true,strikeResolutionNote:"exact"} };
  };
  const close = make("29AUG26", entry+14*86_400_000, 600, 376); // 224-minute synchronization gap
  const farther = make("30AUG26", entry+15*86_400_000, 650, 400);
  const candidates = buildExpiryCandidates([desired],[close.manifest,farther.manifest],entry,120000,[...close.inventory,...farther.inventory],"taker","liquidity-aware","research-estimate");
  assert.equal(candidates.filter(candidate=>candidate.selectedForTest).length,2);
  assert.equal(candidates[0].entryLiquidityQuality,"red");
  assert.equal(candidates[0].entryLiquidity?.viable,true);
  assert.equal(candidates[0].candidateStatus,"recommended");
  assert.equal(candidates[0].expirySelectionReason,"Selected as a low-confidence bounded Research estimate.");
  assert.deepEqual([candidates[0].soldContract?.strike,candidates[0].boughtContract?.strike],[127000,130000]);
  assert.deepEqual([candidates[0].soldListingStatus,candidates[0].boughtListingStatus],["listing-plausible","listing-plausible"],"no pre-entry print is not non-listing");
  const estimate=estimateResearchSpread({spread:candidates[0],targetTimestamp:entry,targetIndex:120000,amount:1,slippageBps:0});
  assert.equal(estimate.status,"unavailable","future, 224-minute-separated IV evidence cannot create a priced Research point");
  const conservative = buildExpiryCandidates([desired],[close.manifest],entry,120000,close.inventory,"taker","liquidity-aware","conservative-tape-check")[0];
  assert.equal(conservative.entryLiquidity?.viable,false,"strict causal tape may fail without invalidating Research");
});

test("authoritative post-entry creation metadata proves non-listing even with bounded trades", () => {
  const entry=100_000, expiry=entry+7*86_400_000;
  const desired={id:"post",targetDte:7,targetWidth:1000,anchorStrike:50000,soldStrike:50000,boughtStrike:51000,optionType:"C" as const,spreadKind:"credit" as const,structure:"bear call",buffered:false};
  const rows=[["BTC-X-50000-C",50000,"sell"],["BTC-X-51000-C",51000,"buy"]] as const;
  const inventory=buildInventory(rows.map(([instrument_name,,direction],index)=>({name:String(index),trades:parseContractText(JSON.stringify({timestamp:entry+1000,price:.01,iv:60,instrument_name,index_price:50000,direction,amount:1}))})));
  const manifest={requestId:desired.id,targetDte:7,minDte:5,maxDte:10,desiredSoldStrike:50000,desiredBoughtStrike:51000,expiryTimestamp:expiry,expiryLabel:"X",actualDte:7,soldInstrumentName:rows[0][0],boughtInstrumentName:rows[1][0],soldStrike:50000,boughtStrike:51000,soldCreationTimestamp:entry+1,boughtCreationTimestamp:entry+1,strikeResolutionSensible:true,strikeResolutionNote:"exact"};
  const [candidate]=buildExpiryCandidates([desired],[manifest],entry,50000,inventory,"taker","liquidity-aware","research-estimate");
  assert.equal(candidate.entryLiquidity?.viable,false);
  assert.equal(candidate.soldListingStatus,"not-listed");
});

test("uses inverse BTC intrinsic settlement", () => {
  assert.equal(intrinsicPriceBtc("C", 60_000, 55_000), 5_000 / 60_000);
  assert.equal(intrinsicPriceBtc("P", 50_000, 55_000), 5_000 / 50_000);
});

test("maps all maker/taker entry and close actions to Deribit taker direction", () => {
  const timestamp = Date.parse("2024-04-10T03:00:00Z");
  const series = buildInventory(["buy", "sell"].map((direction, index) => ({ name: `direction-${index}`, trades: parseContractText(JSON.stringify({ timestamp, price: 0.01, iv: 60, instrument_name: "BTC-17APR24-60000-P", index_price: 60000, direction, amount: 1 })) })))[0];
  const cases = [
    ["maker", "entry", "sell", "buy"], ["maker", "entry", "buy", "sell"],
    ["taker", "entry", "sell", "sell"], ["taker", "entry", "buy", "buy"],
    ["maker", "close", "buy", "sell"], ["maker", "close", "sell", "buy"],
    ["taker", "close", "buy", "buy"], ["taker", "close", "sell", "sell"],
  ] as const;
  for (const [mode, purpose, action, expected] of cases) {
    const result = normalizeLeg(series, timestamp, 60000, action, mode, 30, purpose);
    assert.equal(result.schemaDirection, expected, `${mode} ${purpose} ${action}`);
    assert.equal(result.nearestTrade?.direction, expected);
  }
});

test("entry and causal close select opposite prints and never select a future print", () => {
  const timestamp = Date.parse("2024-04-10T03:00:00Z");
  const series = buildInventory([{ name: "directions", trades: parseContractText([
    { timestamp: timestamp - 1, price: 0.03, iv: 70, instrument_name: "BTC-17APR24-60000-P", index_price: 60000, direction: "buy", amount: 1 },
    { timestamp: timestamp - 2, price: 0.04, iv: 70, instrument_name: "BTC-17APR24-60000-P", index_price: 60000, direction: "sell", amount: 1 },
    { timestamp: timestamp + 1, price: 0.99, iv: 70, instrument_name: "BTC-17APR24-60000-P", index_price: 60000, direction: "sell", amount: 100 },
  ].map(row => JSON.stringify(row)).join("\n")) }])[0];
  const entry = normalizeLeg(series, timestamp, 60000, "sell", "maker", 30, "entry");
  const close = normalizeLeg(series, timestamp, 60000, "buy", "maker", 30, "close");
  assert.equal(entry.schemaDirection, "buy");
  assert.equal(close.schemaDirection, "sell");
  assert.equal(close.vwapPriceBtc, 0.04, "regression: the old implementation selected the opening-side buy print, and a symmetric window could include 0.99");
  assert.equal(close.latestEvidenceTimestamp, timestamp - 2);
  assert.equal(close.windowEnd, timestamp);
});

test("underlying lookup selects only the latest completed candle", () => {
  const at = Date.parse("2024-04-10T08:30:00Z");
  const completed = { openTime: at - 5_400_000, closeTime: at - 1_800_000, open: 1, high: 2, low: 1, close: 2, volume: 1 };
  const containing = { openTime: at - 1_800_000 + 1, closeTime: at + 1_800_000, open: 2, high: 99, low: 2, close: 99, volume: 1 };
  const future = { ...containing, openTime: at + 3_600_000, closeTime: at + 7_200_000, close: 999 };
  assert.equal(latestCompletedCandleAtOrBefore([future, containing, completed], at), completed);
  assert.equal(latestCompletedCandleAtOrBefore([containing, future], at), undefined);
  assert.equal(latestCompletedCandleAtOrBefore([{ ...completed, closeTime: at }], at)?.closeTime, at);
});

test("ordinary 08:00 valuation uses the previous close while expiry uses official delivery price", () => {
  const entry = Date.parse("2024-04-16T04:00:00Z");
  const valuation = Date.parse("2024-04-16T08:00:00Z");
  const expiry = Date.parse("2024-04-17T08:00:00Z");
  const names = ["BTC-17APR24-60000-P", "BTC-17APR24-59000-P"];
  const rows = [
    { timestamp: entry, price: .03, iv: 70, instrument_name: names[0], index_price: 60_000, direction: "buy", amount: 1 },
    { timestamp: entry, price: .01, iv: 65, instrument_name: names[1], index_price: 60_000, direction: "sell", amount: 1 },
    { timestamp: valuation, price: .02, iv: 60, instrument_name: names[0], index_price: 61_000, direction: "sell", amount: 1 },
    { timestamp: valuation, price: .005, iv: 58, instrument_name: names[1], index_price: 61_000, direction: "buy", amount: 1 },
  ];
  const inventory = buildInventory(rows.map((row, i) => ({ name: String(i), trades: parseContractText(JSON.stringify(row)) })));
  const spread = { id: "causal-index", targetDte: 1, targetWidth: 1000, anchorStrike: 60000, soldStrike: 60000, boughtStrike: 59000, optionType: "P", spreadKind: "credit", structure: "credit", buffered: false, expiryTimestamp: expiry, expiryLabel: "17APR24", soldContract: inventory.find(x => x.instrumentName === names[0]), boughtContract: inventory.find(x => x.instrumentName === names[1]), soldExistedAtEntry: true, boughtExistedAtEntry: true, retrievalStatus: "ready", retrievalNote: "fixture", priceIndex: "btc_usd", deliveryPrice: 50_000, deliveryPriceDate: "2024-04-17", deliveryPriceSource: "deribit-get_delivery_prices" } as const;
  const candles = [
    { openTime: valuation - 3_600_000, closeTime: valuation - 1, open: 60_000, high: 61_000, low: 59_000, close: 61_000, volume: 1 },
    { openTime: valuation, closeTime: valuation + 3_599_999, open: 61_000, high: 100_000, low: 1, close: 99_000, volume: 1 },
    { openTime: expiry, closeTime: expiry + 3_599_999, open: 70_000, high: 100_000, low: 1, close: 88_000, volume: 1 },
  ];
  const event = { id: "e", label: "e", direction: "long" as const, entryDate: "2024-04-16", entryTimestamp: entry, entryPrice: 60_000 };
  const run = buildValuation(spread, event, candles, "maker", 1, false, [valuation]);
  const ordinary = run.path.find(point => point.timestamp === valuation)!;
  assert.equal(ordinary.btcIndex, 61_000);
  assert.equal(ordinary.btcIndexSource, "completed-candle");
  assert.equal(ordinary.btcIndexTimestamp, valuation - 1);
  assert.ok(ordinary.btcIndexTimestamp! <= ordinary.timestamp && ordinary.btcIndexSourceCandleCloseTime! <= ordinary.timestamp);
  assert.notEqual(ordinary.rawPnlUsd, undefined);
  assert.notEqual(ordinary.ivPnlBtc, undefined);
  const futureOnly = buildValuation(spread, event, [candles[1], candles[2]], "maker", 1, false, [valuation]);
  const unavailableOrdinary = futureOnly.path.find(point => point.timestamp === valuation)!;
  assert.equal(unavailableOrdinary.btcIndexSource, "unavailable");
  assert.equal(unavailableOrdinary.btcIndex, undefined, "event entry price is not reused after entry");
  assert.equal(unavailableOrdinary.rawPnlUsd, undefined);
  assert.equal(unavailableOrdinary.ivPnlBtc, undefined);
  const settlement = run.path.at(-1)!;
  assert.equal(settlement.btcIndex, 50_000);
  assert.equal(settlement.btcIndexSource, "deribit-delivery-price");
  assert.equal(settlement.valuationSource, "settlement");
  assert.notEqual(settlement.btcIndex, candles[2].close);
  const exported = JSON.parse(JSON.stringify(run));
  const exportedOrdinary = exported.path.find((point: ValuationPoint) => point.timestamp === valuation);
  assert.ok(exportedOrdinary.btcIndexTimestamp <= exportedOrdinary.timestamp);
  assert.ok(exportedOrdinary.btcIndexSourceCandleCloseTime <= exportedOrdinary.timestamp);
  const missing = buildValuation({ ...spread, deliveryPrice: undefined }, event, candles, "maker", 1, false, [valuation]);
  assert.equal(missing.path.at(-1)?.valuationSource, "settlement-data-unavailable");
  assert.equal(missing.path.at(-1)?.rawPnlBtc, undefined);
});

test("opening-side-only evidence leaves causal close PnL unavailable", () => {
  const entry = Date.parse("2024-04-10T03:00:00Z");
  const expiry = entry + 5 * 86_400_000;
  const names = ["BTC-15APR24-60000-P", "BTC-15APR24-59000-P"];
  const rows = [
    { timestamp: entry, price: 0.03, iv: 70, instrument_name: names[0], index_price: 60000, direction: "buy", amount: 1 },
    { timestamp: entry, price: 0.01, iv: 65, instrument_name: names[1], index_price: 60000, direction: "sell", amount: 1 },
  ];
  const inventory = buildInventory(rows.map((row, index) => ({ name: `opening-${index}`, trades: parseContractText(JSON.stringify(row)) })));
  const spread = { id: "opening-only", targetDte: 5, targetWidth: 1000, anchorStrike: 60000, soldStrike: 60000, boughtStrike: 59000, optionType: "P", spreadKind: "credit", structure: "credit", buffered: false, expiryTimestamp: expiry, expiryLabel: "15APR24", soldContract: inventory.find(item => item.instrumentName === names[0]), boughtContract: inventory.find(item => item.instrumentName === names[1]), soldExistedAtEntry: true, boughtExistedAtEntry: true, retrievalStatus: "ready", retrievalNote: "fixture" } as const;
  const run = buildValuation(spread, { id: "e", label: "e", direction: "long", entryDate: "2024-04-10", entryTimestamp: entry, entryPrice: 60000 }, [], "maker", 1, false);
  assert.equal(run.path[0].valuationSource, "unavailable");
  assert.equal(run.path[0].rawPnlBtc, undefined);
  assert.equal(run.path[0].usedDirectionFallback, true);
});

test("chart geometry uses timestamps, cursor lookup, and hit-only grouped exit markers", () => {
  const path = [{ timestamp: 0 }, { timestamp: 10 }, { timestamp: 100 }] as ReturnType<typeof valuationFixture>["path"];
  const { plotLeft, plotRight } = CHART_GEOMETRY;
  assert.equal(timeX(0, 0, 100, plotLeft, plotRight), plotLeft);
  assert.equal(timeX(50, 0, 100, plotLeft, plotRight), (plotLeft + plotRight) / 2);
  assert.equal(timeX(100, 0, 100, plotLeft, plotRight), plotRight);
  assert.equal(timestampAtX(plotLeft, 0, 100, plotLeft, plotRight), 0);
  assert.equal(timestampAtX((plotLeft + plotRight) / 2, 0, 100, plotLeft, plotRight), 50);
  assert.equal(timestampAtX(plotRight, 0, 100, plotLeft, plotRight), 100);
  assert.ok((plotRight - plotLeft) / CHART_GEOMETRY.width > .85, "plot occupies at least 85% of chart width");
  assert.equal(nearestPoint(path, 70).timestamp, 100);
  assert.deepEqual(hitExitGroups([
    { rule: "VPOC hit", timestamp: 10, status: "hit", qualityReason: "hit" },
    { rule: "50% credit", timestamp: 10, status: "hit", qualityReason: "hit" },
    { rule: "4H invalidation", status: "not-hit", qualityReason: "not hit" },
    { rule: "Expiry", status: "unavailable", qualityReason: "missing" },
  ]), [{ timestamp: 10, labels: ["VPOC hit", "50% credit"] }]);
});

test("matrix display filter hides only actual Red entry liquidity", () => {
  const spreads = [
    { id: "red", entryLiquidityQuality: "red", dataStatus: "available" },
    { id: "yellow", entryLiquidityQuality: "yellow", dataStatus: "available" },
    { id: "green", entryLiquidityQuality: "green", dataStatus: "available" },
    { id: "unavailable", entryLiquidityQuality: undefined, dataStatus: "data-unavailable" },
  ] as Parameters<typeof visibleMatrixSpreads>[0];
  assert.equal(visibleMatrixSpreads(spreads, false), spreads, "off preserves the original collection exactly");
  assert.deepEqual(visibleMatrixSpreads(spreads, true).map(spread => spread.id), ["yellow", "green", "unavailable"]);
  assert.deepEqual(visibleMatrixSpreads([spreads[0]], true), []);
  assert.deepEqual(visibleMatrixSpreads(spreads,false,true).map(spread=>spread.id),["red","yellow","green"]);
  assert.deepEqual(visibleMatrixSpreads(spreads,true,true).map(spread=>spread.id),["yellow","green"]);
});

test("matrix toggle defaults off and disclosure buttons retain accessible relationships", () => {
  const page = readFileSync(new URL("../app/options-backtester.tsx", import.meta.url), "utf8");
  assert.match(page, /const \[hideRed, setHideRed\] = useState\(false\)/);
  assert.match(page, /className="matrix-filter"/);
  assert.match(page, /checked=\{hideRed\}/);
  assert.match(page, />Hide red<\/label>/);
  assert.match(page, />Hide data-unavailable<\/label>/);
  assert.match(page, /className="expand-button" aria-expanded=\{expanded\} aria-controls=/);
  assert.match(page, /aria-label=\{`\$\{expanded \? "Collapse" : "Expand"\} evidence/);
  assert.match(page, /className="expand-chevron" aria-hidden="true"/);
  assert.doesNotMatch(page, /⌄/);
  assert.doesNotMatch(page, /ResultTrack|Viewing track|track-selector/, "candidate evidence is not controlled by global track state");
  assert.match(page, /Immediate Maker opportunity/);
  assert.match(page, /Empirical conservative taker · Q90/);
  assert.match(page, /Show data-unavailable/);
  assert.match(page, /Economically valued structures/);
  assert.match(page, /<th>Status<\/th>/);
  assert.doesNotMatch(page, /<th>Exact contracts<\/th>/);
  assert.doesNotMatch(page, /<summary>Evidence<\/summary>/);
  for (const heading of ["Structure", "Reference valuation", "Delayed execution", "Modeled execution"]) assert.match(page, new RegExp(`<h4>${heading}</h4>`));
  assert.match(page, /executionBlock\("Immediate maker",maker,true\)/);
  assert.match(page, /executionBlock\("Immediate taker",taker\)/);
});

test("chart modes keep USD PnL and BTC contract series separate", () => {
  assert.equal(CHART_SERIES.diagnosticIvUnrealizedPnlUsd.metric, "pnl");
  assert.equal(CHART_SERIES.diagnosticRawUnrealizedPnlUsd.metric, "pnl");
  for (const key of ["rawSoldLegPrice", "rawBoughtLegPrice", "rawSpreadValue", "ivSoldLegPrice", "ivBoughtLegPrice", "ivSpreadValue"] as const) assert.equal(CHART_SERIES[key].metric, "values");
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

test("valuation retains exact leg prices, evidence diagnostics, and Settlement status", () => {
  const run = valuationFixture("credit");
  assert.equal(run.path[0].rawSoldLegPrice, 0.03);
  assert.equal(run.path[0].rawBoughtLegPrice, 0.01);
  assert.equal(typeof run.path[0].usedDirectionFallback, "boolean");
  assert.equal(typeof run.path[0].usedModelFallback, "boolean");
  const settlement = run.path.at(-1)!;
  assert.equal(settlement.qualityFlag, "settlement");
  assert.equal(settlement.valuationSource, "settlement");
  assert.equal(settlement.rawSoldLegPrice, 0.2);
  assert.equal(settlement.rawBoughtLegPrice, 0.18);
  assert.equal(settlement.ivSoldLegPrice, settlement.rawSoldLegPrice);
  assert.match(settlement.qualityReason, /intrinsic settlement/i);
});

test("missing valuation data remains explicit rather than reconstructed", () => {
  const missing: ValuationPoint = { timestamp: 1, btcIndex: 60_000, qualityFlag: "red", valuationSource: "unavailable", qualityReason: "Both legs could not be priced at this timestamp.", usedDirectionFallback: false, usedModelFallback: false };
  assert.equal(missing.rawSoldLegPrice, undefined);
  assert.equal(missing.ivSpreadValue, undefined);
  assert.match(missing.qualityReason, /could not be priced/i);
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

function causalPoint(timestamp: number, overrides: Partial<ValuationPoint> = {}): ValuationPoint {
  return {
    timestamp, btcIndex: 60_000, btcIndexSource: "completed-candle", btcIndexTimestamp: timestamp,
    btcIndexSourceCandleOpenTime: timestamp - 60_000, btcIndexSourceCandleCloseTime: timestamp, btcIndexAgeMs: 0,
    btcIndexAvailabilityReason: "causal test evidence", rawPnlBtc: 0.01, ivPnlBtc: 0.01, rawPnlUsd: 600, ivPnlUsd: 600,
    rawCreditCapturedPct: 0.8, ivCreditCapturedPct: 0.8, qualityFlag: "green", valuationSource: "trade-window",
    qualityReason: "causal", usedDirectionFallback: false, usedModelFallback: false, valuationPurpose: "close",
    soldRequiredAction: "buy", boughtRequiredAction: "sell", soldCompatibleDirection: "sell", boughtCompatibleDirection: "buy",
    executionMode: "maker", evidenceWindowStart: timestamp - 60_000, evidenceWindowEnd: timestamp, newestSupportingPrintTimestamp: timestamp,
    rawExitFeesBtc: 0.0006, ivExitFeesBtc: 0.0006, ...overrides,
  };
}

test("future or unavailable underlying evidence cannot trigger credit capture", () => {
  const entry = 1_000_000;
  const expiry = entry + 86_400_000;
  const futureIndex = causalPoint(entry + 4_000, { btcIndexTimestamp: entry + 5_000, btcIndexSourceCandleCloseTime: entry + 5_000 });
  const unavailableIndex = causalPoint(entry + 8_000, { btcIndex: undefined, btcIndexSource: "unavailable", btcIndexTimestamp: undefined, btcIndexSourceCandleCloseTime: undefined });
  const settlement = causalPoint(expiry, { valuationPurpose: "settlement", valuationSource: "settlement", qualityFlag: "settlement", btcIndexSource: "deribit-delivery-price" });
  const exits = evaluateExits([futureIndex, unavailableIndex, settlement], { spreadKind: "credit", expiryTimestamp: expiry } as Parameters<typeof evaluateExits>[1], { entryTimestamp: entry } as Parameters<typeof evaluateExits>[2], []);
  assert.equal(exits.find(exit => exit.rule === "50% credit")?.status, "not-hit");
  assert.equal(exits.find(exit => exit.rule === "70% credit")?.status, "not-hit");
});

test("future-supported and unavailable close values cannot trigger credit capture", () => {
  const entry = 1_000_000;
  const expiry = entry + 5 * 86_400_000;
  const spread = { spreadKind: "credit", expiryTimestamp: expiry } as Parameters<typeof evaluateExits>[1];
  const futureSupported = causalPoint(entry + 4 * 3_600_000, { newestSupportingPrintTimestamp: entry + 5 * 3_600_000 });
  const unavailable = causalPoint(entry + 8 * 3_600_000, { rawPnlBtc: undefined, ivPnlBtc: undefined, rawCreditCapturedPct: undefined, ivCreditCapturedPct: undefined, valuationSource: "unavailable", qualityFlag: "red" });
  const settlement = causalPoint(expiry, { valuationPurpose: "settlement", valuationSource: "settlement", qualityFlag: "settlement", newestSupportingPrintTimestamp: undefined });
  const exits = evaluateExits([futureSupported, unavailable, settlement], spread, { entryTimestamp: entry } as Parameters<typeof evaluateExits>[2], []);
  assert.equal(exits.find(exit => exit.rule === "50% credit")?.status, "not-hit");
  assert.equal(exits.find(exit => exit.rule === "70% credit")?.status, "not-hit");
  assert.equal(exits.find(exit => exit.rule === "Expiry")?.qualityFlag, "settlement");
  assert.equal(exits.find(exit => exit.rule === "Expiry")?.valuationSource, "settlement");
});

test("VPOC and invalidation valuation never precede completed candle decisions", () => {
  const entry = 1_000_000;
  const hour = 3_600_000;
  const candles = Array.from({ length: 4 }, (_, index) => ({ openTime: entry + index * hour, closeTime: entry + (index + 1) * hour - 1, open: 100, high: index === 0 ? 110 : 100, low: 90, close: index === 3 ? 80 : 100, volume: 1 }));
  const path = [causalPoint(entry), causalPoint(candles[0].closeTime + 1), causalPoint(candles[3].closeTime + 1), causalPoint(entry + 5 * 86_400_000, { valuationPurpose: "settlement", valuationSource: "settlement", qualityFlag: "settlement" })];
  const exits = evaluateExits(path, { spreadKind: "credit", expiryTimestamp: entry + 5 * 86_400_000 } as Parameters<typeof evaluateExits>[1], { entryTimestamp: entry, vpocPrice: 105, invalidationPrice: 90, direction: "long" } as Parameters<typeof evaluateExits>[2], candles);
  const vpoc = exits.find(exit => exit.rule === "VPOC hit")!;
  const invalidation = exits.find(exit => exit.rule === "4H invalidation")!;
  assert.equal(vpoc.decisionAvailableTimestamp, candles[0].closeTime);
  assert.ok(vpoc.valuationTimestamp! >= vpoc.decisionAvailableTimestamp!);
  assert.equal(invalidation.decisionAvailableTimestamp, candles[3].closeTime);
  assert.ok(invalidation.valuationTimestamp! >= invalidation.decisionAvailableTimestamp!);
  const vpocPoint = path.find(point => point.timestamp === vpoc.valuationTimestamp)!;
  const invalidationPoint = path.find(point => point.timestamp === invalidation.valuationTimestamp)!;
  assert.ok(vpocPoint.btcIndexTimestamp! <= vpoc.valuationTimestamp! && vpocPoint.btcIndexSourceCandleCloseTime! <= vpoc.valuationTimestamp!);
  assert.ok(invalidationPoint.btcIndexTimestamp! <= invalidation.valuationTimestamp! && invalidationPoint.btcIndexSourceCandleCloseTime! <= invalidation.valuationTimestamp!);
  assert.notEqual(vpoc.triggerTimestamp, vpoc.valuationTimestamp, "exported timing retains trigger separately from valuation");
  const exported = JSON.parse(JSON.stringify({ exits }));
  assert.equal(exported.exits[0].triggerTimestamp, candles[0].closeTime);
  assert.equal(exported.exits[0].valuationTimestamp, candles[0].closeTime + 1);
});

test("fixed exits after expiry are unavailable", () => {
  const entry = 1_000_000;
  const expiry = entry + 4 * 86_400_000;
  const exits = evaluateExits([causalPoint(entry), causalPoint(expiry, { valuationPurpose: "settlement", valuationSource: "settlement", qualityFlag: "settlement" })], { spreadKind: "credit", expiryTimestamp: expiry } as Parameters<typeof evaluateExits>[1], { entryTimestamp: entry } as Parameters<typeof evaluateExits>[2], []);
  assert.equal(exits.find(exit => exit.rule === "5D fixed")?.reasonCode, "after-expiry");
  assert.equal(exits.find(exit => exit.rule === "14D fixed")?.status, "unavailable");
});

test("fixed-time valuation retains causal completed-candle index evidence", () => {
  const entry = 1_000_000;
  const target = entry + 3 * 86_400_000;
  const expiry = entry + 5 * 86_400_000;
  const point = causalPoint(target + 1, { btcIndexTimestamp: target, btcIndexSourceCandleCloseTime: target });
  const settlement = causalPoint(expiry, { valuationPurpose: "settlement", valuationSource: "settlement", qualityFlag: "settlement", btcIndexSource: "deribit-delivery-price" });
  const exit = evaluateExits([point, settlement], { spreadKind: "credit", expiryTimestamp: expiry } as Parameters<typeof evaluateExits>[1], { entryTimestamp: entry } as Parameters<typeof evaluateExits>[2], []).find(result => result.rule === "3D fixed")!;
  assert.equal(exit.valuationTimestamp, target + 1);
  assert.ok(point.btcIndexTimestamp! <= exit.valuationTimestamp! && point.btcIndexSourceCandleCloseTime! <= exit.valuationTimestamp!);
});


test("generation attempts collapse only at canonical evaluation/rendering boundary",()=>{
 // Deliberately minimal identity-only objects exercise this boundary helper.
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const attempts=[{id:"same",targetWidth:1000},{id:"same",targetWidth:2000},{id:"other",targetWidth:3000}] as any;
 const canonical=uniqueCanonicalSpreads(attempts);assert.deepEqual(canonical.map(x=>x.id),["same","other"]);assert.equal(attempts.length,3,"availability input retains every requested attempt");assert.equal(canonical[0],attempts[0],"collapse is deterministic and does not synthesize economics");
});
