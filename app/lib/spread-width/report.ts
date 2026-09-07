import type {AnalysisDataset} from "../research-analysis.ts";
import {observedPercentiles} from "../underlying-resolution/statistics.ts";
import {cohortOf,resolutionSpeedBoundaries,type ResolutionSpeedBoundaries,type ResolutionSpeedCohort} from "../duration-dte/resolution-speed.ts";
import {datasetForAnalyticsCohort,datasetForAnalyticsTrack} from "../research-analytics-model.ts";
import {normalizeWidthStructures,type ExecutionScenario,type WidthStructure} from "./normalize.ts";

/**
 * Spread-Width Analysis view model.
 *
 * THE QUESTION: for a fixed event, expiry, short strike, execution scenario and
 * exit policy, how much protective width gives the best tradeoff between credit
 * retained, tail-risk reduction, fees and capital efficiency?
 *
 * NOT "which width made the most money". The report is built to expose whether
 * a STABLE, economically defensible width REGION exists -- adjacent widths
 * behaving similarly, tolerable fee drag, a long leg that materially bounds the
 * tail, and results that survive taker pricing -- rather than to crown the
 * single best-performing historical cell. Selection happens later, elsewhere.
 *
 * THE UNIT is a matched width group: same MR event, same actual expiry, same
 * SHORT STRIKE, same execution scenario, same exit policy. Only the protective
 * long differs. Comparing widths across different short strikes would attribute
 * a placement difference to width, so the short strike is part of the key.
 * Maker and taker are separate scenarios and never share a statistic.
 */

export interface WidthBandRow {
 readonly actualWidthUsd:number;
 readonly n:number;
 readonly eventN:number;
 readonly metricN:Readonly<Record<string,number>>;
 readonly substitutedN:number;
 readonly medianGrossCreditUsd:number|null;
 readonly medianNetCreditUsd:number|null;
 readonly medianCreditPerActualWidth:number|null;
 readonly medianCreditPerRequestedWidth:number|null;
 readonly medianCreditPerStructuralLoss:number|null;
 readonly medianLongLegCostUsd:number|null;
 readonly medianLongLegShareOfShortPremium:number|null;
 readonly medianFeeDragOnOpening:number|null;
 readonly medianFeeDragRoundTrip:number|null;
 readonly medianBreakEvenIndex:number|null;
 readonly medianStructuralLossUsd:number|null;
}

export interface ProtectionRow {
 readonly actualWidthUsd:number;
 readonly n:number;
 readonly eventN:number;
 readonly metricN:Readonly<Record<string,number>>;
 readonly medianProtectionCostUsd:number|null;
 readonly medianBenefitAtLongStrikeUsd:number|null;
 readonly medianBenefitAtDeepTailUsd:number|null;
 readonly medianNetProtectionValueUsd:number|null;
}

export interface PathRiskRow {
 readonly actualWidthUsd:number;
 readonly n:number;
 readonly eventN:number;
 readonly metricN:Readonly<Record<string,number>>;
 readonly medianPnlAtVpocUsd:number|null;
 readonly medianPnlAtInvalidationUsd:number|null;
 readonly medianWorstAdverseUsd:number|null;
 readonly medianMaeUsd:number|null;
 readonly medianSettlementUsd:number|null;
 readonly touchedN:number;
 readonly breachedN:number;
 readonly medianTouchedPnlUsd:number|null;
 readonly medianBreachedPnlUsd:number|null;
}

export interface CapitalRow {
 readonly actualWidthUsd:number;
 readonly n:number;
 readonly eventN:number;
 readonly metricN:Readonly<Record<string,number>>;
 readonly medianStructuralLossUsd:number|null;
 readonly openingMarginAvailableN:number;
 readonly peakMarginAvailableN:number;
 readonly medianOpeningMarginUsd:number|null;
 readonly medianPeakMarginUsd:number|null;
 readonly medianReturnOnStructuralLoss:number|null;
 readonly medianReturnOnOpeningMargin:number|null;
 readonly medianReturnOnPeakCapital:number|null;
 /** The shared reason opening/peak margin is missing, when it is. */
 readonly marginUnavailableReason:string|null;
}

