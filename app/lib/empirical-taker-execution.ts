import {impliedVolatilityFromInversePrice} from "./inverse-option-pricing.ts";
import {contentHash} from "./volatility/reference-series.ts";
import {EXECUTION_CALIBRATION_DATASET_ID,EXECUTION_CALIBRATION_METHOD_VERSION,type ExecutionCalibrationObservation} from "./execution-calibration.ts";

export const EMPIRICAL_TAKER_EXECUTION_VERSION="empirical-taker-execution-v1" as const;
export const EXECUTION_BUCKET_POLICY_VERSION="taker-action-dte-amount-v1" as const;
export const QUANTILE_METHOD="linear-interpolation-r7" as const;
export const CONDITIONAL_SUPPORT={trades:500,calendarDays:10,expiryDayGroups:20} as const;
export const GLOBAL_SUPPORT={trades:5000,calendarDays:10,expiryDayGroups:20} as const;
export type DteBand="1-3"|"3-7"|"7-14"|"14-30"|"30-46";
export type AmountBand="small"|"larger";
export type TakerAction="buy"|"sell";
export interface EmpiricalCalibrationRow{tradeId:string;timestampMs:number;action:TakerAction;dteDays:number;dteBand:DteBand;amount:number;amountBand:AmountBand;expiryDayGroup:string;calendarDate:string;concessionVolPoints:number;referenceErrorVolPoints:number}
export interface ExecutionEstimatorArtifact{datasetId:string;methodVersion:string;sourceDatasetFingerprint:string;coverageStartMs:number|null;coverageEndMs:number|null;estimatorVersion:string;bucketPolicyVersion:string;tradeCount:number;uniqueDays:number;uniqueExpiryDayGroups:number;quantileMethod:string;rows:EmpiricalCalibrationRow[];artifactHash:string}
export interface BucketEstimate{fallbackLevel:"action_dte_amount"|"action_dte"|"action"|"global";tradeCount:number;calendarDayCount:number;expiryDayGroupCount:number;q50VolPoints:number;q90VolPoints:number;dteBand:DteBand;amountBand:AmountBand}
export interface ReferenceEstimate{fallbackLevel:"dte"|"global";tradeCount:number;calendarDayCount:number;expiryDayGroupCount:number;q90VolPoints:number;dteBand:DteBand}

