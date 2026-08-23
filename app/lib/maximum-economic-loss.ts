import { breakEven, payoffExtrema, type ExpiryPayoffInput } from "./expiry-payoff.ts";

/**
 * The single canonical maximum-economic-loss calculation.
 *
 * An inverse option's intrinsic value is (K-S)/S, which diverges as the
 * settlement index approaches zero, so the `btc-settlement` payoff extremum is
 * an artifact of the tail sample rather than a terminal loss -- it evaluates to
 * roughly -1.8e8 BTC on a routine 60k/55k put spread. The `usd-cash-flow`
 * extremum is exact and bounded, so USD is the primary figure and the BTC
 * number is explicitly that USD loss converted at one stated reference index.
 *
 * Both `structure_economics.jsonl` and `margin_scenarios.jsonl` derive their
 * maximum loss from this function, so the two tables cannot disagree.
 *
 * This is an ECONOMIC quantity. It is not Initial Margin, not Maintenance
 * Margin, not the protective long's premium, and not a required account
 * balance; those are account quantities and live in the margin layer.
 */
export const MAXIMUM_ECONOMIC_LOSS_METHOD_VERSION = "inverse-vertical-bounded-usd-v1" as const;
export const MAXIMUM_ECONOMIC_LOSS_METHOD = "exact inverse-option expiry payoff (usd-cash-flow extremum over strike and tail settlement indices, including per-leg delivery fees)" as const;
export const MAXIMUM_ECONOMIC_LOSS_ASSUMPTION = "USD is the primary, bounded figure and is reported as a positive magnitude. The BTC number is that USD loss converted at the stated reference index; it is a representation at one index, not an unconditional terminal BTC loss, because inverse intrinsic value diverges as the settlement index approaches zero." as const;
export const MAXIMUM_ECONOMIC_LOSS_SIGN_CONVENTION = "positive_magnitude" as const;

export interface CanonicalMaximumEconomicLoss {
  status: "available" | "unavailable";
  /** Bounded loss magnitude in USD; always positive when available. */
  usd: number | null;
  /** The same loss expressed in BTC at `referenceIndex`. Never a tail extremum. */
  btcAtReferenceIndex: number | null;
  referenceIndex: number | null;
  breakevenIndex: number | null;
  method: string | null;
  methodVersion: string | null;
  assumption: string | null;
  signConvention: string | null;
  reason: string | null;
}

const unavailable = (reason: string, referenceIndex: number | null = null): CanonicalMaximumEconomicLoss => ({
  status: "unavailable", usd: null, btcAtReferenceIndex: null, referenceIndex,
  breakevenIndex: null, method: null, methodVersion: null, assumption: null, signConvention: null, reason,
});

export function canonicalMaximumEconomicLoss(input: ExpiryPayoffInput): CanonicalMaximumEconomicLoss {
  const referenceIndex = Number.isFinite(input.entryIndex) && input.entryIndex > 0 ? input.entryIndex : null;
  if (referenceIndex === null) return unavailable("A positive reference index is required to express the bounded USD loss in BTC.");
  let usd: number;
  try {
    usd = Math.abs(payoffExtrema(input, "usd-cash-flow").maximumLoss);
  } catch (error) {
    return unavailable(`The canonical strikes and premiums do not form a valid credit spread: ${error instanceof Error ? error.message : String(error)}`, referenceIndex);
  }
  if (!Number.isFinite(usd)) return unavailable("The exact inverse payoff did not produce a finite bounded loss.", referenceIndex);
  let breakevenIndex: number | null = null;
  try { breakevenIndex = breakEven(input, "usd-cash-flow")?.index ?? null; } catch { breakevenIndex = null; }
  return {
    status: "available", usd, btcAtReferenceIndex: usd / referenceIndex, referenceIndex, breakevenIndex,
    method: MAXIMUM_ECONOMIC_LOSS_METHOD, methodVersion: MAXIMUM_ECONOMIC_LOSS_METHOD_VERSION,
    assumption: MAXIMUM_ECONOMIC_LOSS_ASSUMPTION, signConvention: MAXIMUM_ECONOMIC_LOSS_SIGN_CONVENTION, reason: null,
  };
}
