import test from "node:test";import assert from "node:assert/strict";
import type {ResearchSelectionStore} from "../app/lib/research-selections.ts";
import {buildResearchBundle,validateResearchBundle} from "../app/lib/research-bundle.ts";
import {resolveEventTiming} from "../app/lib/event-timing.ts";
import {FUTURES_FEE_MODEL_VERSION,FUTURES_FUNDING_MODEL_VERSION,FUTURES_SLIPPAGE_MODEL_VERSION,buildEventFuturesBaseline} from "../app/lib/futures-baseline.ts";
import {BARS,ENTRY,HOUR,VPOC_DECISION,VPOC_TRIGGER,barOpen,futuresEvent,futuresMarket,underlyingPath} from "./fixtures/futures-market.ts";
import {config,now,store} from "./fixtures/research-selection-store.ts";

const bundleOf=(events:ResearchSelectionStore["events"])=>buildResearchBundle({schemaVersion:"1.8.0",datasetId:"futures",updatedAtUtc:now,events},now);
const rows=(text:string)=>text.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);
const withGeneration=(event:ReturnType<typeof futuresEvent>)=>({...event,generationSnapshot:{...event.generationSnapshot,configuration:config,candidates:[]},selectedStructures:[]});

test("exactly one canonical futures baseline exists per event, never one per structure",()=>{
 const multi=futuresEvent("long");
 multi.selectedStructures=[{candidateId:"a",marginSnapshot:{maximumStructuralLossUsd:500}},{candidateId:"b",marginSnapshot:{maximumStructuralLossUsd:900}}] as never;
 const bundle=bundleOf([withGeneration(multi),withGeneration(futuresEvent("short",{eventId:"mr-2"}))] as never);
 const comparisons=rows(bundle.files["futures_comparisons.jsonl"]);
 assert.equal(comparisons.length,2,"one row per event");
 assert.deepEqual(comparisons.map(row=>row.event_id).sort(),["mr-1","mr-2"]);
 assert.equal(new Set(comparisons.map(row=>row.comparison_id)).size,2);
 // The derived equal-risk quantity names the structure it was scaled against and
 // never multiplies the baseline into one row per option structure.
 const direct=buildEventFuturesBaseline(multi);
 assert.equal(direct.comparison.quantity_basis,"b");
 assert.equal(direct.comparison.risk_budget_usd,900);
});

test("long and short produce opposite per-unit PnL from the same tape",()=>{
 const long=buildEventFuturesBaseline(futuresEvent("long")).comparison;
 const short=buildEventFuturesBaseline(futuresEvent("short")).comparison;
 assert.equal(long.reference_entry_price,barOpen(0));
 assert.equal(long.exit_price,barOpen(7));
 assert.equal(long.gross_pnl_usd_per_unit,7);
 assert.equal(short.gross_pnl_usd_per_unit,-7);
 assert.equal(long.gross_pnl_usd_per_unit as number,-(short.gross_pnl_usd_per_unit as number));
});

test("entry is causal: never before the decision, and latency is honoured",()=>{
 const immediate=buildEventFuturesBaseline(futuresEvent("long")).comparison;
 assert.equal(immediate.order_available_timestamp_utc,new Date(ENTRY).toISOString());
 assert.equal(immediate.reference_entry_timestamp_utc,new Date(ENTRY).toISOString());
 assert.equal(immediate.entry_lag_ms,0);
 assert.ok(Date.parse(String(immediate.reference_entry_timestamp_utc))>=Date.parse(String(immediate.order_available_timestamp_utc)));

 const delayed=futuresEvent("long");
 (delayed.generationSnapshot.configuration as unknown as {modelAssumptions:Record<string,number>}).modelAssumptions={executionLatencyMs:1_000};
 const withLatency=buildEventFuturesBaseline(delayed).comparison;
 assert.equal(withLatency.order_available_timestamp_utc,new Date(ENTRY+1_000).toISOString());
 assert.equal(withLatency.reference_entry_timestamp_utc,new Date(ENTRY+HOUR).toISOString(),"the next observable bar, not the bar already trading when the order was placed");
 assert.equal(withLatency.entry_lag_ms,HOUR-1_000);
 assert.ok((withLatency.reason_codes as string[]).includes("futures_entry_bar_resolution_lag"));
});

