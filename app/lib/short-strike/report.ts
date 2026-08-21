import type {AnalysisDataset} from "../research-analysis.ts";
import {observedPercentiles} from "../underlying-resolution/statistics.ts";
import {datasetForAnalyticsTrack} from "../research-analytics-model.ts";
import {normalizeShortStrikeStructures,type ExecutionScenario,type ShortStrikeStructure,type StrikeMethod} from "./normalize.ts";

/**
 * Short-Strike Analysis view model.
 *
 * THE QUESTION: does moving the short strike farther from the failed-breakout
 * area reduce challenged-position and tail losses enough to justify the credit
 * sacrificed?
 *
 * THE UNIT OF COMPARISON is a MATCHED PAIR. A technical and a buffered
 * structure are only ever compared when they share the same MR event, the same
 * actual expiry (hence the same actual DTE), the same width and protective-long
 * rule, the same structure/option type, the same execution scenario and the
 * same exit policy. Every reported difference is therefore a paired delta
 * attributable to strike placement alone -- never a difference of aggregate
 * means over two differently-composed populations.
 *
 * Maker and taker are separate scenarios of one structure and are never mixed
 * inside a statistic: the scenario is part of the match key, so a maker
 * technical strike can only ever be paired against a maker buffered strike.
 *
 * NOT A SELECTION. This report deliberately does not choose a strike rule. It
 * puts credit sacrificed beside the risk reduction that credit purchased and
 * leaves the judgement to the reader: buffering that lowers average PnL may
 * still be worthwhile if it materially improves tails, and buffering that
 * costs credit without reducing challenge or invalidation losses has
 * demonstrated no benefit.
 */

export interface PairedDelta {
 readonly label:string;
 /** buffered minus technical, in the metric's own units. Null when either side is Unavailable. */
 readonly value:number|null;
 /** True when a NEGATIVE delta is the favourable direction (e.g. a smaller loss). */
 readonly lowerIsBetter:boolean;
}

export interface MatchedPair {
 readonly matchKey:string;
 readonly eventId:string;
 readonly executionScenario:ExecutionScenario|null;
 readonly actualDteDays:number|null;
 readonly widthUsd:number|null;
 readonly technical:ShortStrikeStructure;
 readonly buffered:ShortStrikeStructure;

 /** How much farther out of the money the buffered strike sits. */
 readonly extraDistanceUsd:number|null;
 readonly extraDistancePctOfSpot:number|null;

 /** Credit given up to buy that distance: technical credit - buffered credit. */
 readonly grossCreditSacrificedUsd:number|null;
 readonly netCreditSacrificedUsd:number|null;
 /** Sacrificed credit as a share of the technical strike's own credit. */
 readonly relativeCreditSacrifice:number|null;

 /** Risk reduction purchased, expressed as a positive number when buffering helped. */
 readonly worstAdverseReductionUsd:number|null;
 readonly maeReductionUsd:number|null;

 readonly deltas:readonly PairedDelta[];
 /** Both sides genuinely evaluated for this scenario, so the economics are comparable. */
 readonly economicsComparable:boolean;
}

export interface GeometryRow {
 readonly method:StrikeMethod;
 readonly n:number;
 readonly medianDistanceFromSpotUsd:number|null;
 readonly medianDistanceFromExtremeUsd:number|null;
 readonly medianDistanceFromInvalidationUsd:number|null;
 readonly medianDistancePctOfSpot:number|null;
 readonly medianDistancePctOfRange:number|null;
 /** Always Unavailable in the current canonical export; the reason travels with it. */
 readonly medianEntryDelta:number|null;
 readonly entryDeltaReason:string|null;
}

export interface ChallengeRow {
 readonly method:StrikeMethod;
 readonly observableN:number;
 readonly touchedN:number;
 readonly breachedN:number;
 readonly breachBeforeInvalidationN:number;
 readonly invalidatedWithoutBreachN:number;
 readonly ambiguousOrderingN:number;
 readonly touchShare:number|null;
 readonly breachShare:number|null;
}

export type ConditionalBucket="touched"|"breached"|"invalidated"|"settled_untouched";