export interface SlowResolutionCell {
 readonly cohort:ResolutionSpeedCohort;
 readonly n:number;
 readonly eventN:number;
 readonly realizedN:number;
 readonly adverseN:number;
 readonly medianRealizedPnlUsd:number|null;
 readonly medianWorstAdverseUsd:number|null;
}
export interface SlowResolutionRow {readonly actualWidthUsd:number;readonly cells:readonly SlowResolutionCell[]}

/** One step between two adjacent actual widths inside a matched group. */
export interface AdjacentWidthStep {
 readonly matchKey:string;
 readonly eventId:string;
 readonly executionScenario:ExecutionScenario|null;
 readonly shortStrike:number|null;
 readonly actualDteDays:number|null;
 readonly narrowerWidthUsd:number;
 readonly widerWidthUsd:number;
 /** Wider minus narrower, in each metric's own units. Null when either side is Unavailable. */
 readonly deltaNetCreditUsd:number|null;
 readonly deltaFeeDragRoundTrip:number|null;
 readonly deltaStructuralLossUsd:number|null;
 readonly deltaPnlAtInvalidationUsd:number|null;
 readonly deltaWorstAdverseUsd:number|null;
 readonly deltaSettlementUsd:number|null;
 readonly deltaProtectionBenefitUsd:number|null;
 readonly deltaReturnOnStructuralLoss:number|null;
 readonly deltaReturnOnOpeningMargin:number|null;
 readonly deltaReturnOnPeakCapital:number|null;
 readonly economicsComparable:boolean;
}

export interface WidthGroup {
 readonly matchKey:string;
 readonly eventId:string;
 readonly shortStrike:number|null;
 readonly actualDteDays:number|null;
 readonly executionScenario:ExecutionScenario|null;
 /** Sorted ascending by actual width. */
 readonly structures:readonly WidthStructure[];
 readonly steps:readonly AdjacentWidthStep[];
}

export interface WidthSummary {
 readonly structures:number;
 readonly matchedGroups:number;
 readonly matchedObservations:number;
 readonly adjacentSteps:number;
 readonly distinctActualWidths:readonly number[];
 readonly substitutedWidthN:number;
 readonly medianNetCreditUsd:number|null;
 readonly medianStructuralLossUsd:number|null;
 readonly medianFeeDragRoundTrip:number|null;
 readonly structuralLossAvailableN:number;
 readonly openingMarginAvailableN:number;
 readonly peakMarginAvailableN:number;
}

export interface SpreadWidthReport {
 readonly scenario:ExecutionScenario|"reference";
 readonly structures:readonly WidthStructure[];
 readonly groups:readonly WidthGroup[];
 readonly summary:WidthSummary;
 readonly entryEconomics:readonly WidthBandRow[];
 readonly protection:readonly ProtectionRow[];
 readonly pathRisk:readonly PathRiskRow[];
 readonly capital:readonly CapitalRow[];
 readonly slowResolution:readonly SlowResolutionRow[];
 readonly cohortBoundaries:ResolutionSpeedBoundaries;
 readonly unmatched:readonly {structure:WidthStructure;reason:string}[];
 readonly methodology:readonly string[];
 readonly robustness?:Readonly<Record<ExecutionScenario,SpreadWidthReport>>;
}

const median=(values:readonly number[]):number|null=>values.length?observedPercentiles(values,[0.5])[0]??null:null;
const defined=(values:readonly (number|null)[]):number[]=>values.filter((x):x is number=>x!==null);
const diff=(a:number|null,b:number|null):number|null=>a===null||b===null?null:a-b;
const COHORTS:readonly ResolutionSpeedCohort[]=["fast","normal","slow","unresolved"];

