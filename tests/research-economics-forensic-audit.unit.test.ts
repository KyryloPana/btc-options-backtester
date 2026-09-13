import test from "node:test";
import assert from "node:assert/strict";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {buildResearchEconomicsForensicAudit} from "../app/lib/research-economics/forensic-audit.ts";

const fields={targetDteFamilyDays:7,strikeMethod:"anchor",requestedWidth:1000,structureFamily:"credit_vertical"};
const opportunity=(eventId:string,id:string,status:string,candidateId:string|null,reasonCode?:string)=>({event_id:eventId,opportunity_id:`${eventId}~${id}`,candidate_id:candidateId,attempt_candidate_ids:[],structural_configuration_id:id,structural_configuration:fields,economic_opportunity:{status,reason_code:reasonCode??(status==="explicit_no_trade"?"empirical_nonpositive_credit_after_fees":null),reason:reasonCode??status}});
const candidate=(eventId:string,candidateId:string,id:string)=>({event_id:eventId,candidate_id:candidateId,structure_execution_id:`${candidateId}~modeled_expected`,structural_configuration_id:id,structural_configuration:fields,analytics_track:"modeled_expected",execution_scenario:null,execution_scenario_status:"evaluated",structure_entry_timestamp_utc:"2026-01-01T00:00:00Z",expiry_timestamp_utc:"2026-01-08T00:00:00Z",actual_dte_days:7,direction:"long",option_type:"P",structure_type:"bull_put_credit",strike_method:"anchor",requested_width:1000,actual_strikes:{short:40000,long:39000,width:1000},entry_index_price:40000,quantity:1,entry_legs:{short:{price_native:.01},long:{price_native:.002}},gross_credit_debit_native:.008,opening_fees_native:.0001,net_opening_cash_flow_native:.0079});
const outcome=(eventId:string,candidateId:string)=>({candidate_id:candidateId,event_id:eventId,analytics_track:"modeled_expected",execution_scenario:null,outcome_type:"settlement",status:"priced",trigger_status:"reached",decision_available_timestamp_utc:"2026-01-08T00:00:00Z",valuation_timestamp_utc:"2026-01-08T00:00:00Z",holding_hours:168,closing_fees_native:.0001,net_pnl_native:.002,net_pnl_usd:80});
const dataset=(opportunities:unknown[],candidates:unknown[]=[],outcomes:unknown[]=[]):AnalysisDataset=>({schemaVersion:"4.5.0",run:{},tables:{configuration_opportunities:opportunities,candidates,outcomes,availability:[],valuations:[],margin_scenarios:[],structure_economics:[]}} as unknown as AnalysisDataset);

test("forensic audit counts canonical contradictions without admitting stale Q50 evidence",()=>{
 const rows=[opportunity("e1","A","explicit_no_trade","c1"),opportunity("e2","B","unavailable","c2","modeled_execution_not_attempted")];
 const audit=buildResearchEconomicsForensicAudit(dataset(rows,[candidate("e1","c1","A"),candidate("e2","c2","B")],[outcome("e1","c1"),outcome("e2","c2")]));
 assert.deepEqual(audit.summary.q50StatusCounts,{trade:0,explicit_no_trade:1,unavailable:1});
 assert.equal(audit.summary.selectedQ50PricedOpportunityCount,0);
 assert.equal(audit.summary.configurationEvidenceStatusCounts.INVALID,2);
 assert.equal(audit.summary.configurationsWithUnavailableCanonicalUsdMetrics,2);
 assert.equal(audit.summary.lowNTailConfigurationCount,2);
 assert.equal(audit.trackMaterializationLedger.find(row=>row.identity==="e1|A"&&row.track==="modeled_expected")!.normalizedPositionStatus,"absent");
 assert.equal(audit.trackMaterializationLedger.find(row=>row.identity==="e1|A"&&row.track==="modeled_expected")!.q50Contradiction,"explicit_no_trade_conflicts_with_priced_position");
 assert.equal(audit.integrityReasonDistribution.find(row=>row.reason==="explicit_no_trade_conflicts_with_priced_position")!.affectedIdentityCount,1);
 assert.equal(audit.integrityReasonDistribution.find(row=>row.reason==="unavailable_q50_opportunity_conflicts_with_priced_position")!.affectedStructuralConfigurationCount,1);
 assert.equal(audit.q50UnavailableReasonDistribution.find(row=>row.reasonCode==="modeled_execution_not_attempted")!.count,1);
});

test("forensic audit reports canonical duplicates instead of choosing by row order",()=>{
 const rows=[opportunity("e","A","trade","c1"),opportunity("e","A","trade","c2")];
 const audit=buildResearchEconomicsForensicAudit(dataset(rows,[candidate("e","c1","A"),candidate("e","c2","A")],[outcome("e","c1"),outcome("e","c2")]));
 assert.equal(audit.summary.canonicalOpportunityRowCount,2);
 assert.equal(audit.summary.canonicalOpportunityIdentityCount,1);
 assert.equal(audit.integrityReasonDistribution.find(row=>row.reason==="duplicate canonical opportunity identity")!.affectedIdentityCount,1);
 const q50=audit.trackMaterializationLedger.filter(row=>row.identity==="e|A"&&row.track==="modeled_expected");
 assert.ok(q50.every(row=>row.normalizedPositionStatus==="absent"));
 assert.ok(q50.every(row=>row.pricedThesisOutcome===false));
});

test("forensic audit retains noncanonical candidate attempts without treating them as economic duplicates",()=>{
 const audit=buildResearchEconomicsForensicAudit(dataset([opportunity("e","A","trade","c1")],[candidate("e","c2","A"),candidate("e","c1","A")],[outcome("e","c2"),outcome("e","c1")]));
 assert.equal(audit.canonicalOpportunityLedger[0]!.candidateRowCount,2);
 assert.deepEqual(audit.canonicalOpportunityLedger[0]!.candidateIds,["c1","c2"]);
 assert.equal(audit.trackMaterializationLedger.find(row=>row.identity==="e|A"&&row.track==="modeled_expected")!.normalizedPositionCount,2);
 assert.equal(audit.trackMaterializationLedger.find(row=>row.identity==="e|A"&&row.track==="modeled_expected")!.pricedThesisOutcome,true);
 assert.equal(audit.integrityReasonDistribution.some(row=>row.reason==="duplicate selected-track event × configuration evidence"),false);
});

test("forensic audit reports identity mismatch without coercing evidence",()=>{
 const audit=buildResearchEconomicsForensicAudit(dataset([opportunity("e","A","trade","c1")],[candidate("e","c1","B")],[outcome("e","c1")]));
 assert.equal(audit.identityReconciliation[0]!.mismatch,true);
 assert.match(audit.identityReconciliation[0]!.mismatchReason!,/disagree/);
 const q50=audit.marginAndUsdCoverage.find(item=>item.track==="modeled_expected"&&item.structuralConfigurationId==="A")!;
 assert.equal(q50.pricedPositionCount,0);
 assert.equal(q50.eligibleOpportunityIdentityCount,1);
});
