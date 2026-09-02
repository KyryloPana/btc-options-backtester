/**
 * Adverse-path evidence from a structure's own raw-VWAP valuation track.
 *
 * This is a canonical research primitive rather than a property of any one
 * report: Duration & DTE and Short-Strike both need "how far under water did
 * this structure go, in this execution scenario, while it existed", and they
 * must answer it identically. It lives here so the two can never drift.
 *
 * The raw track is required deliberately -- it is the conservative,
 * executable-evidence track. A modelled (iv_normalized) mark is NEVER
 * substituted to fill the column; when the raw track has no priced mark inside
 * the window the result stays Unavailable with an inspectable reason.
 */

/** Why an adverse-path metric has no value. Never collapsed into a zero. */
export type PathEvidenceStatus=
 /** Raw-VWAP marks exist in the post-entry window and produced a value. */
 |"available"
 /** This scenario was never evaluated, so it has no valuation track at all. */
 |"scenario_not_evaluated"
 /** Entry or the resolution/censoring boundary is unknown, so no window can be bounded. */
 |"no_observation_window"
 |"raw_evaluation_not_attempted"|"no_compatible_tape"|"insufficient_amount"|"missing_leg"|"synchronization_failure"
 /** Native PnL exists, but there is no USD-valued evidence for a USD metric. */
 |"usd_representation_unavailable"
 /** The window is well-defined but raw evidence is unavailable for another explicit reason. */
 |"no_raw_marks";

export interface AdversePathObservation {
 /** Most adverse raw mark-to-market in the post-entry window. Null means Unavailable. */
 readonly worstAdverseUsd:number|null;
 /**
  * Maximum adverse excursion up to and including the first profitable raw mark,
  * for structures that DO become profitable. Null when the structure never
  * reached a profitable raw mark (`profitObserved` false) or when no raw marks
  * exist -- never fabricated for an unobserved path.
  */
 readonly maeBeforeProfitUsd:number|null;
 /** Whether a profitable raw mark was ever observed in the window. */
 readonly profitObserved:boolean;
 readonly rawMarksInWindow:number;
 readonly status:PathEvidenceStatus;
 /** Human-readable, inspectable explanation when status is not "available". */
 readonly reason:string|null;
}

const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const ms=(v:unknown):number|null=>{const s=str(v);if(!s)return null;const t=Date.parse(s);return Number.isFinite(t)?t:null};

/**
 * Filtering by execution_scenario as well as candidate_id matters once a
 * structure has two scenario rows: without it, a maker row could silently read
 * taker's marks.
 */