test("futures endpoints reuse the options research layer's own event timestamps",()=>{
 const event=futuresEvent("long",{invalidationPrice:100.4});
 const bundle=bundleOf([withGeneration(event)] as never);
 const eventRow=rows(bundle.files["events.jsonl"])[0];
 const comparison=rows(bundle.files["futures_comparisons.jsonl"])[0];
 assert.equal(comparison.exit_trigger_timestamp_utc,eventRow.vpoc_trigger_timestamp_utc);
 assert.equal(comparison.exit_decision_timestamp_utc,eventRow.vpoc_decision_timestamp_utc);
 assert.equal(comparison.sequence_status,eventRow.sequence_status);
 const invalidation=buildEventFuturesBaseline(event,"invalidation").comparison;
 assert.equal(invalidation.exit_trigger_timestamp_utc,eventRow.invalidation_trigger_timestamp_utc);
 assert.equal(invalidation.exit_decision_timestamp_utc,eventRow.invalidation_decision_timestamp_utc);
 // The shared resolver is the single source both layers read.
 const timing=resolveEventTiming({sourceRun:event.sourceRun,underlyingHourlyPath:event.generationSnapshot.underlyingHourlyPath});
 assert.equal(timing.vpocTriggerTimestamp,VPOC_TRIGGER);
 assert.equal(timing.vpocDecisionTimestamp,VPOC_DECISION);
});

test("a same-candle event is reported ambiguous, never ordered",()=>{
 // The invalidation decision is the touch candle's close; placing the VPOC touch
 // at that same instant makes the two unorderable at the path's precision.
 const path=underlyingPath();
 // The first post-entry candle already trades through this level, so the
 // invalidation is known at that candle's close -- the same instant as the VPOC touch.
 const collision=path[0].closeTime;
 const event=futuresEvent("long",{vpocTimestamp:collision,invalidationPrice:path[0].low,underlyingHourlyPath:path});
 const timing=resolveEventTiming({sourceRun:event.sourceRun,underlyingHourlyPath:path});
 assert.equal(timing.sequenceStatus,"ambiguous");
 const comparison=buildEventFuturesBaseline(event).comparison;
 assert.equal(comparison.sequence_status,"ambiguous");
 assert.equal(comparison.exit_ordering_status,"ambiguous","the baseline withholds the ordering claim rather than resolving it");
 assert.ok((comparison.reason_codes as string[]).includes("futures_event_resolution_ambiguous"));
});

test("missing perpetual data stays unavailable and is never index- or spot-filled",()=>{
 const market=futuresMarket("long");
 // A gap at the entry decision: the underlying index path still covers this hour.
 market.reference=market.reference.filter(point=>point.timestamp!==ENTRY);
 const gap=buildEventFuturesBaseline(futuresEvent("long",{futuresMarket:market}));
 assert.equal(gap.comparison.availability,"unavailable");
 assert.ok((gap.comparison.reason_codes as string[]).includes("futures_series_gap_at_entry_decision"));
 assert.equal(gap.comparison.reference_entry_price,undefined);
 assert.equal(gap.path.length,0);
 // An index-priced series is rejected on identity, not silently accepted.
 const spot=buildEventFuturesBaseline(futuresEvent("long",{futuresMarket:futuresMarket("long",{instrument:"btc_usd",instrumentKind:"perpetual"})}));
 assert.equal(spot.comparison.availability,"unavailable");
 assert.ok((spot.comparison.reason_codes as string[]).includes("unsupported_futures_instrument"));
 // Nothing in the engine reads the underlying index path for prices.
 assert.equal(buildEventFuturesBaseline(futuresEvent("long",{futuresMarket:futuresMarket("long",{reference:[]})})).path.length,0);
});

