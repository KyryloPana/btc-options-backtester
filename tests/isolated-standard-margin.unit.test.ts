import test from "node:test";
import assert from "node:assert/strict";
import {buildResearchBundle} from "../app/lib/research-bundle.ts";
import {migrateResearchSelectionStore} from "../app/lib/research-selections.ts";
import {buildResearchMarginSnapshot} from "../app/lib/research-margin.ts";
import {estimateStandardOptionMargin,reconstructStandardVerticalMargin,STANDARD_MARGIN_ENGINE_VERSION,STANDARD_MARGIN_RULE_ID,DEFAULT_DEPLOYMENT} from "../app/lib/margin.ts";
import {payoffExtrema} from "../app/lib/expiry-payoff.ts";
import {store,now,ts} from "./fixtures/research-selection-store.ts";

/**
 * Isolated per-position segregated Standard Margin.
 *
 * Everything here exercises the EXISTING versioned estimator; no second margin
 * model is defined. The properties pinned are the ones that make a margin
 * number trustworthy: it exists for economic research without needing a fill,
 * it is not the maximum economic loss wearing a different name, and it is
 * never described as an observed historical balance.
 */

const SHORT=100,LONG=90,INDEX=100;
const parse=(text:string)=>text.trim()?text.trim().split("\n").map(line=>JSON.parse(line) as Record<string,unknown>):[];

