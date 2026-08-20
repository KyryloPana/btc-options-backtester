export type PolicyId="thesis"|"capture_50"|"capture_70"|"time_cap_3d"|"time_cap_5d"|"time_cap_7d"|"settlement_benchmark";
export type ExitTrigger="credit_capture_50"|"credit_capture_70"|"vpoc"|"invalidation"|"fixed_3d"|"fixed_5d"|"fixed_7d"|"settlement";
export interface ExitPolicy {readonly id:PolicyId;readonly label:string;readonly diagnostic:boolean;readonly priority:readonly ExitTrigger[]}
export const EXIT_POLICIES:readonly ExitPolicy[]=[
 {id:"thesis",label:"Thesis exit",diagnostic:false,priority:["vpoc","invalidation","settlement"]},
 {id:"capture_50",label:"50% capture overlay",diagnostic:false,priority:["credit_capture_50","vpoc","invalidation","settlement"]},
 {id:"capture_70",label:"70% capture overlay",diagnostic:false,priority:["credit_capture_70","vpoc","invalidation","settlement"]},
 {id:"time_cap_3d",label:"Time-cap 3D",diagnostic:false,priority:["vpoc","invalidation","fixed_3d","settlement"]},
 {id:"time_cap_5d",label:"Time-cap 5D",diagnostic:false,priority:["vpoc","invalidation","fixed_5d","settlement"]},
 {id:"time_cap_7d",label:"Time-cap 7D",diagnostic:false,priority:["vpoc","invalidation","fixed_7d","settlement"]},
 {id:"settlement_benchmark",label:"Settlement benchmark (diagnostic)",diagnostic:true,priority:["invalidation","settlement"]},
] as const;
export const policyById=(id:PolicyId)=>EXIT_POLICIES.find(p=>p.id===id)!;