export function adversePath(
 valuations:readonly Readonly<Record<string,unknown>>[],
 candidateId:string,scenario:string|null,scenarioEvaluated:boolean,
 entryMs:number|null,boundaryMs:number|null,
):AdversePathObservation{
 const empty={worstAdverseUsd:null,maeBeforeProfitUsd:null,profitObserved:false,rawMarksInWindow:0} as const;
 if(scenario===null||!scenarioEvaluated)return {...empty,status:"scenario_not_evaluated",
  reason:"This execution scenario was never evaluated for this structure, so it has no valuation track of its own. Reading the other scenario's marks would misattribute them."};
 if(entryMs===null||boundaryMs===null)return {...empty,status:"no_observation_window",
  reason:"Structure entry or the first-resolution/censoring boundary is unknown, so no post-entry observation window can be bounded."};

 const marks:{t:number;pnl:number}[]=[];
 let rawRowsForScenario=0;const rawReasons:string[]=[];
 for(const row of valuations){
  if(row.candidate_id!==candidateId||row.execution_scenario!==scenario||row.pricing_track!=="raw_vwap")continue;
  rawRowsForScenario++;
  rawReasons.push(String(row.unavailable_reason??""),...(Array.isArray(row.unavailable_reason_codes)?row.unavailable_reason_codes.map(String):[]),...(Array.isArray(row.missing_field_codes)?row.missing_field_codes.map(String):[]));
  if(row.valuation_status!=="priced")continue;
  const t=ms(row.timestamp_utc);
  if(t===null||t<entryMs||t>boundaryMs)continue;
  const pnl=num(row.net_pnl_usd);
  if(pnl===null)continue;
  marks.push({t,pnl});
 }
 if(!marks.length){const reasons=rawReasons.join(" ").toLowerCase();const status:PathEvidenceStatus=rawRowsForScenario===0?"raw_evaluation_not_attempted"
  :reasons.includes("amount")||reasons.includes("size")?"insufficient_amount"
  :reasons.includes("missing_leg")||reasons.includes("contract")?"missing_leg"
  :reasons.includes("sync")?"synchronization_failure"
  :reasons.includes("tape")||reasons.includes("print")?"no_compatible_tape":"no_raw_marks";
 return {...empty,status,
  reason:rawRowsForScenario===0
   ?"Raw evaluation was not attempted: the canonical bundle exports no raw-VWAP valuation row for this structure and scenario."
   :`The canonical bundle exports ${rawRowsForScenario} raw-VWAP valuation row(s) for this scenario, but none is priced inside the post-entry observation window. The raw track carries a mark only where a direct-VWAP estimate was recorded for that point; modelled (iv_normalized) marks are deliberately not substituted.`};
 }

 marks.sort((a,b)=>a.t-b.t);
 const worstAdverseUsd=Math.min(0,...marks.map(m=>m.pnl));
 const firstProfit=marks.find(m=>m.pnl>0);
 const maeBeforeProfitUsd=firstProfit?Math.min(0,...marks.filter(m=>m.t<=firstProfit.t).map(m=>m.pnl)):null;
 return {worstAdverseUsd,maeBeforeProfitUsd,profitObserved:firstProfit!==undefined,rawMarksInWindow:marks.length,status:"available",reason:null};
}

/**
 * Fair-value adverse path for the execution-independent Reference track.  It
 * intentionally has a different admissibility rule from `adversePath`: a
 * Reference mark is valid structural valuation evidence, but it is never
 * evidence of an executable maker/taker mark.
 */
export function referenceAdversePath(
 valuations:readonly Readonly<Record<string,unknown>>[],candidateId:string,
 entryMs:number|null,boundaryMs:number|null,
):AdversePathObservation{
 const empty={worstAdverseUsd:null,maeBeforeProfitUsd:null,profitObserved:false,rawMarksInWindow:0} as const;
 if(entryMs===null||boundaryMs===null)return {...empty,status:"no_observation_window",reason:"Reference entry or resolution boundary is unknown."};
 const rows=valuations.filter(r=>r.candidate_id===candidateId&&r.pricing_track==="reference").map(r=>({t:ms(r.timestamp_utc)??ms(r.timestamp),usd:num(r.net_pnl_usd)??num(r.estimatedNetPnlUsd),native:num(r.net_pnl_native)??num(r.estimatedNetPnlBtc)})).filter(r=>r.t!==null&&r.t>=entryMs&&r.t<=boundaryMs);
 const marks=rows.filter((r):r is {t:number;usd:number;native:number|null}=>r.t!==null&&r.usd!==null).map(r=>({t:r.t,p:r.usd})).sort((a,b)=>a.t-b.t);
 if(!marks.length)return {...empty,status:rows.some(r=>r.native!==null)?"usd_representation_unavailable":"no_raw_marks",reason:rows.some(r=>r.native!==null)?"Reference path has native marks but no USD PnL; BTC is not labelled USD.":"Reference path has no USD-valued mark in the post-entry window."};
 const firstProfit=marks.findIndex(m=>m.p>0),before=firstProfit<0?[]:marks.slice(0,firstProfit+1);
 return {worstAdverseUsd:Math.min(0,...marks.map(m=>m.p)),maeBeforeProfitUsd:before.length?Math.min(0,...before.map(m=>m.p)):null,profitObserved:firstProfit>=0,rawMarksInWindow:marks.length,status:"available",reason:null};
}
