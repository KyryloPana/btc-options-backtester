import {payoffExtrema, type ExpiryPayoffInput} from "./expiry-payoff.ts";
import {canonicalStructuralLoss} from "./maximum-economic-loss.ts";

/**
 * The summary risk figures for the Backtester expiration-payoff inspector.
 *
 * WHY THIS EXISTS. The inspector used to render
 * `payoffExtrema(input, currency).maximumLoss` under the label "Maximum profit /
 * loss". That figure is a SAMPLE of the fee-inclusive payoff at an extreme
 * settlement index, and it is not a maximum in either currency mode:
 *
 *  - `usd-cash-flow`: a delivery fee is a FIXED BTC amount per leg, so its USD
 *    value grows without bound as the settlement index grows. A bear call
 *    finishes with both legs deep in the money, so on an ordinary 100k/101k
 *    spread the inspector displayed -$2,702,159,776,982.30.
 *  - `btc-settlement`: an inverse option's intrinsic value is (K-S)/S, which
 *    diverges as the settlement index approaches zero. A bull put on the same
 *    entry displayed -10,638,297.87 BTC.
 *
 * Both are artifacts of where the curve was sampled, not risk the position
 * carries. The research architecture already separates the three real
 * quantities, and this adapter reuses that split rather than inventing another:
 *
 *   1. a BOUNDED maximum structural loss, from the shared canonical helper;
 *   2. scenario-specific settlement/delivery fees, reported beside it;
 *   3. an explicit statement of whether a finite GLOBAL fee-inclusive maximum
 *      exists at all.
 *
 * This module derives no risk of its own. The structural loss is whatever
 * `canonicalStructuralLoss` returns -- the same helper the research exporter
 * uses for `structure_economics.maximum_structural_loss_usd` -- so the
 * Backtester and the exported bundle cannot disagree for the same structure.
 *
 * It deliberately does NOT touch the plotted curve. Every point on the chart
 * remains `expiryPayoff(...)` including delivery fees: that is a genuine
 * scenario payoff at a finite settlement index and is legitimate.
 */

export type FeeInclusiveMaximum = "bounded" | "unbounded";

export interface InspectorStructuralLoss {
  readonly status: "available" | "unavailable";
  /** Bounded structural loss magnitude in USD. Positive when available. */
  readonly usd: number | null;
  /**
   * The SAME loss expressed in BTC at `referenceIndex`. This is a
   * representation at one index, not an unconditional terminal BTC maximum, so
   * the conversion basis is carried alongside it and must stay visible.
   */
  readonly btcAtReferenceIndex: number | null;
  readonly referenceIndex: number | null;
  /** Settlement index at which the bounded structural maximum is attained. */
  readonly settlementIndex: number | null;
  readonly methodVersion: string | null;
  readonly reason: string | null;
}

export interface InspectorMaximumProfit {
  readonly usd: number | null;
  readonly btcAtReferenceIndex: number | null;
  /**
   * True when the maximum coincides with the net opening credit converted at
   * the entry index, which is the case whenever the profitable extremum leaves
   * both legs out of the money and therefore carries no delivery fee. The
   * inspector states the basis rather than asserting it.
   */
  readonly equalsNetCreditAtEntry: boolean;
}

export interface InspectorSettlementFees {
  readonly includedInStructuralLoss: false;
  readonly globalFeeInclusiveMaximum: FeeInclusiveMaximum;
  readonly globalFeeInclusiveMaximumReason: string | null;
  /** The named settlement scenario the reported fee belongs to. */
  readonly scenarioIndex: number | null;
  readonly scenarioLabel: string | null;
  readonly scenarioFeesBtc: number | null;
  readonly scenarioFeesUsd: number | null;
}

export interface PayoffInspectorSummary {
  readonly structuralLoss: InspectorStructuralLoss;
  readonly maximumProfit: InspectorMaximumProfit;
  readonly settlementFees: InspectorSettlementFees;
}

const UNAVAILABLE_FEES: InspectorSettlementFees = {
  includedInStructuralLoss: false,
  globalFeeInclusiveMaximum: "unbounded",
  globalFeeInclusiveMaximumReason: "Not evaluated: the structure did not produce a valid inverse vertical payoff.",
  scenarioIndex: null, scenarioLabel: null, scenarioFeesBtc: null, scenarioFeesUsd: null,
};

const finite = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Net opening cash flow converted at the entry index, in USD. */
export function netCreditUsdAtEntry(input: ExpiryPayoffInput): number | null {
  const amount = Math.abs(input.amount);
  const net = (input.shortEntryPremiumBtc - input.longEntryPremiumBtc) * amount - input.openingFeesBtc;
  return Number.isFinite(net) && Number.isFinite(input.entryIndex) ? net * input.entryIndex : null;
}

export function payoffInspectorSummary(input: ExpiryPayoffInput): PayoffInspectorSummary {
  const loss = canonicalStructuralLoss(input);
  const structuralLoss: InspectorStructuralLoss = {
    status: loss.status,
    usd: finite(loss.usd),
    btcAtReferenceIndex: finite(loss.btcAtReferenceIndex),
    referenceIndex: finite(loss.referenceIndex),
    settlementIndex: finite(loss.worstStructuralIndex),
    methodVersion: loss.methodVersion,
    reason: loss.reason,
  };

  // Maximum profit is a bounded quantity for a credit vertical: the profitable
  // extremum leaves both legs out of the money, so no delivery fee applies
  // there and no divergent tail is involved. It is taken from the authoritative
  // payoff utility rather than re-derived.
  let profitUsd: number | null = null;
  try { profitUsd = finite(payoffExtrema(input, "usd-cash-flow").maximumProfit); } catch { profitUsd = null; }
  const referenceIndex = structuralLoss.referenceIndex ?? (finite(input.entryIndex) && input.entryIndex > 0 ? input.entryIndex : null);
  const netCredit = netCreditUsdAtEntry(input);
  const maximumProfit: InspectorMaximumProfit = {
    usd: profitUsd,
    btcAtReferenceIndex: profitUsd !== null && referenceIndex !== null && referenceIndex > 0 ? profitUsd / referenceIndex : null,
    equalsNetCreditAtEntry: profitUsd !== null && netCredit !== null
      && Math.abs(profitUsd - netCredit) <= 1e-6 * Math.max(1, Math.abs(netCredit)),
  };

  const settlementFees: InspectorSettlementFees = loss.status !== "available" ? UNAVAILABLE_FEES : {
    includedInStructuralLoss: false,
    globalFeeInclusiveMaximum: loss.settlementFees.globalFeeInclusiveMaximum,
    globalFeeInclusiveMaximumReason: loss.settlementFees.globalFeeInclusiveMaximumReason,
    scenarioIndex: finite(loss.settlementFees.scenarioIndex),
    scenarioLabel: loss.settlementFees.scenarioLabel,
    scenarioFeesBtc: finite(loss.settlementFees.scenarioDeliveryFeesBtc),
    scenarioFeesUsd: finite(loss.settlementFees.scenarioDeliveryFeesUsd),
  };

  return {structuralLoss, maximumProfit, settlementFees};
}
