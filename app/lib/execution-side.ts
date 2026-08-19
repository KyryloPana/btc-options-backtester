/**
 * The single, shared mapping from our own order action to which side of the
 * historical Deribit tape supports it -- for maker opportunity and for taker
 * execution alike. Every pathway that reads historical trade direction
 * (backtester.ts's conservative-tape simulator, research-valuation.ts's
 * canonical-bundle pricing) imports this instead of maintaining its own copy,
 * so the two can never silently diverge.
 *
 * Historical `trade.direction` on the tape always records the TAKER side of
 * that print (see README: "Deribit direction is treated as the taker side").
 *
 * For our own action:
 *  - Taker execution: we ARE the taker, so the relevant tape is a print on
 *    our own side (our sell -> a taker-sell print; our buy -> a taker-buy
 *    print).
 *  - Maker opportunity: we are quoting passively and someone else crosses to
 *    fill us, so the relevant tape is a print on the OPPOSITE side (our sell
 *    is filled by a taker who bought from us -> a taker-buy print; our buy
 *    is filled by a taker who sold to us -> a taker-sell print).
 *
 * This holds identically whether the action is opening or closing a leg --
 * "sell to open short" and "sell to close long" both look for taker-buy tape
 * under maker, taker-sell tape under taker. Open/close only decides which
 * action ("buy" or "sell") applies to a given leg at that moment; this
 * function only cares about the action itself.
 */
export type TradeSide = "buy" | "sell";
export type ExecutionMode = "maker" | "taker";

/**
 * Which recorded tape `direction` is consistent with `action` under `mode`.
 * Never proves a maker fill -- only that historical evidence existed
 * consistent with the opportunity to be filled passively.
 */
export function tapeDirectionFor(action: TradeSide, mode: ExecutionMode): TradeSide {
  if (mode === "taker") return action;
  return action === "buy" ? "sell" : "buy";
}
