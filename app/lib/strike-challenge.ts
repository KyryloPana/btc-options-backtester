/**
 * Whether and when the underlying challenged a short strike while a structure
 * existed.
 *
 * A shared canonical primitive rather than one report's helper: Short-Strike
 * and Spread-Width both ask it of the same strike and the same path, and must
 * answer identically. Touch/breach depends on the SHORT STRIKE and the path
 * only -- never on the protective long -- which is why a width comparison that
 * holds the short strike constant sees the same challenge state at every width.
 */

/** Why a figure has no value. Never collapsed into a zero. */
export type UnavailableReason=string;

const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const ms=(v:unknown):number|null=>{if(typeof v==="number"&&Number.isFinite(v))return v;const s=str(v);if(!s)return null;const t=Date.parse(s);return Number.isFinite(t)?t:null};

/**
 * How the underlying challenged the short strike while the structure existed.
 *
 * TOUCH and BREACH are defined from the canonical hourly underlying path and
 * nothing else:
 *  - TOUCH: the candle's extreme reached the strike (low <= K for a short put,
 *    high >= K for a short call). The strike was tested intrabar.
 *  - BREACH: the candle CLOSED beyond the strike. A completed hourly close is
 *    the finest settled evidence the path provides.
 *
 * Ordering is only ever asserted at the precision the path actually has. The
 * path is stamped at candle OPEN, so two events inside one hourly candle
 * cannot be ordered; that case is reported as ambiguous rather than resolved
 * by assumption.
 */
export interface ChallengeObservation {
 readonly touched:boolean|null;
 readonly breached:boolean|null;
 readonly firstTouchMs:number|null;
 readonly firstBreachMs:number|null;
 readonly invalidationMs:number|null;
 readonly invalidatedInWindow:boolean|null;
 /** Null when both happened but within one candle, so their order is genuinely unknown. */
 readonly breachBeforeInvalidation:boolean|null;
 readonly ambiguousOrdering:boolean;
 /** First challenge and Thesis Exit occupy the same hourly candle. */
 readonly ambiguousWithExit:boolean;
 readonly invalidatedWithoutBreach:boolean|null;
 readonly candlesInWindow:number;
 readonly reason:UnavailableReason|null;
}

/**
 * Touch/breach from the canonical hourly path, bounded to the structure's own
 * life. The path is stamped at candle OPEN, so a candle is only counted when
 * it OPENS at or after structure entry: a candle straddling entry is partly
 * pre-entry, and counting it would let price action from before the position
 * existed challenge it. Candles opening after expiry are excluded for the
 * mirror-image reason.
 */
export function challengeOf(
 path:readonly Readonly<Record<string,unknown>>[],
 shortStrike:number|null,direction:"long"|"short"|null,
 entryMs:number|null,expiryMs:number|null,invalidationMs:number|null,thesisExitMs:number|null=null,
):ChallengeObservation{
 const empty={touched:null,breached:null,firstTouchMs:null,firstBreachMs:null,invalidationMs,
  invalidatedInWindow:null,breachBeforeInvalidation:null,ambiguousOrdering:false,ambiguousWithExit:false,
  invalidatedWithoutBreach:null,candlesInWindow:0} as const;
 if(shortStrike===null||direction===null)return {...empty,reason:"The structure has no canonical short strike or the event has no direction, so the strike cannot be challenged."};
 if(entryMs===null||expiryMs===null)return {...empty,reason:"Structure entry or expiry is unknown, so no causal observation window can be bounded."};
 if(!path.length)return {...empty,reason:"The canonical bundle exports no underlying path for this event."};

 const bullish=direction==="long";
 let firstTouchMs:number|null=null,firstBreachMs:number|null=null,candlesInWindow=0,breachCandleOpen:number|null=null;
 const ordered=[...path].map(row=>({t:ms(row.timestamp_utc),high:num(row.high),low:num(row.low),close:num(row.close)}))
  .filter(c=>c.t!==null).sort((a,b)=>a.t!-b.t!);
 for(const candle of ordered){
  const t=candle.t!;
  if(t<entryMs||t>expiryMs)continue;
  candlesInWindow++;
  const touched=bullish?candle.low!==null&&candle.low<=shortStrike:candle.high!==null&&candle.high>=shortStrike;
  if(touched&&firstTouchMs===null)firstTouchMs=t;
  const breached=candle.close!==null&&(bullish?candle.close<shortStrike:candle.close>shortStrike);
  if(breached&&firstBreachMs===null){firstBreachMs=t;breachCandleOpen=t}
 }
 if(!candlesInWindow)return {...empty,reason:"The canonical path has no candle opening inside this structure's life, so touch and breach are unobservable."};

 const invalidatedInWindow=invalidationMs===null?false:invalidationMs>=entryMs&&invalidationMs<=expiryMs;
 // Two events inside one hourly candle cannot be ordered from candle-open
 // stamps, so the sequence is preserved as unknown rather than invented.
 const candleOf=(t:number)=>Math.floor(t/3_600_000)*3_600_000;
 const ambiguousOrdering=firstBreachMs!==null&&invalidationMs!==null&&invalidatedInWindow
  &&breachCandleOpen!==null&&candleOf(invalidationMs)===breachCandleOpen;
 const ambiguousWithExit=thesisExitMs!==null&&(
  (firstTouchMs!==null&&candleOf(thesisExitMs)===firstTouchMs)||
  (firstBreachMs!==null&&candleOf(thesisExitMs)===firstBreachMs));
 if(ambiguousWithExit)return {...empty,invalidationMs,invalidatedInWindow,
  ambiguousWithExit:true,reason:"The first strike challenge and Thesis Exit fall in the same hourly candle, so their causal order is unavailable."};
 const breachBeforeInvalidation=firstBreachMs===null||invalidationMs===null||!invalidatedInWindow?null
  :ambiguousOrdering?null
  :firstBreachMs<invalidationMs;
 return {
  touched:firstTouchMs!==null,breached:firstBreachMs!==null,firstTouchMs,firstBreachMs,invalidationMs,
  invalidatedInWindow,breachBeforeInvalidation,ambiguousOrdering,ambiguousWithExit,
  invalidatedWithoutBreach:invalidatedInWindow?firstBreachMs===null:false,
  candlesInWindow,reason:null,
 };
}
