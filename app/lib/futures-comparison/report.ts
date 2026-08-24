import type {AnalysisDataset} from "../research-analysis.ts";
import {datasetForAnalyticsTrack} from "../research-analytics-model.ts";
import {indexByCandidate,readCanonicalStructuralLoss} from "../canonical-structural-loss.ts";
import {EQUAL_RISK_SIZING_METHOD,FUTURES_POLICIES,equalRiskFuturesQuantity,type FuturesPolicy} from "../futures-baseline.ts";

/**
 * Options versus the canonical BTC perpetual, for the SAME MR event under
 * identical causal event timing.
 *
 * THIS REPORT MAKES NO EXCHANGE REQUESTS AND RUNS NO ENGINE. Every futures
 * number is read from the exported canonical `futures_comparisons` and
 * `futures_path` tables. The perpetual pricing engine is not duplicated here.
 *
 * TWO DENOMINATORS, NEVER MIXED.
 *   - The futures baseline is EVENT-LEVEL: exactly one perpetual observation per
 *     MR event. Aggregate futures statistics count each event once, no matter how
 *     many option structures were selected for it.
 *   - Option configurations are STRUCTURE-LEVEL. An event with six selected
 *     structures contributes six option observations and still one futures
 *     observation.
 * Reporting a futures median over structure rows would silently reweight the
 * futures population by option selection density, so the two populations are
 * counted separately and labelled.
 *
 * ENDPOINT COMPARABILITY IS EXPLICIT. A futures VPOC result is only called
 * directly comparable to an options VPOC result when both name the same event
 * thesis endpoint. A 50%-credit-capture exit has no futures analogue at all, and
 * no synthetic futures "credit capture" exit is invented for it: those rows are
 * marked benchmark-only.
 *
 * MISSINGNESS IS NEVER ZERO. Missing funding, an unreached endpoint, an
 * unavailable option valuation and an unavailable structural risk each keep
 * their own reason. An event whose VPOC endpoint is unavailable is still shown
 * when its other canonical endpoints are available.
 */

type Row=Readonly<Record<string,unknown>>;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const arr=(v:unknown):Row[]=>Array.isArray(v)?v.filter((x):x is Row=>Boolean(x)&&typeof x==="object"):[];
const median=(values:readonly number[]):number|null=>{
 if(!values.length)return null;
 const sorted=[...values].sort((a,b)=>a-b),middle=sorted.length>>1;
 return sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2;
};

/** Canonical option exit policies that have a genuine perpetual analogue. */
export const COMPARABLE_ENDPOINTS:readonly FuturesPolicy[]=FUTURES_POLICIES;
/**
 * A credit-capture exit is defined by the option premium decaying to a fraction
 * of the opening credit. A perpetual has no premium and therefore no analogue.
 */
export const NO_FUTURES_ANALOGUE_PREFIX="credit_capture" as const;

export type EndpointComparability="paired"|"benchmark_only"|"unavailable";

export interface FuturesEndpointRow {
 readonly policy:string;
 readonly triggerTimestampUtc:string|null;
 readonly decisionTimestampUtc:string|null;
 readonly observationTimestampUtc:string|null;
 readonly observationPrice:number|null;
 readonly outcome:string|null;
 readonly status:string|null;
 readonly reasonCode:string|null;
}

export interface FuturesBaseline {
 readonly eventId:string;
 readonly comparisonId:string|null;
 readonly instrument:string|null;
 readonly availability:string;
 readonly direction:string|null;
 readonly referenceEntryTimestampUtc:string|null;
 readonly referenceEntryPrice:number|null;
 readonly referenceEntryBasis:string|null;
 readonly selectedExitPolicy:string|null;
 readonly exitTimestampUtc:string|null;
 readonly exitPrice:number|null;
 readonly exitStatus:string|null;
 readonly holdingHours:number|null;
 readonly grossPnlUsdPerUnit:number|null;
 readonly feesUsdPerUnit:number|null;
 readonly slippageUsdPerUnit:number|null;
 readonly netPnlUsdPerUnitBeforeFunding:number|null;
 readonly fundingUsdPerUnit:number|null;
 readonly fundingStatus:string|null;
 readonly fundingSource:string|null;
 readonly fundingIntervalsExpected:number|null;
 readonly fundingIntervalsObserved:number|null;
 readonly netPnlUsdPerUnitAfterFunding:number|null;
 readonly riskToInvalidationUsdPerUnit:number|null;
 readonly unitConvention:string|null;
 readonly endpoints:readonly FuturesEndpointRow[];
 readonly reasonCodes:readonly string[];
 readonly pathPointCount:number;
 readonly unavailableReason:string|null;
}

