export const STRUCTURAL_CONFIGURATION_ID_VERSION="structural-configuration-v1" as const;
type Row=Readonly<Record<string,unknown>>;
const number=(x:unknown)=>typeof x==="number"&&Number.isFinite(x)?x:null;
const string=(x:unknown)=>typeof x==="string"&&x?x:null;
const object=(x:unknown):Row=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};
const hash=(value:unknown)=>{let h=2166136261;for(const c of JSON.stringify(value)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return(h>>>0).toString(36)};

/** Ex-ante structural knobs only. Realized expiry, DTE, strikes, width, and outcomes are forbidden. */
export function structuralConfigurationIdentity(row:Row):{id:string|null;fields:Readonly<Record<string,unknown>>;reason:string|null}{
 const requested=object(row.requested_strikes),fields={targetDteFamilyDays:number(row.target_horizon_days)??number(row.target_dte),strikeMethod:string(row.strike_method),requestedWidth:number(row.requested_width)??number(requested.width),structureType:string(row.structure_type),quantity:number(row.quantity)};
 const missing=Object.entries(fields).filter(([,v])=>v===null).map(([k])=>k);
 if(missing.length)return{id:null,fields,reason:`Structural configuration identity is unavailable; missing ex-ante field(s): ${missing.join(", ")}.`};
 return{id:`${STRUCTURAL_CONFIGURATION_ID_VERSION}:${hash(fields)}`,fields,reason:null};
}
