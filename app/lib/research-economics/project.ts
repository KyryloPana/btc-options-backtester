import type {AnalysisDataset} from "../research-analysis.ts";
import {DEFAULT_ANALYSIS_CONFIGURATION,type PrimaryExitPolicy} from "../analysis-configuration.ts";
import {datasetForAnalyticsTrack} from "../research-analytics-model.ts";
import {normalizePositionEconomics,type Available,type PositionEconomics} from "../economics/position.ts";
import {classifyEconomicOpportunity} from "../economics/opportunity.ts";
import type {StructuralConfigurationFields} from "../economics/strategy-configuration.ts";
import {deriveUsdMetrics} from "./statistics.ts";
import {EXIT_POLICIES} from "../exit-policy/policies.ts";
import type {MetricAvailability,ResearchEconomicLayer,ResearchEconomicMetric,ResearchEconomicObservation} from "./types.ts";

type OpportunityRow=Readonly<Record<string,unknown>>;
type CanonicalUsdPosition=PositionEconomics & {
 grossOpeningCreditUsd:Available<number>;openingFeesUsd:Available<number>;netOpeningCashFlowUsd:Available<number>;totalRealizedFeesUsd:Available<number>;
 incrementalInitialMarginUsd:Available<number>;peakInitialMarginUsd:Available<number>;capitalDaysUsd:Available<number>;
};
export type ResearchLayerPositions=Readonly<Record<ResearchEconomicLayer,readonly PositionEconomics[]>>;
const layers:readonly [ResearchEconomicLayer,"reference"|"modeled_expected"|"modeled_conservative"][]=[["reference","reference"],["modeled_expected","modeled_expected"],["modeled_conservative","modeled_conservative"]];

export const rawNumber=(value:unknown):number|null=>typeof value==="number"&&Number.isFinite(value)?value:null;
export const availableValue=(value:Available<number>|undefined):number|null=>value?.value!==null&&value?.value!==undefined&&Number.isFinite(value.value)?value.value:null;
export const availableReason=(value:Available<number>|undefined,fallback:string):string|null=>availableValue(value)!==null?null:value?.reason??fallback;
const text=(value:unknown)=>typeof value==="string"&&value?value:null;
const object=(value:unknown):Readonly<Record<string,unknown>>=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Readonly<Record<string,unknown>>:{};
const canonicalConfig=(row:OpportunityRow):StructuralConfigurationFields=>{const config=object(row.structural_configuration);return{targetDteFamilyDays:rawNumber(config.targetDteFamilyDays),strikeMethod:text(config.strikeMethod),requestedWidth:rawNumber(config.requestedWidth),structureFamily:text(config.structureFamily)}};
const metricReasons=(entries:readonly [ResearchEconomicMetric,string|null][]):MetricAvailability=>Object.fromEntries(entries) as unknown as MetricAvailability;
const absentReasons=(reason:string)=>metricReasons((["grossOpeningCreditUsd","openingFeesUsd","netOpeningCreditUsd","totalRealizedFeesUsd","maximumStructuralLossUsd","trackMaximumNetLossUsd","openingInitialMarginUsd","peakInitialMarginUsd","pnlUsd","capitalDaysUsd"] as const).map(key=>[key,reason]));
const positionUsd=(position:PositionEconomics)=>position as CanonicalUsdPosition;

function normalizedLayers(dataset:AnalysisDataset,researchExitPolicy:PrimaryExitPolicy|null):ResearchLayerPositions{
 // Comparative Economics is research-space analysis, not Strategy selection.
 // Keep every already-materialized candidate in the bundle; absence remains
 // unavailable, but selected-cohort routing must not discard valid research rows.
 const carrier=researchExitPolicy??"thesis";
 return Object.fromEntries(layers.map(([name,track])=>[name,normalizePositionEconomics(datasetForAnalyticsTrack(dataset,track,{cohort:"all"}),{...DEFAULT_ANALYSIS_CONFIGURATION,exitPolicy:carrier})])) as unknown as ResearchLayerPositions;
}

