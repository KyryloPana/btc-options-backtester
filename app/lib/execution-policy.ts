/** Canonical timing vocabulary. A search horizon is never a synchronization tolerance. */
export const EXECUTION_TIMING_POLICY_VERSION = "execution-timing-v2" as const;
export const IMMEDIATE_FILL_SEARCH_WINDOWS_MS = [30, 60, 120].map(minutes => minutes * 60_000) as readonly number[];
export const IMMEDIATE_MAXIMUM_LEG_SYNCHRONIZATION_MS = 60 * 60_000;
export const DELAYED_MAXIMUM_LEG_SYNCHRONIZATION_MS = 60 * 60_000;
export const GREEN_SYNCHRONIZATION_MS = 30 * 60_000;
export const YELLOW_SYNCHRONIZATION_MS = 60 * 60_000;

export type SynchronizationQuality = "green" | "yellow" | "red";
export function synchronizationQuality(gapMs:number):SynchronizationQuality {
  if (gapMs <= GREEN_SYNCHRONIZATION_MS) return "green";
  if (gapMs <= YELLOW_SYNCHRONIZATION_MS) return "yellow";
  return "red";
}

export const EXECUTION_TIMING_METADATA = {
  policyVersion: EXECUTION_TIMING_POLICY_VERSION,
  immediateFillSearchWindowsMs: IMMEDIATE_FILL_SEARCH_WINDOWS_MS,
  immediateMaximumLegSynchronizationMs: IMMEDIATE_MAXIMUM_LEG_SYNCHRONIZATION_MS,
  delayedMaximumLegSynchronizationMs: DELAYED_MAXIMUM_LEG_SYNCHRONIZATION_MS,
  greenSynchronizationMs: GREEN_SYNCHRONIZATION_MS,
  yellowSynchronizationMs: YELLOW_SYNCHRONIZATION_MS,
  redRule: "gap exceeds hard maximum or either leg lacks qualifying evidence",
} as const;
