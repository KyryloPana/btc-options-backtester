import type {AnalysisDataset} from "../research-analysis.ts";
import {projectVolatilityAnalytics,type AvailabilityTally} from "./volatility-analytics.ts";

export const REFERENCE_ANALYTICS_TRACK="reference_fair_value" as const;
export type Row=Readonly<Record<string,unknown>>;
const rows=(v:unknown):Row[]=>Array.isArray(v)?v.filter((x):x is Row=>!!x&&typeof x==="object"):[];
const n=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;
const s=(v:unknown)=>typeof v==="string"?v:null;
const observed=(v:unknown):Row|null=>{const x=v&&typeof v==="object"?v as Row:null;return x?.status==="available"&&x.observation==="observed"&&n(x.iv_decimal)!==null?x:null};
export const volatilityLeg=(r:Row,k:"short"|"long")=>observed(rows(r.legs).find(x=>x.leg===k));
export const volatilityDiff=(r:Row,k:string)=>rows(r.differentials).find(x=>x.differential===k&&x.status==="available")??null;
export const quantiles=(xs:readonly number[])=>{const a=[...xs].sort((x,y)=>x-y),q=(p:number)=>{if(!a.length)return null;const z=(a.length-1)*p,l=Math.floor(z),u=Math.ceil(z);return a[l]!+(a[u]!-a[l]!)*(z-l)};return{n:a.length,p25:q(.25),median:q(.5),p75:q(.75)}};
const tally=(available:number,total:number,reason:string):AvailabilityTally=>({available,total,ratio:total?available/total:null,reasons:available===total?{}:{[reason]:total-available}});

export interface VolatilityEndpoint {id:string;label:string;candidateId:string;timestampUtc:string|null;entryShortIv:number|null;shortIv:number|null;deltaShortIv:number|null;entryLongIv:number|null;longIv:number|null;deltaLongIv:number|null;status:"available"|"unavailable";reason:string|null}
export interface EndpointAggregate {id:string;label:string;n:number;denominator:number;medianDeltaShortIv:number|null;medianDeltaLongIv:number|null;shortCompressionShare:number|null;shortExpansionShare:number|null}
export interface PathDiagnostic {candidateId:string;shortPoints:number;longPoints:number;shortMin:number|null;shortMax:number|null;shortRange:number|null;longMin:number|null;longMax:number|null;longRange:number|null}
export interface VolatilityReport {executionIndependent:true;coverage:ReturnType<typeof projectVolatilityAnalytics>["coverage"];eventDenominator:number;structureDenominator:number;events:readonly Row[];structures:readonly Row[];structureCoverage:{short:AvailabilityTally;long:AvailabilityTally;both:AvailabilityTally};aggregates:Readonly<Record<string,ReturnType<typeof quantiles>>>;endpoints:readonly VolatilityEndpoint[];endpointAggregates:readonly EndpointAggregate[];endpointCoverage:AvailabilityTally;paths:readonly PathDiagnostic[]}

