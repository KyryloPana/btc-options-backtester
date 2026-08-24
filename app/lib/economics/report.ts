import type {AnalysisDataset} from "../research-analysis.ts";
import type {AnalysisConfiguration} from "../analysis-configuration.ts";
import {validateEconomicPolicy} from "../analysis-configuration.ts";
import {normalizePositionEconomics,type PositionEconomics} from "./position.ts";
import {reconstructPortfolio} from "./portfolio.ts";
import {datasetForAnalyticsTrack,type AnalyticsTrack} from "../research-analytics-model.ts";
function economicLayer(dataset:AnalysisDataset,configuration:AnalysisConfiguration){const positions=normalizePositionEconomics(dataset,configuration),portfolio=reconstructPortfolio(positions,configuration);return{positions,portfolio};}
export function buildEconomicReport(dataset:AnalysisDataset,configuration:AnalysisConfiguration){const reference=economicLayer(datasetForAnalyticsTrack(dataset,"reference"),{...configuration,pricingTrack:"raw_vwap",executionAssumption:"maker"});const observed={maker:economicLayer(dataset,{...configuration,executionAssumption:"maker"}),taker:economicLayer(dataset,{...configuration,executionAssumption:"taker"})};const modeled=Object.fromEntries((["modeled_expected","modeled_conservative","penalty_sensitivity"] as AnalyticsTrack[]).map(track=>[track,economicLayer(datasetForAnalyticsTrack(dataset,track),{...configuration,pricingTrack:"raw_vwap",executionAssumption:"maker"})]));const delayed=Object.fromEntries((["delayed_maker","delayed_taker"] as AnalyticsTrack[]).map(track=>[track,economicLayer(datasetForAnalyticsTrack(dataset,track),{...configuration,pricingTrack:"raw_vwap",executionAssumption:track==="delayed_taker"?"taker":"maker"})]));const positions=reference.positions,portfolio=reference.portfolio;return{configuration:{executionScenario:"reference",pricingTrack:"reference",exitPolicy:configuration.exitPolicy,marginModel:configuration.marginModel,collateralMode:configuration.collateralMode,maximumRiskFraction:configuration.maximumRiskFraction,maximumMarginUtilization:configuration.maximumMarginUtilization},configurationErrors:validateEconomicPolicy(configuration),capabilities:{structuralLoss:positions.some(x=>x.maximumStructuralLossBtc.value!==null),openingMargin:positions.some(x=>x.incrementalInitialMarginBtc.value!==null),peakMargin:positions.some(x=>x.peakInitialMarginBtc.value!==null),portfolioMargin:false},positions,portfolio,reference,observed,delayed,modeled,modeledStatus:"Uncalibrated sensitivity" as const};}
export type EconomicReport=ReturnType<typeof buildEconomicReport>;

/**
 * One compact, auditable aggregate per analytical layer.
 *
 * Reference stays the PRIMARY layer and is not replaced by a dropdown. The rows
 * below are a sensitivity comparison beside it: observed maker/taker execution,
 * the delayed openings and the modelled layers. They are read-only summaries of
 * layers `buildEconomicReport` already constructs -- no new modelling phase, and
 * no economic path is invented for a layer that does not have one.
 *
 * Coverage is reported so a layer with two priced positions is never read as
 * though it covered the whole dataset, and an unavailable layer is reported as
 * unavailable with a count rather than as zero.
 */
export type EconomicLayerKind="reference"|"observed"|"delayed"|"modeled";
export interface EconomicLayerSummary {
 readonly track:AnalyticsTrack;
 readonly label:string;
 readonly kind:EconomicLayerKind;
 readonly primary:boolean;
 readonly status:"available"|"unavailable";
 readonly reason:string|null;
 readonly positions:number;
 readonly pricedPositions:number;
 readonly unavailablePositions:number;
 readonly eventsRepresented:number;
 readonly medianNetOpeningCreditBtc:number|null;
 readonly medianExitPnlBtc:number|null;
 readonly medianReturnOnStructuralLoss:number|null;
 readonly medianReturnOnOpeningMargin:number|null;
 readonly medianReturnOnPeakCapital:number|null;
 readonly medianHoldingDays:number|null;
}

