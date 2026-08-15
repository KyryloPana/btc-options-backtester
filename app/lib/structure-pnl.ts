export interface StructureAvailability { id: string; status: "priced" | "unavailable"; estimateQuality?: "green"|"yellow"|"red"; reason?: string }

export function pricedStructures<T extends StructureAvailability>(rows:T[]){ return rows.filter((row):row is T & {status:"priced"}=>row.status==="priced"); }
export function structureCoverage(rows:StructureAvailability[]){
  const priced=pricedStructures(rows).length,total=rows.length,reasons:Record<string,number>={};
  for(const row of rows)if(row.status==="unavailable")reasons[row.reason??"Unspecified unavailable reason"]=(reasons[row.reason??"Unspecified unavailable reason"]??0)+1;
  return {priced,total,unavailable:total-priced,reasons};
}
export function reconcileStructureSelection(rows:StructureAvailability[],selectedId?:string,expandedIds:string[]=[]){
  const available=new Set(pricedStructures(rows).map(row=>row.id));
  return {selectedId:selectedId&&available.has(selectedId)?selectedId:undefined,expandedIds:expandedIds.filter(id=>available.has(id))};
}
