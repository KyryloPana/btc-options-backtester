import {readFile} from "node:fs/promises";
import {ExecutionCalibrationIndex,validateExecutionEstimatorArtifact} from "../app/lib/empirical-taker-execution.ts";

/** Load, validate and index once. A rejected promise means recomputation must not start. */
export async function loadExecutionCalibration(path:string):Promise<ExecutionCalibrationIndex>{
 let parsed:unknown;
 try{parsed=JSON.parse(await readFile(path,"utf8"))}catch(error){throw new Error(`Unable to read execution estimator artifact ${path}: ${(error as Error).message}`)}
 return new ExecutionCalibrationIndex(validateExecutionEstimatorArtifact(parsed));
}
