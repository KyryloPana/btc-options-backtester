import type { ImportResult } from "./research-analysis";

export type ImportStage="reading-archive"|"parsing-source-data"|"normalizing-records"|"validating-research-bundle"|"preparing-analytics";
export type WorkerImportRequest={id:number;bytes:Uint8Array;filename:string;companionText?:string};
export type WorkerImportMessage={type:"stage";id:number;stage:ImportStage}|{type:"result";id:number;result:ImportResult};

export function createResearchImportWorker():Worker{
 return new Worker(new URL("../workers/research-import.worker.ts",import.meta.url),{type:"module"});
}
