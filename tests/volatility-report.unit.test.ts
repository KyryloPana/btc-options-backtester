import test from "node:test";
import assert from "node:assert/strict";
import {availableStateQuantiles,buildVolatilityReport,quantiles} from "../app/lib/volatility/volatility-report.ts";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";

const dataset=(tables:Record<string,Record<string,unknown>[]>):AnalysisDataset=>({filename:"fixture.zip",schemaVersion:"3.9.0",migratedFrom:null,run:{},tables,counts:{},venues:[],sourceRuns:[],eventUniverseComplete:true,capabilities:[]});

test("empty volatility tables are an honest not-evaluated report",()=>{
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[],valuations:[],outcomes:[]}));
 assert.equal(report.coverage.eventCount,0);assert.equal(report.coverage.referenceIvByTenor["7d"].ratio,null);assert.equal(report.endpointCoverage.both.ratio,null);
});

test("market-IV report excludes reconstructed pricing IV and does not synthesize spread IV",()=>{
 const structure={event_id:"e",candidate_id:"c",entry_timestamp_utc:"2020-01-01T00:00:00.000Z",legs:[{leg:"short",status:"available",observation:"observed",iv_decimal:.5},{leg:"long",status:"available",observation:"reconstructed",iv_decimal:.6}],same_expiry_reference:{status:"unavailable"},differentials:[],synthesized_spread_iv:null};
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[structure],valuations:[],outcomes:[]}));
 assert.equal(report.structureCoverage.short.available,1);assert.equal(report.structureCoverage.long.available,0);assert.equal(report.structureCoverage.long.total,1);assert.ok(!("spread_iv" in report.aggregates));
});

test("post-entry IV comes only from independent market state at the exact canonical target",()=>{
 const entry="2020-01-01T00:00:00.000Z",target="2020-01-01T04:01:00.000Z",observed="2020-01-01T03:44:00.000Z";
 const evidence=(iv:number)=>({status:"available",source:"deribit_trade_iv",iv_decimal:iv,observation_timestamp_utc:observed,age_minutes:17});
 const structure={event_id:"e",candidate_id:"c",entry_timestamp_utc:entry,legs:[{leg:"short",status:"available",observation:"observed",iv_decimal:.5},{leg:"long",status:"available",observation:"observed",iv_decimal:.6}],same_expiry_reference:{status:"unavailable"},differentials:[],post_entry_market_iv:[{endpoint_id:"vpoc",target_timestamp_utc:target,short:evidence(.4),long:evidence(.55)}],market_iv_path:[]};
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[structure],valuations:[{candidate_id:"c",analytics_track:"reference_fair_value",timestamp_utc:target,short_leg_volatility:{status:"available",observation:"reconstructed",iv_decimal:.99}}],outcomes:[{candidate_id:"c",analytics_track:"reference_fair_value",outcome_type:"vpoc",valuation_timestamp_utc:target}]}));
 const vpoc=report.endpoints.find(e=>e.id==="vpoc")!;assert.equal(vpoc.timestampUtc,target);assert.equal(vpoc.shortIv,.4);assert.ok(Math.abs(vpoc.deltaShortIv!+.1)<1e-12);
});

test("pricing IV cannot create a post-entry market endpoint",()=>{
 const entry="2020-01-01T00:00:00.000Z",exit="2020-01-01T04:00:00.000Z",structure={event_id:"e",candidate_id:"c",entry_timestamp_utc:entry,legs:[{leg:"short",status:"available",observation:"observed",iv_decimal:.5}],same_expiry_reference:{status:"unavailable"},differentials:[],post_entry_market_iv:[],market_iv_path:[]};
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[structure],valuations:[{candidate_id:"c",analytics_track:"reference_fair_value",timestamp_utc:exit,short_leg_volatility:{status:"available",observation:"observed",iv_decimal:.4}}],outcomes:[]}));
 assert.equal(report.endpoints.length,0);
});

test("production cache materialization preserves one event and candidate row per structural identity",async()=>{
 const {mkdtemp}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {materializeVolatilityStates}=await import("../scripts/materialize-volatility-states.ts");
 const {store}=await import("./fixtures/research-selection-store.ts");
 const state=await materializeVolatilityStates(store,await mkdtemp(join(tmpdir(),"vol-state-")),{populateMissing:false});
 assert.deepEqual(state.events!.map(x=>x.event_id).sort(),["e1","e2"]);
 assert.equal(state.structures!.length,4);assert.equal(new Set(state.structures!.map(x=>x.candidate_id)).size,4);
 assert.ok(state.events!.every(x=>x.reference_iv.every(v=>v.status==="unavailable")),"missing cache must remain unavailable");
});

test("materialization uses canonical timing for nested and legacy direct sourceRun shapes",async()=>{
 const {mkdtemp}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {materializeVolatilityStates}=await import("../scripts/materialize-volatility-states.ts");
 const {store}=await import("./fixtures/research-selection-store.ts");
 const fixture=structuredClone(store);fixture.events[1]!.sourceRun=(fixture.events[1]!.sourceRun as Record<string,unknown>).event as never;
 const state=await materializeVolatilityStates(fixture,await mkdtemp(join(tmpdir(),"vol-timing-")),{populateMissing:false});
 assert.equal(state.events!.length,2);assert.ok(state.events!.every(x=>x.entry_timestamp_utc==="2026-08-16T00:00:00.000Z"));
});

