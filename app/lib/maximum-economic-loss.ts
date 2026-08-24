import { breakEven, creditSpreadKind, expiryPayoff, type ExpiryPayoffInput } from "./expiry-payoff.ts";

/**
 * The single canonical BOUNDED loss calculation for an inverse vertical.
 *
 * Two separate divergences make a naive "maximum loss" wrong here, and they are
 * handled by taking the structural legs only:
 *
 * 1. An inverse option's intrinsic value is (K-S)/S, which diverges as the
 *    settlement index approaches zero, so the `btc-settlement` extremum is a
 *    tail artifact rather than a terminal loss.
 *
 * 2. A settlement DELIVERY FEE is a fixed BTC amount (0.00015 BTC per leg).
 *    Converting that fixed BTC fee to USD at settlement index S gives 0.00015*S,
 *    which grows without bound. For a bear call both legs finish deep ITM as
 *    S -> infinity, so the fee-inclusive USD loss is mathematically UNBOUNDED.
 *    Sampling that tail at Number.MAX_SAFE_INTEGER produced the observed
 *    0.0003 BTC * 9.007e15 = $2.702 trillion artifact on an ordinary $1k-wide
 *    spread, and that artifact then propagated into futures equal-risk sizing.
 *
 * The STRUCTURAL loss is the bounded risk inherent in the vertical itself: net
 * opening cash flow converted at the reference index, plus the gross spread
 * position value converted at each settlement index. It excludes delivery fees
 * precisely because their USD value is unbounded, and it is the quantity that
 * belongs in credit/max-loss ratios, width comparisons and equal-risk sizing.
 *
 * Delivery fees are NOT discarded: they are reported separately, at an
 * explicitly named settlement scenario, and the global fee-inclusive maximum is
 * reported as unbounded where it genuinely is.
 *
 * This is an ECONOMIC quantity. It is not Initial Margin, not Maintenance
 * Margin, not the protective long's premium, and not a required account
 * balance; those are account quantities and live in the margin layer.
 */
export const STRUCTURAL_LOSS_METHOD_VERSION = "inverse-vertical-structural-usd-v2" as const;
export const STRUCTURAL_LOSS_METHOD = "exact inverse-option expiry payoff, structural legs only: net opening cash flow at the reference index plus the gross spread position value converted at each sampled settlement index, sampled at both strikes and at a bounded post-strike plateau where the structural payoff is flat" as const;
export const STRUCTURAL_LOSS_ASSUMPTION = "USD is the primary, bounded figure and is reported as a positive magnitude. Settlement delivery fees are excluded because a fixed BTC fee converts to an unbounded USD amount as the settlement index grows; they are reported separately at a named settlement scenario. The BTC number is this USD loss converted at the stated reference index -- a representation at one index, not an unconditional terminal BTC loss." as const;
export const STRUCTURAL_LOSS_SIGN_CONVENTION = "positive_magnitude" as const;

export type FeeInclusiveMaximumStatus = "bounded" | "unbounded";

export interface SettlementFeeTreatment {
  /** Structural loss never includes delivery fees. */
  includedInStructuralLoss: false;
  /** Whether a GLOBAL fee-inclusive maximum exists as a finite number at all. */
  globalFeeInclusiveMaximum: FeeInclusiveMaximumStatus;
  globalFeeInclusiveMaximumReason: string;
  /** Delivery fees at one named settlement scenario. Scenario-specific, never global. */
  scenarioIndex: number | null;
  scenarioLabel: string | null;
  scenarioDeliveryFeesBtc: number | null;
  scenarioDeliveryFeesUsd: number | null;
}

export interface CanonicalStructuralLoss {
  status: "available" | "unavailable";
  /** Bounded structural loss magnitude in USD; always positive when available. */
  usd: number | null;
  /** The same loss expressed in BTC at `referenceIndex`. Never a tail extremum. */
  btcAtReferenceIndex: number | null;
  referenceIndex: number | null;
  /** Settlement index at which the structural maximum loss is first attained. */
  worstStructuralIndex: number | null;
  breakevenIndex: number | null;
  method: string | null;
  methodVersion: string | null;
  assumption: string | null;
  signConvention: string | null;
  settlementFees: SettlementFeeTreatment;
  reason: string | null;
}

const UNAVAILABLE_FEES: SettlementFeeTreatment = {
  includedInStructuralLoss: false, globalFeeInclusiveMaximum: "unbounded",
  globalFeeInclusiveMaximumReason: "Not evaluated: the structure did not produce a valid inverse vertical payoff.",
  scenarioIndex: null, scenarioLabel: null, scenarioDeliveryFeesBtc: null, scenarioDeliveryFeesUsd: null,
};