function bandRow(width:number,rows:readonly WidthStructure[]):WidthBandRow{
 const count=(f:(r:WidthStructure)=>unknown)=>rows.filter(r=>f(r)!==null).length;
 return {
  actualWidthUsd:width,n:rows.length,eventN:new Set(rows.map(r=>r.eventId)).size,
  metricN:{grossCredit:count(r=>r.entry.grossCreditUsd),netCredit:count(r=>r.entry.netCreditUsd),creditActual:count(r=>r.entry.creditPerActualWidth),creditRequested:count(r=>r.entry.creditPerRequestedWidth),creditStructural:count(r=>r.entry.creditPerStructuralLoss),structuralLoss:count(r=>r.payoff.maximumStructuralLossUsd.value),feeDragOpening:count(r=>r.entry.feeDragOnOpening),feeDrag:count(r=>r.entry.feeDragRoundTrip),breakeven:count(r=>r.payoff.breakEvenIndex.value),longLegCost:count(r=>r.protection.longLegPremiumUsd),longShare:count(r=>r.entry.longLegCostShareOfShortPremium)},
  substitutedN:rows.filter(r=>r.identity.widthSubstituted).length,
  medianGrossCreditUsd:median(defined(rows.map(r=>r.entry.grossCreditUsd))),
  medianNetCreditUsd:median(defined(rows.map(r=>r.entry.netCreditUsd))),
  medianCreditPerActualWidth:median(defined(rows.map(r=>r.entry.creditPerActualWidth))),
  medianCreditPerRequestedWidth:median(defined(rows.map(r=>r.entry.creditPerRequestedWidth))),
  medianCreditPerStructuralLoss:median(defined(rows.map(r=>r.entry.creditPerStructuralLoss))),
  medianLongLegCostUsd:median(defined(rows.map(r=>r.protection.longLegPremiumUsd))),
  medianLongLegShareOfShortPremium:median(defined(rows.map(r=>r.entry.longLegCostShareOfShortPremium))),
  medianFeeDragOnOpening:median(defined(rows.map(r=>r.entry.feeDragOnOpening))),
  medianFeeDragRoundTrip:median(defined(rows.map(r=>r.entry.feeDragRoundTrip))),
  medianBreakEvenIndex:median(defined(rows.map(r=>r.payoff.breakEvenIndex.value))),
  medianStructuralLossUsd:median(defined(rows.map(r=>r.payoff.maximumStructuralLossUsd.value))),
 };
}

function protectionRow(width:number,rows:readonly WidthStructure[]):ProtectionRow{
 const count=(f:(r:WidthStructure)=>unknown)=>rows.filter(r=>f(r)!==null).length;
 return {
  actualWidthUsd:width,n:rows.length,eventN:new Set(rows.map(r=>r.eventId)).size,
  metricN:{protectionCost:count(r=>r.protection.totalProtectionCostUsd),grossBenefit:count(r=>r.protection.benefitAtDeepTailUsd.value),netProtection:count(r=>r.protection.netProtectionValueUsd)},
  medianProtectionCostUsd:median(defined(rows.map(r=>r.protection.totalProtectionCostUsd))),
  medianBenefitAtLongStrikeUsd:median(defined(rows.map(r=>r.protection.benefitAtLongStrikeUsd.value))),
  medianBenefitAtDeepTailUsd:median(defined(rows.map(r=>r.protection.benefitAtDeepTailUsd.value))),
  medianNetProtectionValueUsd:median(defined(rows.map(r=>r.protection.netProtectionValueUsd))),
 };
}

