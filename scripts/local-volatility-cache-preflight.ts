import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {REFERENCE_SERIES_ID,REFERENCE_SERIES_METHOD_VERSION} from "../app/lib/volatility/reference-series.ts";
import {LOCAL_PRECOMPUTE_MANIFEST,type LocalPrecomputeManifest} from "./precompute-local-volatility.ts";
import {LOCAL_AUX_DIRECTORY,LOCAL_INSTRUMENT_MANIFEST,type LocalVolatilityRetrieval} from "./local-volatility-retrieval.ts";

const sha256=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
const stale=(detail:string)=>new Error(`Stale or incompatible precomputed volatility reference cache: ${detail}. Run npm run volatility:precompute-local.`);

/** Verify that read-only reference rows came from the exact prepared local sources. */
export async function preflightLocalVolatilityCache(retrieval:LocalVolatilityRetrieval,cacheRoot:string,targets:readonly number[]){
 const path=join(cacheRoot,REFERENCE_SERIES_ID,LOCAL_PRECOMPUTE_MANIFEST);let manifest:LocalPrecomputeManifest;try{manifest=JSON.parse(await readFile(path,"utf8")) as LocalPrecomputeManifest}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")throw stale(`missing ${path}`);throw stale(`cannot read ${path}`)}
 const archive=await retrieval.archiveManifest();await retrieval.sourceManifest();const instrumentFingerprint=sha256(await readFile(join(retrieval.root,LOCAL_AUX_DIRECTORY,LOCAL_INSTRUMENT_MANIFEST)));
 if(manifest.referenceSeriesId!==REFERENCE_SERIES_ID)throw stale(`series id is ${manifest.referenceSeriesId}, expected ${REFERENCE_SERIES_ID}`);
 if(manifest.referenceSeriesMethodVersion!==REFERENCE_SERIES_METHOD_VERSION)throw stale(`method version is ${manifest.referenceSeriesMethodVersion}, expected ${REFERENCE_SERIES_METHOD_VERSION}`);
 if(manifest.archiveFingerprint!==archive.data_content_fingerprint)throw stale("archive fingerprint mismatch");
 if(manifest.instrumentManifestFingerprint!==instrumentFingerprint)throw stale("instrument-manifest fingerprint mismatch");
 if(manifest.coverageStart!==archive.coverage_start||manifest.coverageEnd!==archive.coverage_end)throw stale("prepared archive coverage mismatch");
 const start=Date.parse(manifest.targetCoverageStart),end=Date.parse(manifest.targetCoverageEnd);if(!Number.isFinite(start)||!Number.isFinite(end))throw stale("invalid target coverage");
 for(const target of targets)if(target<start||target>end)throw stale(`target ${new Date(target).toISOString()} is outside [${manifest.targetCoverageStart}, ${manifest.targetCoverageEnd}]`);
 return manifest;
}
