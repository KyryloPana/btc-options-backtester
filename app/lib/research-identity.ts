/**
 * Structural identity of a research selection.
 *
 * A recompute may replace derived research freely, but it must not move a
 * single field in here. Extracting the identity and diffing it before anything
 * is written is what makes "the recompute cannot reselect" a checked claim
 * rather than a design intention -- a migration that quietly substituted a
 * candidate would otherwise be indistinguishable from a successful one.
 */

import type {ResearchSelectionStore} from "./research-selections.ts";

/** The fields a recompute may never change. */
export interface StructuralIdentity {
  eventId: string; candidateId: string; venue: string;
  optionType: string; structure: string; strikeMethod: string;
  requestedShort: number | null; requestedLong: number | null; requestedWidth: number | null;
  actualShort: number | null; actualLong: number | null; actualWidth: number | null;
  expiryTimestamp: number | null; targetHorizon: number | null; quantity: number | null;
}

const numberOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function structuralIdentityOf(store: ResearchSelectionStore): StructuralIdentity[] {
  const rows: StructuralIdentity[] = [];
  for (const event of store.events) {
    const byId = new Map(event.generationSnapshot.candidates.map(c => [c.candidateId, c]));
    for (const structure of event.selectedStructures) {
      const candidate = byId.get(structure.candidateId);
      rows.push({
        eventId: event.eventId, candidateId: structure.candidateId, venue: structure.venue,
        optionType: String(candidate?.optionType ?? ""), structure: String(candidate?.structure ?? ""),
        strikeMethod: String(candidate?.strikeMethod ?? ""),
        requestedShort: numberOrNull(candidate?.requestedStrikes?.short),
        requestedLong: numberOrNull(candidate?.requestedStrikes?.long),
        requestedWidth: numberOrNull(candidate?.requestedStrikes?.width),
        actualShort: numberOrNull(candidate?.actualStrikes?.short),
        actualLong: numberOrNull(candidate?.actualStrikes?.long),
        actualWidth: numberOrNull(candidate?.actualStrikes?.width),
        expiryTimestamp: numberOrNull(candidate?.actualExpiryTimestamp),
        targetHorizon: numberOrNull(candidate?.targetHorizon),
        quantity: numberOrNull(structure.quantity),
      });
    }
  }
  return rows.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}

/** Every structural difference between two stores, or an empty list. */
export function structuralDifferences(
  before: StructuralIdentity[], after: StructuralIdentity[],
): string[] {
  const problems: string[] = [];
  if (before.length !== after.length)
    problems.push(`selected structure count changed: ${before.length} -> ${after.length}`);
  const afterById = new Map(after.map(r => [r.candidateId, r]));
  for (const row of before) {
    const match = afterById.get(row.candidateId);
    if (!match) { problems.push(`candidate ${row.candidateId} disappeared`); continue; }
    for (const key of Object.keys(row) as (keyof StructuralIdentity)[])
      if (row[key] !== match[key])
        problems.push(`${row.candidateId}.${key}: ${String(row[key])} -> ${String(match[key])}`);
  }
  for (const row of after)
    if (!before.some(b => b.candidateId === row.candidateId))
      problems.push(`candidate ${row.candidateId} appeared`);
  return problems;
}
