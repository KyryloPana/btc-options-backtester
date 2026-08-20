import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { emptyResearchSelectionStore, migrateResearchSelectionStore, validateResearchSelectionStore, type ResearchSelectionEvent, type ResearchSelectionStore } from "../app/lib/research-selections.ts";

const PREFIX="/__local/research-selections",CAPABILITIES="/__local/persistence-capabilities",SAFE_ID=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// A store that does not exist yet still needs a stable version for the GET ->
// If-Match PUT handshake. Using the current time here made every first save
// stale because read() produced a different version for each request.
const EMPTY_STORE_VERSION="1970-01-01T00:00:00.000Z";
export const RESEARCH_SELECTION_REQUEST_LIMIT_BYTES=10_000_000;
export class ResearchSelectionService{
  readonly directory:string;
  constructor(directory:string){this.directory=directory;}
  private path(id:string){if(!SAFE_ID.test(id)||basename(id)!==id)throw Object.assign(new Error("Invalid dataset ID; paths are not accepted."),{status:400});return resolve(this.directory,`${id}.json`);}
  async read(id:string){try{const raw=await readFile(this.path(id),"utf8");let parsed:unknown;try{parsed=JSON.parse(raw)}catch{throw Object.assign(new Error("Persisted research selection JSON is malformed; repair or remove the file before saving."),{status:422})}let migrated:ResearchSelectionStore;try{migrated=migrateResearchSelectionStore(parsed)}catch(error){throw Object.assign(new Error("Persisted research selection file failed schema validation; it was not modified."),{status:422,details:error instanceof Error?error.message:error})}if(migrated.datasetId!==id)throw Object.assign(new Error("Selection dataset identity does not match its filename."),{status:422});return migrated;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return emptyResearchSelectionStore(id,EMPTY_STORE_VERSION);throw error;}}
  async save(id:string,value:unknown){const checked=validateResearchSelectionStore(value);if(!checked.ok)throw Object.assign(new Error("Research selection validation failed."),{status:400,details:checked.errors});if(checked.store.datasetId!==id)throw Object.assign(new Error("Selection dataset identity cannot be changed while saving."),{status:400});try{await this.read(id)}catch(error){throw error}const saved={...checked.store,updatedAtUtc:new Date().toISOString()};await this.atomicWrite(saved);return saved;}
  async upsertEvent(id:string,eventId:string,event:unknown,expectedUpdatedAt?:string|null){if(!event||typeof event!=="object")throw Object.assign(new Error("Research selection event must be a JSON object."),{status:400});if((event as ResearchSelectionEvent).eventId!==eventId)throw Object.assign(new Error("Request event ID must match the event payload."),{status:400});const current=await this.read(id);if(expectedUpdatedAt&&current.updatedAtUtc!==expectedUpdatedAt)throw Object.assign(new Error("Research selections changed on disk; reload before saving this event."),{status:409});const draft:ResearchSelectionStore={...current,events:[...current.events.filter(e=>e.eventId!==eventId),event as ResearchSelectionEvent].sort((a,b)=>a.eventId.localeCompare(b.eventId)),updatedAtUtc:new Date().toISOString()};const checked=validateResearchSelectionStore(draft);if(!checked.ok)throw Object.assign(new Error("Research selection event validation failed."),{status:400,details:checked.errors});await this.atomicWrite(checked.store);return checked.store;}
  /**
   * Removes an event and everything the store owns for it. Every canonical
   * bundle table is derived from `events` at export time, so dropping the
   * event here is the cascade -- no other rows need sweeping, and a later
   * export/validate/import round trip stays internally consistent.
   *
   * Deleting an event that is already absent is a no-op success rather than a
   * 404: the caller's intent (the event should not exist) is already true, and
   * failing would leave the UI unable to clean up after a partial delete.
   */
  async deleteEvent(id:string,eventId:string,expectedUpdatedAt?:string|null){
   const current=await this.read(id);
   const events=current.events.filter(event=>event.eventId!==eventId);
   // Nothing to remove: the caller's intent already holds, so this succeeds
   // without an optimistic-concurrency check. That check is deliberately AFTER
   // this branch -- a dataset with no selections file on disk gets a freshly
   // synthesized store from read(), whose updatedAtUtc can never match a
   // caller's If-Match, and guarding first would make every such delete 409.
   if(events.length===current.events.length)return current;
   if(expectedUpdatedAt&&current.updatedAtUtc!==expectedUpdatedAt)throw Object.assign(new Error("Research selections changed on disk; reload before deleting this event."),{status:409});
   const draft:ResearchSelectionStore={...current,events,updatedAtUtc:new Date().toISOString()};
   const checked=validateResearchSelectionStore(draft);
   if(!checked.ok)throw Object.assign(new Error("Research selection store validation failed after deletion."),{status:400,details:checked.errors});
   await this.atomicWrite(checked.store);
   return checked.store;
  }
  async atomicWrite(store:ResearchSelectionStore){await mkdir(this.directory,{recursive:true});const target=this.path(store.datasetId),temp=resolve(this.directory,`.${store.datasetId}.${process.pid}.${Date.now()}.tmp`);try{await writeFile(temp,JSON.stringify(store,null,2)+"\n",{encoding:"utf8",flag:"wx"});await rename(temp,target)}catch(error){await unlink(temp).catch(()=>undefined);throw error}}
}
async function body(req:IncomingMessage){const chunks:Buffer[]=[];let total=0;for await(const chunk of req){const b=Buffer.from(chunk);total+=b.length;if(total>RESEARCH_SELECTION_REQUEST_LIMIT_BYTES)throw Object.assign(new Error(`Selection snapshot ${(total/1_000_000).toFixed(1)} MB exceeds ${(RESEARCH_SELECTION_REQUEST_LIMIT_BYTES/1_000_000).toFixed(0)} MB limit.`),{status:413,details:{receivedBytes:total,limitBytes:RESEARCH_SELECTION_REQUEST_LIMIT_BYTES}});chunks.push(b)}try{return JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}") }catch{throw Object.assign(new Error("Request body is malformed JSON."),{status:400})}}
function json(res:ServerResponse,status:number,payload:unknown){res.statusCode=status;res.setHeader("Content-Type","application/json");res.end(JSON.stringify(payload));}
export function researchSelectionApiPlugin(directory=resolve(process.cwd(),"data/research-selections")):Plugin{const service=new ResearchSelectionService(directory);return{name:"local-research-selections",configureServer(server){server.middlewares.use(async(req,res,next)=>{const url=new URL(req.url??"/","http://local");if(url.pathname===CAPABILITIES&&req.method==="GET")return json(res,200,{runtime:"local-application-server",researchSelections:true,version:1});if(!url.pathname.startsWith(PREFIX))return next();try{const rest=url.pathname.slice(PREFIX.length+1).split("/").map(decodeURIComponent);const [id,kind,eventId]=rest;if(!id||!SAFE_ID.test(id))return json(res,404,{error:"Research selection endpoint not found."});if(rest.length===1&&req.method==="GET")return json(res,200,await service.read(id));if(rest.length===1&&req.method==="PUT")return json(res,200,await service.save(id,await body(req)));if(rest.length===3&&kind==="events"&&eventId){if(req.method==="PUT")return json(res,200,{store:await service.upsertEvent(id,eventId,await body(req),req.headers["if-match"]?.toString())});if(req.method==="DELETE")return json(res,200,{store:await service.deleteEvent(id,eventId,req.headers["if-match"]?.toString())});return json(res,405,{error:"Method not allowed."});}return json(res,404,{error:"Research selection endpoint not found."});}catch(error){const e=error as Error&{status?:number;details?:unknown};return json(res,e.status??400,{error:e.message,details:e.details})}})}}}