export interface ConditionalPnlRow {
 readonly bucket:ConditionalBucket;
 readonly technicalN:number;
 readonly bufferedN:number;
 readonly technicalMedianPnlUsd:number|null;
 readonly bufferedMedianPnlUsd:number|null;
 readonly technicalMedianWorstAdverseUsd:number|null;
 readonly bufferedMedianWorstAdverseUsd:number|null;
 /** Paired within the bucket, so this is never a difference of two populations. */
 readonly medianPairedPnlDeltaUsd:number|null;
 readonly pairedN:number;
}

export interface ShortStrikeSummary {
 readonly matchedPairs:number;
 readonly matchedEvents:number;
 readonly technicalStructures:number;
 readonly bufferedStructures:number;
 readonly unmatchedTechnical:number;
 readonly unmatchedBuffered:number;
 readonly medianGrossCreditSacrificedUsd:number|null;
 readonly medianNetCreditSacrificedUsd:number|null;
 readonly medianRelativeCreditSacrifice:number|null;
 readonly medianWorstAdverseReductionUsd:number|null;
 readonly medianMaeReductionUsd:number|null;
 /** Buffered breach share minus technical breach share, over matched pairs. */
 readonly breachRateDifference:number|null;
 readonly medianExtraDistanceUsd:number|null;
}

export interface ShortStrikeReport {
 readonly scenario:ExecutionScenario|"reference";
 readonly structures:readonly ShortStrikeStructure[];
 readonly pairs:readonly MatchedPair[];
 readonly summary:ShortStrikeSummary;
 readonly geometry:readonly GeometryRow[];
 readonly challenge:readonly ChallengeRow[];
 readonly conditionalPnl:readonly ConditionalPnlRow[];
 /** Structures excluded from pairing, with the reason, so nothing disappears silently. */
 readonly unpaired:readonly {structure:ShortStrikeStructure;reason:string}[];
 readonly methodology:readonly string[];
 readonly robustness?:Readonly<Record<ExecutionScenario,ShortStrikeReport>>;
}

const median=(values:readonly number[]):number|null=>values.length?observedPercentiles(values,[0.5])[0]??null:null;
const defined=(values:readonly (number|null)[]):number[]=>values.filter((x):x is number=>x!==null);
const share=(count:number,whole:number):number|null=>whole>0?count/whole:null;
const diff=(a:number|null,b:number|null):number|null=>a===null||b===null?null:a-b;

/** Which conditional bucket a structure's own life falls into. */
function bucketOf(s:ShortStrikeStructure):ConditionalBucket|null{
 const c=s.challenge;
 if(c.reason!==null)return null;
 if(c.breached===true)return "breached";
 if(c.invalidatedInWindow===true)return "invalidated";
 if(c.touched===true)return "touched";
 return "settled_untouched";
}

function geometryRow(method:StrikeMethod,structures:readonly ShortStrikeStructure[]):GeometryRow{
 const rows=structures.filter(s=>s.strikeMethod===method);
 return {
  method,n:rows.length,
  medianDistanceFromSpotUsd:median(defined(rows.map(s=>s.geometry.distanceFromEntrySpotUsd))),
  medianDistanceFromExtremeUsd:median(defined(rows.map(s=>s.geometry.distanceFromExtremeUsd))),
  medianDistanceFromInvalidationUsd:median(defined(rows.map(s=>s.geometry.distanceFromInvalidationUsd))),
  medianDistancePctOfSpot:median(defined(rows.map(s=>s.geometry.distanceAsPctOfSpot))),
  medianDistancePctOfRange:median(defined(rows.map(s=>s.geometry.distanceAsPctOfRange))),
  medianEntryDelta:null,
  entryDeltaReason:rows[0]?.geometry.entryDeltaReason??null,
 };
}

function challengeRow(method:StrikeMethod,structures:readonly ShortStrikeStructure[]):ChallengeRow{
 const rows=structures.filter(s=>s.strikeMethod===method);
 // Only structures whose challenge is genuinely observable form the
 // denominator; an unobservable path is not a "no touch".
 const observable=rows.filter(s=>s.challenge.reason===null);
 const touchedN=observable.filter(s=>s.challenge.touched===true).length;
 const breachedN=observable.filter(s=>s.challenge.breached===true).length;
 return {
  method,observableN:observable.length,touchedN,breachedN,
  breachBeforeInvalidationN:observable.filter(s=>s.challenge.breachBeforeInvalidation===true).length,
  invalidatedWithoutBreachN:observable.filter(s=>s.challenge.invalidatedWithoutBreach===true).length,
  ambiguousOrderingN:observable.filter(s=>s.challenge.ambiguousOrdering).length,
  touchShare:share(touchedN,observable.length),
  breachShare:share(breachedN,observable.length),
 };
}

