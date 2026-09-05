export type ControlledAttempt<TProduction,TControlled>={production:TProduction;controlled:TControlled;authoritative:true}|{production:TProduction;controlled?:undefined;authoritative:false;error:string};

/** A controlled branch may fail, but the already-established production value is immutable. */
export async function attemptControlled<TProduction,TControlled>(production:TProduction,operation:()=>Promise<TControlled>|TControlled):Promise<ControlledAttempt<TProduction,TControlled>>{
 try{return{production,controlled:await operation(),authoritative:true}}catch(error){return{production,authoritative:false,error:error instanceof Error?error.message:"Controlled research failed."}}
}

/** Route/materializer failure preserves the last authoritative controlled cohort verbatim. */
export function controlledPersistence<T>(saved:readonly T[],current:readonly T[],authoritative:boolean):T[]{
 return [...structuredClone(authoritative?current:saved)];
}
