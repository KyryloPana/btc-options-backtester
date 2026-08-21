import {observedPercentiles} from "../underlying-resolution/statistics.ts";
import {realizedPnlOf,type DteCandidate,type ExecutionScenario,type HorizonFamily} from "./normalize.ts";

/**
 * Controlled comparisons for Duration & DTE.
 *
 * Two different questions live here, and neither may be answered by simply
 * pooling candidate rows:
 *
 *  1. "Does DTE change the economics?" -- answered by MATCHED STRUCTURAL
 *     VARIANTS: the same MR event, the same short-strike method, the same
 *     width, the same structure/option type, the same execution scenario,
 *     differing ONLY in horizon/actual DTE. Pooling unmatched rows would
 *     attribute a width or strike-placement difference to duration.
 *  2. "What does execution assumption cost?" -- answered by MATCHED
 *     STRUCTURES: the same candidate_id evaluated under BOTH maker and taker.
 *     Maker and taker are two scenarios of one structure, never two
 *     independent observations, so an unmatched structure contributes nothing.
 *
 * Every statistic below is a median over matched differences. An empty matched
 * set yields null, never zero.
 */

const median=(values:readonly number[]):number|null=>values.length?observedPercentiles(values,[0.5])[0]??null:null;

/** Difference in one metric across a matched pair, kept only when BOTH sides have a value. */
function delta(pairs:readonly (readonly [number|null,number|null])[]):number[]{
 return pairs.filter((p):p is readonly [number,number]=>p[0]!==null&&p[1]!==null).map(([a,b])=>a-b);
}

export interface MatchedDteComparisonRow {
 readonly shorter:HorizonFamily;
 readonly longer:HorizonFamily;
 /** Structural variants present at BOTH horizons -- the only population compared. */
 readonly matchedVariants:number;
 readonly medianPnlDeltaUsd:number|null;
 readonly medianWorstAdverseDeltaUsd:number|null;
 readonly medianHoldingDeltaDays:number|null;
 readonly medianCapture50DeltaDays:number|null;
 readonly medianDteDeltaDays:number|null;
 readonly comparableN:{readonly pnl:number;readonly worstAdverse:number;readonly holding:number;readonly capture50:number};
 readonly shorterOnlyN:number;readonly longerOnlyN:number;
}

/**
 * Longer-horizon minus shorter-horizon, within matched structural variants.
 *
 * A variant that exists at only one of the two horizons is excluded entirely:
 * including it would silently reintroduce the confounding this function exists
 * to remove. When a variant somehow appears twice at one horizon the earliest
 * expiry is used, so the comparison stays one-to-one.
 */
export function buildMatchedDteComparison(candidates:readonly DteCandidate[],horizons:readonly HorizonFamily[]):readonly MatchedDteComparisonRow[] {
 const byHorizon=new Map<number,Map<string,DteCandidate>>();
 for(const c of candidates){
  if(c.horizonNominalDays===null||c.ineligibilityReason!==null)continue;
  const slot=byHorizon.get(c.horizonNominalDays)??new Map<string,DteCandidate>();
  const existing=slot.get(c.structuralVariantKey);
  if(!existing||(c.expiryTimestampMs??Infinity)<(existing.expiryTimestampMs??Infinity))slot.set(c.structuralVariantKey,c);
  byHorizon.set(c.horizonNominalDays,slot);
 }

 const rows:MatchedDteComparisonRow[]=[];
 for(let i=0;i<horizons.length;i++)for(let j=i+1;j<horizons.length;j++){
  const shorter=horizons[i]!,longer=horizons[j]!;
  const a=byHorizon.get(shorter.nominalDays),b=byHorizon.get(longer.nominalDays);
  if(!a||!b)continue;
  const matched=[...a.keys()].filter(k=>b.has(k)).map(k=>[b.get(k)!,a.get(k)!] as const);
  if(!matched.length)continue;
  const pnl=delta(matched.map(([l,s])=>[realizedPnlOf(l),realizedPnlOf(s)] as const)),worst=delta(matched.map(([l,s])=>[l.worstAdverseUsd,s.worstAdverseUsd] as const)),holding=delta(matched.map(([l,s])=>[l.holdingDays,s.holdingDays] as const)),capture=delta(matched.map(([l,s])=>[l.capture50?.reached?l.capture50.timeToCaptureDays:null,s.capture50?.reached?s.capture50.timeToCaptureDays:null] as const));
  rows.push({
   shorter,longer,matchedVariants:matched.length,
   medianPnlDeltaUsd:median(pnl),medianWorstAdverseDeltaUsd:median(worst),medianHoldingDeltaDays:median(holding),medianCapture50DeltaDays:median(capture),
   medianDteDeltaDays:median(delta(matched.map(([l,s])=>[l.actualDteDays,s.actualDteDays] as const))),
   comparableN:{pnl:pnl.length,worstAdverse:worst.length,holding:holding.length,capture50:capture.length},
   shorterOnlyN:[...a.keys()].filter(k=>!b.has(k)).length,longerOnlyN:[...b.keys()].filter(k=>!a.has(k)).length,
  });
 }
 return rows;
}