function pairOf(technical:ShortStrikeStructure,buffered:ShortStrikeStructure):MatchedPair{
 const economicsComparable=technical.executionScenarioStatus==="evaluated"&&buffered.executionScenarioStatus==="evaluated";
 const grossCreditSacrificedUsd=economicsComparable?diff(technical.grossCreditUsd,buffered.grossCreditUsd):null;
 const netCreditSacrificedUsd=economicsComparable?diff(technical.netCreditUsd,buffered.netCreditUsd):null;
 // Worst adverse is a loss (negative), so buffering helps when the buffered
 // figure is LESS negative: reduction = buffered - technical, positive = better.
 const worstAdverseReductionUsd=economicsComparable?diff(buffered.worstAdverseUsd,technical.worstAdverseUsd):null;
 const maeReductionUsd=economicsComparable?diff(buffered.maeUsd,technical.maeUsd):null;
 const extraDistanceUsd=diff(buffered.geometry.distanceFromEntrySpotUsd,technical.geometry.distanceFromEntrySpotUsd);
 return {
  matchKey:technical.matchKey,eventId:technical.eventId,executionScenario:technical.executionScenario,
  actualDteDays:technical.actualDteDays,widthUsd:technical.widthUsd,technical,buffered,
  extraDistanceUsd,
  extraDistancePctOfSpot:diff(buffered.geometry.distanceAsPctOfSpot,technical.geometry.distanceAsPctOfSpot),
  grossCreditSacrificedUsd,netCreditSacrificedUsd,
  relativeCreditSacrifice:grossCreditSacrificedUsd!==null&&technical.grossCreditUsd!==null&&technical.grossCreditUsd!==0
   ?grossCreditSacrificedUsd/Math.abs(technical.grossCreditUsd):null,
  worstAdverseReductionUsd,maeReductionUsd,
  deltas:[
   {label:"Δ entry credit (gross)",value:economicsComparable?diff(buffered.grossCreditUsd,technical.grossCreditUsd):null,lowerIsBetter:false},
   {label:"Δ entry credit (net)",value:economicsComparable?diff(buffered.netCreditUsd,technical.netCreditUsd):null,lowerIsBetter:false},
   {label:"Δ worst adverse",value:worstAdverseReductionUsd,lowerIsBetter:false},
   {label:"Δ MAE before profit",value:maeReductionUsd,lowerIsBetter:false},
   {label:"Δ PnL at invalidation",value:economicsComparable?diff(buffered.pnlAtInvalidationUsd,technical.pnlAtInvalidationUsd):null,lowerIsBetter:false},
   {label:"Δ settlement / tail PnL",value:economicsComparable?diff(buffered.pnlAtSettlementUsd,technical.pnlAtSettlementUsd):null,lowerIsBetter:false},
   {label:"Δ realized PnL",value:economicsComparable?diff(buffered.realizedPnlUsd,technical.realizedPnlUsd):null,lowerIsBetter:false},
  ],
  economicsComparable,
 };
}

function conditionalRow(bucket:ConditionalBucket,pairs:readonly MatchedPair[],structures:readonly ShortStrikeStructure[]):ConditionalPnlRow{
 const inBucket=(s:ShortStrikeStructure)=>bucketOf(s)===bucket;
 const technical=structures.filter(s=>s.strikeMethod==="technical"&&inBucket(s));
 const buffered=structures.filter(s=>s.strikeMethod==="buffered"&&inBucket(s));
 // The paired delta only uses pairs where BOTH sides landed in this bucket, so
 // it never compares a touched technical against an untouched buffered.
 const paired=pairs.filter(p=>inBucket(p.technical)&&inBucket(p.buffered)&&p.economicsComparable);
 return {
  bucket,technicalN:technical.length,bufferedN:buffered.length,
  technicalMedianPnlUsd:median(defined(technical.map(s=>s.realizedPnlUsd))),
  bufferedMedianPnlUsd:median(defined(buffered.map(s=>s.realizedPnlUsd))),
  technicalMedianWorstAdverseUsd:median(defined(technical.map(s=>s.worstAdverseUsd))),
  bufferedMedianWorstAdverseUsd:median(defined(buffered.map(s=>s.worstAdverseUsd))),
  medianPairedPnlDeltaUsd:median(defined(paired.map(p=>diff(p.buffered.realizedPnlUsd,p.technical.realizedPnlUsd)))),
  pairedN:paired.length,
 };
}