export interface EqualRiskComparison {
 readonly status:"available"|"unavailable";
 readonly reason:string|null;
 readonly riskBudgetUsd:number|null;
 readonly futuresQuantity:number|null;
 readonly futuresPnlUsd:number|null;
 readonly optionPnlUsd:number|null;
 readonly differenceUsd:number|null;
}

export interface OptionComparison {
 readonly eventId:string;
 readonly candidateId:string;
 readonly actualDteDays:number|null;
 readonly shortStrike:number|null;
 readonly longStrike:number|null;
 readonly widthUsd:number|null;
 /** The canonical option endpoint this row is compared at. */
 readonly endpoint:string|null;
 readonly optionPnlUsd:number|null;
 readonly optionStatus:string;
 readonly maximumStructuralLossUsd:number|null;
 readonly structuralLossReason:string|null;
 readonly openingInitialMarginUsd:number|null;
 readonly peakInitialMarginUsd:number|null;
 readonly marginReason:string|null;
 readonly comparability:EndpointComparability;
 readonly comparabilityReason:string|null;
 readonly equalRisk:EqualRiskComparison;
}

export interface FuturesEventComparison {
 readonly baseline:FuturesBaseline;
 readonly options:readonly OptionComparison[];
}

export interface FuturesComparisonSummary {
 /** EVENT-level population. One perpetual observation per MR event. */
 readonly eventsWithBaseline:number;
 readonly eventsTotal:number;
 readonly eventsWithVpocEndpoint:number;
 readonly eventsWithInvalidationEndpoint:number;
 readonly eventsWithFixed3d:number;
 readonly eventsWithFixed5d:number;
 readonly eventsWithFixed7d:number;
 readonly eventsWithCompleteFunding:number;
 readonly eventsWithPartialOrMissingFunding:number;
 readonly medianFuturesNetPnlUsdPerUnit:number|null;
 readonly medianRiskToInvalidationUsdPerUnit:number|null;
 /** STRUCTURE-level population. Never used as a futures denominator. */
 readonly optionConfigurations:number;
 readonly pairedComparableN:number;
 readonly benchmarkOnlyN:number;
 readonly equalRiskComparableN:number;
 readonly medianPairedDifferenceUsd:number|null;
}

export interface FuturesComparisonReport {
 readonly availability:"available"|"unavailable";
 readonly unavailableReason:string|null;
 readonly events:readonly FuturesEventComparison[];
 readonly summary:FuturesComparisonSummary;
 readonly diagnostics:readonly {eventId:string;candidateId:string|null;reason:string}[];
 readonly equalRiskSizingMethod:string;
 readonly methodology:readonly string[];
}

const EMPTY_SUMMARY:FuturesComparisonSummary={
 eventsWithBaseline:0,eventsTotal:0,eventsWithVpocEndpoint:0,eventsWithInvalidationEndpoint:0,
 eventsWithFixed3d:0,eventsWithFixed5d:0,eventsWithFixed7d:0,
 eventsWithCompleteFunding:0,eventsWithPartialOrMissingFunding:0,
 medianFuturesNetPnlUsdPerUnit:null,medianRiskToInvalidationUsdPerUnit:null,
 optionConfigurations:0,pairedComparableN:0,benchmarkOnlyN:0,equalRiskComparableN:0,
 medianPairedDifferenceUsd:null,
};

const METHODOLOGY:readonly string[]=[
 "Scope. For the same MR event, this compares the selected option structures with the canonical BTC perpetual implementation under identical causal event timing. Every futures figure is read from the exported canonical futures tables: no exchange request is made here and the perpetual engine is not re-run in the browser.",
 "Two denominators, never mixed. The futures baseline is EVENT-level -- exactly one perpetual observation per MR event -- and every aggregate futures statistic counts each event once regardless of how many option structures were selected for it. Option configurations are STRUCTURE-level and are counted separately. An option configuration may be compared against its event's single futures baseline individually, but a futures median computed over structure rows would reweight the futures population by option selection density and is never reported.",
 "Endpoint comparability is explicit. A futures result is called directly comparable to an options result only when both name the same event thesis endpoint: VPOC, invalidation, fixed 3D, fixed 5D or fixed 7D. A credit-capture exit is defined by option premium decay and has no perpetual analogue, so those rows are shown as a separate benchmark and are never paired. No synthetic futures credit-capture exit is invented.",
 "Equal risk uses the canonical sizing rule and the canonical bounded structural loss as the risk budget, applied through the same shared helper the futures engine uses. It is never a second formula written here, and it never reads a fee-inclusive tail figure.",
 "Funding integrity. Actual funding is used where the canonical export reports it available; partial and missing funding stay explicit and are never silently zero. Spot or index prices are never substituted for missing perpetual data.",
 "Missingness. An event is not hidden because one endpoint is unavailable: the other canonical endpoints, the entry, the causal path and the per-unit economics that do not depend on an exit all remain visible. Every missing comparison keeps its own reason.",
 "Paired differences use matched observations only -- the same event and the same endpoint on both sides. Unmatched aggregate means are never differenced and called an options advantage. No strategy is recommended.",
];

