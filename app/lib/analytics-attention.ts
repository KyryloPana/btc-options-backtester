import type {PositionEconomics} from "./economics/position.ts";

export type AnalyticsEvidenceStatus="VALID"|"PARTIAL"|"UNAVAILABLE"|"INVALID";
export type AnalyticsAttentionKind="UNUSUAL"|"ADVERSE"|"FAVORABLE"|"TAIL"|"LOW_N";
export interface AnalyticsAttention {kind:AnalyticsAttentionKind;reason:string}
export interface AnalyticsAssessment {evidence:AnalyticsEvidenceStatus;evidenceReason:string;attention:readonly AnalyticsAttention[]}

/** Descriptive tails are presentation only: never exclusions or strategy selection. */
export const ECONOMICS_TAIL_ATTENTION_MIN_N=20;
const invalidReason=(reason:string)=>/(?:integrity|semantic|causal violation|pre[_ -]?entry|after[_ -]?expiry|invalid timestamp)/i.test(reason);

export function assessEconomicPositions(positions:readonly PositionEconomics[]):ReadonlyMap<string,AnalyticsAssessment>{
 const priced=positions.filter(p=>p.status==="priced"&&p.pnlBtc!==null),pnls=priced.map(p=>p.pnlBtc!).sort((a,b)=>a-b),tails=pnls.length>=ECONOMICS_TAIL_ATTENTION_MIN_N;let low:number|null=null,high:number|null=null;
 if(tails){low=pnls[Math.floor((pnls.length-1)*.1)]!;high=pnls[Math.ceil((pnls.length-1)*.9)]!}
 return new Map(positions.map(p=>{const reason=p.missingReason??"Canonical economic evidence is complete.";let evidence:AnalyticsEvidenceStatus;
  if(invalidReason(reason))evidence="INVALID";
  else if(p.status!=="priced")evidence="UNAVAILABLE";
  else if([p.trackMaximumNetLossBtc,p.incrementalInitialMarginBtc,p.peakInitialMarginBtc,p.capitalDaysBtc].some(x=>x.value===null))evidence="PARTIAL";
  else evidence="VALID";
  const attention:AnalyticsAttention[]=[];
  if(tails&&p.pnlBtc!==null&&p.pnlBtc<=low!)attention.push({kind:"UNUSUAL",reason:`Descriptive lower PnL decile (N=${pnls.length}); retained as a valid observation.`},{kind:"ADVERSE",reason:"Economically adverse tail observation; evidence validity is assessed separately."},{kind:"TAIL",reason:"PnL is at or below the cohort P10."});
  if(tails&&p.pnlBtc!==null&&p.pnlBtc>=high!)attention.push({kind:"UNUSUAL",reason:`Descriptive upper PnL decile (N=${pnls.length}); retained as a valid observation.`},{kind:"FAVORABLE",reason:"Economically favorable tail observation; this is not a strategy recommendation."},{kind:"TAIL",reason:"PnL is at or above the cohort P90."});
  return [`${p.structureExecutionId}|${p.exitPolicy}`,{evidence,evidenceReason:reason,attention}] as const;
 }));
}

export type AttentionFilter="attention"|"invalid"|"partial"|"unavailable"|"unusual"|"all";
export function matchesAttentionFilter(a:AnalyticsAssessment,filter:AttentionFilter){if(filter==="all")return true;if(filter==="invalid")return a.evidence==="INVALID";if(filter==="partial")return a.evidence==="PARTIAL";if(filter==="unavailable")return a.evidence==="UNAVAILABLE";if(filter==="unusual")return a.attention.some(x=>x.kind==="UNUSUAL");return a.evidence!=="VALID"||a.attention.length>0}
export function summarizeAttention(rows:Iterable<AnalyticsAssessment>){const out={invalid:0,partial:0,unavailable:0,unusualAdverse:0,unusualFavorable:0,lowN:0};for(const a of rows){if(a.evidence==="INVALID")out.invalid++;if(a.evidence==="PARTIAL")out.partial++;if(a.evidence==="UNAVAILABLE")out.unavailable++;if(a.attention.some(x=>x.kind==="UNUSUAL")&&a.attention.some(x=>x.kind==="ADVERSE"))out.unusualAdverse++;if(a.attention.some(x=>x.kind==="UNUSUAL")&&a.attention.some(x=>x.kind==="FAVORABLE"))out.unusualFavorable++;if(a.attention.some(x=>x.kind==="LOW_N"))out.lowN++}return out}
