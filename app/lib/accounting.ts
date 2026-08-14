import type { ExecutionMode, OptionType, TradeSide } from "./backtester.ts";

export type FeeTier = "standard";
export type ExecutionRoute = "official-combo" | "separate-legs" | "synchronized-leg-proxy";

export interface OptionFeeSchedule {
  effectiveDate: string;
  tier: FeeTier;
  baseFeeRate: number;
  premiumCap: number;
  currency: "BTC";
}

export const STANDARD_INVERSE_BTC_OPTION_FEE: OptionFeeSchedule = {
  effectiveDate: "2019-07-01T00:00:00Z",
  tier: "standard",
  baseFeeRate: 0.0003,
  premiumCap: 0.125,
  currency: "BTC",
};

export interface FeeCalculation {
  scheduleEffectiveDate: string;
  tier: FeeTier;
  executionMode: ExecutionMode;
  baseFeeRate: number;
  premiumCap: number;
  grossFee: number;
  discount: number;
  finalFee: number;
  feeCurrency: "BTC";
}

export function calculateOptionFee(
  optionPriceBtc: number,
  absoluteAmount: number,
  executionMode: ExecutionMode,
  schedule: OptionFeeSchedule,
  discount = 0,
): FeeCalculation {
  if (schedule.tier !== "standard") throw new Error(`Unsupported explicit fee tier: ${schedule.tier}`);
  if (discount < 0 || discount > 1) throw new RangeError("Fee discount must be between zero and one");
  const grossFee = Math.min(schedule.baseFeeRate, schedule.premiumCap * Math.max(0, optionPriceBtc)) * Math.abs(absoluteAmount);
  return {
    scheduleEffectiveDate: schedule.effectiveDate, tier: schedule.tier, executionMode,
    baseFeeRate: schedule.baseFeeRate, premiumCap: schedule.premiumCap, grossFee,
    discount, finalFee: grossFee * (1 - discount), feeCurrency: schedule.currency,
  };
}

export interface RoutedFeeLeg { side: TradeSide; fee: FeeCalculation }
export interface RoutedFees {
  executionRoute: ExecutionRoute;
  legs: RoutedFeeLeg[];
  buyAggregate: number;
  sellAggregate: number;
  waivedDirectionalGroup?: TradeSide;
  finalFee: number;
  feeCurrency: "BTC";
}

export function aggregateRoutedFees(legs: RoutedFeeLeg[], executionRoute: ExecutionRoute): RoutedFees {
  const buyAggregate = legs.filter(leg => leg.side === "buy").reduce((sum, leg) => sum + leg.fee.finalFee, 0);
  const sellAggregate = legs.filter(leg => leg.side === "sell").reduce((sum, leg) => sum + leg.fee.finalFee, 0);
  if (executionRoute !== "official-combo") return { executionRoute, legs, buyAggregate, sellAggregate, finalFee: buyAggregate + sellAggregate, feeCurrency: "BTC" };
  return {
    executionRoute, legs, buyAggregate, sellAggregate,
    waivedDirectionalGroup: buyAggregate <= sellAggregate ? "buy" : "sell",
    finalFee: Math.max(buyAggregate, sellAggregate), feeCurrency: "BTC",
  };
}

export const OPTION_TO_FUTURE_EFFECTIVE_AT = Date.parse("2026-08-01T00:00:00Z");
export type SettlementLedgerVersion = "legacy-direct-cash" | "option-to-future";

export interface DeliveryFeeCalculation {
  exempt: boolean; rate: number; grossFeeBtc: number; deliveredOptionValueBtc: number;
  premiumCap: number; finalFeeBtc: number; feeCurrency: "BTC";
}

export function calculateDeliveryFee(intrinsicValueBtc: number, amount: number, dailyOption: boolean): DeliveryFeeCalculation {
  const deliveredOptionValueBtc = Math.max(0, intrinsicValueBtc) * Math.abs(amount);
  const grossFeeBtc = dailyOption ? 0 : 0.00015 * Math.abs(amount);
  return { exempt: dailyOption, rate: 0.00015, grossFeeBtc, deliveredOptionValueBtc, premiumCap: 0.125,
    finalFeeBtc: Math.min(grossFeeBtc, 0.125 * deliveredOptionValueBtc), feeCurrency: "BTC" };
}

