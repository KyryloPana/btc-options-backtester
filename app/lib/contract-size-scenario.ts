import type { BacktestEvent, Candle, InstrumentAmountMetadata, RetrievedSpread, ValuationPoint } from "./backtester.ts";
import { runEventBacktest, type StrategyObservation, type StrategyVariantConfig } from "./observation-ledger.ts";
import type { DeploymentModel } from "./margin.ts";
import { buildOptionSettlementLedger } from "./accounting.ts";

export interface OpeningCapitalRequirement {
  amount: number;
  marginModel: DeploymentModel;
  collateralCurrency: string;
  estimatedInitialMargin?: number;
  estimatedMaintenanceMargin?: number;
  minimumStartingBalance?: number;
  minimumStartingBalanceUsd?: number;
  calculationSource: "historical-formula-estimate" | "deribit-account-simulation" | "unavailable";
  openingSequence: string[];
  reason?: string;
}

export interface ScenarioPathMetrics {
  bestUnrealized?: number;
  maxAdverse?: number;
  gridPoints: number;
  series: "ivPnlUsd" | "rawPnlUsd";
  amount: number;
}

export interface ScenarioOutcome {
  rule: string;
  status: "filled" | "settlement" | "triggered-unfilled" | "not-hit" | "unavailable" | "no-entry";
  pnlUsd?: number;
}

export interface ContractSizeScenario {
  amount: number;
  observation: StrategyObservation;
  pathMetrics: ScenarioPathMetrics;
  capitalRequirement: OpeningCapitalRequirement;
  outcomes: ScenarioOutcome[];
  executable: boolean;
}

const closeEnough = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export function validateScenarioAmount(raw: number, sold?: InstrumentAmountMetadata, bought?: InstrumentAmountMetadata): string | undefined {
  if (!Number.isFinite(raw) || raw <= 0) return "Enter a finite, positive contract size.";
  if (!sold || !bought) return "Instrument amount metadata is unavailable.";
  const rules = [sold, bought];
  for (const rule of rules) {
    if (raw < rule.minimumTradeAmount && !closeEnough(raw, rule.minimumTradeAmount)) return `Minimum trade amount is ${rule.minimumTradeAmount}.`;
    const units = raw / rule.amountStep;
    if (!Number.isInteger(Math.round(units)) || !closeEnough(units, Math.round(units))) return `Contract size must use a ${rule.amountStep} increment.`;
    const decimalPlaces = (String(raw).split(".")[1] ?? "").length;
    if (decimalPlaces > rule.amountPrecision) return `Contract size permits ${rule.amountPrecision} decimal places.`;
  }
  return undefined;
}

export function scenarioPathMetrics(path: ValuationPoint[], amount: number, series: "ivPnlUsd" | "rawPnlUsd" = "ivPnlUsd"): ScenarioPathMetrics {
  const values = path.map(point => point[series]).filter((value): value is number => value !== undefined && Number.isFinite(value));
  return { bestUnrealized: values.length ? Math.max(...values) : undefined, maxAdverse: values.length ? Math.min(...values) : undefined, gridPoints: path.length, series, amount };
}

export function openingCapitalRequirement(observation: StrategyObservation): OpeningCapitalRequirement {
  const model = observation.marginResult?.deployment.model ?? "segregated_sm";
  const base = { amount: observation.entryExecution?.sold.requestedAmount ?? 0, marginModel: model, collateralCurrency: observation.marginResult?.deployment.collateralCurrency ?? "BTC" };
  if (model.endsWith("_pm")) return { ...base, calculationSource: "unavailable", openingSequence: [], reason: "PM capital requirement needs valid portfolio simulation evidence." };
  const entry = observation.entryCashFlow;
  const margin = observation.marginResult;
  const execution = observation.entryExecution;
  if (!entry || !margin || !execution || margin.initialMarginBtc === undefined) return { ...base, calculationSource: "unavailable", openingSequence: [], reason: "Reliable entry execution and margin state are required." };
  const boughtPremium = execution.bought.fillPriceBtc! * execution.bought.filledAmount;
  const boughtFee = observation.feeLedger?.opening.buyAggregate ?? 0;
  // Long options require premium rather than an additional short-option margin charge.
  const firstLegRequirement = boughtPremium + boughtFee;
  // Net cash flow is positive when already received, and negative when already paid.
  const finalRequirement = margin.initialMarginBtc - entry.netBtc;
  const officialCombo = observation.feeLedger?.route === "official-combo" && observation.feeLedger.officialComboEvidence;
  const minimumStartingBalance = officialCombo ? Math.max(0, finalRequirement) : Math.max(0, firstLegRequirement, finalRequirement);
  return { ...base, estimatedInitialMargin: margin.initialMarginBtc, estimatedMaintenanceMargin: margin.maintenanceMarginBtc, minimumStartingBalance, minimumStartingBalanceUsd: minimumStartingBalance * entry.conversionPriceUsdPerBtc, calculationSource: "historical-formula-estimate", openingSequence: officialCombo ? ["official combined order / final spread"] : ["protective bought leg", "short leg / final spread"] };
}