export function dteBand(dte:number):DteBand|null{return dte>=1&&dte<3?"1-3":dte>=3&&dte<7?"3-7":dte>=7&&dte<14?"7-14":dte>=14&&dte<30?"14-30":dte>=30&&dte<=46?"30-46":null}
export const amountBand=(amount:number):AmountBand=>amount<=1?"small":"larger";
export function quantileR7(values:readonly number[],p:number){if(!values.length)return null;const x=[...values].sort((a,b)=>a-b),h=(x.length-1)*p,lo=Math.floor(h),f=h-lo;return x[lo]!+(x[Math.min(lo+1,x.length-1)]!-x[lo]!)*f}
const economicIdentity=(r:ExecutionCalibrationObservation)=>JSON.stringify([r.trade_timestamp_ms,r.direction,r.trade_iv_decimal,r.primary_fair_iv_decimal,r.mark_price_btc,r.index_price,r.forward_price,r.strike,r.option_type,r.expiry_timestamp_ms,r.actual_dte_days,r.amount,r.forward_moneyness,r.features?.calendar_date,r.features?.expiry_date_group_id]);
export function compileCalibrationRows(observations:readonly ExecutionCalibrationObservation[]):EmpiricalCalibrationRow[]{
 const ids=new Map<string,string>(),rows:EmpiricalCalibrationRow[]=[];
 for(const r of observations){if(r.method_version!==EXECUTION_CALIBRATION_METHOD_VERSION||!r.taker_concession_eligible||!r.trade_id)continue;const identity=economicIdentity(r),prior=ids.get(r.trade_id);if(prior!==undefined){if(prior!==identity)throw new Error(`Conflicting economic fields for duplicate trade_id ${r.trade_id}`);continue}ids.set(r.trade_id,identity);
  const action=r.direction,band=dteBand(r.actual_dte_days),amount=r.amount,forward=r.forward_price,index=r.index_price,fair=r.primary_fair_iv_decimal,trade=r.trade_iv_decimal,mark=r.mark_price_btc,m=r.forward_moneyness;
  if((action!=="buy"&&action!=="sell")||band===null||amount===null||!(amount>0)||forward===null||!(forward>0)||index===null||!(index>0)||fair===null||!(fair>0)||trade===null||!(trade>0)||mark===null||!(mark>=0)||m===null||Math.abs(m)>0.35)continue;
  const markIv=impliedVolatilityFromInversePrice({optionType:r.option_type==="C"?"call":"put",indexPrice:index,strike:r.strike,valuationTimestamp:r.trade_timestamp_ms,expiryTimestamp:r.expiry_timestamp_ms,forwardPrice:forward,priceBtc:mark});if(markIv===null)continue;
  rows.push({tradeId:r.trade_id,timestampMs:r.trade_timestamp_ms,action,dteDays:r.actual_dte_days,dteBand:band,amount,amountBand:amountBand(amount),expiryDayGroup:r.features.expiry_date_group_id,calendarDate:r.features.calendar_date,concessionVolPoints:(action==="buy"?trade-markIv:markIv-trade)*100,referenceErrorVolPoints:Math.abs(fair-markIv)*100});
 }
 return rows.sort((a,b)=>a.timestampMs-b.timestampMs||a.tradeId.localeCompare(b.tradeId));
}
const support=(rows:readonly EmpiricalCalibrationRow[])=>({tradeCount:rows.length,calendarDayCount:new Set(rows.map(r=>r.calendarDate)).size,expiryDayGroupCount:new Set(rows.map(r=>r.expiryDayGroup)).size});
const adequate=(s:ReturnType<typeof support>,global=false)=>s.tradeCount>=(global?GLOBAL_SUPPORT.trades:CONDITIONAL_SUPPORT.trades)&&s.calendarDayCount>=10&&s.expiryDayGroupCount>=20;
const causalEnd=(rows:readonly EmpiricalCalibrationRow[],cutoffMs:number)=>{let low=0,high=rows.length;while(low<high){const middle=(low+high)>>>1;if(rows[middle]!.timestampMs<cutoffMs)low=middle+1;else high=middle}return low};
const causalPrefix=(rows:readonly EmpiricalCalibrationRow[]|undefined,cutoffMs:number):readonly EmpiricalCalibrationRow[]=>rows?.slice(0,causalEnd(rows,cutoffMs))??[];
const grouped=(rows:readonly EmpiricalCalibrationRow[],key:(row:EmpiricalCalibrationRow)=>string)=>{const groups=new Map<string,EmpiricalCalibrationRow[]>();for(const row of rows){const value=key(row),group=groups.get(value);if(group)group.push(row);else groups.set(value,[row])}return groups};
export class ExecutionCalibrationIndex{
 readonly artifact:ExecutionEstimatorArtifact;
 private readonly rows:readonly EmpiricalCalibrationRow[];
 private readonly byAction:Map<string,EmpiricalCalibrationRow[]>;
 private readonly byActionDte:Map<string,EmpiricalCalibrationRow[]>;
 private readonly byActionDteAmount:Map<string,EmpiricalCalibrationRow[]>;
 private readonly byDte:Map<string,EmpiricalCalibrationRow[]>;
 constructor(input:readonly ExecutionCalibrationObservation[]|ExecutionEstimatorArtifact){const raw=Array.isArray(input),artifact=input as ExecutionEstimatorArtifact,observations=input as readonly ExecutionCalibrationObservation[],rows:EmpiricalCalibrationRow[]=raw?compileCalibrationRows(observations):artifact.rows;const base={datasetId:EXECUTION_CALIBRATION_DATASET_ID,methodVersion:EXECUTION_CALIBRATION_METHOD_VERSION,sourceDatasetFingerprint:raw?contentHash(rows.map(r=>r.tradeId)):artifact.sourceDatasetFingerprint,coverageStartMs:rows[0]?.timestampMs??null,coverageEndMs:rows.at(-1)?.timestampMs??null,estimatorVersion:EMPIRICAL_TAKER_EXECUTION_VERSION,bucketPolicyVersion:EXECUTION_BUCKET_POLICY_VERSION,tradeCount:rows.length,uniqueDays:new Set(rows.map(r=>r.calendarDate)).size,uniqueExpiryDayGroups:new Set(rows.map(r=>r.expiryDayGroup)).size,quantileMethod:QUANTILE_METHOD,rows};this.artifact={...base,artifactHash:raw?contentHash(base):artifact.artifactHash};this.rows=[...rows].sort((a,b)=>a.timestampMs-b.timestampMs||a.tradeId.localeCompare(b.tradeId));this.byAction=grouped(this.rows,r=>r.action);this.byActionDte=grouped(this.rows,r=>`${r.action}|${r.dteBand}`);this.byActionDteAmount=grouped(this.rows,r=>`${r.action}|${r.dteBand}|${r.amountBand}`);this.byDte=grouped(this.rows,r=>r.dteBand)}
 execution(target:{action:TakerAction;dteDays:number;amount:number;forwardMoneyness:number;cutoffMs:number}):BucketEstimate|null{const band=dteBand(target.dteDays);if(!band||Math.abs(target.forwardMoneyness)>0.35)return null;const ab=amountBand(target.amount),levels=[{name:"action_dte_amount" as const,rows:causalPrefix(this.byActionDteAmount.get(`${target.action}|${band}|${ab}`),target.cutoffMs)},{name:"action_dte" as const,rows:causalPrefix(this.byActionDte.get(`${target.action}|${band}`),target.cutoffMs)},{name:"action" as const,rows:causalPrefix(this.byAction.get(target.action),target.cutoffMs)},{name:"global" as const,rows:causalPrefix(this.rows,target.cutoffMs)}];for(const level of levels){const s=support(level.rows);if(adequate(s,level.name==="global")){return{fallbackLevel:level.name,...s,q50VolPoints:quantileR7(level.rows.map(r=>r.concessionVolPoints),.5)!,q90VolPoints:quantileR7(level.rows.map(r=>r.concessionVolPoints),.9)!,dteBand:band,amountBand:ab}}}return null}
 reference(target:{dteDays:number;cutoffMs:number}):ReferenceEstimate|null{const band=dteBand(target.dteDays);if(!band)return null;const levels=[{name:"dte" as const,rows:causalPrefix(this.byDte.get(band),target.cutoffMs)},{name:"global" as const,rows:causalPrefix(this.rows,target.cutoffMs)}];for(const level of levels){const s=support(level.rows);if(adequate(s,level.name==="global"))return{fallbackLevel:level.name,...s,q90VolPoints:quantileR7(level.rows.map(r=>r.referenceErrorVolPoints),.9)!,dteBand:band}}return null}
}