export interface MatchedExecutionRow {
 readonly horizon:HorizonFamily;
 /** Structures with BOTH maker and taker genuinely evaluated -- the only population compared. */
 readonly matchedN:number;
 /** Structures evaluated under maker only; reported, never silently folded into the comparison. */
 readonly makerOnlyN:number;
 readonly takerOnlyN:number;
 readonly medianPnlDragUsd:number|null;
 readonly medianWorstAdverseDragUsd:number|null;
 readonly medianCapture50DragDays:number|null;
 readonly medianCapitalDayReturnDrag:number|null;
 readonly medianSynchronizationDragMinutes:number|null;
 readonly comparableN:{readonly pnl:number;readonly worstAdverse:number;readonly capture50:number;readonly capitalDayReturn:number;readonly synchronization:number};
}

/**
 * Execution drag = maker result - taker result, for structures genuinely
 * evaluated under BOTH scenarios, matched by candidate_id.
 *
 * Never compares a not_evaluated scenario against an evaluated one, and never
 * compares two different structures. Because both rows of a structure carry
 * identical execution-INDEPENDENT facts, every difference reported here is
 * attributable to the execution assumption alone.
 */
export function buildMatchedExecution(allScenarios:readonly DteCandidate[],horizons:readonly HorizonFamily[]):readonly MatchedExecutionRow[] {
 return horizons.map(horizon=>{
  const at=allScenarios.filter(c=>c.horizonNominalDays===horizon.nominalDays&&c.ineligibilityReason===null);
  const pick=(s:ExecutionScenario)=>new Map(at.filter(c=>c.executionScenario===s&&c.executionScenarioStatus==="evaluated"&&!c.executionScenarioLegacyUndifferentiated).map(c=>[c.candidateId,c]));
  const maker=pick("maker"),taker=pick("taker");
  const matchedIds=[...maker.keys()].filter(id=>taker.has(id));
  const pairs=matchedIds.map(id=>[maker.get(id)!,taker.get(id)!] as const);
  const observedPnl=(c:DteCandidate)=>c.outcomeBeforeExpiry==="vpoc_before_expiry"?c.observedPnlAtVpocUsd:c.outcomeBeforeExpiry==="invalidation_before_expiry"?c.observedPnlAtInvalidationUsd:c.outcomeBeforeExpiry==="no_resolution_before_expiry"?c.observedPnlAtSettlementUsd:null;
  const pnl=delta(pairs.map(([m,t])=>[observedPnl(m),observedPnl(t)] as const)),worst=delta(pairs.map(([m,t])=>[m.observedAdversePath.worstAdverseUsd,t.observedAdversePath.worstAdverseUsd] as const)),capture=delta(pairs.map(([m,t])=>[m.observedCapture50?.reached?m.observedCapture50.timeToCaptureDays:null,t.observedCapture50?.reached?t.observedCapture50.timeToCaptureDays:null] as const)),capital=delta(pairs.map(([m,t])=>[m.capitalDayReturn,t.capitalDayReturn] as const)),sync=delta(pairs.map(([m,t])=>[m.synchronizationMinutes,t.synchronizationMinutes] as const));
  return {
   horizon,matchedN:pairs.length,
   makerOnlyN:[...maker.keys()].filter(id=>!taker.has(id)).length,
   takerOnlyN:[...taker.keys()].filter(id=>!maker.has(id)).length,
   medianPnlDragUsd:median(pnl),medianWorstAdverseDragUsd:median(worst),medianCapture50DragDays:median(capture),medianCapitalDayReturnDrag:median(capital),medianSynchronizationDragMinutes:median(sync),
   comparableN:{pnl:pnl.length,worstAdverse:worst.length,capture50:capture.length,capitalDayReturn:capital.length,synchronization:sync.length},
  };
 });
}
