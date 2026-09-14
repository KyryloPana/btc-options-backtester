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
  structuralConfigurationId: string | null; attemptCandidateIds: string; researchRole: string | null;
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
    const structures = [...event.selectedStructures, ...(event.researchStructures ?? []).filter(row => row.researchRole === "comparative_economics")];
    for (const structure of structures) {
      const candidate = byId.get(structure.candidateId);
      rows.push({
        eventId: event.eventId, candidateId: structure.candidateId, venue: structure.venue,
        structuralConfigurationId: "structuralConfigurationId" in structure && typeof structure.structuralConfigurationId === "string" ? structure.structuralConfigurationId : null,
        attemptCandidateIds: "attemptCandidateIds" in structure && Array.isArray(structure.attemptCandidateIds) ? [...new Set(structure.attemptCandidateIds.filter((id):id is string=>typeof id==="string"))].sort().join("\u0000") : "",
        researchRole: "researchRole" in structure && typeof structure.researchRole === "string" ? structure.researchRole : null,
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
  return rows.sort((a, b) => `${a.eventId}|${a.candidateId}|${a.researchRole}`.localeCompare(`${b.eventId}|${b.candidateId}|${b.researchRole}`));
}

/** Every structural difference between two stores, or an empty list. */
export function structuralDifferences(
  before: StructuralIdentity[], after: StructuralIdentity[],
): string[] {
  const problems: string[] = [];
  if (before.length !== after.length)
    problems.push(`recompute structure count changed: ${before.length} -> ${after.length}`);
  const key = (r: StructuralIdentity) => `${r.eventId}|${r.candidateId}|${r.researchRole ?? "selected"}`;
  const afterById = new Map(after.map(r => [key(r), r]));
  for (const row of before) {
    const match = afterById.get(key(row));
    if (!match) { problems.push(`candidate ${row.candidateId} disappeared`); continue; }
    for (const key of Object.keys(row) as (keyof StructuralIdentity)[])
      if (row[key] !== match[key])
        problems.push(`${row.candidateId}.${key}: ${String(row[key])} -> ${String(match[key])}`);
  }
  for (const row of after)
    if (!before.some(b => key(b) === key(row)))
      problems.push(`candidate ${row.candidateId} appeared`);
  return problems;
}
