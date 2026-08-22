import test from "node:test";
import assert from "node:assert/strict";
import { buildResearchMarginSnapshot, canonicalMarginReason, referenceMarginPoints } from "../app/lib/research-margin.ts";
import type { SelectedStructure } from "../app/lib/research-selections.ts";

const day=86_400_000,entry=Date.parse("2024-01-01T00:00:00Z"),expiry=entry+7*day;
const structure=(mutation:(value:SelectedStructure)=>void=()=>{}):SelectedStructure=>{
 const value={selectionId:"s",eventId:"e",candidateId:"c",venue:"deribit",selectedAtUtc:new Date(entry).toISOString(),quantity:2,candidateSnapshot:{optionType:"P",shortStrike:60_000,longStrike:55_000,expiryTimestamp:expiry},contractResolution:{status:"exact_resolved",reason:null,short:null,long:null},referenceValuation:{status:"valued",reason:null,source:"local_iv_interpolation",entrySnapshot:{status:"priced",targetTimestamp:entry,entryTargetIndex:58_000,sold:{priceBtcPerContract:.08},bought:{priceBtcPerContract:.03},openingFeesBtc:.001},valuationPathSnapshot:[{timestamp:entry+day,targetIndex:57_000,modelEstimate:{sold:{priceBtcPerContract:.09},bought:{priceBtcPerContract:.04}}},{timestamp:expiry+day,targetIndex:50_000,modelEstimate:{sold:{priceBtcPerContract:.2},bought:{priceBtcPerContract:.1}}}],outcomeSnapshots:[],provenance:{executionIndependent:true}},executionScenarios:{maker:{status:"unavailable",reason:"no maker fill",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]},taker:{status:"unavailable",reason:"no taker fill",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]}},marginSnapshot:null} satisfies SelectedStructure;mutation(value);return value;
};
const record=(value:unknown)=>value as Record<string,unknown>;

test("reference margin is independent of immediate Maker/Taker fills and bounded by the holding window",()=>{
 const selected=structure(),points=referenceMarginPoints(selected.referenceValuation),margin=record(buildResearchMarginSnapshot(selected));
 assert.equal(margin.status,"available");assert.equal(points.length,3,"extractor retains reference points; engine applies terminal bound");
 const path=margin.path as Array<Record<string,number>>;assert.deepEqual(path.map(point=>point.timestamp),[entry,entry+day]);
 assert.equal(path[1]!.shortMarkPriceBtc,.09);assert.equal(path[1]!.longMarkPriceBtc,.04,"reference option marks, not execution tape or candles, feed SM");
 assert.ok(Number(margin.capitalDaysMarginBtc)>0);assert.notEqual(margin.openingInitialMarginBtc,margin.theoreticalMaximumSpreadLossBtc,"maximum economic loss never substitutes for IM");
});

test("missing reference point inputs and historical boundary produce deterministic machine codes",()=>{
 const cases:[string,(point:Record<string,unknown>)=>void][]=[["margin_missing_index",p=>delete p.targetIndex],["margin_missing_short_mark",p=>delete record(record(p.modelEstimate).sold).priceBtcPerContract],["margin_missing_long_mark",p=>delete record(record(p.modelEstimate).bought).priceBtcPerContract]];
 for(const [code,mutate] of cases){const selected=structure(value=>mutate(record(value.referenceValuation!.valuationPathSnapshot[0]))),result=record(buildResearchMarginSnapshot(selected));assert.equal(result.status,"unavailable");assert.equal(result.reasonCode,code);assert.equal(typeof result.reason,"string");}
 const historical=structure(value=>{const ref=record(value.referenceValuation!.entrySnapshot);ref.targetTimestamp=Date.parse("2019-07-31T00:00:00Z");value.referenceValuation!.valuationPathSnapshot=[];});assert.equal(record(buildResearchMarginSnapshot(historical)).reasonCode,"margin_historical_rule_unverified");
});

test("legacy engine-not-run prose is classified without becoming a reason code",()=>{
 assert.equal(canonicalMarginReason("No margin result was produced."),"margin_not_recomputed");
 assert.equal(canonicalMarginReason("some human diagnostic"),"verified_historical_margin_model_unavailable");
});
