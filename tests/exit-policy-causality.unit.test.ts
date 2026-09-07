import test from "node:test";
import assert from "node:assert/strict";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {normalizeExitPolicies} from "../app/lib/exit-policy/normalize.ts";
import {buildExitPolicyReport} from "../app/lib/exit-policy/report.ts";
import {DEFAULT_ANALYSIS_CONFIGURATION} from "../app/lib/analysis-configuration.ts";

const D=(day:number)=>new Date(Date.UTC(2026,0,day)).toISOString();
const dataset=(outcomes:Readonly<Record<string,unknown>>[],candidates:Readonly<Record<string,unknown>>[]=[candidate()]):AnalysisDataset=>({filename:"fixture",schemaVersion:"4.1.0",migratedFrom:null,run:{},tables:{candidates,outcomes,valuations:[],margin_scenarios:[]},counts:{},venues:["deribit"],sourceRuns:["run"],eventUniverseComplete:true,capabilities:[]});
function candidate(over:Record<string,unknown>={}){return{source_run_id:"run",event_id:"event",candidate_id:"candidate",strategy_variant_id:"candidate",structure_execution_id:"candidate~reference",analytics_track:"reference",execution_scenario:null,execution_scenario_status:"evaluated",structure_entry_timestamp_utc:D(2),expiry_timestamp_utc:D(10),quantity:1,...over}}
const outcome=(type:string,day:number,over:Record<string,unknown>={})=>({candidate_id:"candidate",analytics_track:"reference",execution_scenario:null,outcome_type:type,trigger_status:"reached",source_status:"estimated",status:"priced",decision_available_timestamp_utc:D(day),valuation_timestamp_utc:D(day),net_pnl_native:.01,net_pnl_usd:400,...over});
const thesis=(d:AnalysisDataset)=>normalizeExitPolicies(d).find(x=>x.policyId==="thesis")!;

test("chronology freezes an earlier reached-but-unpriced winner",()=>{const row=thesis(dataset([outcome("vpoc",3,{status:"unavailable",net_pnl_native:null,evidence_reason:"reference mark absent"}),outcome("settlement",9)]));assert.equal(row.winningTrigger,"vpoc");assert.equal(row.status,"triggered_unpriced");assert.equal(row.diagnosticCode,"outcome_reached_unpriced");assert.match(row.missingDataReason!,/reference mark absent/)});

test("exact decision ties use declared policy priority and disclose the tie",()=>{const row=thesis(dataset([outcome("invalidation",4),outcome("vpoc",4),outcome("settlement",9)]));assert.equal(row.winningTrigger,"vpoc");assert.match(row.tieResolution!,/policy priority at the same decision timestamp/)});

test("fixed identities resolve, an after-expiry cap cannot win, and settlement survives",()=>{const rows=normalizeExitPolicies(dataset([outcome("fixed_3d",5),outcome("fixed_5d",7),outcome("fixed_7d",11,{trigger_status:"after_expiry"}),outcome("settlement",10)]));assert.equal(rows.find(x=>x.policyId==="time_cap_3d")!.winningTrigger,"fixed_3d");assert.equal(rows.find(x=>x.policyId==="time_cap_5d")!.winningTrigger,"fixed_5d");assert.equal(rows.find(x=>x.policyId==="time_cap_7d")!.winningTrigger,"settlement");assert.equal(rows.find(x=>x.policyId==="settlement_benchmark")!.winningTrigger,"settlement")});

test("a pre-entry VPOC cannot close a delayed-entry structure",()=>{const row=thesis(dataset([outcome("vpoc",1),outcome("settlement",9)]));assert.equal(row.winningTrigger,"settlement");assert.equal(row.status,"priced")});

test("one projected analytical track does not double count pricing representations",()=>{const candidates=[candidate(),candidate({structure_execution_id:"alternate-representation"})],rows=normalizeExitPolicies(dataset([outcome("settlement",9)],candidates));assert.equal(rows.filter(x=>x.policyId==="thesis").length,1);assert.equal(rows[0]!.pricingTrack,null)});

test("Reference report routing is execution-independent while strict tracks are projected separately",()=>{const base=candidate({analytics_track:undefined,execution_scenario:"maker",structure_execution_id:"candidate~maker",reference_valuation:{status:"valued",entrySnapshot:{status:"priced",targetTimestamp:Date.parse(D(2)),grossSpreadBtc:.02,openingFeesBtc:.001,netOpeningCashFlowBtc:.019},valuationPathSnapshot:[],outcomeSnapshots:[{label:"settlement",status:"estimated",decisionTimestamp:Date.parse(D(10)),valuationTimestamp:Date.parse(D(10)),estimatedNetPnlBtc:.01,estimatedNetPnlUsd:400}]}}),report=buildExitPolicyReport(dataset([], [base]),DEFAULT_ANALYSIS_CONFIGURATION);assert.equal(report.scope.analyticsTrack,"reference");assert.equal(report.scope.executionScenario,null);assert.equal(report.scope.pricingTrack,null);assert.equal(report.reference.policies.find(x=>x.policy.id==="thesis")!.observations.length,1);assert.equal(report.reference.policies.find(x=>x.policy.id==="thesis")!.observations[0]!.pricingTrack,null);assert.equal(report.observed.maker.scope.analyticsTrack,"immediate_maker");assert.equal(report.observed.taker.scope.analyticsTrack,"immediate_taker")});