export function scenarioOutcomes(observation: StrategyObservation): ScenarioOutcome[] {
  if (!observation.entryExecution || observation.entryExecution.status !== "filled") return (observation.independentExitOutcomes ?? []).map(item => ({ rule: item.rule, status: "no-entry" }));
  const lifecycle = observation.selectedExitLifecycle;
  const vpoc = observation.independentExitOutcomes?.find(item => item.rule === "VPOC target");
  const triggeredUnfilled = lifecycle?.reasonCode === "triggered-unfilled-carried-to-settlement" || (vpoc?.status === "triggered" && lifecycle?.status !== "filled");
  const primary: ScenarioOutcome = !vpoc || vpoc.status !== "triggered" ? { rule: "VPOC target", status: "not-hit" } : triggeredUnfilled ? { rule: "VPOC target", status: "triggered-unfilled" } : lifecycle?.status === "filled" ? { rule: "VPOC target", status: "filled", pnlUsd: observation.netPnl?.usd } : { rule: "VPOC target", status: "unavailable" };
  let settlement: ScenarioOutcome = { rule: "Expiry settlement", status: "unavailable" };
  const spread = observation.spread;
  if (observation.eventOutcome === "settled") settlement = { rule: "Expiry settlement", status: "settlement", pnlUsd: observation.netPnl?.usd };
  else if (spread?.deliveryPrice !== undefined && spread.expiryTimestamp && spread.soldContract && spread.boughtContract && observation.entryCashFlow) {
    const amount = observation.entryExecution.sold.filledAmount;
    const legs = [buildOptionSettlementLedger({ expiryTimestamp: spread.expiryTimestamp, optionType: spread.optionType, side: "short", amount, strike: spread.soldContract.strike, deliveryPrice: spread.deliveryPrice, dailyOption: false }), buildOptionSettlementLedger({ expiryTimestamp: spread.expiryTimestamp, optionType: spread.optionType, side: "long", amount, strike: spread.boughtContract.strike, deliveryPrice: spread.deliveryPrice, dailyOption: false })];
    const settlementCash = legs.reduce((sum, leg) => sum + leg.futureEconomicPnlBtc, 0);
    const deliveryFees = legs.reduce((sum, leg) => sum + leg.aggregateDeliveryFeeBtc, 0);
    settlement = { rule: "Expiry settlement", status: "settlement", pnlUsd: (observation.entryCashFlow.grossBtc + settlementCash - observation.entryCashFlow.feesBtc - deliveryFees) * spread.deliveryPrice };
  }
  return [primary, settlement];
}

/** Pure local orchestration: candidates contain the already-loaded tapes, so this performs no retrieval. */
export function calculateContractSizeScenario(input: { event: BacktestEvent; candidates: RetrievedSpread[]; candles: Candle[]; baseConfig: StrategyVariantConfig; amount: number; series?: "ivPnlUsd" | "rawPnlUsd" }): ContractSizeScenario {
  const observation = runEventBacktest({ event: input.event, candidates: input.candidates, candles: input.candles, config: { ...input.baseConfig, amount: input.amount } });
  const executable = observation.entryExecution?.status === "filled";
  return { amount: input.amount, observation, executable, pathMetrics: scenarioPathMetrics(observation.valuationPath ?? [], input.amount, input.series), capitalRequirement: openingCapitalRequirement(observation), outcomes: scenarioOutcomes(observation) };
}
