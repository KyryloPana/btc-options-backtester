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
 * rule, the same structure/option type and the same exit policy. Every
 * reported difference is therefore a paired delta
 * attributable to strike placement alone -- never a difference of aggregate
 * means over two differently-composed populations.
 *
 * Maker and taker are separate scenarios of one structure and are never mixed:
 * the report is scoped to one analytical track before structural pairing.
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

export type ConditionalBucket="breached"|"touched_not_breached"|"never_touched";

export interface ConditionalPnlRow {
 readonly bucket:ConditionalBucket;
 readonly technicalN:number;
 readonly bufferedN:number;
 readonly technicalPnlN:number;
 readonly bufferedPnlN:number;
 readonly technicalAdverseN:number;
 readonly bufferedAdverseN:number;
 readonly technicalMedianPnlUsd:number|null;
 readonly bufferedMedianPnlUsd:number|null;
 readonly technicalMedianWorstAdverseUsd:number|null;
 readonly bufferedMedianWorstAdverseUsd:number|null;
 /** Paired within the bucket, so this is never a difference of two populations. */
 readonly medianPairedPnlDeltaUsd:number|null;
 readonly pairedN:number;
 readonly independentEventN:number;
 readonly medianPairedAdverseReductionUsd:number|null;
 readonly bufferedTransitions:Readonly<Record<ConditionalBucket,number>>;
}

export interface ShortStrikeSummary {
 readonly matchedPairs:number;
 readonly matchedEvents:number;
 readonly bufferEligibleTechnicalStructures:number;
 readonly bufferEligibleShare:number|null;
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
 /** Equal-weight MR-event inference: pair deltas are first aggregated within event. */
 readonly eventWeighted:Readonly<{
  independentEventN:number;
  medianGrossCreditSacrificedUsd:number|null;
  medianNetCreditSacrificedUsd:number|null;
  medianWorstAdverseReductionUsd:number|null;
  medianMaeReductionUsd:number|null;
  medianRealizedPnlDeltaUsd:number|null;
 }>;
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
 if(c.touched===true)return "touched_not_breached";
 return "never_touched";
}

