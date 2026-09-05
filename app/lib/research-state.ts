import { sameSelectionIds, type GenerationSnapshot } from "./research-selections.ts";
import type { HistoryRequest } from "./short-strike/materialize.ts";

export interface CompletedGeneration {
  eventId: string;
  snapshot: GenerationSnapshot;
}

/** Identity of the exact event and production request universe certified by a load. */
export function contractGenerationKey(eventId:string,entryTimestamp:number,requests:HistoryRequest[],configuration?:unknown):string{
  return JSON.stringify({eventId,entryTimestamp,requests:requests.map(request=>({...request})).sort((a,b)=>a.requestId.localeCompare(b.requestId)),configuration});
}

/**
 * Selection changes and regenerated event evidence are deliberately independent.
 * A generation is saveable only when it came from a completed, event-local run;
 * changing configuration metadata on the persisted snapshot is not a run.
 */
export function researchStateDirtiness(input: {
  eventId: string;
  savedSelectionIds: Iterable<string>;
  draftSelectionIds: Iterable<string>;
  savedGeneration?: GenerationSnapshot;
  completedGeneration?: CompletedGeneration;
}) {
  const selectionDirty = !sameSelectionIds(input.savedSelectionIds, input.draftSelectionIds);
  const completed = input.completedGeneration;
  const genuineCurrentGeneration = Boolean(
    completed && completed.eventId === input.eventId &&
    (!input.savedGeneration || completed.snapshot.generatedAtUtc !== input.savedGeneration.generatedAtUtc),
  );
  const generationDirty = genuineCurrentGeneration;
  return { selectionDirty, generationDirty, researchStateDirty: selectionDirty || generationDirty, genuineCurrentGeneration };
}
