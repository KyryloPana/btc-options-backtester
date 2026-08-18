/**
 * Pure time-to-event statistics for the Underlying Resolution report.
 *
 * Written fresh for this report. Nothing here falls back to 0 for a missing or
 * inestimable quantity: every function returns `null` when the data cannot
 * support the statistic, and callers are expected to render an explicit
 * "Not estimable" / "Unavailable" state rather than a number.
 */

/** One time-to-event observation. `observed:false` means right-censored at `timeDays`. */
export interface SurvivalObservation {readonly timeDays:number;readonly observed:boolean}

export interface KaplanMeierPoint {
 readonly timeDays:number;
 /** Number still under observation immediately before `timeDays`. */
 readonly atRisk:number;
 readonly events:number;
 readonly censored:number;
 /** Event-free probability S(t): probability of NOT having resolved by `timeDays`. */
 readonly survival:number;
 /** Log-log transformed 95% band; null where the band is not estimable. */
 readonly lower:number|null;
 readonly upper:number|null;
}

const finite=(x:number)=>Number.isFinite(x);

/**
 * Kaplan-Meier estimator of the event-free probability.
 *
 * Standard convention: at a tied time, events are treated as occurring before
 * censorings, so an observation censored at exactly t remains in the risk set
 * for the event increment at t. A censored observation never contributes to the
 * numerator of an event increment — it only leaves the risk set afterwards.
 *
 * Returns points at each distinct event time, plus a leading S(0)=1 anchor.
 * Times with only censorings do not produce a step (S is unchanged there) but do
 * reduce the risk set for later times.
 */
export function kaplanMeier(observations:readonly SurvivalObservation[]):readonly KaplanMeierPoint[]{
 const clean=observations.filter(o=>finite(o.timeDays)&&o.timeDays>=0);
 if(!clean.length)return [];
 const times=[...new Set(clean.filter(o=>o.observed).map(o=>o.timeDays))].sort((a,b)=>a-b);
 const points:KaplanMeierPoint[]=[{timeDays:0,atRisk:clean.length,events:0,censored:0,survival:1,lower:1,upper:1}];
 let survival=1,greenwood=0;
 for(const t of times){
  const atRisk=clean.filter(o=>o.timeDays>=t).length;
  const events=clean.filter(o=>o.observed&&o.timeDays===t).length;
  const censored=clean.filter(o=>!o.observed&&o.timeDays===t).length;
  if(atRisk<=0)break;
  survival*=1-events/atRisk;
  // Greenwood's formula accumulates d / (n * (n - d)); undefined once n === d.
  greenwood+=atRisk>events?events/(atRisk*(atRisk-events)):Number.POSITIVE_INFINITY;
  let lower:number|null=null,upper:number|null=null;
  if(survival>0&&survival<1&&finite(greenwood)){
   // Log-log transform keeps the band inside (0,1).
   // se is sigma / |log S|; the band is S^factor (lower) and S^(1/factor)
   // (upper), because raising S in (0,1) to a larger power moves it down.
   const se=Math.sqrt(greenwood)/Math.abs(Math.log(survival)),
    factor=Math.exp(1.959964*se);
   lower=survival**factor;
   upper=survival**(1/factor);
  }else if(survival===1){lower=1;upper=1}
  points.push({timeDays:t,atRisk,events,censored,survival,lower,upper});
 }
 return points;
}

/**
 * Quantile read off a Kaplan-Meier curve: the smallest time at which the
 * event-free probability has fallen to or below 1 - p.
 *
 * Returns null ("Not estimable") when the curve never descends that far, which
 * is the correct answer under heavy censoring rather than the largest observed
 * time. This is why percentiles here are not raw order statistics.
 */
export function kaplanMeierQuantile(curve:readonly KaplanMeierPoint[],p:number):number|null{
 if(!curve.length||!(p>0&&p<1))return null;
 const threshold=1-p;
 for(const point of curve)if(point.survival<=threshold+1e-12)return point.timeDays;
 return null;
}

/**
 * Percentiles of time to a specific outcome under competing risks.
 *
 * Observations that resolved via the competing outcome, or that were censored,
 * are treated as censored for this endpoint — they were under observation and
 * simply never experienced *this* event.
 */
export function quantiles(observations:readonly SurvivalObservation[],ps:readonly number[]):readonly (number|null)[]{
 const curve=kaplanMeier(observations);
 return ps.map(p=>kaplanMeierQuantile(curve,p));
}

/** Counts of observed vs censored, used for data-sufficiency reporting. */
export function riskSummary(observations:readonly SurvivalObservation[]):{effectiveN:number;observed:number;censored:number}{
 const clean=observations.filter(o=>finite(o.timeDays)&&o.timeDays>=0);
 return {effectiveN:clean.length,observed:clean.filter(o=>o.observed).length,censored:clean.filter(o=>!o.observed).length};
}