/** A model-valued structure with a causal reference path and NO execution evidence. */
function fixture(mutate:(reference:Record<string,unknown>)=>void=()=>{}){
 const f=migrateResearchSelectionStore(structuredClone(store)) as ReturnType<typeof migrateResearchSelectionStore>;
 const event=f.events[0]!,s=structuredClone(event.selectedStructures[0]!) as Record<string,unknown>;
 const entry=structuredClone((s.executionScenarios as Record<string,Record<string,unknown>>).taker.entrySnapshot);
 s.contractResolution={status:"exact_resolved",reason:null,
  short:{instrumentName:"BTC-S",creationTimestamp:ts-1,expirationTimestamp:ts+7*864e5,strike:SHORT,optionType:"P",contractSize:1,source:"fixture",retrievedAtUtc:now,authoritative:true},
  long:{instrumentName:"BTC-L",creationTimestamp:ts-1,expirationTimestamp:ts+7*864e5,strike:LONG,optionType:"P",contractSize:1,source:"fixture",retrievedAtUtc:now,authoritative:true}};
 const point=(t:number,index:number,shortMark:number,longMark:number)=>({timestamp:t,status:"priced",targetIndex:index,
  estimatedNetPnlBtc:.001,modelEstimate:{sold:{priceBtcPerContract:shortMark},bought:{priceBtcPerContract:longMark}}});
 const reference:Record<string,unknown>={status:"valued",reason:null,source:"local_iv_interpolation",entrySnapshot:entry,
  // Entry, then a deeper point (index 96, richer short mark) that must own the
  // peak, then a recovery point.
  valuationPathSnapshot:[point(ts,INDEX,.02,.01),point(ts+4*36e5,96,.031,.014),point(ts+8*36e5,101,.018,.009)],
  outcomeSnapshots:[{label:"Settlement",status:"estimated",decisionTimestamp:ts+7*864e5,valuationTimestamp:ts+7*864e5,estimatedNetPnlBtc:.003,conversionIndex:102}],
  provenance:{executionIndependent:true,method:"margin fixture",engineVersion:"reference/1"}};
 mutate(reference);
 s.referenceValuation=reference;
 // Neither immediate scenario is available: margin must not depend on them.
 s.executionScenarios={maker:{status:"unavailable",reason:"No maker tape.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]},
  taker:{status:"not_evaluated",reason:"Taker was intentionally skipped.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]}};
 // The legacy placeholder a pre-wiring store carries.
 s.marginSnapshot={status:"unavailable",reason:"No margin result was produced."};
 s.selectionProvenance="model-only-diagnostic";
 f.events=[{...event,selectedStructures:[s]} as typeof event,{...f.events[1]!,selectedStructures:[]}];
 return f;
}
const marginRow=(mutate?:(reference:Record<string,unknown>)=>void)=>
 parse(buildResearchBundle(fixture(mutate),now).files["margin_scenarios.jsonl"])[0]!;

test("EXECUTION-INDEPENDENT: Standard Margin is computed for a model-valued spread with no maker or taker fill",()=>{
 const row=marginRow();
 assert.equal(row.margin_status,"available","margin does not require strict tape execution to exist");
 assert.equal(row.margin_model,"segregated_sm");
 assert.equal(row.method_version,STANDARD_MARGIN_ENGINE_VERSION);
 assert.equal(row.rule_version,STANDARD_MARGIN_RULE_ID);
 assert.deepEqual(row.reason_codes,[]);
 assert.ok(Number(row.incremental_initial_margin)>0);
 assert.ok(Number(row.incremental_maintenance_margin)>0);
 // And the execution scenarios really were unavailable.
 const candidates=parse(buildResearchBundle(fixture(),now).files["candidates.jsonl"]);
 assert.ok(candidates.every(c=>c.execution_scenario_status!=="evaluated"));
});

test("ESTIMATOR: opening IM and MM come from the existing versioned Standard Margin formula",()=>{
 const row=marginRow();
 // IM = (mark + max(0.15 - OTM, 0.10)) * amount; MM = (mark + 0.075) * amount.
 // At entry the short put is at the money, so OTM = 0.
 const expected=estimateStandardOptionMargin({side:"short",optionType:"P",amount:1,strike:SHORT,
  indexPrice:INDEX,markPriceBtc:.02,observationTimestamp:ts,theoreticalMaximumSpreadLossBtc:0});
 assert.equal(expected.state,"ok");
 assert.equal(row.incremental_initial_margin,expected.initialMarginBtc);
 assert.equal(row.incremental_maintenance_margin,expected.maintenanceMarginBtc);
 assert.ok(Math.abs(Number(row.incremental_initial_margin)-(.02+.15))<1e-12);
 assert.ok(Math.abs(Number(row.incremental_maintenance_margin)-(.02+.075))<1e-12);
});

test("DISTINCTNESS: maximum economic loss is not initial or maintenance margin",()=>{
 const row=marginRow();
 assert.notEqual(row.maximum_loss_native,row.incremental_initial_margin);
 assert.notEqual(row.maximum_loss_native,row.incremental_maintenance_margin);
 assert.notEqual(row.maximum_loss_usd,row.incremental_initial_margin);
 // They are different KINDS of quantity: loss is a payoff property, margin is
 // an account requirement, and the row says so.
 assert.equal(row.margin_measurement,"model_estimated_historical_requirement");
 assert.match(String(row.maximum_loss_method),/inverse vertical expiry payoff/i);
});

test("DISTINCTNESS: the protective long's cash cost is never presented as margin",()=>{
 const row=marginRow();
 // The long premium is 0.01 BTC at entry. Under segregated SM the protective
 // long carries a ZERO requirement and supplies no offset, so no margin field
 // may equal its cash cost.
 const longPremium=.01;
 for(const field of ["incremental_initial_margin","incremental_maintenance_margin","peak_initial_margin","peak_maintenance_margin"])
  assert.notEqual(row[field],longPremium,`${field} must not be the protective-long premium`);
 assert.match(String((row.margin_inputs as Record<string,unknown>).vertical_treatment),
  /protective long has zero SM requirement/i);
 assert.equal(estimateStandardOptionMargin({side:"long",optionType:"P",amount:1,strike:LONG,indexPrice:INDEX,
  markPriceBtc:longPremium,observationTimestamp:ts,theoreticalMaximumSpreadLossBtc:0}).initialMarginBtc,0,
  "a long option leg has no SM requirement at all");
});

test("PATH: peak IM/MM come from causal path points, and the timestamp is the point that produced the peak",()=>{
 const row=marginRow();
 // The index-96 point at +4h carries the richest short mark, so it owns the peak.
 assert.ok(Math.abs(Number(row.peak_initial_margin)-(.031+.15))<1e-12);
 assert.ok(Math.abs(Number(row.peak_maintenance_margin)-(.031+.075))<1e-12);
 assert.equal(row.peak_timestamp_utc,new Date(ts+4*36e5).toISOString());
 assert.ok(Number(row.peak_initial_margin)>Number(row.incremental_initial_margin),
  "the peak is a path maximum, not a copy of the opening requirement");
 // Every path point sits inside the holding window.
 const path=(row.margin_inputs as {path:{timestamp:number}[]}).path;
 assert.equal(path.length,3);
 for(const p of path)assert.ok(p.timestamp>=ts&&p.timestamp<=ts+7*864e5);
});

test("PATH: a missing mark is never forward-filled; the reconstruction reports unavailable",()=>{
 const row=marginRow(reference=>{
  // Drop the protective-long mark on the middle point.
  const points=reference.valuationPathSnapshot as Record<string,unknown>[];
  (points[1]!.modelEstimate as Record<string,unknown>).bought={};
 });
 assert.equal(row.margin_status,"unavailable");
 assert.deepEqual(row.reason_codes,["margin_missing_long_mark"]);
 assert.equal(row.incremental_initial_margin,null,"no value is carried forward from the previous point");
 assert.equal(row.peak_initial_margin,null);
 // The same property at the engine level: one missing mark invalidates the run
 // rather than being interpolated.
 const reconstruction=reconstructStandardVerticalMargin({optionType:"P",amount:1,shortStrike:SHORT,longStrike:LONG,
  expiryTimestamp:ts+7*864e5,theoreticalMaximumSpreadLossBtc:1,entryTimestamp:ts,terminalTimestamp:ts+7*864e5,
  points:[{timestamp:ts,indexPrice:INDEX,shortMarkPriceBtc:.02,longMarkPriceBtc:.01},
   {timestamp:ts+36e5,indexPrice:INDEX,shortMarkPriceBtc:.03}]});
 assert.equal(reconstruction.status,"unavailable");
 assert.deepEqual(reconstruction.path,[]);
});

test("MAX LOSS: the BTC figure carries its reference index, method and assumption",()=>{
 const row=marginRow();
 assert.equal(row.reference_index,INDEX);
 assert.deepEqual(row.maximum_loss_units,{native:"BTC",quote:"USD"});
 assert.match(String(row.maximum_loss_assumption),/not an unconditional terminal BTC loss/i);
 // USD is the primary bounded figure; BTC is that loss at the stated index.
 const usd=Number(row.maximum_loss_usd),btc=Number(row.maximum_loss_native);
 assert.ok(Number.isFinite(usd)&&usd>0);
 assert.ok(Math.abs(btc-usd/INDEX)<1e-9,"the BTC representation is the USD loss converted at the reference index");
 // It matches the authoritative inverse payoff, not width minus credit.
 const exact=Math.abs(payoffExtrema({optionType:"P",shortStrike:SHORT,longStrike:LONG,
  shortEntryPremiumBtc:.02,longEntryPremiumBtc:.01,entryIndex:INDEX,amount:1,openingFeesBtc:.001,
  expiryTimestamp:ts+7*864e5},"usd-cash-flow").maximumLoss);
 assert.ok(Math.abs(usd-exact)<1e-6);
});

test("MAX LOSS: the divergent inverse BTC extremum is never exported as a terminal loss",()=>{
 // An inverse put's intrinsic (K-S)/S diverges as settlement approaches zero,
 // so the btc-settlement extremum is a tail artifact rather than a loss.
 const btcExtremum=Math.abs(payoffExtrema({optionType:"P",shortStrike:60_000,longStrike:55_000,
  shortEntryPremiumBtc:.08,longEntryPremiumBtc:.03,entryIndex:58_000,amount:2,openingFeesBtc:.001,
  expiryTimestamp:ts+7*864e5},"btc-settlement").maximumLoss);
 assert.ok(btcExtremum>1e6,"the raw BTC extremum really is divergent, which is why it is not used");
 const row=marginRow();
 assert.ok(Number(row.maximum_loss_native)<1,"the exported BTC figure is a bounded conversion, not the divergent extremum");
});

test("CAPITAL TIME: capital-days states its basis and formula unambiguously",()=>{
 const row=marginRow();
 assert.ok(Number(row.capital_days_margin)>0);
 assert.equal(row.capital_days_basis,"initial_margin_btc");
 assert.match(String(row.capital_days_definition),/piecewise-constant/i);
 assert.match(String(row.capital_days_definition),/to expiry/i);
 assert.match(String((row.margin_inputs as Record<string,unknown>).integration_convention),/piecewise-constant/i);
});

test("LABELLING: the requirement is model-estimated, never observed historical margin",()=>{
 const row=marginRow();
 assert.equal(row.data_quality,"historical_formula_reconstruction");
 assert.equal(row.margin_measurement,"model_estimated_historical_requirement");
 assert.match(String(row.margin_measurement_note),/not evidence of the balance Deribit actually reserved/i);
 assert.match(String(row.calculation_method),/reconstruction/i);
 const text=JSON.stringify(row);
 assert.ok(!/observed[_ ]historical[_ ]margin/i.test(text),"nothing claims observed historical margin");
});

test("PORTFOLIO MARGIN: stays explicitly unavailable and never falls back to Standard Margin",()=>{
 const row=marginRow();
 assert.equal(row.portfolio_margin_status,"unavailable");
 assert.match(String(row.portfolio_margin_reason),/no runnable historical implementation/i);
 assert.match(String(row.portfolio_margin_reason),/never substituted/i);
 assert.equal(row.margin_model,"segregated_sm","the SM figure is not relabelled as PM");
 // The estimator itself refuses a PM deployment rather than silently using SM.
 for(const model of ["segregated_pm","cross_pm","cross_sm"] as const){
  const result=estimateStandardOptionMargin({side:"short",optionType:"P",amount:1,strike:SHORT,indexPrice:INDEX,
   markPriceBtc:.02,observationTimestamp:ts,theoreticalMaximumSpreadLossBtc:0,
   deployment:{...DEFAULT_DEPLOYMENT,model}});
  assert.equal(result.state,"unavailable");
  assert.equal(result.initialMarginBtc,undefined,"no SM number is produced for a non-SM deployment");
 }
});

test("RECOMPUTE: a legacy placeholder is recomputed rather than exported as margin_not_recomputed",()=>{
 const row=marginRow();
 assert.equal(row.margin_status,"available");
 assert.ok(!JSON.stringify(row).includes("margin_not_recomputed"));
 // A genuinely uncomputable structure still reports a SPECIFIC reason.
 const noReference=structuredClone(store) as Record<string,unknown>;
 const rows=parse(buildResearchBundle(noReference as never,now).files["margin_scenarios.jsonl"]);
 assert.ok(rows.length>0);
 for(const r of rows){
  assert.equal(r.margin_status,"unavailable");
  assert.deepEqual(r.reason_codes,["margin_no_canonical_valuation_path"]);
 }
});

test("MANIFEST: table availability reflects the rows actually produced",()=>{
 const withMargin=JSON.parse(buildResearchBundle(fixture(),now).files["run.json"]) as Record<string,unknown>;
 assert.equal((withMargin.table_availability as Record<string,unknown>).margin_scenarios,"available");
 const withoutMargin=JSON.parse(buildResearchBundle(structuredClone(store) as never,now).files["run.json"]) as Record<string,unknown>;
 assert.equal((withoutMargin.table_availability as Record<string,unknown>).margin_scenarios,"unavailable");
});

test("SNAPSHOT: the research margin snapshot reuses the shared estimator's own output shape",()=>{
 const f=fixture(),s=f.events[0]!.selectedStructures[0]!;
 const snapshot=buildResearchMarginSnapshot(s) as Record<string,unknown>;
 assert.equal(snapshot.status,"available");
 assert.equal(snapshot.engineVersion,STANDARD_MARGIN_ENGINE_VERSION);
 assert.equal(snapshot.ruleVersion,STANDARD_MARGIN_RULE_ID);
 assert.equal((snapshot.deployment as Record<string,unknown>).model,"segregated_sm");
 assert.ok(Number(snapshot.openingInitialMarginBtc)>0);
 assert.ok(Number(snapshot.peakInitialMarginBtc)>=Number(snapshot.openingInitialMarginBtc));
});