const LAYER_LABELS:Readonly<Record<string,{label:string;kind:EconomicLayerKind}>>={
 reference:{label:"Reference fair value",kind:"reference"},
 immediate_maker:{label:"Immediate Maker",kind:"observed"},
 immediate_taker:{label:"Immediate Taker",kind:"observed"},
 delayed_maker:{label:"Delayed Maker",kind:"delayed"},
 delayed_taker:{label:"Delayed Taker",kind:"delayed"},
 modeled_conservative:{label:"Conservative modeled",kind:"modeled"},
 modeled_expected:{label:"Expected modeled",kind:"modeled"},
 penalty_sensitivity:{label:"Penalty sensitivity",kind:"modeled"},
};

const med=(values:readonly (number|null)[]):number|null=>{
 const defined=values.filter((x):x is number=>x!==null&&Number.isFinite(x));
 if(!defined.length)return null;
 const sorted=[...defined].sort((a,b)=>a-b),middle=sorted.length>>1;
 return sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2;
};

function layerSummary(track:AnalyticsTrack,positions:readonly PositionEconomics[],reason:string|null):EconomicLayerSummary{
 const meta=LAYER_LABELS[track]??{label:track,kind:"modeled" as EconomicLayerKind};
 const priced=positions.filter(p=>p.status==="priced");
 return {
  track,label:meta.label,kind:meta.kind,primary:track==="reference",
  // A layer is available only when it produced at least one PRICED position.
  // Rows that exist but are unavailable keep the missingness visible instead of
  // presenting an uncalibrated or unsupported layer as a zero result.
  status:priced.length?"available":"unavailable",
  reason:priced.length?null:(reason??positions.find(p=>p.missingReason)?.missingReason
   ??"This layer produced no priced position for the selected complete exit policy."),
  positions:positions.length,pricedPositions:priced.length,
  unavailablePositions:positions.length-priced.length,
  eventsRepresented:new Set(priced.map(p=>p.eventId)).size,
  medianNetOpeningCreditBtc:med(priced.map(p=>p.netOpeningCashFlowBtc)),
  medianExitPnlBtc:med(priced.map(p=>p.pnlBtc)),
  medianReturnOnStructuralLoss:med(priced.map(p=>p.returnOnStructuralLoss.value)),
  medianReturnOnOpeningMargin:med(priced.map(p=>p.returnOnOpeningMargin.value)),
  medianReturnOnPeakCapital:med(priced.map(p=>p.returnOnPeakCapital.value)),
  medianHoldingDays:med(priced.map(p=>p.holdingDays)),
 };
}

/**
 * The sensitivity comparison is PER-POSITION. An account-level cross-track
 * comparison is not cleanly defined -- the reference portfolio reconstruction is
 * not a live Deribit portfolio simulation and each layer would open a different
 * set of positions at different times -- so no fake account comparison is forced.
 */
export function economicLayerSummaries(report:EconomicReport):readonly EconomicLayerSummary[]{
 const rows:EconomicLayerSummary[]=[layerSummary("reference",report.reference.positions,null)];
 rows.push(layerSummary("immediate_maker",report.observed.maker.positions,null));
 rows.push(layerSummary("immediate_taker",report.observed.taker.positions,null));
 for(const track of ["delayed_maker","delayed_taker"] as const)
  rows.push(layerSummary(track,report.delayed[track]?.positions??[],
   "The canonical delayed economic track is unavailable: a delayed opening alone is entry-only evidence and is never reported as a complete economic path."));
 rows.push(layerSummary("modeled_conservative",report.modeled.modeled_conservative?.positions??[],
  "Conservative modelled execution produced no priced position. It is a modelled downside sensitivity and is never substituted for expected modelled execution."));
 rows.push(layerSummary("modeled_expected",report.modeled.modeled_expected?.positions??[],
  "Expected modelled execution is unavailable until the existing calibration requirements pass. It is never shown as observed, never shown as zero, and conservative modelled execution is never substituted for it."));
 rows.push(layerSummary("penalty_sensitivity",report.modeled.penalty_sensitivity?.positions??[],
  "Penalty sensitivity produced no priced position."));
 return rows;
}
