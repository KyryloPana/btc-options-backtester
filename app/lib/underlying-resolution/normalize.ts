import type {AnalysisDataset} from "../research-analysis.ts";

/**
 * Canonical research bundle 2.1.0 -> normalized MR events for the Underlying
 * Resolution report.
 *
 * The bundle already defines outcome ordering (`sequence_status`) and censoring
 * (`censoring_status`), so those are read as authoritative rather than
 * re-derived. Timing uses exactly the pair the canonical ordering compares --
 * `vpoc_trigger_timestamp_utc` against `invalidation_decision_timestamp_utc` --
 * so a computed time can never contradict the canonical outcome.
 *
 * Option execution semantics are not consulted anywhere in this module. The
 * observation horizon is the event's own `observation_end_timestamp_utc`.
 */

/** Canonical `sequence_status`. `ambiguous` = VPOC and invalidation at the same timestamp. */
export type ResolutionOutcome="vpoc_first"|"invalidation_first"|"ambiguous"|"unresolved";

/** Why an event cannot contribute to time-to-event analysis. */
export type IneligibilityReason="missing_entry_timestamp"|"no_observation_window";

export interface MfeMae {readonly mfeUsd:number;readonly maeUsd:number;readonly mfePct:number|null;readonly maePct:number|null}

export interface NormalizedMrEvent {
 readonly eventId:string;
 readonly direction:"long"|"short"|null;
 readonly entryTimestampMs:number|null;
 readonly entryDateUtc:string|null;
 readonly entryPrice:number|null;
 readonly rangeWidthUsd:number|null;
 /** |vpoc_price - entry_price| in USD, straight from canonical `vpoc_distance`. */
 readonly remainingDistanceUsd:number|null;
 /** Remaining distance expressed in range widths. Null when range width is unusable. */
 readonly remainingDistanceRange:number|null;
 readonly outcome:ResolutionOutcome;
 /** Canonical right-censoring flag. Censored is NOT failure. */
 readonly censored:boolean;
 readonly timeToVpocDays:number|null;
 readonly timeToInvalidationDays:number|null;
 /** min(valid T_VPOC, valid T_inv); null when censored -- never manufactured. */
 readonly timeToResolutionDays:number|null;
 /** Time from entry to observation end; the censoring time for unresolved events. */
 readonly observationDays:number|null;
 /** MFE/MAE derived from hourly OHLC; null means Unavailable, never zero. */
 readonly excursion:MfeMae|null;
 /** Null when the event can contribute to time-to-event analysis. */
 readonly ineligibility:IneligibilityReason|null;
}

const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const ms=(v:unknown):number|null=>{const s=str(v);if(!s)return null;const t=Date.parse(s);return Number.isFinite(t)?t:null};
const DAY=864e5;
const days=(from:number|null,to:number|null):number|null=>from===null||to===null?null:(to-from)/DAY;

const OUTCOMES=new Set<ResolutionOutcome>(["vpoc_first","invalidation_first","ambiguous","unresolved"]);
const outcomeOf=(v:unknown):ResolutionOutcome=>{const s=str(v);return s&&OUTCOMES.has(s as ResolutionOutcome)?s as ResolutionOutcome:"unresolved"};

/**
 * Maximum favourable / adverse excursion from the hourly path, measured from
 * entry price in the direction of the thesis, over [entry, observation end].
 * Returns null when no usable candle exists so the caller can show Unavailable.
 */
function excursion(path:readonly Readonly<Record<string,unknown>>[],entryPrice:number|null,direction:"long"|"short"|null,fromMs:number|null,toMs:number|null):MfeMae|null{
 if(entryPrice===null||direction===null||fromMs===null||toMs===null)return null;
 let high=Number.NEGATIVE_INFINITY,low=Number.POSITIVE_INFINITY,seen=false;
 for(const row of path){
  const t=ms(row.timestamp_utc),h=num(row.high),l=num(row.low);
  if(t===null||h===null||l===null||t<fromMs||t>toMs)continue;
  high=Math.max(high,h);low=Math.min(low,l);seen=true;
 }
 if(!seen)return null;
 const mfeUsd=direction==="long"?high-entryPrice:entryPrice-low,
  maeUsd=direction==="long"?low-entryPrice:entryPrice-high,
  pct=(x:number)=>entryPrice?x/entryPrice:null;
 return {mfeUsd,maeUsd,mfePct:pct(mfeUsd),maePct:pct(maeUsd)};
}

export function normalizeMrEvents(dataset:AnalysisDataset):readonly NormalizedMrEvent[]{
 const rows=dataset.tables.events??[],paths=dataset.tables.underlying_path??[];
 const byEvent=new Map<string,Readonly<Record<string,unknown>>[]>();
 for(const row of paths){const id=str(row.event_id);if(!id)continue;const list=byEvent.get(id);if(list)list.push(row);else byEvent.set(id,[row])}

 return rows.map(row=>{
  const eventId=str(row.event_id)??"unknown-event",
   directionRaw=str(row.direction),
   direction=directionRaw==="long"||directionRaw==="short"?directionRaw:null,
   entry=ms(row.entry_timestamp_utc),
   vpoc=ms(row.vpoc_trigger_timestamp_utc),
   invalidation=ms(row.invalidation_decision_timestamp_utc),
   observationEnd=ms(row.observation_end_timestamp_utc),
   outcome=outcomeOf(row.sequence_status),
   entryPrice=num(row.entry_price),
   rangeLow=num(row.range_low),
   rangeHigh=num(row.range_high),
   rangeWidthUsd=rangeLow!==null&&rangeHigh!==null&&rangeHigh>rangeLow?rangeHigh-rangeLow:null,
   vpocDistance=num(row.vpoc_distance),
   remainingDistanceUsd=vpocDistance===null?null:Math.abs(vpocDistance),
   observationDays=days(entry,observationEnd);

  // An event with no observation window (no stored path collapses observation
  // end onto entry) cannot be censored "at time 0" without distorting the risk
  // set, so it is held out of time-to-event analysis and reported explicitly.
  const ineligibility:IneligibilityReason|null=entry===null?"missing_entry_timestamp"
   :observationDays===null||observationDays<=0?"no_observation_window":null;

  const timeToVpocDays=outcome==="vpoc_first"||outcome==="ambiguous"?days(entry,vpoc):null,
   timeToInvalidationDays=outcome==="invalidation_first"||outcome==="ambiguous"?days(entry,invalidation):null;
  const resolutionCandidates=[timeToVpocDays,timeToInvalidationDays].filter((x):x is number=>x!==null);
  const timeToResolutionDays=outcome==="unresolved"||!resolutionCandidates.length?null:Math.min(...resolutionCandidates);

  return {
   eventId,direction,entryTimestampMs:entry,
   entryDateUtc:entry===null?null:new Date(entry).toISOString().slice(0,10),
   entryPrice,rangeWidthUsd,remainingDistanceUsd,
   remainingDistanceRange:remainingDistanceUsd!==null&&rangeWidthUsd?remainingDistanceUsd/rangeWidthUsd:null,
   outcome,censored:str(row.censoring_status)==="right_censored"||outcome==="unresolved",
   timeToVpocDays,timeToInvalidationDays,timeToResolutionDays,observationDays,
   excursion:excursion(byEvent.get(eventId)??[],entryPrice,direction,entry,observationEnd),
   ineligibility,
  } satisfies NormalizedMrEvent;
 });
}