/** Descriptive market-IV analytics. Pricing/reconstructed IV is never admitted. */
export function buildVolatilityReport(dataset:AnalysisDataset):VolatilityReport{
 const p=projectVolatilityAnalytics(dataset.tables),structures=p.structures,vals=dataset.tables.valuations??[],outs=dataset.tables.outcomes??[];
 const eventDenominator=dataset.tables.events?.length??p.events.length,structureDenominator=new Set((dataset.tables.candidates??[]).map(x=>String(x.candidate_id))).size||structures.length;
 const shortN=structures.filter(x=>volatilityLeg(x,"short")).length,longN=structures.filter(x=>volatilityLeg(x,"long")).length,bothN=structures.filter(x=>volatilityLeg(x,"short")&&volatilityLeg(x,"long")).length;
 const metrics:Record<string,number[]>={short_iv:[],long_iv:[],reference_iv:[],short_minus_reference_iv:[],long_minus_reference_iv:[],short_minus_long_iv:[]};
 for(const r of structures){for(const [k,v] of [["short_iv",n(volatilityLeg(r,"short")?.iv_decimal)],["long_iv",n(volatilityLeg(r,"long")?.iv_decimal)],["reference_iv",n((r.same_expiry_reference as Row|undefined)?.iv_decimal)]] as const)if(v!==null)metrics[k]!.push(v);for(const k of ["short_minus_reference_iv","long_minus_reference_iv","short_minus_long_iv"]){const v=n(volatilityDiff(r,k)?.value);if(v!==null)metrics[k]!.push(v)}}
 const endpoints:VolatilityEndpoint[]=[];
 const endpointDefs=[...[["4h","+4h",4],["12h","+12h",12],["1d","+1D",24],["3d","+3D",72]] as const];
 const outcomeDefs=[["vpoc","VPOC"],["invalidation","Invalidation"],["credit_capture_50","50% capture"],["credit_capture_70","70% capture"],["fixed_3d","Fixed 3D"],["fixed_5d","Fixed 5D"],["fixed_7d","Fixed 7D"],["settlement","Settlement"]] as const;
 for(const r of structures){const id=String(r.candidate_id),entryMs=Date.parse(String(r.entry_timestamp_utc)),baseS=n(volatilityLeg(r,"short")?.iv_decimal),baseL=n(volatilityLeg(r,"long")?.iv_decimal),vr=vals.filter(v=>String(v.candidate_id)===id&&v.analytics_track===REFERENCE_ANALYTICS_TRACK);
  const add=(key:string,label:string,ts:string|null)=>{const point=ts?vr.find(v=>v.timestamp_utc===ts):undefined,ps=observed(point?.short_leg_volatility),pl=observed(point?.long_leg_volatility),sv=n(ps?.iv_decimal),lv=n(pl?.iv_decimal),ds=baseS!==null&&sv!==null?sv-baseS:null,dl=baseL!==null&&lv!==null?lv-baseL:null,ok=ds!==null||dl!==null;endpoints.push({id:key,label,candidateId:id,timestampUtc:ts,entryShortIv:baseS,shortIv:sv,deltaShortIv:ds,entryLongIv:baseL,longIv:lv,deltaLongIv:dl,status:ok?"available":"unavailable",reason:ok?null:point?"endpoint_market_iv_not_observed":"exact_canonical_valuation_unavailable"})};
  for(const [key,label,h] of endpointDefs)add(key,label,Number.isFinite(entryMs)?new Date(entryMs+h*3600000).toISOString():null);
  for(const [key,label] of outcomeDefs){const o=outs.find(x=>String(x.candidate_id)===id&&x.analytics_track===REFERENCE_ANALYTICS_TRACK&&x.outcome_type===key);add(key,label,s(o?.valuation_timestamp_utc))}
 }
 const endpointAggregates=[...new Map(endpoints.map(x=>[x.id,x.label])).entries()].map(([id,label])=>{const all=endpoints.filter(x=>x.id===id),ok=all.filter(x=>x.deltaShortIv!==null||x.deltaLongIv!==null),ds=ok.flatMap(x=>x.deltaShortIv===null?[]:[x.deltaShortIv]),dl=ok.flatMap(x=>x.deltaLongIv===null?[]:[x.deltaLongIv]);return{id,label,n:ok.length,denominator:all.length,medianDeltaShortIv:quantiles(ds).median,medianDeltaLongIv:quantiles(dl).median,shortCompressionShare:ds.length?ds.filter(x=>x<0).length/ds.length:null,shortExpansionShare:ds.length?ds.filter(x=>x>0).length/ds.length:null}});
 const paths=structures.map(r=>{const id=String(r.candidate_id),v=vals.filter(x=>String(x.candidate_id)===id&&x.analytics_track===REFERENCE_ANALYTICS_TRACK),ss=v.flatMap(x=>{const z=observed(x.short_leg_volatility);return z?[n(z.iv_decimal)!]:[]}),ll=v.flatMap(x=>{const z=observed(x.long_leg_volatility);return z?[n(z.iv_decimal)!]:[]}),q=(a:number[])=>({min:a.length?Math.min(...a):null,max:a.length?Math.max(...a):null});const a=q(ss),b=q(ll);return{candidateId:id,shortPoints:ss.length,longPoints:ll.length,shortMin:a.min,shortMax:a.max,shortRange:a.min!==null&&a.max!==null?a.max-a.min:null,longMin:b.min,longMax:b.max,longRange:b.min!==null&&b.max!==null?b.max-b.min:null}});
 const available=endpoints.filter(x=>x.status==="available").length;
 return{executionIndependent:true,coverage:p.coverage,eventDenominator,structureDenominator,events:p.events,structures,structureCoverage:{short:tally(shortN,structureDenominator,"short_market_iv_unavailable"),long:tally(longN,structureDenominator,"long_market_iv_unavailable"),both:tally(bothN,structureDenominator,"both_legs_not_observed")},aggregates:Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,quantiles(v)])),endpoints,endpointAggregates,endpointCoverage:tally(available,endpoints.length,"endpoint_market_iv_unavailable"),paths};
}