function pathRiskRow(width:number,rows:readonly WidthStructure[]):PathRiskRow{
 const touched=rows.filter(r=>r.challenge.touched===true),breached=rows.filter(r=>r.challenge.breached===true);
 return {
  actualWidthUsd:width,n:rows.length,eventN:new Set(rows.map(r=>r.eventId)).size,
  metricN:{vpoc:defined(rows.map(r=>r.pnlAtVpocUsd)).length,invalidation:defined(rows.map(r=>r.pnlAtInvalidationUsd)).length,worstAdverse:defined(rows.map(r=>r.worstAdverseUsd)).length,mae:defined(rows.map(r=>r.maeUsd)).length,settlement:defined(rows.map(r=>r.pnlAtSettlementUsd)).length,touched:defined(touched.map(r=>r.realizedPnlUsd)).length,breached:defined(breached.map(r=>r.realizedPnlUsd)).length},
  medianPnlAtVpocUsd:median(defined(rows.map(r=>r.pnlAtVpocUsd))),
  medianPnlAtInvalidationUsd:median(defined(rows.map(r=>r.pnlAtInvalidationUsd))),
  medianWorstAdverseUsd:median(defined(rows.map(r=>r.worstAdverseUsd))),
  medianMaeUsd:median(defined(rows.map(r=>r.maeUsd))),
  medianSettlementUsd:median(defined(rows.map(r=>r.pnlAtSettlementUsd))),
  touchedN:touched.length,breachedN:breached.length,
  medianTouchedPnlUsd:median(defined(touched.map(r=>r.realizedPnlUsd))),
  medianBreachedPnlUsd:median(defined(breached.map(r=>r.realizedPnlUsd))),
 };
}

function capitalRow(width:number,rows:readonly WidthStructure[]):CapitalRow{
 const opening=rows.filter(r=>r.capital.incrementalInitialMarginUsd.value!==null);
 const peak=rows.filter(r=>r.capital.peakMarginUsd.value!==null);
 return {
  actualWidthUsd:width,n:rows.length,eventN:new Set(rows.map(r=>r.eventId)).size,
  metricN:{structuralLoss:defined(rows.map(r=>r.capital.maximumStructuralLossUsd.value)).length,openingMargin:opening.length,peakMargin:peak.length,returnStructural:defined(rows.map(r=>r.capital.returnOnStructuralLoss.value)).length,returnOpening:defined(rows.map(r=>r.capital.returnOnOpeningMargin.value)).length,returnPeak:defined(rows.map(r=>r.capital.returnOnPeakCapital.value)).length},
  medianStructuralLossUsd:median(defined(rows.map(r=>r.capital.maximumStructuralLossUsd.value))),
  openingMarginAvailableN:opening.length,peakMarginAvailableN:peak.length,
  medianOpeningMarginUsd:median(defined(opening.map(r=>r.capital.incrementalInitialMarginUsd.value))),
  medianPeakMarginUsd:median(defined(peak.map(r=>r.capital.peakMarginUsd.value))),
  medianReturnOnStructuralLoss:median(defined(rows.map(r=>r.capital.returnOnStructuralLoss.value))),
  medianReturnOnOpeningMargin:median(defined(rows.map(r=>r.capital.returnOnOpeningMargin.value))),
  medianReturnOnPeakCapital:median(defined(rows.map(r=>r.capital.returnOnPeakCapital.value))),
  marginUnavailableReason:opening.length===0?rows[0]?.capital.incrementalInitialMarginUsd.reason??null:null,
 };
}