export interface OptionSettlementInput {
  expiryTimestamp: number; optionType: OptionType; side: "long" | "short"; amount: number;
  strike: number; deliveryPrice: number; dailyOption: boolean; existingFutureUsd?: number;
}

export interface OptionSettlementLedger {
  version: SettlementLedgerVersion; expiryTimestamp: number; intrinsicValueBtc: number;
  entries: Array<{ type: "expiry" | "direct-cash-settlement" | "option-to-future" | "future-delivery"; btcAmount?: number; entryPrice?: number; signedUsdSize?: number; deliveryPrice?: number; deliveryFeeBtc: number }>;
  generatedFutureUsd: number; existingFutureUsd: number; netFutureUsd: number; futureEconomicPnlBtc: number;
  deliveryFee: DeliveryFeeCalculation; aggregateDeliveryFeeBtc: number;
}

export function buildOptionSettlementLedger(input: OptionSettlementInput): OptionSettlementLedger {
  if (input.deliveryPrice <= 0 || input.strike <= 0) throw new RangeError("Strike and delivery price must be positive");
  const side = input.side === "long" ? 1 : -1;
  const perContract = input.optionType === "C"
    ? Math.max(input.deliveryPrice - input.strike, 0) / input.deliveryPrice
    : Math.max(input.strike - input.deliveryPrice, 0) / input.deliveryPrice;
  const intrinsicValueBtc = side * Math.abs(input.amount) * perContract;
  const deliveryFee = calculateDeliveryFee(perContract, input.amount, input.dailyOption);
  const existingFutureUsd = input.existingFutureUsd ?? 0;
  if (input.expiryTimestamp < OPTION_TO_FUTURE_EFFECTIVE_AT) return {
    version: "legacy-direct-cash", expiryTimestamp: input.expiryTimestamp, intrinsicValueBtc,
    entries: [{ type: "direct-cash-settlement", btcAmount: intrinsicValueBtc, deliveryFeeBtc: deliveryFee.finalFeeBtc }],
    generatedFutureUsd: 0, existingFutureUsd, netFutureUsd: existingFutureUsd, futureEconomicPnlBtc: intrinsicValueBtc,
    deliveryFee, aggregateDeliveryFeeBtc: deliveryFee.finalFeeBtc,
  };
  if (perContract === 0) return {
    version: "option-to-future", expiryTimestamp: input.expiryTimestamp, intrinsicValueBtc: 0,
    entries: [{ type: "expiry", btcAmount: 0, deliveryFeeBtc: 0 }], generatedFutureUsd: 0,
    existingFutureUsd, netFutureUsd: existingFutureUsd, futureEconomicPnlBtc: 0, deliveryFee, aggregateDeliveryFeeBtc: 0,
  };
  const typeDirection = input.optionType === "C" ? 1 : -1;
  const generatedFutureUsd = side * typeDirection * Math.abs(input.amount) * input.strike;
  const futureEconomicPnlBtc = generatedFutureUsd * (1 / input.strike - 1 / input.deliveryPrice);
  return {
    version: "option-to-future", expiryTimestamp: input.expiryTimestamp, intrinsicValueBtc,
    entries: [
      { type: "option-to-future", entryPrice: input.strike, signedUsdSize: generatedFutureUsd, deliveryFeeBtc: deliveryFee.finalFeeBtc },
      { type: "future-delivery", signedUsdSize: generatedFutureUsd, deliveryPrice: input.deliveryPrice, deliveryFeeBtc: 0 },
    ], generatedFutureUsd, existingFutureUsd, netFutureUsd: existingFutureUsd + generatedFutureUsd,
    futureEconomicPnlBtc, deliveryFee, aggregateDeliveryFeeBtc: deliveryFee.finalFeeBtc,
  };
}
