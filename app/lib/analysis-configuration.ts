/**
 * Locked analysis configuration.
 *
 * Declared before any evaluation so that constraints cannot be chosen after seeing results. The
 * configuration is an input to the analysis-run identity, which keeps a given configuration
 * reproducibly tied to the run it produced. `PricingTrack` stays an explicit union because raw and
 * IV-normalized pricing must never be collapsed into a single track.
 *
 * WHAT THESE FIELDS ARE NOT. `pricingTrack` and `executionAssumption` are NOT a
 * workspace-wide analytical-track selector, and the visible control surface no
 * longer presents them as one. The canonical architecture routes each report to
 * the layer its question requires (see `analytical-track-layers.ts`), and every
 * layer that needs an execution scenario supplies its own.
 *
 *  - `pricingTrack` is report-scoped: the Duration & DTE operational-holding
 *    subsection is the only consumer that reads it from here, and the control is
 *    labelled with that scope.
 *  - `executionAssumption` is retained ONLY as an internal parameter for the
 *    older exit-policy and economics calculators, which set it themselves per
 *    layer. It has no visible workspace control, because a value chosen there
 *    would reach no report: `buildExitPolicyReport` and `buildEconomicReport`
 *    both override it for every layer they construct.
 *
 * `CapitalBasis` keeps the serialized token `maximum_economic_loss` for
 * compatibility with stored configurations and the run identity. The quantity it
 * selects is the canonical bounded MAXIMUM STRUCTURAL LOSS; only the visible
 * wording changed. Structural loss is not IM and not MM.
 */
export type PricingTrack="raw_vwap"|"iv_normalized";
export type ExecutionAssumption="maker"|"taker";
export type PrimaryExitPolicy="thesis"|"capture_50"|"capture_70"|"time_cap_3d"|"time_cap_5d"|"time_cap_7d"|"settlement_benchmark";
export type NearFullLossFraction=number|null;
export type MarginModel="standard"|"portfolio";
export type CollateralMode="segregated"|"cross";
export type CapitalBasis="maximum_economic_loss"|"incremental_opening_margin"|"peak_required_capital";
export interface AnalysisConfiguration {pricingTrack:PricingTrack|null;executionAssumption:ExecutionAssumption|null;includedQualityLevels:string[];exitPolicy:PrimaryExitPolicy|null;capitalBasis:CapitalBasis;nearFullLossFraction:NearFullLossFraction;trainingEndTimestampUtc:string|null;accountEquity:number|null;maximumRiskPerTrade:number|null;maximumRiskFraction:number|null;maximumMarginUtilization:number|null;marginModel:MarginModel;collateralMode:CollateralMode;dteMinimumDays:number|null;dteMaximumDays:number|null;maximumTailLossRiskUnits:number|null;maximumDrawdown:number|null;minimumCellEvents:number;uncertaintySeed:number}
export const DEFAULT_ANALYSIS_CONFIGURATION:AnalysisConfiguration={pricingTrack:null,executionAssumption:null,includedQualityLevels:[],exitPolicy:null,capitalBasis:"maximum_economic_loss",nearFullLossFraction:null,trainingEndTimestampUtc:null,accountEquity:null,maximumRiskPerTrade:null,maximumRiskFraction:null,maximumMarginUtilization:null,marginModel:"standard",collateralMode:"segregated",dteMinimumDays:null,dteMaximumDays:null,maximumTailLossRiskUnits:null,maximumDrawdown:null,minimumCellEvents:5,uncertaintySeed:271828};

/** Policy fractions are declared inputs, never inferred from report results. */
export function validateEconomicPolicy(configuration:Pick<AnalysisConfiguration,"maximumRiskFraction"|"maximumMarginUtilization">):string[]{
 const errors:string[]=[];
 for(const [label,value] of [["maximumRiskFraction",configuration.maximumRiskFraction],["maximumMarginUtilization",configuration.maximumMarginUtilization]] as const)
  if(value!==null&&(!Number.isFinite(value)||value<=0||value>=1))errors.push(`${label} must be greater than zero and less than one.`);
 return errors;
}
