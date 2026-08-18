/**
 * Locked analysis configuration.
 *
 * Declared before any evaluation so that constraints cannot be chosen after seeing results. The
 * configuration is an input to the analysis-run identity, which keeps a given configuration
 * reproducibly tied to the run it produced. `PricingTrack` stays an explicit union because raw and
 * IV-normalized pricing must never be collapsed into a single track.
 */
export type PricingTrack="raw_vwap"|"iv_normalized";
export interface AnalysisConfiguration {pricingTrack:PricingTrack|null;executionAssumption:string|null;includedQualityLevels:string[];exitPolicy:string|null;trainingEndTimestampUtc:string|null;accountEquity:number|null;maximumRiskPerTrade:number|null;maximumMarginUtilization:number|null;dteMinimumDays:number|null;dteMaximumDays:number|null;maximumTailLossRiskUnits:number|null;maximumDrawdown:number|null;minimumCellEvents:number;uncertaintySeed:number}
export const DEFAULT_ANALYSIS_CONFIGURATION:AnalysisConfiguration={pricingTrack:null,executionAssumption:null,includedQualityLevels:[],exitPolicy:null,trainingEndTimestampUtc:null,accountEquity:null,maximumRiskPerTrade:null,maximumMarginUtilization:null,dteMinimumDays:null,dteMaximumDays:null,maximumTailLossRiskUnits:null,maximumDrawdown:null,minimumCellEvents:5,uncertaintySeed:271828};
