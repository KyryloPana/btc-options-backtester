/**
 * ONE canonical identity mapping between the labels the valuation engines
 * persist and the canonical research-policy IDs the bundle exports.
 *
 * This replaces ad-hoc string normalization. The previous exporter lowercased
 * and underscored labels, so `"3D"` became `"3d"` and never matched the
 * canonical `fixed_3d`: valid persisted fixed-time outcomes were silently
 * replaced by generic unavailable rows. Semantic identity needs a table, not a
 * regex.
 *
 * An unrecognised label resolves to `null` and is reported as unmapped. It is
 * never coerced into a neighbouring policy, because quietly filing a `"14D"`
 * snapshot under `fixed_7d` would be worse than losing it.
 */
export const RESEARCH_OUTCOME_IDENTITY_VERSION = "research-outcome-identity-v1" as const;

export const CANONICAL_OUTCOMES = [
  "vpoc", "invalidation",
  "credit_capture_25", "credit_capture_50", "credit_capture_70",
  "fixed_3d", "fixed_5d", "fixed_7d", "fixed_14d",
  "settlement",
] as const;
export type CanonicalOutcome = (typeof CANONICAL_OUTCOMES)[number];

/**
 * `fixed_14d` is a RECOGNISED policy that the exit-policy layer produces but
 * the canonical bundle contract does not carry. It is mapped rather than left
 * unknown -- a persisted "14D" snapshot is not a mystery label -- but it is
 * deliberately outside the exported set, so the exporter is not accused of
 * dropping it and no new exit rule is introduced here.
 */
export const OUTCOMES_OUTSIDE_EXPORT_CONTRACT: readonly CanonicalOutcome[] = ["fixed_14d"];

/** Every source label this repository's engines are known to persist. */
const LABELS: Readonly<Record<string, CanonicalOutcome>> = Object.freeze({
  "vpoc": "vpoc",
  "vpoc hit": "vpoc",
  "invalidation": "invalidation",
  "25 credit": "credit_capture_25",
  "50 credit": "credit_capture_50",
  "70 credit": "credit_capture_70",
  "25 credit capture": "credit_capture_25",
  "50 credit capture": "credit_capture_50",
  "70 credit capture": "credit_capture_70",
  "3d": "fixed_3d",
  "5d": "fixed_5d",
  "7d": "fixed_7d",
  "3d fixed": "fixed_3d",
  "5d fixed": "fixed_5d",
  "7d fixed": "fixed_7d",
  "14d": "fixed_14d",
  "14d fixed": "fixed_14d",
  "settlement": "settlement",
});

const CANONICAL = new Set<string>(CANONICAL_OUTCOMES);

/**
 * Reduces a label to a lookup key WITHOUT deciding policy: case, punctuation
 * and spacing only. All semantic identity comes from the table above.
 */
export function outcomeLookupKey(label: string): string {
  return label.trim().toLowerCase().replace(/[%_]/g, " ").replace(/\s+/g, " ").trim();
}

/** The canonical policy ID for a persisted label, or null when unmapped. */
export function canonicalOutcomeId(label: unknown): CanonicalOutcome | null {
  if (typeof label !== "string" || !label.trim()) return null;
  const key = outcomeLookupKey(label);
  // A label that is already a canonical ID passes through unchanged.
  const direct = key.replace(/ /g, "_");
  if (CANONICAL.has(direct)) return direct as CanonicalOutcome;
  return LABELS[key] ?? null;
}

export interface ResolvedOutcomeLabel { label: string; outcome: CanonicalOutcome | null }
/**
 * Resolves a whole snapshot set, keeping unmapped labels visible so an export
 * can report them rather than dropping them without trace.
 */
export function resolveOutcomeLabels(labels: readonly unknown[]): ResolvedOutcomeLabel[] {
  return labels.map(label => ({ label: typeof label === "string" ? label : String(label ?? ""), outcome: canonicalOutcomeId(label) }));
}

/**
 * Holding time for one outcome, measured from THAT TRACK's own actual entry --
 * never from the original signal, so a delayed track reports the interval it
 * genuinely held for.
 *
 * The effective close is the valuation timestamp where the outcome is actually
 * valued, falling back to the causal decision timestamp; the trigger timestamp
 * is deliberately not used when valuation becomes actionable later. Returns
 * null rather than a nonsensical number: an unreached outcome has no holding
 * time, and neither does one that would resolve before entry or after expiry.
 */
export function outcomeHoldingHours(input: {
  reached: boolean; entryTimestampMs: number | null;
  valuationTimestampMs: number | null; decisionTimestampMs: number | null;
  expiryTimestampMs: number | null;
}): number | null {
  if (!input.reached) return null;
  const entry = input.entryTimestampMs, close = input.valuationTimestampMs ?? input.decisionTimestampMs;
  if (entry === null || close === null || !Number.isFinite(entry) || !Number.isFinite(close)) return null;
  if (close < entry) return null;
  if (input.expiryTimestampMs !== null && close > input.expiryTimestampMs) return null;
  return (close - entry) / 3_600_000;
}