test("fees and slippage are applied once per side and carry versioned provenance",()=>{
 const comparison=buildEventFuturesBaseline(futuresEvent("long")).comparison;
 const entry=barOpen(0),exit=barOpen(7),rate=0.00035;
 assert.equal(comparison.fee_rate,rate);
 assert.equal(comparison.fee_source,"deribit-get_instrument","the venue's own commission schedule, not an assumption");
 assert.equal(comparison.fee_model_version,FUTURES_FEE_MODEL_VERSION);
 assert.equal(comparison.fees_usd_per_unit,(entry+exit)*rate);
 assert.equal(comparison.slippage_bps,0);
 assert.equal(comparison.slippage_model_version,FUTURES_SLIPPAGE_MODEL_VERSION);
 assert.equal(comparison.slippage_usd_per_unit,0);
 assert.equal(comparison.net_pnl_usd_per_unit_before_funding,(exit-entry)-(entry+exit)*rate);
 // A snapshot with no commission schedule reports the absence rather than assuming one.
 const noFees=buildEventFuturesBaseline(futuresEvent("long",{futuresMarket:futuresMarket("long",{instrumentMetadata:null,feeRate:undefined})})).comparison;
 assert.equal(noFees.fee_rate,null);
 assert.equal(noFees.fees_usd_per_unit,null);
 assert.equal(noFees.net_pnl_usd_per_unit_before_funding,null);
 assert.ok((noFees.reason_codes as string[]).includes("futures_fee_schedule_unavailable"));
});

test("funding is summed from official hourly rates and is never assumed zero when partial",()=>{
 const comparison=buildEventFuturesBaseline(futuresEvent("long")).comparison;
 assert.equal(comparison.funding_status,"available");
 assert.equal(comparison.funding_model_version,FUTURES_FUNDING_MODEL_VERSION);
 assert.equal(comparison.funding_rate_field,"interest_1h");
 assert.equal(comparison.funding_intervals_expected,7);
 assert.equal(comparison.funding_intervals_observed,7);
 // A long pays positive funding, priced at each hour's own perpetual bar.
 const expected=-[1,2,3,4,5,6,7].reduce((sum,hour)=>sum+barOpen(hour)*0.0001,0);
 assert.ok(Math.abs((comparison.funding_usd_per_unit as number)-expected)<1e-12);
 assert.ok((comparison.funding_usd_per_unit as number)<0);
 assert.equal(comparison.net_pnl_usd_per_unit_after_funding,(comparison.net_pnl_usd_per_unit_before_funding as number)+(comparison.funding_usd_per_unit as number));

 const market=futuresMarket("long");
 market.funding=market.funding!.filter(point=>point.timestamp!==ENTRY+3*HOUR);
 const partial=buildEventFuturesBaseline(futuresEvent("long",{futuresMarket:market})).comparison;
 assert.equal(partial.funding_status,"partial");
 assert.equal(partial.funding_usd_per_unit,null,"a partially known funding bill is not a zero funding bill");
 assert.equal(partial.net_pnl_usd_per_unit_after_funding,null);
 assert.ok(Number.isFinite(partial.net_pnl_usd_per_unit_before_funding as number));
 assert.ok((partial.reason_codes as string[]).includes("funding_partial"));
});

