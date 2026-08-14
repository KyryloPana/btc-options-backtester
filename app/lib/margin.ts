import type { OptionType } from "./backtester.ts";

export type DeploymentModel = "segregated_sm" | "cross_sm" | "segregated_pm" | "cross_pm";
export interface DeploymentConfig {
  model: DeploymentModel; collateralCurrency: string; accountAssumption: string;
  modelEffectiveDate: string; marginSource: "formula-estimate" | "deribit-authenticated" | "portfolio-simulation";
}
export const DEFAULT_DEPLOYMENT: DeploymentConfig = {
  model: "segregated_sm", collateralCurrency: "BTC", accountAssumption: "dedicated-empty-strategy-subaccount",
  modelEffectiveDate: "2026-08-01T00:00:00Z", marginSource: "formula-estimate",
};

export interface MarginResult {
  deployment: DeploymentConfig; theoreticalMaximumSpreadLossBtc: number; initialMarginBtc?: number;
  maintenanceMarginBtc?: number; peakInitialMarginBtc?: number; peakMaintenanceMarginBtc?: number;
  marginBalanceBtc?: number; utilization?: number; availableBalanceBtc?: number;
  state: "ok" | "insufficient-margin" | "liquidation" | "unavailable";
  indexPrice?: number; markPriceBtc?: number; observationTimestamp?: number;
  activeMarginModel?: string; accountState?: unknown; simulationTimestamp?: number;
}

export function estimateStandardOptionMargin(input: {
  side: "long" | "short"; optionType: OptionType; amount: number; strike: number;
  indexPrice?: number; markPriceBtc?: number; observationTimestamp: number; theoreticalMaximumSpreadLossBtc: number;
  deployment?: DeploymentConfig;
}): MarginResult {
  const deployment = input.deployment ?? DEFAULT_DEPLOYMENT;
  if (deployment.model !== "segregated_sm" && deployment.model !== "cross_sm") throw new Error("Portfolio Margin must use Deribit's portfolio simulation endpoint");
  if (!input.indexPrice || input.markPriceBtc === undefined) return { deployment, theoreticalMaximumSpreadLossBtc: input.theoreticalMaximumSpreadLossBtc, state: "unavailable", observationTimestamp: input.observationTimestamp };
  const amount = Math.abs(input.amount);
  const otm = input.optionType === "C" ? Math.max(input.strike - input.indexPrice, 0) / input.indexPrice : Math.max(input.indexPrice - input.strike, 0) / input.indexPrice;
  const initialMarginBtc = input.side === "long" ? input.markPriceBtc * amount : (input.markPriceBtc + Math.max(0.15 - otm, 0.1)) * amount;
  const maintenanceMarginBtc = input.side === "long" ? 0 : (input.markPriceBtc + Math.max(0.075 - otm, 0.075)) * amount;
  return { deployment: { ...deployment, marginSource: "formula-estimate" }, theoreticalMaximumSpreadLossBtc: input.theoreticalMaximumSpreadLossBtc,
    initialMarginBtc, maintenanceMarginBtc, peakInitialMarginBtc: initialMarginBtc, peakMaintenanceMarginBtc: maintenanceMarginBtc,
    state: "ok", indexPrice: input.indexPrice, markPriceBtc: input.markPriceBtc, observationTimestamp: input.observationTimestamp };
}

export function portfolioMarginResult(input: { deployment: DeploymentConfig; theoreticalMaximumSpreadLossBtc: number; response: { margin_model: string; initial_margin: number; maintenance_margin: number; margin_balance?: number; available_funds?: number }; accountState: unknown; simulationTimestamp: number }): MarginResult {
  if (input.deployment.model !== "segregated_pm" && input.deployment.model !== "cross_pm") throw new Error("Portfolio simulation requires a PM deployment model");
  const balance = input.response.margin_balance;
  return { deployment: { ...input.deployment, marginSource: "portfolio-simulation" }, theoreticalMaximumSpreadLossBtc: input.theoreticalMaximumSpreadLossBtc,
    initialMarginBtc: input.response.initial_margin, maintenanceMarginBtc: input.response.maintenance_margin,
    marginBalanceBtc: balance, availableBalanceBtc: input.response.available_funds,
    utilization: balance && balance > 0 ? input.response.initial_margin / balance : undefined,
    state: input.response.available_funds !== undefined && input.response.available_funds < 0 ? "insufficient-margin" : "ok",
    activeMarginModel: input.response.margin_model, accountState: input.accountState, simulationTimestamp: input.simulationTimestamp };
}
