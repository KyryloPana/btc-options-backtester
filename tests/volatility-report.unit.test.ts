import test from "node:test";
import assert from "node:assert/strict";
import {buildVolatilityReport} from "../app/lib/volatility/volatility-report.ts";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";

const dataset=(tables:Record<string,Record<string,unknown>[]>):AnalysisDataset=>({filename:"fixture.zip",schemaVersion:"3.8.0",migratedFrom:null,run:{},tables,counts:{},venues:[],sourceRuns:[],eventUniverseComplete:true,capabilities:[]});

test("empty volatility tables are an honest not-evaluated report",()=>{
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[],valuations:[],outcomes:[]}));
 assert.equal(report.coverage.eventCount,0);assert.equal(report.coverage.referenceIvByTenor["7d"].ratio,null);assert.equal(report.endpointCoverage.ratio,null);
});

test("market-IV report excludes reconstructed pricing IV and does not synthesize spread IV",()=>{
 const structure={event_id:"e",candidate_id:"c",entry_timestamp_utc:"2020-01-01T00:00:00.000Z",legs:[{leg:"short",status:"available",observation:"observed",iv_decimal:.5},{leg:"long",status:"available",observation:"reconstructed",iv_decimal:.6}],same_expiry_reference:{status:"unavailable"},differentials:[],synthesized_spread_iv:null};
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[structure],valuations:[],outcomes:[]}));
 assert.equal(report.structureCoverage.short.available,1);assert.equal(report.structureCoverage.long.available,0);assert.equal(report.structureCoverage.long.total,1);assert.ok(!("spread_iv" in report.aggregates));
});

test("outcome IV joins exactly to its canonical Reference valuation timestamp",()=>{
 const entry="2020-01-01T00:00:00.000Z",exit="2020-01-01T04:01:00.000Z",structure={event_id:"e",candidate_id:"c",entry_timestamp_utc:entry,legs:[{leg:"short",status:"available",observation:"observed",iv_decimal:.5},{leg:"long",status:"available",observation:"observed",iv_decimal:.6}],same_expiry_reference:{status:"unavailable"},differentials:[],synthesized_spread_iv:null};
 const vol=(iv:number,observation="observed")=>({status:"available",observation,iv_decimal:iv});
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[structure],valuations:[{candidate_id:"c",analytics_track:"reference",timestamp_utc:exit,short_leg_volatility:vol(.4),long_leg_volatility:vol(.55)}],outcomes:[{candidate_id:"c",analytics_track:"reference",outcome_type:"vpoc",valuation_timestamp_utc:exit}]}));
 const vpoc=report.endpoints.find(e=>e.id==="vpoc")!;assert.equal(vpoc.timestampUtc,exit);assert.ok(Math.abs(vpoc.deltaShortIv!+.1)<1e-12);
 const fixed=report.endpoints.find(e=>e.id==="4h")!;assert.equal(fixed.status,"unavailable","the nearby 04:01 mark must not be searched forward");
});

test("endpoint reconstructed IV makes change unavailable",()=>{
 const entry="2020-01-01T00:00:00.000Z",exit="2020-01-01T04:00:00.000Z",structure={event_id:"e",candidate_id:"c",entry_timestamp_utc:entry,legs:[{leg:"short",status:"available",observation:"observed",iv_decimal:.5},{leg:"long",status:"available",observation:"observed",iv_decimal:.6}],same_expiry_reference:{status:"unavailable"},differentials:[],synthesized_spread_iv:null};
 const report=buildVolatilityReport(dataset({event_volatility_state:[],structure_volatility_state:[structure],valuations:[{candidate_id:"c",analytics_track:"reference",timestamp_utc:exit,short_leg_volatility:{status:"available",observation:"reconstructed",iv_decimal:.4}}],outcomes:[]}));
 assert.equal(report.endpoints.find(e=>e.id==="4h")!.deltaShortIv,null);
});