const endpointRows=(row:Row):FuturesEndpointRow[]=>arr(row.endpoints).map(e=>({
 policy:String(e.policy??""),
 triggerTimestampUtc:str(e.trigger_timestamp_utc),decisionTimestampUtc:str(e.decision_timestamp_utc),
 observationTimestampUtc:str(e.observation_timestamp_utc),observationPrice:num(e.observation_price),
 outcome:str(e.outcome),status:str(e.status),reasonCode:str(e.reason_code),
}));

function baselineOf(row:Row,pathPointCount:number):FuturesBaseline{
 const availability=String(row.availability??"unavailable");
 return {
  eventId:str(row.event_id)??"unknown-event",comparisonId:str(row.comparison_id),
  instrument:str(row.instrument),availability,direction:str(row.direction),
  referenceEntryTimestampUtc:str(row.reference_entry_timestamp_utc),
  referenceEntryPrice:num(row.reference_entry_price),referenceEntryBasis:str(row.reference_entry_basis),
  selectedExitPolicy:str(row.exit_policy),
  exitTimestampUtc:str(row.exit_timestamp_utc),exitPrice:num(row.exit_price),exitStatus:str(row.exit_status),
  holdingHours:num(row.holding_hours),
  grossPnlUsdPerUnit:num(row.gross_pnl_usd_per_unit),feesUsdPerUnit:num(row.fees_usd_per_unit),
  slippageUsdPerUnit:num(row.slippage_usd_per_unit),
  netPnlUsdPerUnitBeforeFunding:num(row.net_pnl_usd_per_unit_before_funding),
  fundingUsdPerUnit:num(row.funding_usd_per_unit),fundingStatus:str(row.funding_status),
  fundingSource:str(row.funding_source),
  fundingIntervalsExpected:num(row.funding_intervals_expected),
  fundingIntervalsObserved:num(row.funding_intervals_observed),
  netPnlUsdPerUnitAfterFunding:num(row.net_pnl_usd_per_unit_after_funding),
  riskToInvalidationUsdPerUnit:num(row.risk_to_invalidation_usd_per_unit),
  unitConvention:str(row.unit_convention),
  endpoints:endpointRows(row),
  reasonCodes:(Array.isArray(row.reason_codes)?row.reason_codes:[]).map(String),
  pathPointCount,
  unavailableReason:availability==="available"?null:(str(row.unavailable_reason)
   ??(Array.isArray(row.reason_codes)&&row.reason_codes.length?row.reason_codes.map(String).join(", "):"The canonical futures baseline is unavailable for this event.")),
 };
}

/**
 * The option endpoint to compare at: the futures baseline's own selected exit
 * policy, so both sides name the same event thesis endpoint by construction.
 */
const comparabilityOf=(endpoint:string|null,futures:FuturesEndpointRow|undefined):{comparability:EndpointComparability;reason:string|null}=>{
 if(endpoint===null)return {comparability:"unavailable",reason:"The option side names no canonical exit endpoint."};
 if(endpoint.startsWith(NO_FUTURES_ANALOGUE_PREFIX))
  return {comparability:"benchmark_only",reason:`A ${endpoint.replaceAll("_"," ")} exit is defined by option premium decay and has no perpetual analogue. The futures result is shown as a separate benchmark rather than paired, and no synthetic futures credit-capture exit is invented.`};
 if(!COMPARABLE_ENDPOINTS.includes(endpoint as FuturesPolicy))
  return {comparability:"benchmark_only",reason:`The canonical futures baseline does not carry a ${endpoint.replaceAll("_"," ")} endpoint, so a direct endpoint comparison is unavailable.`};
 if(!futures)return {comparability:"unavailable",reason:`The futures baseline reports no ${endpoint} endpoint for this event.`};
 if(futures.status!=="available")
  return {comparability:"unavailable",reason:`The futures ${endpoint} endpoint is ${futures.outcome??futures.status??"unavailable"}${futures.reasonCode?` (${futures.reasonCode})`:""}, so this is not a paired comparison.`};
 return {comparability:"paired",reason:null};
};