function identityMatches(position:PositionEconomics,eventId:string,configurationId:string){return position.eventId===eventId&&position.structuralConfigurationId===configurationId}
function isPriced(position:PositionEconomics|undefined){return Boolean(position&&position.status==="priced")}

export function projectResearchEconomicObservationsFromPositions(dataset:AnalysisDataset,researchExitPolicy:PrimaryExitPolicy|null,positionsByLayer:ResearchLayerPositions):readonly ResearchEconomicObservation[]{
 const opportunities=dataset.tables.configuration_opportunities??[];
 return layers.flatMap(([analyticalTrack])=>opportunities.map(row=>{
  const eventId=text(row.event_id)??"",configurationId=text(row.structural_configuration_id)??"",configuration=canonicalConfig(row),generation=classifyEconomicOpportunity(row.economic_opportunity),declaredCandidate=text(row.candidate_id),candidates=positionsByLayer[analyticalTrack].filter(position=>identityMatches(position,eventId,configurationId)&&(declaredCandidate===null||position.candidateId===declaredCandidate)&&(researchExitPolicy===null||position.exitPolicy===researchExitPolicy)),uniqueCandidates=new Set(candidates.map(position=>position.candidateId)),position=candidates.length===1&&uniqueCandidates.size===1?candidates[0]:undefined,validIdentity=configuration.targetDteFamilyDays!==null&&configuration.strikeMethod!==null&&configuration.requestedWidth!==null&&configuration.structureFamily!==null;
  const ambiguity=uniqueCandidates.size>1||candidates.length>1,baseReason=!validIdentity?"Canonical structural configuration identity fields are incomplete.":ambiguity?`Expected exactly one entered position for event × configuration; found ${candidates.length}.`:!position?"No uniquely matching position economics exists for this event × configuration and layer.":null;

  // The generation decision is a Q50 deployability fact. It must never erase
  // valid Reference/Q90 evidence. Only the central modeled_expected layer uses
  // explicit_no_trade as a layer state or treats generation-unavailable as a
  // blocker. A contradiction between explicit no-trade and priced Q50 evidence
  // is an integrity failure, matching the canonical Strategy opportunity guard.
  if(analyticalTrack==="modeled_expected"&&generation.status==="explicit_no_trade"){
   if(isPriced(position)){
    const reason="Canonical explicit no-trade conflicts with a priced Q50 position.";
    return deriveUsdMetrics({eventId,candidateId:position?.candidateId??declaredCandidate,structuralConfigurationId:configurationId,direction:position?.direction??"unknown",dteFamily:configuration.targetDteFamilyDays===null?null:`${configuration.targetDteFamilyDays}D`,actualDteDays:position?.actualDteDays??null,strikeMethod:configuration.strikeMethod,requestedWidth:configuration.requestedWidth,actualWidth:position?.actualWidth??null,structureFamily:configuration.structureFamily,exitPolicy:researchExitPolicy,analyticalTrack,analyticsTrack:position?.analyticsTrack??null,eligible:true,structuralIdentityValid:validIdentity,generationOpportunityStatus:generation.status,generationReasonCode:generation.reasonCode,generationReason:generation.reason,coverageStatus:"unavailable",reasonCode:"explicit_no_trade_conflicts_with_priced_position",grossOpeningCreditUsd:null,openingFeesUsd:null,netOpeningCreditUsd:null,maximumStructuralLossUsd:null,trackMaximumNetLossUsd:null,openingInitialMarginUsd:null,peakInitialMarginUsd:null,pnlUsd:null,holdingDays:null,totalRealizedFeesUsd:null,capitalDaysUsd:null,metricAvailability:absentReasons(reason)});
   }
   const reason=generation.reason??"Canonical opportunity is an explicit no-trade.";
   return deriveUsdMetrics({eventId,candidateId:declaredCandidate,structuralConfigurationId:configurationId,direction:position?.direction??"unknown",dteFamily:configuration.targetDteFamilyDays===null?null:`${configuration.targetDteFamilyDays}D`,actualDteDays:position?.actualDteDays??null,strikeMethod:configuration.strikeMethod,requestedWidth:configuration.requestedWidth,actualWidth:position?.actualWidth??null,structureFamily:configuration.structureFamily,exitPolicy:researchExitPolicy,analyticalTrack,analyticsTrack:position?.analyticsTrack??null,eligible:true,structuralIdentityValid:validIdentity,generationOpportunityStatus:generation.status,generationReasonCode:generation.reasonCode,generationReason:generation.reason,coverageStatus:"explicit_no_trade",reasonCode:generation.reasonCode,grossOpeningCreditUsd:null,openingFeesUsd:null,netOpeningCreditUsd:null,maximumStructuralLossUsd:null,trackMaximumNetLossUsd:null,openingInitialMarginUsd:null,peakInitialMarginUsd:null,pnlUsd:0,holdingDays:null,totalRealizedFeesUsd:null,capitalDaysUsd:null,metricAvailability:{...absentReasons(reason),pnlUsd:null}});
  }

  if(analyticalTrack==="modeled_expected"&&generation.status==="unavailable"){
   const reason=generation.reason??"Canonical Q50 economic opportunity is unavailable.";
   return deriveUsdMetrics({eventId,candidateId:position?.candidateId??declaredCandidate,structuralConfigurationId:configurationId,direction:position?.direction??"unknown",dteFamily:configuration.targetDteFamilyDays===null?null:`${configuration.targetDteFamilyDays}D`,actualDteDays:position?.actualDteDays??null,strikeMethod:configuration.strikeMethod,requestedWidth:configuration.requestedWidth,actualWidth:position?.actualWidth??null,structureFamily:configuration.structureFamily,exitPolicy:researchExitPolicy,analyticalTrack,analyticsTrack:position?.analyticsTrack??null,eligible:true,structuralIdentityValid:validIdentity,generationOpportunityStatus:generation.status,generationReasonCode:generation.reasonCode,generationReason:generation.reason,coverageStatus:"unavailable",reasonCode:generation.reasonCode??"economic_opportunity_unavailable",grossOpeningCreditUsd:null,openingFeesUsd:null,netOpeningCreditUsd:null,maximumStructuralLossUsd:null,trackMaximumNetLossUsd:null,openingInitialMarginUsd:null,peakInitialMarginUsd:null,pnlUsd:null,holdingDays:null,totalRealizedFeesUsd:null,capitalDaysUsd:null,metricAvailability:absentReasons(reason)});
  }

  if(!position||ambiguity||!validIdentity){const reason=baseReason!;return deriveUsdMetrics({eventId,candidateId:declaredCandidate,structuralConfigurationId:configurationId,direction:position?.direction??"unknown",dteFamily:configuration.targetDteFamilyDays===null?null:`${configuration.targetDteFamilyDays}D`,actualDteDays:position?.actualDteDays??null,strikeMethod:configuration.strikeMethod,requestedWidth:configuration.requestedWidth,actualWidth:position?.actualWidth??null,structureFamily:configuration.structureFamily,exitPolicy:researchExitPolicy,analyticalTrack,analyticsTrack:position?.analyticsTrack??null,eligible:true,structuralIdentityValid:validIdentity,generationOpportunityStatus:generation.status,generationReasonCode:generation.reasonCode,generationReason:generation.reason,coverageStatus:"unavailable",reasonCode:ambiguity?"ambiguous_event_configuration_position":!validIdentity?"invalid_structural_configuration_identity":"matching_position_unavailable",grossOpeningCreditUsd:null,openingFeesUsd:null,netOpeningCreditUsd:null,maximumStructuralLossUsd:null,trackMaximumNetLossUsd:null,openingInitialMarginUsd:null,peakInitialMarginUsd:null,pnlUsd:null,holdingDays:null,totalRealizedFeesUsd:null,capitalDaysUsd:null,metricAvailability:absentReasons(reason)})}

  const usd=positionUsd(position),exitRequired="Exit policy required",selectedExit=researchExitPolicy!==null,positionUsable=position.status==="priced",coverageStatus=positionUsable?"priced":"unavailable",coverageReason=positionUsable?null:position.missingReason??"The selected-policy position is unavailable.";
  return deriveUsdMetrics({eventId,candidateId:position.candidateId,structuralConfigurationId:configurationId,direction:position.direction??"unknown",dteFamily:`${configuration.targetDteFamilyDays}D`,actualDteDays:position.actualDteDays,strikeMethod:configuration.strikeMethod,requestedWidth:configuration.requestedWidth,actualWidth:position.actualWidth,structureFamily:configuration.structureFamily,exitPolicy:researchExitPolicy,analyticalTrack,analyticsTrack:position.analyticsTrack,eligible:true,structuralIdentityValid:true,generationOpportunityStatus:generation.status,generationReasonCode:generation.reasonCode,generationReason:generation.reason,coverageStatus,reasonCode:positionUsable?null:position.diagnosticCode??"selected_policy_position_unavailable",grossOpeningCreditUsd:availableValue(usd.grossOpeningCreditUsd),openingFeesUsd:availableValue(usd.openingFeesUsd),netOpeningCreditUsd:availableValue(usd.netOpeningCashFlowUsd),maximumStructuralLossUsd:availableValue(position.maximumStructuralLossUsd),trackMaximumNetLossUsd:availableValue(position.trackMaximumNetLossUsd),openingInitialMarginUsd:availableValue(usd.incrementalInitialMarginUsd),peakInitialMarginUsd:selectedExit?availableValue(usd.peakInitialMarginUsd):null,pnlUsd:selectedExit?position.pnlUsd:null,holdingDays:selectedExit?position.holdingDays:null,totalRealizedFeesUsd:selectedExit?availableValue(usd.totalRealizedFeesUsd):null,capitalDaysUsd:selectedExit?availableValue(usd.capitalDaysUsd):null,metricAvailability:metricReasons([["grossOpeningCreditUsd",availableReason(usd.grossOpeningCreditUsd,"Canonical gross opening credit USD is unavailable.")],["openingFeesUsd",availableReason(usd.openingFeesUsd,"Canonical opening fees USD are unavailable.")],["netOpeningCreditUsd",availableReason(usd.netOpeningCashFlowUsd,"Canonical net opening cash flow USD is unavailable.")],["totalRealizedFeesUsd",selectedExit?availableReason(usd.totalRealizedFeesUsd,"Canonical total realized fees USD are unavailable."):exitRequired],["maximumStructuralLossUsd",availableReason(position.maximumStructuralLossUsd,"Canonical maximum structural loss USD is unavailable.")],["trackMaximumNetLossUsd",availableReason(position.trackMaximumNetLossUsd,"Canonical track maximum net loss USD is unavailable.")],["openingInitialMarginUsd",availableReason(usd.incrementalInitialMarginUsd,"Canonical opening IM USD is unavailable.")],["peakInitialMarginUsd",selectedExit?availableReason(usd.peakInitialMarginUsd,"Canonical policy-window peak IM USD is unavailable."):exitRequired],["pnlUsd",selectedExit?(position.pnlUsd===null?position.missingReason??coverageReason??"Canonical selected-policy PnL USD is unavailable.":null):exitRequired],["capitalDaysUsd",selectedExit?availableReason(usd.capitalDaysUsd,"Canonical capital-days USD is unavailable."):exitRequired]])});
 }))
}

export function projectResearchEconomicObservations(dataset:AnalysisDataset,researchExitPolicy:PrimaryExitPolicy|null):readonly ResearchEconomicObservation[]{return projectResearchEconomicObservationsFromPositions(dataset,researchExitPolicy,normalizedLayers(dataset,researchExitPolicy))}

/** Auxiliary policy cube for the Thesis-relative panel; it never defines primary coverage. */
export function projectResearchExitPolicyObservations(dataset:AnalysisDataset):readonly ResearchEconomicObservation[]{return EXIT_POLICIES.flatMap(policy=>projectResearchEconomicObservations(dataset,policy.id))}
