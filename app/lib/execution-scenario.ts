import type {ExecutionScenarioEvaluationStatus} from "./research-selections.ts";

/** Canonical execution-scenario states emitted by research bundle schema 2.3.0. */
export const EXECUTION_SCENARIO_STATUSES=["evaluated","unavailable","not_evaluated"] as const satisfies readonly ExecutionScenarioEvaluationStatus[];
export type ExecutionScenarioStatus=ExecutionScenarioEvaluationStatus;

/** Parse an external value without collapsing a valid canonical state into unknown. */
export function normalizeExecutionScenarioStatus(value:unknown):ExecutionScenarioStatus|null {
 return typeof value==="string"&&(EXECUTION_SCENARIO_STATUSES as readonly string[]).includes(value)
  ?value as ExecutionScenarioStatus:null;
}

export function executionScenarioStatusLabel(status:ExecutionScenarioStatus|null):string {
 return status==="evaluated"?"Evaluated":status==="unavailable"?"Unavailable":status==="not_evaluated"?"Not evaluated":"Unknown";
}
