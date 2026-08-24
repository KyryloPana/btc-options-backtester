import type { ReproducibilitySnapshot } from "./research-selections.ts";

/**
 * ONE canonical identity for a research methodology.
 *
 * The bundle builder has always derived a source-run identity from the
 * generation configuration, but it hashed `JSON.stringify` directly: that is
 * sensitive to object-key order and — worse — included `generatedAtUtc`, so two
 * runs of the identical methodology minutes apart were treated as different
 * source runs. This module keeps that concept and makes it deterministic
 * instead of introducing a second, competing notion of configuration identity.
 *
 * `applicationBuild` is deliberately EXCLUDED. It is build provenance, tracked
 * separately, and folding it in would declare every persisted event
 * methodologically stale on each commit even when nothing about the research
 * method changed.
 */
export const CONFIGURATION_IDENTITY_VERSION = "effective-configuration-v1" as const;

/** Fields that genuinely change research output. Anything absent here is noise. */
export const METHODOLOGY_FIELDS = [
  "pricingEngineVersion", "pricingAssumption", "pricingTracks",
  "qualityRulesVersion", "qualityThresholds",
  "dteWindows", "expirySelectionMode",
  "executionMode", "historicalEvidenceWindows", "synchronizationThresholds",
  "feeScheduleVersion", "feeAssumptions",
  "settlementRules", "valuationInterval", "modelAssumptions",
] as const;
export type MethodologyField = (typeof METHODOLOGY_FIELDS)[number];

/** Excluded on purpose, with the reason recorded so the choice is inspectable. */
export const EXCLUDED_FROM_CONFIGURATION_IDENTITY: Readonly<Record<string, string>> = Object.freeze({
  generatedAtUtc: "Generation timestamp is provenance, not methodology.",
  applicationBuild: "Build provenance is tracked separately; a rebuild does not change the research method.",
});

/**
 * Scalar arrays whose ORDER is itself methodology, addressed by dotted path
 * from the methodology field. These are declared sequences, not sets, so
 * sorting them would let two genuinely different methodologies hash alike.
 *
 * `synchronizationThresholds.immediateFillSearchWindowsMs` records the
 * progressive entry-evidence escalation that `estimateResearchSpread`
 * implements with first-match-wins semantics (`RESEARCH_WINDOWS_MINUTES`):
 * the first window that finds qualifying tape produces the entry price, and
 * only the tightest window can earn a green quality flag. Declaring
 * [120m, 60m, 30m] instead of [30m, 60m, 120m] is the same SET but a
 * different research method and must not share an identity.
 */
export const ORDER_SIGNIFICANT_CONFIGURATION_PATHS: readonly string[] = [
  "synchronizationThresholds.immediateFillSearchWindowsMs",
];

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isScalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);

/**
 * Stable rendering. Object keys are sorted everywhere. Arrays whose members are
 * all scalars are sorted too — in this schema those are set-like
 * (`pricingTracks` is checkbox order; `historicalEvidenceWindows.entryMinutes`
 * declares the set-like causal model/reconstruction evidence horizon, not the
 * progressive immediate execution search sequence) — EXCEPT at a path listed in
 * `ORDER_SIGNIFICANT_CONFIGURATION_PATHS`, where the order is the methodology.
 * Arrays containing objects always keep their order, because there the position
 * may be meaningful.
 *
 * `path` is the dotted address from the methodology field; descending into an
 * array's members does not extend it, so a sequence is addressed by the field
 * that holds it rather than by index.
 */
export function canonicalConfigurationValue(value: unknown, path = ""): unknown {
  if (Array.isArray(value)) {
    const members = value.map(member => canonicalConfigurationValue(member, path));
    const ordered = ORDER_SIGNIFICANT_CONFIGURATION_PATHS.includes(path);
    return members.every(isScalar) && !ordered ? [...members].sort((a, b) => String(a).localeCompare(String(b))) : members;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalConfigurationValue(value[key], path ? `${path}.${key}` : key)]));
  }
  return value;
}

/** The exact methodology-only representation the hash is taken over. */
export function canonicalConfigurationRepresentation(configuration: unknown): Record<string, unknown> {
  const source = isPlainObject(configuration) ? configuration : {};
  return Object.fromEntries(METHODOLOGY_FIELDS.map(field => [field, canonicalConfigurationValue(source[field] ?? null, field)]));
}