function stepOf(narrower:WidthStructure,wider:WidthStructure):AdjacentWidthStep{
 const economicsComparable=narrower.executionScenarioStatus==="evaluated"&&wider.executionScenarioStatus==="evaluated";
 const eco=<T,>(value:T|null):T|null=>economicsComparable?value:null;
 return {
  matchKey:narrower.matchKey,eventId:narrower.eventId,executionScenario:narrower.executionScenario,
  shortStrike:narrower.identity.shortStrike,actualDteDays:narrower.actualDteDays,
  narrowerWidthUsd:narrower.identity.actualWidthUsd!,widerWidthUsd:wider.identity.actualWidthUsd!,
  deltaNetCreditUsd:eco(diff(wider.entry.netCreditUsd,narrower.entry.netCreditUsd)),
  deltaFeeDragRoundTrip:eco(diff(wider.entry.feeDragRoundTrip,narrower.entry.feeDragRoundTrip)),
  deltaStructuralLossUsd:diff(wider.payoff.maximumStructuralLossUsd.value,narrower.payoff.maximumStructuralLossUsd.value),
  deltaPnlAtInvalidationUsd:eco(diff(wider.pnlAtInvalidationUsd,narrower.pnlAtInvalidationUsd)),
  deltaWorstAdverseUsd:eco(diff(wider.worstAdverseUsd,narrower.worstAdverseUsd)),
  deltaSettlementUsd:eco(diff(wider.pnlAtSettlementUsd,narrower.pnlAtSettlementUsd)),
  deltaProtectionBenefitUsd:eco(diff(wider.protection.benefitAtDeepTailUsd.value,narrower.protection.benefitAtDeepTailUsd.value)),
  deltaReturnOnStructuralLoss:eco(diff(wider.capital.returnOnStructuralLoss.value,narrower.capital.returnOnStructuralLoss.value)),
  deltaReturnOnOpeningMargin:eco(diff(wider.capital.returnOnOpeningMargin.value,narrower.capital.returnOnOpeningMargin.value)),
  deltaReturnOnPeakCapital:eco(diff(wider.capital.returnOnPeakCapital.value,narrower.capital.returnOnPeakCapital.value)),
  economicsComparable,
 };
}

