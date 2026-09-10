export const STRUCTURAL_CONFIGURATION_ID_VERSION="structural-configuration-v2" as const;
type Row=Readonly<Record<string,unknown>>;
const number=(x:unknown)=>typeof x==="number"&&Number.isFinite(x)?x:null;
const string=(x:unknown)=>typeof x==="string"&&x?x:null;
const object=(x:unknown):Row=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};
const hash=(value:unknown)=>{let h=2166136261;for(const c of JSON.stringify(value)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return(h>>>0).toString(36)};
export type StructuralConfigurationFields={targetDteFamilyDays:number|null;strikeMethod:string|null;requestedWidth:number|null;structureFamily:string|null};
export const directionNeutralStructureFamily=(value:unknown)=>{const x=string(value)?.toLowerCase()??null;if(x===null)return null;if(["bull_put_credit","bear_call_credit","put_credit_spread","call_credit_spread","credit_vertical","vertical","credit"].includes(x))return "credit_vertical";return x};
/** Ex-ante strategy rule only. Direction, quantity and all realized geometry/outcomes are forbidden. */
export function structuralConfigurationIdentity(row:Row):{id:string|null;fields:StructuralConfigurationFields;reason:string|null}{
 const persisted=object(row.structural_configuration),requested=object(row.requested_strikes),fields:StructuralConfigurationFields={targetDteFamilyDays:number(persisted.targetDteFamilyDays)??number(row.target_horizon_days)??number(row.target_dte),strikeMethod:string(persisted.strikeMethod)??string(row.strike_method),requestedWidth:number(persisted.requestedWidth)??number(row.requested_width)??number(requested.width),structureFamily:directionNeutralStructureFamily(persisted.structureFamily??persisted.structureType??row.structure_family??row.structure_type)};
 const missing=Object.entries(fields).filter(([,v])=>v===null).map(([k])=>k);
 if(missing.length)return{id:null,fields,reason:`Structural configuration identity is unavailable; missing ex-ante field(s): ${missing.join(", ")}.`};
 return{id:`${STRUCTURAL_CONFIGURATION_ID_VERSION}:${hash(fields)}`,fields,reason:null};
}
export function structuralConfigurationLabel(fields:Readonly<Record<string,unknown>>|null){if(!fields)return "Configuration unavailable";const d=number(fields.targetDteFamilyDays),method=string(fields.strikeMethod),width=number(fields.requestedWidth),family=string(fields.structureFamily);return [d===null?"DTE unavailable":`${d}D`,method??"strike rule unavailable",width===null?"width unavailable":`$${width.toLocaleString("en-US")} width`,family?.replaceAll("_"," ")??"family unavailable"].join(" · ")}