test("per-unit risk to invalidation reconciles with the observed price movement",()=>{
 const comparison=buildEventFuturesBaseline(futuresEvent("long")).comparison;
 const entry=comparison.reference_entry_price as number,invalidation=comparison.invalidation_price as number;
 assert.equal(comparison.risk_to_invalidation_usd_per_unit,Math.abs(entry-invalidation));
 assert.equal(comparison.risk_to_invalidation_usd_per_unit,20);
 // Equal-dollar-risk scaling reproduces exactly from the exported per-unit values.
 assert.equal(comparison.quantity,500/20);
 assert.equal(comparison.gross_trading_pnl_usd,(comparison.gross_pnl_usd_per_unit as number)*(comparison.quantity as number));
 assert.equal(comparison.unit_convention,"per 1 BTC-equivalent of perpetual notional, quoted in USD");
 assert.equal(comparison.contract_size_usd,10);
 const short=buildEventFuturesBaseline(futuresEvent("short")).comparison;
 assert.equal(short.risk_to_invalidation_usd_per_unit,20,"risk is a distance, not a signed quantity");
});

test("exported futures rows join cleanly to the event table and the manifest tells the truth",()=>{
 const bundle=bundleOf([withGeneration(futuresEvent("long")),withGeneration(futuresEvent("short",{eventId:"mr-2"}))] as never);
 assert.equal(validateResearchBundle(bundle.files).ok,true);
 const eventIds=new Set(rows(bundle.files["events.jsonl"]).map(row=>row.event_id));
 const comparisons=rows(bundle.files["futures_comparisons.jsonl"]);
 const path=rows(bundle.files["futures_path.jsonl"]);
 const comparisonIds=new Set(comparisons.map(row=>row.comparison_id));
 assert.ok(comparisons.every(row=>eventIds.has(row.event_id)));
 assert.ok(path.every(row=>eventIds.has(row.event_id)&&comparisonIds.has(row.comparison_id)));
 assert.equal(path.length,16,"eight causal observations for each of two events");
 assert.ok(path.every(row=>row.series_kind==="futures"&&row.verified===true&&row.source==="deribit"));
 assert.equal((bundle.run.table_availability as Record<string,string>).futures_comparisons,"available");
 assert.equal((bundle.run.table_availability as Record<string,string>).futures_path,"available");
 assert.equal(bundle.run.futures_engine_version,"deribit-btc-perpetual-baseline-v1");
 // Path prices come only from the perpetual bars, carrying their own basis.
 assert.ok(path.every(row=>row.price_basis==="traded_ohlc"));
 assert.equal(path[0].close,futuresMarket("long").reference[0].close);
});

test("the manifest reports futures tables unavailable when no perpetual evidence exists",()=>{
 const bundle=buildResearchBundle(structuredClone(store),now);
 assert.equal((bundle.run.table_availability as Record<string,string>).futures_comparisons,"unavailable");
 assert.equal((bundle.run.table_availability as Record<string,string>).futures_path,"unavailable");
 assert.match(bundle.files["futures_comparisons.jsonl"],/futures_instrument_unavailable/);
 assert.equal(bundle.files["futures_path.jsonl"].trim(),"");
});

test("every observation endpoint is exported with its own status, priced or not",()=>{
 const built=buildEventFuturesBaseline(futuresEvent("long"));
 const endpoints=built.comparison.endpoints as Array<Record<string,unknown>>;
 assert.deepEqual(endpoints.map(endpoint=>endpoint.policy),["vpoc","invalidation","fixed_3d","fixed_5d","fixed_7d"]);
 const vpoc=endpoints.find(endpoint=>endpoint.policy==="vpoc")!;
 assert.equal(vpoc.status,"available");
 assert.equal(vpoc.observation_price,barOpen(7));
 // The fixture's tape stops well before three days, so those endpoints are
 // explicitly unavailable rather than clamped onto the last known bar.
 for(const policy of ["fixed_3d","fixed_5d","fixed_7d"]){
  const endpoint=endpoints.find(row=>row.policy===policy)!;
  assert.equal(endpoint.status,"unavailable");
  assert.equal(endpoint.observation_price,null);
  assert.equal(endpoint.reason_code,"futures_exit_observation_unavailable");
 }
 assert.equal(built.comparison.reference_received_points,BARS);
});