/**
 * Deterministic 64-bit FNV-1a over the canonical representation, rendered in
 * base 36. Two independent lanes so the space is wide enough that an accidental
 * collision between the handful of methodologies in a research dataset is not a
 * practical concern; this identifies configurations, it does not authenticate them.
 */
function fnv64(text: string): string {
  let a = 2166136261, b = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a ^= code; a = Math.imul(a, 16777619);
    b ^= code + i; b = Math.imul(b, 2246822519);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36).padStart(7, "0")}`;
}

export function effectiveConfigurationHash(configuration: unknown): string {
  return fnv64(JSON.stringify(canonicalConfigurationRepresentation(configuration)));
}

/** Methodology fields whose canonical values differ, for an actionable error. */
export function configurationDifferences(left: unknown, right: unknown): MethodologyField[] {
  const a = canonicalConfigurationRepresentation(left), b = canonicalConfigurationRepresentation(right);
  return METHODOLOGY_FIELDS.filter(field => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
}

export interface MethodologyIdentity {
  hash: string;
  version: typeof CONFIGURATION_IDENTITY_VERSION;
  fields: readonly MethodologyField[];
  excluded: Readonly<Record<string, string>>;
}
export function methodologyIdentity(configuration: ReproducibilitySnapshot | unknown): MethodologyIdentity {
  return { hash: effectiveConfigurationHash(configuration), version: CONFIGURATION_IDENTITY_VERSION, fields: METHODOLOGY_FIELDS, excluded: EXCLUDED_FROM_CONFIGURATION_IDENTITY };
}

export interface MethodologyStalenessEntry { eventId: string; hash: string; differingFields: MethodologyField[] }
export interface MethodologyStaleness { compatible: boolean; baselineHash: string | null; baselineEventIds: string[]; stale: MethodologyStalenessEntry[] }

/**
 * Which persisted events were generated under a different methodology than the
 * baseline, and exactly which fields differ.
 *
 * A stale event must be REGENERATED. Rewriting its metadata to match would
 * claim results the changed methodology never produced, so schema migration is
 * deliberately not an escape hatch here. The exporter and the UI read this same
 * function so they can never disagree about which events need a rerun.
 */
export function diagnoseMethodologyStaleness(
  events: readonly { eventId: string; configuration: unknown }[],
  currentConfiguration?: unknown,
): MethodologyStaleness {
  if (!events.length) return { compatible: true, baselineHash: currentConfiguration === undefined ? null : effectiveConfigurationHash(currentConfiguration), baselineEventIds: [], stale: [] };
  const hashed = events.map(event => ({ ...event, hash: effectiveConfigurationHash(event.configuration) }));
  // Without an explicit current methodology the majority is the baseline, so a
  // single legacy event reads as stale rather than condemning the whole set.
  const counts = new Map<string, number>();
  for (const event of hashed) counts.set(event.hash, (counts.get(event.hash) ?? 0) + 1);
  const baselineHash = currentConfiguration === undefined
    ? [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    : effectiveConfigurationHash(currentConfiguration);
  const baseline = hashed.find(event => event.hash === baselineHash)?.configuration ?? currentConfiguration;
  const stale = hashed.filter(event => event.hash !== baselineHash)
    .map(event => ({ eventId: event.eventId, hash: event.hash, differingFields: configurationDifferences(baseline, event.configuration) }));
  return { compatible: stale.length === 0, baselineHash, baselineEventIds: hashed.filter(event => event.hash === baselineHash).map(event => event.eventId).sort(), stale };
}

/** The message the exporter refuses with, and the UI shows. One wording, one source. */
export function describeMethodologyStaleness(diagnosis: MethodologyStaleness): string {
  const detail = diagnosis.stale.map(entry => `${entry.eventId} (${entry.hash}) differs in: ${entry.differingFields.join(", ") || "unknown fields"}`).join(" | ");
  return `Incompatible research methodologies cannot be aggregated into one bundle. Baseline ${diagnosis.baselineHash} [${diagnosis.baselineEventIds.join(", ")}]; ${detail}. Regenerate the stale events under the current methodology -- schema migration cannot substitute for regeneration.`;
}
