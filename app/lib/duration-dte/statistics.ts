import type {KaplanMeierPoint} from "../underlying-resolution/statistics.ts";

/**
 * Pure statistics specific to Duration & DTE.
 *
 * Percentiles and five-number summaries are deliberately NOT reimplemented
 * here -- they are imported directly from underlying-resolution/statistics.ts
 * so a value is never computed twice by two different formulas.
 */

export interface CoveragePoint {readonly timeDays:number;readonly coverage:number;readonly lower:number|null;readonly upper:number|null}

/**
 * Resolution coverage P(T_resolution < t) derived directly from the SAME
 * Kaplan-Meier event-free probability curve Underlying Resolution computes
 * (coverage = 1 - S(t)). This is not a second competing censoring model: it is
 * the identical curve, relabelled, so "how much of the MR thesis resolves
 * within t days" and "the event-free probability curve" can never disagree.
 */
export function coverageFromSurvival(curve:readonly KaplanMeierPoint[]):readonly CoveragePoint[]{
 return curve.map(p=>({
  timeDays:p.timeDays,coverage:1-p.survival,
  lower:p.upper===null?null:1-p.upper,
  upper:p.lower===null?null:1-p.lower,
 }));
}

/** Simple percentage helper that is honest about an empty denominator. */
export function share(count:number,whole:number):number|null{
 return whole>0?count/whole:null;
}