const unavailable = (reason: string, referenceIndex: number | null = null): CanonicalStructuralLoss => ({
  status: "unavailable", usd: null, btcAtReferenceIndex: null, referenceIndex, worstStructuralIndex: null,
  breakevenIndex: null, method: null, methodVersion: null, assumption: null, signConvention: null,
  settlementFees: UNAVAILABLE_FEES, reason,
});

/**
 * Settlement indices the structural payoff must be sampled at.
 *
 * The structural payoff is piecewise linear in the settlement index with knees
 * at the two strikes, and it is FLAT beyond the higher strike, so a bounded
 * plateau sample is sufficient and exact. Number.MAX_SAFE_INTEGER is
 * deliberately not used: it is unnecessary for the structural quantity and it
 * is what turned a fixed BTC delivery fee into a trillion-dollar USD artifact.
 */
export function structuralSampleIndices(input: ExpiryPayoffInput): number[] {
  const low = Math.min(input.shortStrike, input.longStrike), high = Math.max(input.shortStrike, input.longStrike);
  return [Math.max(low * 1e-9, Number.MIN_VALUE), low, high, Math.max(high, input.entryIndex) * 4];
}

export function canonicalStructuralLoss(input: ExpiryPayoffInput): CanonicalStructuralLoss {
  const referenceIndex = Number.isFinite(input.entryIndex) && input.entryIndex > 0 ? input.entryIndex : null;
  if (referenceIndex === null) return unavailable("A positive reference index is required to express the bounded USD loss in BTC.");
  let kind: ReturnType<typeof creditSpreadKind>;
  let worstUsd = Infinity;
  const samples: Array<{ index: number; structuralUsd: number; feesBtc: number }> = [];
  try {
    kind = creditSpreadKind(input);
    for (const index of structuralSampleIndices(input)) {
      const point = expiryPayoff(input, index, "usd-cash-flow");
      // Structural only: the gross spread value converted at this settlement
      // index, with delivery fees deliberately left out of the extremum.
      const structuralUsd = point.netEntryCashFlowBtc * input.entryIndex + point.grossPositionValueBtc * index;
      samples.push({ index, structuralUsd, feesBtc: point.settlementFeesBtc });
      if (structuralUsd < worstUsd) worstUsd = structuralUsd;
    }
  } catch (error) {
    return unavailable(`The canonical strikes and premiums do not form a valid credit spread: ${error instanceof Error ? error.message : String(error)}`, referenceIndex);
  }
  if (!Number.isFinite(worstUsd)) return unavailable("The exact inverse payoff did not produce a finite bounded structural loss.", referenceIndex);
  const usd = Math.abs(worstUsd);
  // The structural payoff is FLAT past the far strike, so the plateau sample
  // ties with the knee up to floating point. Report the tie nearest the money --
  // the far strike itself -- which is the tightest and most interpretable
  // scenario: above it for a bear call, below it for a bull put.
  const tolerance = 1e-9 * Math.max(1, usd);
  const tied = samples.filter(sample => sample.structuralUsd <= worstUsd + tolerance)
    .sort((a, b) => kind === "bear-call-credit" ? a.index - b.index : b.index - a.index);
  const worst = tied[0]!;
  const worstIndex = worst.index, worstFeesBtc = worst.feesBtc;
  let breakevenIndex: number | null = null;
  try { breakevenIndex = breakEven(input, "usd-cash-flow")?.index ?? null; } catch { breakevenIndex = null; }
  // A bear call finishes with BOTH legs deep in the money as the settlement
  // index grows, so a fixed BTC delivery fee has unbounded USD value there. A
  // bull put's legs are both out of the money above the short strike, so its
  // delivery fee in USD is bounded.
  const unboundedFees = kind === "bear-call-credit";
  return {
    status: "available", usd, btcAtReferenceIndex: usd / referenceIndex, referenceIndex,
    worstStructuralIndex: worstIndex, breakevenIndex,
    method: STRUCTURAL_LOSS_METHOD, methodVersion: STRUCTURAL_LOSS_METHOD_VERSION,
    assumption: STRUCTURAL_LOSS_ASSUMPTION, signConvention: STRUCTURAL_LOSS_SIGN_CONVENTION,
    settlementFees: {
      includedInStructuralLoss: false,
      globalFeeInclusiveMaximum: unboundedFees ? "unbounded" : "bounded",
      globalFeeInclusiveMaximumReason: unboundedFees
        ? "Both legs of a bear call finish deep in the money as the settlement index grows, leaving a fixed BTC delivery fee whose USD value increases without bound. No finite global fee-inclusive maximum exists; sampling a large settlement index would report the sample, not a maximum."
        : "Both legs of a bull put are out of the money above the short strike, so the delivery fee in USD is bounded across every settlement index.",
      scenarioIndex: worstIndex, scenarioLabel: "settlement at the index producing the structural maximum loss",
      scenarioDeliveryFeesBtc: worstFeesBtc, scenarioDeliveryFeesUsd: worstFeesBtc * worstIndex,
    },
    reason: null,
  };
}