const BUCKETS:readonly ConditionalBucket[]=["touched","breached","invalidated","settled_untouched"];

export function buildShortStrikeReport(dataset:AnalysisDataset,scenario?:ExecutionScenario):ShortStrikeReport{
 const primary=scenario===undefined, selectedScenario=scenario??"maker";
 const all=normalizeShortStrikeStructures(primary?datasetForAnalyticsTrack(dataset,"reference"):dataset);
 const structures=all.filter(s=>s.executionScenario===selectedScenario);

 // Pair strictly within the structural match key: same event, expiry, DTE, width and structure. A key holding anything other than exactly one technical and one
 // buffered structure is reported as unpaired rather than force-matched.
 const byKey=new Map<string,ShortStrikeStructure[]>();
 for(const s of structures){const list=byKey.get(s.matchKey);if(list)list.push(s);else byKey.set(s.matchKey,[s])}
 const pairs:MatchedPair[]=[],unpaired:{structure:ShortStrikeStructure;reason:string}[]=[];
 for(const group of byKey.values()){
  const technical=group.filter(s=>s.strikeMethod==="technical"),buffered=group.filter(s=>s.strikeMethod==="buffered");
  if(technical.length===1&&buffered.length===1){pairs.push(pairOf(technical[0]!,buffered[0]!));continue}
  for(const s of group)unpaired.push({structure:s,reason:
   technical.length===0?"No technical-strike structure shares this event, expiry, DTE, width and exit policy."
   :buffered.length===0?"No buffered-strike structure was generated here: the canonical generator only produces one when the failed-breakout extreme sits within 100 of the rounded strike boundary."
   :"More than one structure of a placement shares this match key, so the pairing would be ambiguous."});
 }
 pairs.sort((a,b)=>a.eventId.localeCompare(b.eventId)||(a.actualDteDays??0)-(b.actualDteDays??0)||(a.widthUsd??0)-(b.widthUsd??0));

 const comparable=pairs.filter(p=>p.economicsComparable);
 const technicalBreach=pairs.filter(p=>p.technical.challenge.reason===null),
  bufferedBreach=pairs.filter(p=>p.buffered.challenge.reason===null);
 const technicalBreachShare=share(technicalBreach.filter(p=>p.technical.challenge.breached===true).length,technicalBreach.length),
  bufferedBreachShare=share(bufferedBreach.filter(p=>p.buffered.challenge.breached===true).length,bufferedBreach.length);

 const report:ShortStrikeReport={
  scenario:primary?"reference":selectedScenario,structures,pairs,
  summary:{
   matchedPairs:pairs.length,
   matchedEvents:new Set(pairs.map(p=>p.eventId)).size,
   technicalStructures:structures.filter(s=>s.strikeMethod==="technical").length,
   bufferedStructures:structures.filter(s=>s.strikeMethod==="buffered").length,
   unmatchedTechnical:unpaired.filter(u=>u.structure.strikeMethod==="technical").length,
   unmatchedBuffered:unpaired.filter(u=>u.structure.strikeMethod==="buffered").length,
   medianGrossCreditSacrificedUsd:median(defined(comparable.map(p=>p.grossCreditSacrificedUsd))),
   medianNetCreditSacrificedUsd:median(defined(comparable.map(p=>p.netCreditSacrificedUsd))),
   medianRelativeCreditSacrifice:median(defined(comparable.map(p=>p.relativeCreditSacrifice))),
   medianWorstAdverseReductionUsd:median(defined(comparable.map(p=>p.worstAdverseReductionUsd))),
   medianMaeReductionUsd:median(defined(comparable.map(p=>p.maeReductionUsd))),
   breachRateDifference:bufferedBreachShare!==null&&technicalBreachShare!==null?bufferedBreachShare-technicalBreachShare:null,
   medianExtraDistanceUsd:median(defined(pairs.map(p=>p.extraDistanceUsd))),
  },
  geometry:(["technical","buffered"] as const).map(m=>geometryRow(m,structures)),
  challenge:(["technical","buffered"] as const).map(m=>challengeRow(m,structures)),
  conditionalPnl:BUCKETS.map(b=>conditionalRow(b,pairs,structures)),
  unpaired,
  methodology:[
   "Scope. This report analyses short-strike PLACEMENT only. Spread width is held constant inside every comparison rather than studied here: placement decides where risk begins, width decides how much tail risk is retained. Width is analysed separately, and no result here is attributed to it.",
   `Comparison unit. Every figure is a MATCHED PAIR: the same MR event, the same actual expiry (hence the same actual DTE), the same width and protective-long rule, the same structure and option type, the same exit policy. Only the short strike differs. Execution scenario is absent from the primary key. This report is scoped to the ${primary?"reference":selectedScenario} track; explicit observed robustness layers are filtered before matching, so maker and taker are never mixed.`,
   "Exit policy is a constant rather than a read field: a canonical bundle exports one outcome set for every structure, so there is no exit dimension that could vary within a pair.",
   "Placement names are read from canonical strike_method, never inferred from the strike value. 'anchor' is the technical placement rounded from the failed-breakout extreme; 'buffered' is one strike step farther out. The generator only produces a buffered variant when the extreme sits within 100 of the rounded boundary, which is why many structures have no partner and are listed as unpaired rather than silently dropped.",
   "Distance sign. Every distance is signed so that POSITIVE MEANS FARTHER OUT OF THE MONEY for both directions: a bullish MR sells a put below spot, a bearish MR sells a call above it. Distances are measured from the entry spot (the candidate's own entry index where present, otherwise the event's entry price), from the failed-breakout extreme, and from the invalidation level, plus normalised by spot and by the event's range width.",
   "Entry delta is Unavailable. The canonical bundle records per-leg implied volatility but carries no delta on any table; deriving one from an IV anchor would present a model output as a canonical observation, so the column stays empty with its reason attached rather than being filled.",
   "Touch and breach come from the canonical hourly underlying path and nothing else. A TOUCH is a candle whose extreme reached the strike (low <= K for a short put, high >= K for a short call). A BREACH is a candle that CLOSED beyond it -- a completed hourly close is the finest settled evidence the path provides.",
   "Causality. Only candles that OPEN at or after structure entry and at or before expiry are counted: a candle straddling entry is partly pre-entry, and letting it challenge the strike would use price action from before the position existed. Post-expiry candles are excluded for the mirror-image reason.",
   "Ordering is asserted only at the precision the path has. The path is stamped at candle open, so a breach and an invalidation falling inside one hourly candle cannot be ordered; that case is reported as ambiguous and excluded from 'breach before invalidation' rather than resolved by assumption.",
   "Candidate-relative outcomes. PnL at invalidation is used only when the invalidation genuinely occurred inside the structure's life; an invalidation before entry or after expiry is never priced as though the option were still alive. Realized PnL is the invalidation result when the structure was invalidated in-window, and the settlement result otherwise.",
   "Worst adverse and MAE use the shared canonical adverse-path primitive: this scenario's raw-VWAP valuation track only, bounded to the structure's post-entry life. Modelled marks are never substituted, so an absent raw track leaves the figure Unavailable with a reason rather than a zero.",
   "Credit sacrificed = technical entry credit - buffered entry credit, reported gross and net, in USD at each structure's own entry index. Risk reduction is reported as buffered minus technical on the adverse figures, so a positive number always means buffering reduced the loss.",
   "Not evaluated, Unavailable and a true zero stay distinct throughout. A pair is marked economics-comparable only when BOTH sides were genuinely evaluated for the scenario; otherwise its economic deltas are Unavailable rather than zero.",
   "No selection. This report does not choose a strike rule. Lower loss alone does not make buffering superior, and higher average PnL alone does not make the technical strike superior: the tradeoff is credit given up against the reduction in challenged-position and tail losses that credit purchased.",
  ],
 };
 return primary?{...report,robustness:{maker:buildShortStrikeReport(dataset,"maker"),taker:buildShortStrikeReport(dataset,"taker")}}:report;
}
