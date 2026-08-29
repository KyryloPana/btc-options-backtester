import type {AnalysisDataset} from "../research-analysis.ts";
import {projectVolatilityAnalytics, type AvailabilityTally} from "./volatility-analytics.ts";

type Row=Readonly<Record<string,unknown>>;
const rows=(value:unknown):Row[]=>Array.isArray(value)?value.filter((v):v is Row=>Boolean(v)&&typeof v==="object"):[];
const text=(value:unknown)=>typeof value==="string"?value:null;
const number=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:null;
const observedLeg=(value:unknown):Row|null=>{const v=value&&typeof value==="object"?value as Row:null;return v?.status==="available"&&v.observation==="observed"&&number(v.iv_decimal)!==null?v:null};
const leg=(row:Row,name:"short"|"long")=>observedLeg(rows(row.legs).find(value=>value.leg===name));
const differential=(row:Row,name:string)=>rows(row.differentials).find(value=>value.differential===name&&value.status==="available")??null;
const quantiles=(values:readonly number[])=>{const sorted=[...values].sort((a,b)=>a-b),q=(p:number)=>{if(!sorted.length)return null;const i=(sorted.length-1)*p,l=Math.floor(i),u=Math.ceil(i);return sorted[l]!+(sorted[u]!-sorted[l]!)*(i-l)};return {n:sorted.length,p25:q(.25),median:q(.5),p75:q(.75)}};
const availability=(available:number,total:number,reasons:Record<string,number>):AvailabilityTally=>({available,total,ratio:total?available/total:null,reasons});

export interface VolatilityEndpoint {readonly id:string;readonly label:string;readonly candidateId:string;readonly timestampUtc:string|null;readonly shortIv:number|null;readonly longIv:number|null;readonly deltaShortIv:number|null;readonly deltaLongIv:number|null;readonly status:"available"|"unavailable";readonly reason:string|null}
export interface VolatilityReport {readonly executionIndependent:true;readonly coverage:ReturnType<typeof projectVolatilityAnalytics>["coverage"];readonly events:readonly Row[];readonly structures:readonly Row[];readonly structureCoverage:{short:AvailabilityTally;long:AvailabilityTally;both:AvailabilityTally};readonly aggregates:Readonly<Record<string,ReturnType<typeof quantiles>>>;readonly endpoints:readonly VolatilityEndpoint[];readonly endpointCoverage:AvailabilityTally}

/** Builds a descriptive market-state report without creating a valuation path. */
export function buildVolatilityReport(dataset:AnalysisDataset):VolatilityReport{
 const projection=projectVolatilityAnalytics(dataset.tables),structures=projection.structures;
 const shortN=structures.filter(r=>leg(r,"short")).length,longN=structures.filter(r=>leg(r,"long")).length,bothN=structures.filter(r=>leg(r,"short")&&leg(r,"long")).length;
 const reason=(n:number):Record<string,number>=>n===structures.length?{}:{market_iv_evidence_unavailable:structures.length-n};
 const metrics:Record<string,number[]>={short_iv:[],long_iv:[],reference_iv:[],short_minus_reference_iv:[],long_minus_reference_iv:[],short_minus_long_iv:[]};
 for(const row of structures){const s=leg(row,"short"),l=leg(row,"long"),ref=row.same_expiry_reference as Row|undefined;if(s)metrics.short_iv!.push(number(s.iv_decimal)!);if(l)metrics.long_iv!.push(number(l.iv_decimal)!);if(ref?.status==="available"&&number(ref.iv_decimal)!==null)metrics.reference_iv!.push(number(ref.iv_decimal)!);for(const key of ["short_minus_reference_iv","long_minus_reference_iv","short_minus_long_iv"]){const v=number(differential(row,key)?.value);if(v!==null)metrics[key]!.push(v)}}
 const valuations=dataset.tables.valuations??[],outcomes=dataset.tables.outcomes??[],endpoints:VolatilityEndpoint[]=[];
 for(const structure of structures){const candidateId=String(structure.candidate_id),entry=Date.parse(String(structure.entry_timestamp_utc)),entryShort=leg(structure,"short"),entryLong=leg(structure,"long"),referenceRows=valuations.filter(v=>String(v.candidate_id)===candidateId&&v.analytics_track==="reference");
  const add=(id:string,label:string,timestamp:string|null)=>{const point=timestamp?referenceRows.find(v=>v.timestamp_utc===timestamp):undefined,s=observedLeg(point?.short_leg_volatility),l=observedLeg(point?.long_leg_volatility),shortIv=number(s?.iv_decimal),longIv=number(l?.iv_decimal),baseS=number(entryShort?.iv_decimal),baseL=number(entryLong?.iv_decimal),ok=Boolean(point&&(s||l));endpoints.push({id,label,candidateId,timestampUtc:timestamp,shortIv,longIv,deltaShortIv:baseS!==null&&shortIv!==null?shortIv-baseS:null,deltaLongIv:baseL!==null&&longIv!==null?longIv-baseL:null,status:ok?"available":"unavailable",reason:ok?null:point?"endpoint_market_iv_not_observed":"canonical_valuation_timestamp_unavailable"})};
  for(const [id,label,hours] of [["4h","+4h",4],["12h","+12h",12],["1d","+1D",24],["3d","+3D",72]] as const)add(id,label,Number.isFinite(entry)?new Date(entry+hours*3_600_000).toISOString():null);
  for(const [type,label] of [["vpoc","VPOC"],["invalidation","Invalidation"],["credit_capture_50","50% capture"],["credit_capture_70","70% capture"]] as const){const outcome=outcomes.find(o=>String(o.candidate_id)===candidateId&&o.analytics_track==="reference"&&o.outcome_type===type);add(type,label,text(outcome?.valuation_timestamp_utc))}
 }
 const endpointAvailable=endpoints.filter(e=>e.status==="available").length;
 return {executionIndependent:true,coverage:projection.coverage,events:projection.events,structures,structureCoverage:{short:availability(shortN,structures.length,reason(shortN)),long:availability(longN,structures.length,reason(longN)),both:availability(bothN,structures.length,reason(bothN))},aggregates:Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,quantiles(v)])),endpoints,endpointCoverage:availability(endpointAvailable,endpoints.length,endpointAvailable===endpoints.length?{}:{endpoint_market_iv_unavailable:endpoints.length-endpointAvailable})};
}