test("an unresolved canonical event timestamp is diagnosed instead of disappearing",async()=>{
 const {mkdtemp}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {materializeVolatilityStates}=await import("../scripts/materialize-volatility-states.ts");
 const {store}=await import("./fixtures/research-selection-store.ts");const fixture=structuredClone(store);fixture.events[0]!.sourceRun={event:{}};
 const root=await mkdtemp(join(tmpdir(),"vol-timing-"));await assert.rejects(()=>materializeVolatilityStates(fixture,root,{populateMissing:false}),/cannot resolve canonical entry timing for event e1/);
});

test("report quantiles use linear interpolation and every metric uses all available events",()=>{
 const event=(id:string,iv:number,rv:number,pct:number,slope:number)=>({event_id:id,reference_iv:[{nominal_tenor:"7d",status:"available",iv_decimal:iv}],realized_volatility:[{horizon:"7d",status:"available",rv_decimal:rv}],iv_minus_rv:[{horizon:"7d",status:"available",value:iv-rv}],reference_iv_percentile:[{nominal_tenor:"7d",status:"available",percentile:pct}],term_structure:[{slope:"slope_7d_14d",status:"available",value:slope,value_per_day:slope/7}]});
 const report=buildVolatilityReport(dataset({events:[{event_id:"a"},{event_id:"b"}],event_volatility_state:[event("a",.4,.2,.1,.01),event("b",.8,.6,.9,.03)],structure_volatility_state:[],valuations:[],outcomes:[]}));
 assert.equal(report.events.length,2);assert.deepEqual(quantiles([0,10]),{n:2,p25:2.5,median:5,p75:7.5});
});

test("endpoint coverage distinguishes short, long, and both legs and aggregates matched pairs",()=>{
 const entry="2020-01-01T00:00:00.000Z",exit="2020-01-01T04:00:00.000Z",short={status:"available",source:"deribit_trade_iv",iv_decimal:.4},missing={status:"unavailable",source:null,iv_decimal:null};
 const structure={event_id:"e",candidate_id:"c",entry_timestamp_utc:entry,legs:[{leg:"short",status:"available",observation:"observed",iv_decimal:.5},{leg:"long",status:"available",observation:"observed",iv_decimal:.6}],same_expiry_reference:{status:"unavailable"},differentials:[],post_entry_market_iv:[{endpoint_id:"4h",target_timestamp_utc:exit,short,long:missing}],market_iv_path:[]};
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[structure],valuations:[],outcomes:[]}));
 assert.equal(report.endpointCoverage.short.available,1);assert.equal(report.endpointCoverage.long.available,0);assert.equal(report.endpointCoverage.both.available,0);
 const aggregate=report.endpointAggregates.find(x=>x.id==="4h")!;assert.equal(aggregate.medianEntryShortIv,.5);assert.equal(aggregate.medianShortIv,.4);assert.equal(aggregate.bothN,0);
});

test("path diagnostics use only independent available market states",()=>{
 const structure={event_id:"e",candidate_id:"c",entry_timestamp_utc:"2020-01-01T00:00:00.000Z",legs:[],same_expiry_reference:{status:"unavailable"},differentials:[],post_entry_market_iv:[],market_iv_path:[{target_timestamp_utc:"2020-01-01T04:00:00Z",short:{status:"available",source:"deribit_trade_iv",iv_decimal:.4},long:{status:"unavailable",iv_decimal:.99}},{target_timestamp_utc:"2020-01-01T08:00:00Z",short:{status:"available",source:"deribit_trade_iv",iv_decimal:.6},long:{status:"available",source:"deribit_trade_iv",iv_decimal:.5}}]};
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[structure],valuations:[{candidate_id:"c",analytics_track:"reference_fair_value",short_leg_volatility:{status:"available",observation:"observed",iv_decimal:.9}}],outcomes:[]})),path=report.paths[0]!;
 assert.deepEqual({n:path.shortPoints,min:path.shortMin,max:path.shortMax},{n:2,min:.4,max:.6});assert.ok(Math.abs(path.shortRange!-.2)<1e-12);assert.equal(path.longPoints,1);
});

test("unavailable and degenerate slopes contribute neither raw nor per-day values",()=>{
 const events=[{term_structure:[{slope:"slope_7d_14d",status:"unavailable",value:.9,value_per_day:null,unavailable_reason:"degenerate_tenor_span"}]},{term_structure:[{slope:"slope_7d_14d",status:"available",value:.2,value_per_day:.02}]}];
 assert.deepEqual(availableStateQuantiles(events,"term_structure","slope_7d_14d","value"),{n:1,p25:.2,median:.2,p75:.2});
 assert.equal(availableStateQuantiles(events,"term_structure","slope_7d_14d","value_per_day").median,.02);
});