export function buildFuturesComparisonReport(dataset:AnalysisDataset):FuturesComparisonReport{
 const comparisons=dataset.tables.futures_comparisons??[];
 const eventsTotal=new Set((dataset.tables.events??[]).map(e=>str(e.event_id)).filter((x):x is string=>x!==null)).size;
 if(!comparisons.length)return {
  availability:"unavailable",
  unavailableReason:"The research bundle carries no futures_comparisons rows, so no BTC perpetual baseline exists to compare against.",
  events:[],summary:{...EMPTY_SUMMARY,eventsTotal},diagnostics:[],
  equalRiskSizingMethod:EQUAL_RISK_SIZING_METHOD,methodology:METHODOLOGY,
 };

 // Reference is the primary option layer, consistent with every other report.
 const reference=datasetForAnalyticsTrack(dataset,"reference");
 const candidates=reference.tables.candidates??[],outcomes=reference.tables.outcomes??[];
 const economicsById=indexByCandidate(dataset.tables.structure_economics),
  marginById=indexByCandidate(dataset.tables.margin_scenarios);
 const pathCounts=new Map<string,number>();
 for(const row of dataset.tables.futures_path??[]){
  const id=str(row.event_id);if(id===null)continue;
  pathCounts.set(id,(pathCounts.get(id)??0)+1);
 }
 const candidatesByEvent=new Map<string,Row[]>();
 for(const row of candidates){
  const id=str(row.event_id);if(id===null)continue;
  const list=candidatesByEvent.get(id);if(list)list.push(row);else candidatesByEvent.set(id,[row]);
 }
 const diagnostics:{eventId:string;candidateId:string|null;reason:string}[]=[];

 // ONE baseline row per event. A duplicate export would otherwise multiply the
 // event-level population.
 const byEvent=new Map<string,Row>();
 for(const row of comparisons){
  const id=str(row.event_id);if(id===null)continue;
  if(byEvent.has(id)){diagnostics.push({eventId:id,candidateId:null,reason:"More than one futures baseline row was exported for this event; the first is used and the event is still counted once."});continue}
  byEvent.set(id,row);
 }

 const events:FuturesEventComparison[]=[...byEvent.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([eventId,row])=>{
  const baseline=baselineOf(row,pathCounts.get(eventId)??0);
  if(baseline.unavailableReason)diagnostics.push({eventId,candidateId:null,reason:baseline.unavailableReason});
  const endpoint=baseline.selectedExitPolicy;
  const futuresEndpoint=baseline.endpoints.find(e=>e.policy===endpoint);
  const {comparability,reason}=comparabilityOf(endpoint,futuresEndpoint);

  const options:OptionComparison[]=(candidatesByEvent.get(eventId)??[]).map(candidate=>{
   const candidateId=str(candidate.candidate_id)??"unknown-candidate";
   const strikes=candidate.actual_strikes&&typeof candidate.actual_strikes==="object"?candidate.actual_strikes as Row:{};
   const outcome=outcomes.find(o=>str(o.candidate_id)===candidateId&&str(o.outcome_type)===endpoint);
   const optionPriced=outcome?.status==="priced";
   const optionPnlUsd=optionPriced?num(outcome!.net_pnl_usd):null;
   const optionStatus=outcome===undefined?"unavailable":String(outcome.status??"unavailable");

   const loss=readCanonicalStructuralLoss({economics:economicsById.get(candidateId),margin:marginById.get(candidateId)});
   const margin=marginById.get(candidateId);
   const marginAvailable=margin?.margin_status==="available";
   const index=num(margin?.reference_index)??num(candidate.entry_index_price);
   const toUsd=(v:number|null)=>v===null||index===null?null:v*index;
   const openingIm=marginAvailable?toUsd(num(margin!.incremental_initial_margin)):null;
   const peakIm=marginAvailable?toUsd(num(margin!.peak_initial_margin)):null;

   // Equal risk: the canonical sizing rule, applied with the canonical bounded
   // structural loss and the exported per-unit invalidation distance.
   const perUnitNet=baseline.netPnlUsdPerUnitAfterFunding;
   const quantity=equalRiskFuturesQuantity(loss.usd,baseline.riskToInvalidationUsdPerUnit);
   const equalRiskReason=
    comparability!=="paired"?reason??"The endpoints are not directly comparable."
    :loss.usd===null?loss.reason??"The canonical maximum structural loss is unavailable, so no equal-risk budget exists."
    :baseline.riskToInvalidationUsdPerUnit===null?"The futures baseline reports no distance from entry to structural invalidation, so no equal-risk quantity can be derived."
    :quantity===null?"The canonical sizing rule does not produce a positive equal-risk quantity from these inputs."
    :perUnitNet===null?`The futures per-unit net result is unavailable${baseline.fundingStatus&&baseline.fundingStatus!=="available"?` (funding ${baseline.fundingStatus})`:""}, so it is left Unavailable rather than treated as zero.`
    :optionPnlUsd===null?"The option side has no priced result at this endpoint, so there is nothing to difference."
    :null;
   const futuresPnlUsd=equalRiskReason===null?perUnitNet!*quantity!:null;
   const equalRisk:EqualRiskComparison={
    status:equalRiskReason===null?"available":"unavailable",reason:equalRiskReason,
    riskBudgetUsd:loss.usd,futuresQuantity:quantity,
    futuresPnlUsd,optionPnlUsd:equalRiskReason===null?optionPnlUsd:null,
    differenceUsd:equalRiskReason===null?optionPnlUsd!-futuresPnlUsd!:null,
   };
   if(equalRiskReason!==null)diagnostics.push({eventId,candidateId,reason:equalRiskReason});

   return {
    eventId,candidateId,
    actualDteDays:num(candidate.actual_dte_days)??num(candidate.actual_dte),
    shortStrike:num(strikes.short),longStrike:num(strikes.long),widthUsd:num(strikes.width),
    endpoint,optionPnlUsd,optionStatus,
    maximumStructuralLossUsd:loss.usd,structuralLossReason:loss.reason,
    openingInitialMarginUsd:openingIm,peakInitialMarginUsd:peakIm,
    marginReason:marginAvailable?null:(str(margin?.unavailable_reason)??"No available canonical margin scenario for this structure."),
    comparability,comparabilityReason:reason,equalRisk,
   } satisfies OptionComparison;
  });
  return {baseline,options};
 });

 // EVENT-level aggregates. One row per event, never per structure.
 const available=events.filter(e=>e.baseline.availability==="available");
 const endpointAvailable=(policy:string)=>available.filter(e=>e.baseline.endpoints.some(x=>x.policy===policy&&x.status==="available")).length;
 const allOptions=events.flatMap(e=>e.options);
 const pairedDifferences=allOptions.filter(o=>o.comparability==="paired"&&o.equalRisk.status==="available"&&o.equalRisk.differenceUsd!==null)
  .map(o=>o.equalRisk.differenceUsd!);

 return {
  availability:available.length?"available":"unavailable",
  unavailableReason:available.length?null:"No exported futures baseline for any event reports an available reference series.",
  events,
  summary:{
   eventsWithBaseline:available.length,eventsTotal:eventsTotal||events.length,
   eventsWithVpocEndpoint:endpointAvailable("vpoc"),
   eventsWithInvalidationEndpoint:endpointAvailable("invalidation"),
   eventsWithFixed3d:endpointAvailable("fixed_3d"),
   eventsWithFixed5d:endpointAvailable("fixed_5d"),
   eventsWithFixed7d:endpointAvailable("fixed_7d"),
   eventsWithCompleteFunding:available.filter(e=>e.baseline.fundingStatus==="available").length,
   eventsWithPartialOrMissingFunding:available.filter(e=>e.baseline.fundingStatus!=="available").length,
   medianFuturesNetPnlUsdPerUnit:median(available.map(e=>e.baseline.netPnlUsdPerUnitAfterFunding).filter((x):x is number=>x!==null)),
   medianRiskToInvalidationUsdPerUnit:median(available.map(e=>e.baseline.riskToInvalidationUsdPerUnit).filter((x):x is number=>x!==null)),
   optionConfigurations:allOptions.length,
   pairedComparableN:allOptions.filter(o=>o.comparability==="paired").length,
   benchmarkOnlyN:allOptions.filter(o=>o.comparability==="benchmark_only").length,
   equalRiskComparableN:pairedDifferences.length,
   medianPairedDifferenceUsd:median(pairedDifferences),
  },
  diagnostics,
  equalRiskSizingMethod:EQUAL_RISK_SIZING_METHOD,
  methodology:METHODOLOGY,
 };
}
