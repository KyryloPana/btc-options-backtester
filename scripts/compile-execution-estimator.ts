#!/usr/bin/env node
import {readFile,readdir,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ExecutionCalibrationIndex,type ExecutionEstimatorArtifact} from "../app/lib/empirical-taker-execution.ts";
import type {ExecutionCalibrationObservation} from "../app/lib/execution-calibration.ts";

async function files(root:string):Promise<string[]>{const out:string[]=[];for(const name of await readdir(root,{withFileTypes:true})){const path=join(root,name.name);if(name.isDirectory())out.push(...await files(path));else if(/\.(ndjson|jsonl)$/.test(name.name))out.push(path)}return out.sort()}
export async function compileExecutionEstimator(root:string):Promise<ExecutionEstimatorArtifact>{const rows:ExecutionCalibrationObservation[]=[];for(const path of await files(root)){for(const line of (await readFile(path,"utf8")).split(/\r?\n/)){if(!line.trim())continue;const value=JSON.parse(line) as ExecutionCalibrationObservation;if(value&&typeof value==="object"&&"method_version" in value)rows.push(value)}}return new ExecutionCalibrationIndex(rows).artifact}
async function main(){const root=process.argv[2],output=process.argv[3];if(!root||!output)throw new Error("Usage: node --experimental-strip-types scripts/compile-execution-estimator.ts <v4-cache-root> <artifact.json>");const artifact=await compileExecutionEstimator(resolve(root));await writeFile(output,JSON.stringify(artifact)+"\n");console.log(JSON.stringify({...artifact,rows:undefined},null,2))}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])await main();
