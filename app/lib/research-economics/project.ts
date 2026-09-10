import type {AnalysisDataset} from "../research-analysis.ts";
import {DEFAULT_ANALYSIS_CONFIGURATION,type PrimaryExitPolicy} from "../analysis-configuration.ts";
import {datasetForAnalyticsTrack} from "../research-analytics-model.ts";
import {normalizePositionEconomics,type PositionEconomics} from "../economics/position.ts";
import {EXIT_POLICIES} from "../exit-policy/policies.ts";
import {deriveUsdMetrics} from "./statistics.ts";
import type {ResearchEconomicLayer,ResearchEconomicObservation} from "./types.ts";

const layers:readonly [ResearchEconomicLayer,"reference"|"modeled_expected"|"modeled_conservative"][]=[
 ["reference","reference"],
 ["modeled_expected","modeled_expected"],
 ["modeled_conservative","modeled_conservative"],
];
const number=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:null;
const string=(value:unknown)=>typeof value==="string"&&value?value:null;
const field=(position:PositionEconomics,...keys:string[])=>{const row=position as unknown as Record<string,unknown>;for(const key of keys)if(row[key]!==undefined)return row[key];return null};
const configField=(position:PositionEconomics,...keys:string[])=>{const config=position.structuralConfiguration;for(const key of keys)if(config?.[key]!==undefined)return config[key];return null};
const usd=(position:PositionEconomics,...keys:string[])=>number(field(position,...keys));

/**
 * Projects only exported canonical USD values. There is intentionally no
 * BTC × spot/index fallback in this Research boundary.
 */
export function projectResearchEconomicObservations(dataset:AnalysisDataset):readonly ResearchEconomicObservation[]{
 const observations:ResearchEconomicObservation[]=[];
 for(const [analyticalTrack,track] of layers)for(const policy of EXIT_POLICIES){
  const positions=normalizePositionEconomics(datasetForAnalyticsTrack(dataset,track),{...DEFAULT_ANALYSIS_CONFIGURATION,exitPolicy:policy.id as PrimaryExitPolicy});
  for(const position of positions){
   const requestedWidth=number(position.requestedWidth)??number(configField(position,"requested_width","requestedWidth","width"));
   const strikeMethod=position.strikeMethod??string(configField(position,"strike_method","strikeMethod"));
   const dte=string(configField(position,"target_dte_family","dte_family","dteFamily"))??String(number(configField(position,"target_dte_days","targetDteDays"))??position.actualDteDays??"unknown").replace(/D$/i,"")+"D";
   if(!position.structuralConfigurationId||requestedWidth===null||!strikeMethod)continue;
   const openingIm=usd(position,"openingInitialMarginUsd","incrementalInitialMarginUsd");
   const peakIm=usd(position,"peakInitialMarginUsd");
   const holding=position.holdingDays;
   observations.push(deriveUsdMetrics({eventId:position.eventId,candidateId:position.candidateId,structuralConfigurationId:position.structuralConfigurationId,direction:position.direction??"unknown",dteFamily:dte,actualDteDays:position.actualDteDays,strikeMethod,requestedWidth,actualWidth:position.actualWidth,structureFamily:position.structureType??string(configField(position,"structure_family","structureFamily"))??"vertical",exitPolicy:policy.id,analyticalTrack,analyticsTrack:position.analyticsTrack,eligible:true,coverageStatus:position.status==="priced"?"priced":"unavailable",reasonCode:position.diagnosticCode??position.missingReason,grossOpeningCreditUsd:usd(position,"grossOpeningCreditUsd"),openingFeesUsd:usd(position,"openingFeesUsd"),netOpeningCreditUsd:usd(position,"netOpeningCreditUsd","netOpeningCashFlowUsd"),maximumStructuralLossUsd:position.maximumStructuralLossUsd.value,trackMaximumNetLossUsd:position.trackMaximumNetLossUsd.value,openingInitialMarginUsd:openingIm,peakInitialMarginUsd:peakIm,pnlUsd:position.pnlUsd,holdingDays:holding,totalRealizedFeesUsd:usd(position,"totalRealizedFeesUsd"),capitalDaysUsd:usd(position,"capitalDaysUsd")}));
  }
 }
 return observations;
}