export function buildSpreadWidthReport(dataset:AnalysisDataset,scenario?:ExecutionScenario):SpreadWidthReport{
 const primary=scenario===undefined;
 const selected=datasetForAnalyticsCohort(dataset,"selected");
 const track=primary?"reference":scenario==="maker"?"immediate_maker":"immediate_taker";
 // Legacy tabular fixtures/bundles can already be scenario-projected but carry
 // no analytics_track column. Preserve that compatibility only for explicit
 // robustness calls; current bundles always use the canonical projector.
 const canonical=primary||selected.tables.candidates.some(r=>typeof r.analytics_track==="string");
 const all=normalizeWidthStructures(canonical?datasetForAnalyticsTrack(selected,track):selected);
 const structures=all.filter(s=>primary?s.analyticsTrack==="reference":s.executionScenario===scenario&&(canonical?s.analyticsTrack===track:true));
 const boundaries=resolutionSpeedBoundaries(dataset);

 const byKey=new Map<string,WidthStructure[]>();
 for(const s of structures){const list=byKey.get(s.matchKey);if(list)list.push(s);else byKey.set(s.matchKey,[s])}
 const groups:WidthGroup[]=[],unmatched:{structure:WidthStructure;reason:string}[]=[];
 for(const group of byKey.values()){
  // Only structures with a known ACTUAL width can be ordered by width; the
  // requested width is never used to place a structure in the ladder.
  const ordered=group.filter(s=>s.identity.actualWidthUsd!==null)
   .sort((a,b)=>a.identity.actualWidthUsd!-b.identity.actualWidthUsd!);
  for(const s of group.filter(s=>s.identity.actualWidthUsd===null))
   unmatched.push({structure:s,reason:"The canonical candidate has no actual strike width, so it cannot be placed on the width ladder."});
  const distinctWidths=new Set(ordered.map(s=>s.identity.actualWidthUsd));
  if(distinctWidths.size<2){
   for(const s of ordered)unmatched.push({structure:s,reason:"No other width shares this event, expiry, DTE, short strike and exit policy, so there is nothing to compare it against."});
   continue;
  }
  const steps:AdjacentWidthStep[]=[];
  for(let i=0;i<ordered.length-1;i++){
   // Two structures at the same actual width are not a width step.
   if(ordered[i]!.identity.actualWidthUsd===ordered[i+1]!.identity.actualWidthUsd)continue;
   steps.push(stepOf(ordered[i]!,ordered[i+1]!));
  }
  groups.push({matchKey:ordered[0]!.matchKey,eventId:ordered[0]!.eventId,shortStrike:ordered[0]!.identity.shortStrike,
   actualDteDays:ordered[0]!.actualDteDays,executionScenario:ordered[0]!.executionScenario,structures:ordered,steps});
 }
 groups.sort((a,b)=>a.eventId.localeCompare(b.eventId)||(a.shortStrike??0)-(b.shortStrike??0));

 // Width bands are drawn from ACTUAL widths present in matched groups.
 const matched=groups.flatMap(g=>g.structures);
 const widths=[...new Set(defined(matched.map(s=>s.identity.actualWidthUsd)))].sort((a,b)=>a-b);
 const atWidth=(w:number)=>matched.filter(s=>s.identity.actualWidthUsd===w);

 const report:SpreadWidthReport={
  scenario:primary?"reference":scenario!,structures,groups,
  summary:{
   structures:structures.length,
   matchedGroups:groups.length,
   matchedObservations:matched.length,
   adjacentSteps:groups.reduce((n,g)=>n+g.steps.length,0),
   distinctActualWidths:widths,
   substitutedWidthN:structures.filter(s=>s.identity.widthSubstituted).length,
   medianNetCreditUsd:median(defined(matched.map(s=>s.entry.netCreditUsd))),
   medianStructuralLossUsd:median(defined(matched.map(s=>s.payoff.maximumStructuralLossUsd.value))),
   medianFeeDragRoundTrip:median(defined(matched.map(s=>s.entry.feeDragRoundTrip))),
   structuralLossAvailableN:matched.filter(s=>s.payoff.maximumStructuralLossUsd.value!==null).length,
   openingMarginAvailableN:matched.filter(s=>s.capital.incrementalInitialMarginUsd.value!==null).length,
   peakMarginAvailableN:matched.filter(s=>s.capital.peakMarginUsd.value!==null).length,
  },
  entryEconomics:widths.map(w=>bandRow(w,atWidth(w))),
  protection:widths.map(w=>protectionRow(w,atWidth(w))),
  pathRisk:widths.map(w=>pathRiskRow(w,atWidth(w))),
  capital:widths.map(w=>capitalRow(w,atWidth(w))),
  slowResolution:widths.map(w=>({actualWidthUsd:w,cells:COHORTS.map(cohort=>{
   const rows=atWidth(w).filter(s=>cohortOf(s.timeToResolutionDays,boundaries)===cohort);
   return {cohort,n:rows.length,eventN:new Set(rows.map(s=>s.eventId)).size,realizedN:defined(rows.map(s=>s.realizedPnlUsd)).length,adverseN:defined(rows.map(s=>s.worstAdverseUsd)).length,
    medianRealizedPnlUsd:median(defined(rows.map(s=>s.realizedPnlUsd))),
    medianWorstAdverseUsd:median(defined(rows.map(s=>s.worstAdverseUsd)))};
  })})),
  cohortBoundaries:boundaries,
  unmatched,
  methodology:[
   "Scope. This report analyses PROTECTIVE WIDTH only. The short strike is held constant inside every comparison and is never re-optimized here: the short strike decides where risk begins, width decides how much tail exposure is retained and how much protection is purchased. Short-strike placement is a separate report.",
   `Comparison unit. A matched width group requires at least two DISTINCT actual widths and holds the same MR event, actual expiry and DTE, SHORT STRIKE, option/structure and thesis_exit_v1 policy; only the protective long differs. The report is scoped to the selected strategy cohort and ${primary?"Reference fair-value":scenario} track; controlled-research candidates and other analytical tracks are excluded before grouping.`,
   "Requested versus actual width. Historical strike availability frequently forces the protective long onto a strike other than the one requested. Every economic figure -- payoff, credit ratio, maximum loss, capital return -- is computed from the ACTUAL contracts, and structures are ordered on the ladder by actual width. The requested width is retained beside it for audit and is reported as substituted where the two differ, but it is never fed into a calculation.",
   "Structural risk is consumed, not recomputed. The canonical risk figure is the bounded MAXIMUM STRUCTURAL LOSS already exported by the research bundle: structure_economics is the primary source and margin_scenarios is read as reconciliation. Where both are present and materially disagree, the figure is reported Unavailable as an integrity failure rather than resolved by preferring one. This report no longer derives its own fee-inclusive maximum from a payoff extremum sampled at an unbounded settlement index.",
   "Settlement fees remain real and remain separate. A delivery fee is a fixed BTC amount per leg, so its USD value grows without bound as the settlement index grows; for a bear call, where both legs finish deep in the money, no finite GLOBAL fee-inclusive maximum exists at all. Delivery fees are therefore reported at an explicitly named settlement scenario and are never folded into the bounded structural loss.",
   "Inverse-option payoff. The authoritative expiry-payoff utility still supplies the scenario quantities it legitimately answers -- breakeven, maximum profit, the settlement payoff and the protective-long counterfactual -- so this report cannot disagree with the payoff shown elsewhere in the app. It no longer defines the report's canonical structural risk.",
   "Entry economics use each analytical track's canonical per-leg premiums. Reference remains fair-value evidence; Maker and Taker retain their own scenario-local premiums. Credit is reported against requested width, actual width and the canonical maximum structural loss, since the last of those is the only denominator that reflects the structure's genuinely bounded risk.",
   "Fees. Opening fees are canonical. The four-leg round trip adds an estimated closing pair computed with the SAME canonical, execution-mode-invariant option fee schedule applied to that track's entry premiums; the Reference calculation is not fill evidence. It is labelled an entry-price estimate and never presented as a recorded closing fee.",
   "Protection accounting. Protection cost is long premium plus its incremental opening fee. Gross tail benefit is the long's terminal intrinsic loss reduction net only of its settlement delivery fee, before entry cost; net protection value subtracts entry cost exactly once. The deterministic diagnostic stress index is 50% of K_long for puts and 200% for calls; it is not a BTC forecast. At exactly K_long gross intrinsic protection is zero.",
   `Thesis Exit. Width is frozen to ${"thesis_exit_v1"}: first causally identifiable VPOC, otherwise invalidation, otherwise priced settlement fallback. Equal-precision VPOC/invalidation is ambiguous and has no realized PnL. Touch, breach and marks stop at that same causal boundary. Reference adverse metrics use fair-value valuation paths; Maker/Taker robustness uses only strict scenario-local raw-VWAP evidence, never modeled substitutions.`,
   "Slow-resolution behaviour reuses the canonical Duration & DTE cohorts (fast < P25, normal P25-P75, slow > P75, with unresolved kept explicit), cut from the observed first-resolution distribution. No hypothetical path is fabricated, and DTE is held constant inside each matched group.",
   "Capital. Three concepts are kept apart and never collapsed. Maximum STRUCTURAL loss is an economic property of the structure and is consumed from the canonical export; it is not Initial Margin and not Maintenance Margin. Incremental initial margin and peak margin are properties of the ACCOUNT -- they depend on Deribit's margin model, standard versus portfolio margin and segregated versus cross collateral -- so where the canonical margin scenario does not report them they stay Unavailable. The protective-leg cost, the width and the structural loss are never substituted for a margin figure, and a return whose denominator is Unavailable is itself Unavailable rather than zero.",
   "Evidence hierarchy. Width-level medians can contain different event compositions and are descriptive support only. Adjacent-width steps are the primary controlled evidence because they are paired inside the same matched ladder. They expose a plateau without comparing aggregate totals. No width is chosen, and none is preferred for having the highest historical PnL.",
  ],
 };
 return primary?{...report,robustness:{maker:buildSpreadWidthReport(dataset,"maker"),taker:buildSpreadWidthReport(dataset,"taker")}}:report;
}
