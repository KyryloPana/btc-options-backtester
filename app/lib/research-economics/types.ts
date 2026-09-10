import type {AnalyticsTrack} from "../research-analytics-model.ts";

export type ResearchEconomicLayer="reference"|"modeled_expected"|"modeled_conservative";
export type ResearchDimension="dte"|"strike"|"width";
export type CoverageStatus="priced"|"explicit_no_trade"|"unavailable";

export interface ResearchEconomicObservation {
 eventId:string;candidateId:string|null;structuralConfigurationId:string;direction:string;dteFamily:string;actualDteDays:number|null;strikeMethod:string;requestedWidth:number;actualWidth:number|null;structureFamily:string;exitPolicy:string;analyticalTrack:ResearchEconomicLayer;analyticsTrack?:AnalyticsTrack|null;
 eligible:boolean;coverageStatus:CoverageStatus;reasonCode:string|null;
 grossOpeningCreditUsd:number|null;openingFeesUsd:number|null;netOpeningCreditUsd:number|null;
 maximumStructuralLossUsd:number|null;trackMaximumNetLossUsd:number|null;openingInitialMarginUsd:number|null;peakInitialMarginUsd:number|null;
 pnlUsd:number|null;holdingDays:number|null;totalRealizedFeesUsd:number|null;capitalDaysUsd:number|null;
 feeDragUsd:number|null;returnOnStructuralLossUsd:number|null;returnOnOpeningImUsd:number|null;returnOnPeakImUsd:number|null;pnlPerCapitalDayUsd:number|null;
}

export type NumericMetric=Exclude<{[K in keyof ResearchEconomicObservation]:ResearchEconomicObservation[K] extends number|null?K:never}[keyof ResearchEconomicObservation],undefined>;
export interface Statistic {value:number|null;rawDenominator:number;effectiveN:number;unavailableCount:number;reason:string|null}
export interface TailStatistic extends Statistic {minimumN:number}
export interface CoverageSummary {eligibleN:number;pricedN:number;explicitNoTradeN:number;unavailableN:number;coverage:number}
export interface EconomicSummary extends CoverageSummary {
 weighting:"equal_event";eventsRepresented:number;
 medianGrossOpeningCreditUsd:Statistic;medianNetOpeningCreditUsd:Statistic;medianTotalFeesUsd:Statistic;medianFeeDragUsd:Statistic;
 meanPnlUsd:Statistic;medianPnlUsd:Statistic;opportunityExpectancyUsd:Statistic;worstPnlUsd:Statistic;p10PnlUsd:TailStatistic;p5PnlUsd:TailStatistic;
 medianMaximumStructuralLossUsd:Statistic;medianTrackMaximumNetLossUsd:Statistic;medianOpeningInitialMarginUsd:Statistic;medianPeakInitialMarginUsd:Statistic;
 medianReturnOnStructuralLossUsd:Statistic;medianReturnOnOpeningImUsd:Statistic;medianReturnOnPeakImUsd:Statistic;medianHoldingDays:Statistic;medianCapitalDaysUsd:Statistic;medianPnlPerCapitalDayUsd:Statistic;
}
export interface DimensionBucket {key:string;numericKey:number|null;summary:EconomicSummary}
export interface MetricDelta {metric:NumericMetric;medianDelta:Statistic}
export interface MatchedComparison {dimension:ResearchDimension;source:string;destination:string;label:string;commonPairedN:number;unpairedN:number;effectiveNByMetric:Readonly<Record<string,number>>;missingReasons:Readonly<Record<string,number>>;deltas:readonly MetricDelta[]}
export interface InteractionCell {row:string;column:string;summary:EconomicSummary}
export interface InteractionMatrix {rows:readonly string[];columns:readonly string[];cells:readonly InteractionCell[]}
export interface ExecutionStage {layer:ResearchEconomicLayer;summary:Readonly<Record<string,Statistic>>}
export interface ExecutionSurvivalBucket {bucket:string;stages:readonly ExecutionStage[];degradation:readonly MatchedComparison[]}
export interface ExitPolicyComparison {baseline:string;policy:string;comparison:MatchedComparison}
export interface ConfigurationMatrixRow {structuralConfigurationId:string;dteFamily:string;strikeMethod:string;requestedWidth:number;structureFamily:string;summary:EconomicSummary}
export interface ResearchEconomicsReport {
 selectedDisplayLayer:ResearchEconomicLayer;defaultDisplayLayer:"modeled_expected";selectedResearchExitPolicy:string|null;outcomeState:"available"|"Exit policy required";
 universe:"full eligible event × ex-ante structural configuration × exit policy × analytical layer matrix";observationIdentity:readonly string[];weighting:"equal_event";tailMinimumN:number;
 observations:readonly ResearchEconomicObservation[];marginals:{dte:readonly DimensionBucket[];strike:readonly DimensionBucket[];width:readonly DimensionBucket[]};
 controlledComparisons:{dte:readonly MatchedComparison[];strike:readonly MatchedComparison[];widthAdjacent:readonly MatchedComparison[]};
 interactions:{dteByWidth:InteractionMatrix;dteByStrike:InteractionMatrix;strikeByWidth:InteractionMatrix};
 executionSurvival:{dte:readonly ExecutionSurvivalBucket[];strike:readonly ExecutionSurvivalBucket[];width:readonly ExecutionSurvivalBucket[]};exitPolicyEconomics:readonly ExitPolicyComparison[];configurationMatrix:readonly ConfigurationMatrixRow[];
 exclusions:{portfolioEconomics:true;fields:readonly string[]};
}