function geometryRow(method:StrikeMethod,pairs:readonly MatchedPair[]):GeometryRow{
 const rows=pairs.map(p=>method==="technical"?p.technical:p.buffered);
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

function challengeRow(method:StrikeMethod,pairs:readonly MatchedPair[]):ChallengeRow{
 const unique=new Map<string,ShortStrikeStructure>();
 for(const p of pairs.filter(p=>p.technical.challenge.reason===null&&p.buffered.challenge.reason===null)){
  const row=method==="technical"?p.technical:p.buffered;
  // Width changes only the protective long; it cannot create another
  // independent observation of the same short strike and underlying path.
  unique.set([row.eventId,row.expiryTimestampMs,row.geometry.shortStrike].join("|"),row);
 }
 const rows=[...unique.values()];
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

function conditionalRow(bucket:ConditionalBucket,pairs:readonly MatchedPair[]):ConditionalPnlRow{
 const inBucket=(s:ShortStrikeStructure)=>bucketOf(s)===bucket;
 // Condition on the technical strike, then retain both placements from those
 // exact pairs. A buffered avoidance is evidence, not a reason to drop a pair.
 const conditioned=pairs.filter(p=>inBucket(p.technical));
 const technical=conditioned.map(p=>p.technical),buffered=conditioned.map(p=>p.buffered);
 const pnlPairs=conditioned.filter(p=>p.technical.realizedPnlUsd!==null&&p.buffered.realizedPnlUsd!==null);
 const adversePairs=conditioned.filter(p=>p.technical.worstAdverseUsd!==null&&p.buffered.worstAdverseUsd!==null);
 const transitions={breached:0,touched_not_breached:0,never_touched:0};
 for(const p of conditioned){const state=bucketOf(p.buffered);if(state)transitions[state]++}
 return {
  bucket,technicalN:technical.length,bufferedN:buffered.length,
  technicalPnlN:defined(technical.map(s=>s.realizedPnlUsd)).length,bufferedPnlN:defined(buffered.map(s=>s.realizedPnlUsd)).length,
  technicalAdverseN:defined(technical.map(s=>s.worstAdverseUsd)).length,bufferedAdverseN:defined(buffered.map(s=>s.worstAdverseUsd)).length,
  technicalMedianPnlUsd:median(defined(technical.map(s=>s.realizedPnlUsd))),
  bufferedMedianPnlUsd:median(defined(buffered.map(s=>s.realizedPnlUsd))),
  technicalMedianWorstAdverseUsd:median(defined(technical.map(s=>s.worstAdverseUsd))),
  bufferedMedianWorstAdverseUsd:median(defined(buffered.map(s=>s.worstAdverseUsd))),
  medianPairedPnlDeltaUsd:median(defined(pnlPairs.map(p=>diff(p.buffered.realizedPnlUsd,p.technical.realizedPnlUsd)))),
  medianPairedAdverseReductionUsd:median(defined(adversePairs.map(p=>diff(p.buffered.worstAdverseUsd,p.technical.worstAdverseUsd)))),
  pairedN:conditioned.length,independentEventN:new Set(conditioned.map(p=>p.eventId)).size,bufferedTransitions:transitions,
 };
}

function eventWeighted(pairs:readonly MatchedPair[]){
 const groups=new Map<string,MatchedPair[]>();for(const p of pairs){const g=groups.get(p.eventId);if(g)g.push(p);else groups.set(p.eventId,[p])}
 const perEvent=(read:(p:MatchedPair)=>number|null)=>[...groups.values()].map(g=>median(defined(g.map(read))));
 return {independentEventN:groups.size,
  medianGrossCreditSacrificedUsd:median(defined(perEvent(p=>p.grossCreditSacrificedUsd))),
  medianNetCreditSacrificedUsd:median(defined(perEvent(p=>p.netCreditSacrificedUsd))),
  medianWorstAdverseReductionUsd:median(defined(perEvent(p=>p.worstAdverseReductionUsd))),
  medianMaeReductionUsd:median(defined(perEvent(p=>p.maeReductionUsd))),
  medianRealizedPnlDeltaUsd:median(defined(perEvent(p=>diff(p.buffered.realizedPnlUsd,p.technical.realizedPnlUsd))))};
}

const BUCKETS:readonly ConditionalBucket[]=["breached","touched_not_breached","never_touched"];

export function buildShortStrikeReport(dataset:AnalysisDataset,scenario?:ExecutionScenario):ShortStrikeReport{
 const primary=scenario===undefined, selectedScenario=scenario??"maker";
 const all=normalizeShortStrikeStructures(primary?datasetForAnalyticsTrack(dataset,"reference"):dataset);
 const structures=all.filter(s=>primary?s.analyticsTrack==="reference":s.executionScenario===selectedScenario);

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
 const challengeRows=(method:StrikeMethod)=>{const unique=new Map<string,ShortStrikeStructure>();for(const p of pairs.filter(p=>p.technical.challenge.reason===null&&p.buffered.challenge.reason===null)){const row=method==="technical"?p.technical:p.buffered;unique.set([row.eventId,row.expiryTimestampMs,row.geometry.shortStrike].join("|"),row)}return [...unique.values()]};
 const technicalChallenge=challengeRows("technical"),bufferedChallenge=challengeRows("buffered");
 const technicalBreachShare=share(technicalChallenge.filter(s=>s.challenge.breached===true).length,technicalChallenge.length),
  bufferedBreachShare=share(bufferedChallenge.filter(s=>s.challenge.breached===true).length,bufferedChallenge.length);

 const report:ShortStrikeReport={
  scenario:primary?"reference":selectedScenario,structures,pairs,
  summary:{
   matchedPairs:pairs.length,
   matchedEvents:new Set(pairs.map(p=>p.eventId)).size,
   bufferEligibleTechnicalStructures:pairs.length,
   bufferEligibleShare:share(pairs.length,structures.filter(s=>s.strikeMethod==="technical").length),
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
   eventWeighted:eventWeighted(comparable),
  },
  geometry:(["technical","buffered"] as const).map(m=>geometryRow(m,pairs)),
  challenge:(["technical","buffered"] as const).map(m=>challengeRow(m,pairs)),
  conditionalPnl:BUCKETS.map(b=>conditionalRow(b,pairs)),
  unpaired,
  methodology:[
   "Scope. This report analyses short-strike PLACEMENT only. Spread width is held constant inside every comparison rather than studied here: placement decides where risk begins, width decides how much tail risk is retained. Width is analysed separately, and no result here is attributed to it.",
   `Comparison unit. Every figure is a MATCHED PAIR: the same MR event, the same actual expiry (hence the same actual DTE), the same width and protective-long rule, the same structure and option type, the same exit policy. Only the short strike differs. Execution scenario is absent from the primary key. This report is scoped to the ${primary?"reference":selectedScenario} track; explicit observed robustness layers are filtered before matching, so maker and taker are never mixed.`,
   "Thesis Exit (frozen for Short-Strike): the first candidate-relative post-entry endpoint of VPOC or invalidation, followed by settlement only when neither resolves before that structure's expiry. Exit-policy optimization is analysed separately so it cannot confound strike placement.",
   "Placement names are read from canonical strike_method, never inferred from the strike value. 'anchor' is the technical placement rounded from the failed-breakout extreme; 'buffered' is one strike step farther out. The generator only produces a buffered variant when the extreme sits within 100 of the rounded boundary, which is why many structures have no partner and are listed as unpaired rather than silently dropped.",
   "Inference scope. Technical-versus-buffered inference applies only to the buffer-eligible subset. Coverage reports all technical structures, eligible/matched technical structures, their share, raw pair N, and independent MR-event N; no missing buffered alternative is invented.",
   "Weighting. Exact event × expiry × width pairs remain diagnostics. Headline event-weighted statistics first take the median pair delta inside each MR event and then the median across events, giving every independent event equal weight. Pure challenge summaries use matched observations and should be read with independent-event N because expiry variants within an event are not independent.",
   "Distance sign. Every distance is signed so that POSITIVE MEANS FARTHER OUT OF THE MONEY for both directions: a bullish MR sells a put below spot, a bearish MR sells a call above it. Distances are measured from the entry spot (the candidate's own entry index where present, otherwise the event's entry price), from the failed-breakout extreme, and from the invalidation level, plus normalised by spot and by the event's range width.",
   "Entry delta is Unavailable. The canonical bundle records per-leg implied volatility but carries no delta on any table; deriving one from an IV anchor would present a model output as a canonical observation, so the column stays empty with its reason attached rather than being filled.",
   "Touch and breach come from the canonical hourly underlying path and nothing else. A TOUCH is a candle whose extreme reached the strike (low <= K for a short put, high >= K for a short call). A BREACH is a candle that CLOSED beyond it -- a completed hourly close is the finest settled evidence the path provides.",
   "Causality. Only candles that OPEN at or after structure entry and at or before expiry are counted: a candle straddling entry is partly pre-entry, and letting it challenge the strike would use price action from before the position existed. Post-expiry candles are excluded for the mirror-image reason.",
   "Ordering is asserted only at the precision the path has. The path is stamped at candle open, so a breach and an invalidation falling inside one hourly candle cannot be ordered; that case is reported as ambiguous and excluded from 'breach before invalidation' rather than resolved by assumption.",
   "Candidate-relative outcomes. Realized PnL follows Thesis Exit. Pre-entry and post-expiry endpoints are never used. Equal-time VPOC and invalidation are labelled ambiguous_resolution_order and excluded rather than arbitrarily ranked.",
   primary?"Reference adverse metrics use the Reference fair-value valuation path, bounded to the post-entry life and resolution boundary. USD metrics use USD marks only; native BTC is never labelled USD.":"Observed adverse metrics use this scenario's raw-VWAP track only. Modelled or Reference marks are never substituted, so absent tape remains Unavailable.",
   "Credit sacrificed = technical entry credit - buffered entry credit, reported gross and net, in USD at each structure's own entry index. Risk reduction is reported as buffered minus technical on the adverse figures, so a positive number always means buffering reduced the loss.",
   "Not evaluated, Unavailable and a true zero stay distinct throughout. A pair is marked economics-comparable only when BOTH sides were genuinely evaluated for the scenario; otherwise its economic deltas are Unavailable rather than zero.",
   "No selection. This report does not choose a strike rule. Lower loss alone does not make buffering superior, and higher average PnL alone does not make the technical strike superior: the tradeoff is credit given up against the reduction in challenged-position and tail losses that credit purchased.",
  ],
 };
 return primary?{...report,robustness:{maker:buildShortStrikeReport(dataset,"maker"),taker:buildShortStrikeReport(dataset,"taker")}}:report;
}
