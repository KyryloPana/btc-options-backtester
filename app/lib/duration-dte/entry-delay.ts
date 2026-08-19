import type {AnalysisDataset} from "../research-analysis.ts";
import type {ExecutionScenario} from "./normalize.ts";

/**
 * Entry-delay sensitivity: would the same structure still have been executable
 * 4, 8 or 12 hours after the signal, and at what cost?
 *
 * This is deliberately kept SEPARATE from resolution-speed sensitivity. A slow
 * MR resolution and a late execution are different risks and must never be
 * blended into one statistic.
 *
 * CAUSALITY IS THE WHOLE PROBLEM. A delayed maker scenario must be priced from
 * maker-relevant tape available AFTER the delayed order time, and a delayed
 * taker scenario from taker-relevant tape after that time. It is never
 * legitimate to reuse the original fill, borrow earlier tape, treat a modelled
 * mark as a historical fill, or assume a resting order reached the front of the
 * queue. So rather than assume support, this module TESTS the canonical export
 * for the evidence a causal reconstruction would need, and reports honestly
 * when that evidence is absent.
 *
 * The test: for each requested delay, does the bundle contain a priced
 * RAW-VWAP valuation mark, for that structure and that execution scenario, at
 * or after entry + delay? The raw track is the only per-timestamp historical
 * evidence in the canonical export; `iv_normalized` is a model reconstruction
 * and cannot stand in for a fill.
 */

export const ENTRY_DELAY_HOURS=[0,4,8,12] as const;
export type EntryDelayHours=(typeof ENTRY_DELAY_HOURS)[number];

export interface EntryDelaySupportRow {
 readonly delayHours:EntryDelayHours;
 /** Structures with a priced raw mark at/after entry+delay, per scenario. */
 readonly structuresWithRawEvidence:Record<ExecutionScenario,number>;
 readonly supported:boolean;
}

export interface EntryDelayReport {
 readonly supported:boolean;
 readonly structuresConsidered:number;
 readonly rows:readonly EntryDelaySupportRow[];
 /** Why the analysis is unsupported; null when supported. */
 readonly reason:string|null;
 /** Exactly what a future canonical export would have to add. */
 readonly requiredCanonicalInputs:readonly string[];
}

const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const ms=(v:unknown):number|null=>{const s=str(v);if(!s)return null;const t=Date.parse(s);return Number.isFinite(t)?t:null};
const HOUR=36e5;

const REQUIRED_INPUTS=[
 "A priced raw-VWAP valuation mark per (structure, execution scenario) at each delayed entry offset -- the canonical export currently records a raw track row for every valuation point, but prices only the model (iv_normalized) track, so no historical mark exists to fill a delayed entry from.",
 "Direction-resolved tape (taker-buy vs taker-sell prints) covering the delayed entry window for both legs, so a maker opportunity and a taker execution can be evaluated from disjoint evidence at the later timestamp.",
 "Observed traded size at the delayed timestamp, so a delayed fill is not claimed for a size the tape never supported.",
] as const;

/**
 * Detects, rather than assumes, whether delayed-entry reconstruction is
 * supported by this bundle. Returns `supported:false` with a precise reason
 * instead of fabricating delayed-entry results.
 */
export function buildEntryDelayReport(dataset:AnalysisDataset):EntryDelayReport{
 const candidates=dataset.tables.candidates??[],valuations=dataset.tables.valuations??[];

 // Entry timestamp per (structure, scenario), from that scenario's own row.
 const entryByKey=new Map<string,number>();
 for(const row of candidates){
  const id=str(row.candidate_id),scenario=str(row.execution_scenario);
  const entry=ms(row.structure_entry_timestamp_utc)??ms(row.valuation_timestamp_utc);
  if(id&&scenario&&entry!==null)entryByKey.set(`${id}~${scenario}`,entry);
 }

 // Priced raw marks per (structure, scenario), which is the only historical
 // per-timestamp evidence a causal delayed entry could be built from.
 const rawMarksByKey=new Map<string,number[]>();
 for(const row of valuations){
  if(row.pricing_track!=="raw_vwap"||row.valuation_status!=="priced")continue;
  const id=str(row.candidate_id),scenario=str(row.execution_scenario),t=ms(row.timestamp_utc);
  if(!id||!scenario||t===null)continue;
  const key=`${id}~${scenario}`;
  const list=rawMarksByKey.get(key);if(list)list.push(t);else rawMarksByKey.set(key,[t]);
 }

 const rows=ENTRY_DELAY_HOURS.map(delayHours=>{
  const structuresWithRawEvidence:Record<ExecutionScenario,number>={maker:0,taker:0};
  for(const scenario of ["maker","taker"] as const){
   for(const [key,entry] of entryByKey){
    if(!key.endsWith(`~${scenario}`))continue;
    const marks=rawMarksByKey.get(key);
    if(marks?.some(t=>t>=entry+delayHours*HOUR))structuresWithRawEvidence[scenario]++;
   }
  }
  return {delayHours,structuresWithRawEvidence,supported:structuresWithRawEvidence.maker>0||structuresWithRawEvidence.taker>0};
 });

 const supported=rows.every(r=>r.supported);
 return {
  supported,structuresConsidered:entryByKey.size,rows,
  reason:supported?null
   :"Not supported by current canonical export. Delayed entries cannot be reconstructed causally: the bundle prices only the model (iv_normalized) valuation track, so there is no historical raw mark at any delayed entry offset. Reusing the original fill, borrowing earlier tape, or treating a model mark as a fill would each break causality, so no delayed-entry figures are produced.",
  requiredCanonicalInputs:supported?[]:REQUIRED_INPUTS,
 };
}
