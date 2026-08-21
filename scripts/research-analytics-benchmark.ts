import {performance} from "node:perf_hooks";
import {createResearchAnalyticsContext,datasetForAnalyticsTrack} from "../app/lib/research-analytics-model.ts";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";

const iso=(day:number,hour=0)=>new Date(Date.UTC(2024,0,day,hour)).toISOString();
function fixture():AnalysisDataset {
 const events=[],availability=[],candidates=[];
 for(let event=0;event<25;event++)for(let variant=0;variant<12;variant++){
  const eventId=`event-${event}`,candidateId=`${eventId}-variant-${variant}`,gross=.05+variant/1000;
  if(variant===0)events.push({event_id:eventId,signal_timestamp_utc:iso(1,event%20),sequence_status:event%3===0?"vpoc_first":"unresolved"});
  availability.push({event_id:eventId,candidate_id:candidateId,strategy_variant_id:candidateId,contract_status:"resolved"});
  const reference={status:"valued",source:"local_iv_interpolation",entrySnapshot:{status:"priced",targetTimestamp:Date.parse(iso(1)),grossSpreadBtc:gross,openingFeesBtc:.001,netOpeningCashFlowBtc:gross-.001,entryTargetIndex:60000},valuationPathSnapshot:Array.from({length:42},(_,mark)=>({timestamp:Date.parse(iso(2))+mark*144e5,estimatedNetPnlBtc:(mark-20)/1000})),outcomeSnapshots:[]};
  const delayed_execution=variant%5===0?{maker:{status:"evaluated",entrySnapshot:{...reference.entrySnapshot,targetTimestamp:Date.parse(iso(1,4))},valuationPathSnapshot:reference.valuationPathSnapshot,outcomeSnapshots:[]}}:undefined;
  const modeled_execution={expected:{status:"evaluated",modelVersion:"benchmark-v1",calibrationCount:0,entrySnapshot:reference.entrySnapshot,valuationPathSnapshot:reference.valuationPathSnapshot,outcomeSnapshots:[]},conservative:{status:"unavailable",reason:"uncalibrated benchmark sensitivity"}};
  for(const execution_scenario of ["maker","taker"])candidates.push({event_id:eventId,candidate_id:candidateId,strategy_variant_id:candidateId,structure_execution_id:`${candidateId}~${execution_scenario}`,execution_scenario,execution_scenario_status:variant%4===0?"evaluated":"unavailable",execution_scenario_reason:"deterministic sparse tape",structure_entry_timestamp_utc:iso(1),expiry_timestamp_utc:iso(8+variant%3),actual_dte:7+variant%3,strike_method:variant%2?"buffered":"anchor",option_type:"put",quantity:1,actual_strikes:{short:59000,long:59000-[500,1000,2000][variant%3],width:[500,1000,2000][variant%3]},reference_valuation:reference,delayed_execution,modeled_execution,gross_credit_debit_native:gross,opening_fees_native:.001,net_opening_cash_flow_native:gross-.001});
 }
 return {filename:"deterministic-25-event.zip",schemaVersion:"3.2.0",migratedFrom:null,run:{bundle_id:"benchmark"},tables:{events,availability,candidates,outcomes:[],valuations:[],margin_scenarios:[]},counts:{},venues:["DERIBIT"],sourceRuns:["benchmark"],eventUniverseComplete:true,capabilities:[]};
}
const tracks=["reference","modeled_expected","modeled_conservative","penalty_sensitivity"] as const;
const startBefore=performance.now();
for(const track of tracks)datasetForAnalyticsTrack(structuredClone(fixture()),track);
const before=performance.now()-startBefore;
const dataset=fixture(),startAfter=performance.now(),context=createResearchAnalyticsContext(dataset);
for(const track of tracks)context.projection(track);
for(const track of tracks)context.projection(track);
const after=performance.now()-startAfter;
console.log(JSON.stringify({fixture:{events:25,variants:300,candidateRows:600,valuationMarks:12600},simulatedRepeatedDatasetIdentityMs:+before.toFixed(2),oneContextAndCachedReaccessMs:+after.toFixed(2),improvementPct:+((before-after)/before*100).toFixed(1),normalizations:{repeated:4,context:1},projectionReaccessBuilds:0},null,2));
