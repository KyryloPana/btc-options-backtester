import { aggregateRoutedFees, buildOptionSettlementLedger, calculateOptionFee, STANDARD_INVERSE_BTC_OPTION_FEE, type ExecutionRoute, type OptionSettlementLedger, type RoutedFees } from "./accounting.ts";
import { buildValuationPath, executionClock, firstTouch, simulateTakerExit, simulateTakerSpread, type BacktestEvent, type Candle, type ExecutionClock, type ExitExecution, type RetrievedSpread, type SpreadExecution, type ValuationPoint } from "./backtester.ts";
import { DEFAULT_DEPLOYMENT, estimateStandardOptionMargin, type MarginResult } from "./margin.ts";

export const OBSERVATION_SCHEMA_VERSION = "strategy-observation/1.0.0";
export type ObservationOutcome = "executed" | "no-trade:no-executable-structure" | "no-trade:no-entry-fill" | "data-unavailable" | "entered-exit-unfilled" | "settled" | "exit-policy-unconfigured";
export type SelectedExitPolicy = { rule: "vpoc-target"; fallback: "settlement" } | { rule: "fixed-time"; afterMs: number; fallback: "settlement" } | { rule: "none"; fallback?: never };

export interface StrategyVariantConfig {
  targetExpiryHorizonDays: number; widthUsd: number; spreadKind: "credit" | "debit";
  expirySelectionPolicy: string; candidateRankPolicy: "rank-1-only"; amount: number;
  primaryExecutionScenario: "taker-tape-proxy"; latencyMs: number; fillWaitMs: number;
  synchronizationThresholdMs: number; slippageBps: number; exitPolicy: SelectedExitPolicy;
  requestedPackaging: "legs" | "combo"; executionRoute: ExecutionRoute; officialComboEvidence?: boolean;
  feeTier: "standard"; marginModel: "segregated_sm" | "cross_sm" | "segregated_pm" | "cross_pm";
}

export interface CashFlowLedger { grossBtc: number; feesBtc: number; netBtc: number; conversionTimestamp: number; conversionPriceUsdPerBtc: number; conversionSource: string; netUsd: number }
export interface SelectedExitLifecycle { rule: string; triggerTimestamp?: number; decisionTimestamp?: number; orderTimestamp?: number; fillTimestamp?: number; status: "not-triggered" | "filled" | "triggered-unfilled" | "settled" | "unconfigured"; fallbackRule?: "settlement"; reasonCode: string; execution?: ExitExecution }
export interface StrategyObservation {
  eventId: string; strategyVariantId: string; eventOutcome: ObservationOutcome;
  signalClock: ExecutionClock; candidateSelection: { policy: string; selectedCandidateId?: string; selectedRank?: number; reason: string };
  candidateAttempts: Array<{ candidateId: string; rank?: number; status: string; executable: boolean; reason: string }>;
  entryExecution?: SpreadExecution; entryCashFlow?: CashFlowLedger; valuationPath?: ValuationPoint[];
  independentExitOutcomes?: Array<{ rule: string; triggerTimestamp?: number; status: string; reasonCode: string }>;
  selectedExitLifecycle?: SelectedExitLifecycle; settlementLedger?: { legs: OptionSettlementLedger[]; cashFlowBtc: number; deliveryFeesBtc: number };
  feeLedger?: { route: ExecutionRoute; opening: RoutedFees; closing?: RoutedFees; deliveryFeesBtc: number; requestedPackaging: string; officialComboEvidence: boolean };
  marginResult?: MarginResult; netPnl?: { btc: number; usd: number; conversionTimestamp: number; conversionPriceUsdPerBtc: number; conversionSource: string; identity: string };
  unavailableReason?: string; spread?: RetrievedSpread;
}

export interface EventBacktestInput { event: BacktestEvent; candidates: RetrievedSpread[]; candles: Candle[]; config: StrategyVariantConfig }

function stableVariantId(config: StrategyVariantConfig) {
  return ["v1", `dte=${config.targetExpiryHorizonDays}`, `width=${config.widthUsd}`, `kind=${config.spreadKind}`, `expiry=${config.expirySelectionPolicy}`, `rank=${config.candidateRankPolicy}`, `amount=${config.amount}`, `exec=${config.primaryExecutionScenario}`, `latency=${config.latencyMs}`, `wait=${config.fillWaitMs}`, `sync=${config.synchronizationThresholdMs}`, `slip=${config.slippageBps}`, `exit=${config.exitPolicy.rule}${config.exitPolicy.rule === "fixed-time" ? `-${config.exitPolicy.afterMs}` : ""}`, `route=${config.executionRoute}`, `fee=${config.feeTier}`, `margin=${config.marginModel}`].join("|");
}

function routedFees(soldPrice: number, boughtPrice: number, amount: number, route: ExecutionRoute, closing = false) {
  return aggregateRoutedFees([
    { side: closing ? "buy" : "sell", fee: calculateOptionFee(soldPrice, amount, "taker", STANDARD_INVERSE_BTC_OPTION_FEE) },
    { side: closing ? "sell" : "buy", fee: calculateOptionFee(boughtPrice, amount, "taker", STANDARD_INVERSE_BTC_OPTION_FEE) },
  ], route);
}

function effectiveRoute(config: StrategyVariantConfig): ExecutionRoute {
  return config.executionRoute === "official-combo" && !config.officialComboEvidence ? "synchronized-leg-proxy" : config.executionRoute;
}

/** The single executable orchestration boundary used by the UI and tests. */
export function runEventBacktest(input: EventBacktestInput): StrategyObservation {
  const { event, candles, config } = input;
  const signalCandle = event.entryTimeSource === "resolved"
    ? candles.find(c => c.openTime <= (event.entryTimestamp ?? 0) && c.closeTime >= (event.entryTimestamp ?? 0))
    : undefined;
  const signalTimestamp = event.entryTimestamp ?? Date.parse(`${event.entryDate}T00:00:00Z`);
  const signalClock = executionClock({ signalTimestamp, signalSourceTimestamp: signalCandle?.openTime ?? signalTimestamp, signalSourceCandle: signalCandle, signalTimePrecision: signalCandle ? "candle" : event.entryTimeSource === "manual" ? "manual" : "second", configuredLatencyMs: config.latencyMs, maxFillWaitMs: config.fillWaitMs });
  const candidates = [...input.candidates].sort((a, b) => (a.expiryRank ?? Infinity) - (b.expiryRank ?? Infinity));
  const selected = candidates.find(candidate => candidate.expiryRank === 1) ?? candidates[0];
  const attempts = candidates.map(candidate => ({ candidateId: candidate.id, rank: candidate.expiryRank, status: candidate.dataStatus === "data-unavailable" ? "data-unavailable" : candidate.retrievalStatus, executable: candidate.id === selected?.id, reason: candidate.id === selected?.id ? "Rank-1 candidate selected before execution." : "Retained diagnostic alternative; causal fallback was not configured." }));
  const base = { eventId: event.id, strategyVariantId: stableVariantId(config), signalClock, candidateSelection: { policy: config.candidateRankPolicy, selectedCandidateId: selected?.id, selectedRank: selected?.expiryRank, reason: selected ? "Only the pre-ranked primary candidate may execute." : "No candidate was available." }, candidateAttempts: attempts };
  if (!selected) return { ...base, eventOutcome: "no-trade:no-executable-structure", netPnl: zeroPnl(signalClock.orderSubmittedAt, event.entryPrice), unavailableReason: "No viable ranked structure." };
  if (selected.dataStatus === "data-unavailable" || selected.retrievalStatus === "partial") return { ...base, spread: selected, eventOutcome: "data-unavailable", unavailableReason: selected.retrievalNote || "Required contract retrieval was incomplete." };
  if (!selected.soldContract || !selected.boughtContract || !selected.expiryTimestamp || selected.retrievalStatus !== "ready") return { ...base, spread: selected, eventOutcome: "no-trade:no-executable-structure", netPnl: zeroPnl(signalClock.orderSubmittedAt, event.entryPrice), unavailableReason: selected.retrievalNote || "No complete two-leg structure." };
  const entryExecution = simulateTakerSpread(selected, signalClock, config.amount, config.slippageBps, config.synchronizationThresholdMs);
  if (entryExecution.status !== "filled") return { ...base, spread: selected, eventOutcome: "no-trade:no-entry-fill", entryExecution, netPnl: zeroPnl(signalClock.orderSubmittedAt, event.entryPrice), unavailableReason: entryExecution.reason };
  const route = effectiveRoute(config);
  const opening = routedFees(entryExecution.sold.fillPriceBtc!, entryExecution.bought.fillPriceBtc!, config.amount, route);
  const grossEntry = (entryExecution.sold.fillPriceBtc! - entryExecution.bought.fillPriceBtc!) * config.amount;
  const entryCashFlow = cashFlow(grossEntry, opening.finalFee, event.entryPrice, Math.max(entryExecution.sold.fillTimestamp!, entryExecution.bought.fillTimestamp!), "entry-fill-index");
  const marginResult = estimateStandardOptionMargin({ side: "short", optionType: selected.optionType, amount: entryExecution.sold.filledAmount, strike: selected.soldContract.strike, indexPrice: entryExecution.sold.supportingTrades.at(-1)?.indexPrice, markPriceBtc: entryExecution.sold.supportingTrades.at(-1)?.markPrice ?? entryExecution.sold.fillPriceBtc, observationTimestamp: entryExecution.sold.fillTimestamp!, theoreticalMaximumSpreadLossBtc: Math.max(0, (Math.abs(selected.soldContract.strike - selected.boughtContract.strike) / event.entryPrice) * config.amount - grossEntry), deployment: { ...DEFAULT_DEPLOYMENT, model: config.marginModel } });
  const valuationPath = buildValuationPath(selected, { ...event, entryTimestamp: signalClock.orderSubmittedAt }, candles, "taker", config.amount, false);
  const trigger = config.exitPolicy.rule === "vpoc-target" && event.vpocPrice ? firstTouch(candles, event.vpocPrice, signalClock.orderSubmittedAt) : config.exitPolicy.rule === "fixed-time" ? { openTime: signalClock.orderSubmittedAt + config.exitPolicy.afterMs, closeTime: signalClock.orderSubmittedAt + config.exitPolicy.afterMs } : undefined;
  const independentExitOutcomes = [{ rule: "VPOC target", triggerTimestamp: trigger?.closeTime, status: trigger ? "triggered" : "not-triggered", reasonCode: trigger ? "causal-candle-close" : "not-hit-or-unconfigured" }, { rule: "Expiry settlement", triggerTimestamp: selected.expiryTimestamp, status: "available", reasonCode: "configured-fallback" }];
  if (config.exitPolicy.rule === "none") return { ...base, spread: selected, eventOutcome: "exit-policy-unconfigured", entryExecution, entryCashFlow, valuationPath, independentExitOutcomes, selectedExitLifecycle: { rule: "none", status: "unconfigured", reasonCode: "exit-policy-unconfigured" }, feeLedger: { route, opening, deliveryFeesBtc: 0, requestedPackaging: config.requestedPackaging, officialComboEvidence: Boolean(config.officialComboEvidence) }, marginResult };
  if (trigger && trigger.closeTime < selected.expiryTimestamp) {
    const triggerCandle = candles.find(c => c.openTime === trigger.openTime && c.closeTime === trigger.closeTime);
    const exitClock = executionClock({ signalTimestamp: trigger.closeTime, signalSourceTimestamp: trigger.openTime, signalSourceCandle: triggerCandle, signalTimePrecision: triggerCandle ? "candle" : "second", configuredLatencyMs: config.latencyMs, maxFillWaitMs: config.fillWaitMs });
    const close = simulateTakerExit(selected, exitClock, trigger.closeTime, config.amount, config.slippageBps, config.synchronizationThresholdMs);
    if (close.exitStatus === "filled") {
      const closing = routedFees(close.sold.fillPriceBtc!, close.bought.fillPriceBtc!, config.amount, route, true);
      const closeGross = (close.bought.fillPriceBtc! - close.sold.fillPriceBtc!) * config.amount;
      const netBtc = grossEntry + closeGross - opening.finalFee - closing.finalFee;
      return { ...base, spread: selected, eventOutcome: "executed", entryExecution, entryCashFlow, valuationPath, independentExitOutcomes, selectedExitLifecycle: { rule: config.exitPolicy.rule, triggerTimestamp: trigger.closeTime, decisionTimestamp: exitClock.decisionAvailableTimestamp, orderTimestamp: exitClock.orderSubmittedAt, fillTimestamp: close.exitFillTimestamp, status: "filled", fallbackRule: "settlement", reasonCode: "causal-taker-fill", execution: close }, feeLedger: { route, opening, closing, deliveryFeesBtc: 0, requestedPackaging: config.requestedPackaging, officialComboEvidence: Boolean(config.officialComboEvidence) }, marginResult, netPnl: pnl(netBtc, close.bought.supportingTrades.at(-1)?.indexPrice ?? event.entryPrice, close.exitFillTimestamp!, "exit-fill-index", `entry gross ${grossEntry} + close gross ${closeGross} - opening fees ${opening.finalFee} - closing fees ${closing.finalFee}`) };
    }
  }
  if (selected.deliveryPrice === undefined) return { ...base, spread: selected, eventOutcome: "entered-exit-unfilled", entryExecution, entryCashFlow, valuationPath, independentExitOutcomes, selectedExitLifecycle: { rule: config.exitPolicy.rule, triggerTimestamp: trigger?.closeTime, decisionTimestamp: trigger?.closeTime, orderTimestamp: trigger ? trigger.closeTime + config.latencyMs : undefined, status: trigger ? "triggered-unfilled" : "not-triggered", fallbackRule: "settlement", reasonCode: "settlement-data-unavailable" }, feeLedger: { route, opening, deliveryFeesBtc: 0, requestedPackaging: config.requestedPackaging, officialComboEvidence: Boolean(config.officialComboEvidence) }, marginResult, unavailableReason: "Official delivery price required by the configured settlement fallback is unavailable." };
  const legs = [buildOptionSettlementLedger({ expiryTimestamp: selected.expiryTimestamp, optionType: selected.optionType, side: "short", amount: config.amount, strike: selected.soldContract.strike, deliveryPrice: selected.deliveryPrice, dailyOption: false }), buildOptionSettlementLedger({ expiryTimestamp: selected.expiryTimestamp, optionType: selected.optionType, side: "long", amount: config.amount, strike: selected.boughtContract.strike, deliveryPrice: selected.deliveryPrice, dailyOption: false })];
  const settlementCash = legs.reduce((sum, leg) => sum + leg.futureEconomicPnlBtc, 0); const deliveryFees = legs.reduce((sum, leg) => sum + leg.aggregateDeliveryFeeBtc, 0);
  const netBtc = grossEntry + settlementCash - opening.finalFee - deliveryFees;
  return { ...base, spread: selected, eventOutcome: "settled", entryExecution, entryCashFlow, valuationPath, independentExitOutcomes, selectedExitLifecycle: { rule: config.exitPolicy.rule, triggerTimestamp: trigger?.closeTime, decisionTimestamp: trigger?.closeTime, orderTimestamp: trigger ? trigger.closeTime + config.latencyMs : undefined, status: "settled", fallbackRule: "settlement", reasonCode: trigger ? "triggered-unfilled-carried-to-settlement" : "primary-not-triggered-carried-to-settlement" }, settlementLedger: { legs, cashFlowBtc: settlementCash, deliveryFeesBtc: deliveryFees }, feeLedger: { route, opening, deliveryFeesBtc: deliveryFees, requestedPackaging: config.requestedPackaging, officialComboEvidence: Boolean(config.officialComboEvidence) }, marginResult, netPnl: pnl(netBtc, selected.deliveryPrice, selected.expiryTimestamp, "deribit-delivery-price", `entry gross ${grossEntry} + settlement ${settlementCash} - opening fees ${opening.finalFee} - delivery fees ${deliveryFees}`) };
}

function cashFlow(grossBtc: number, feesBtc: number, conversionPrice: number, timestamp: number, source: string): CashFlowLedger { const netBtc = grossBtc - feesBtc; return { grossBtc, feesBtc, netBtc, conversionTimestamp: timestamp, conversionPriceUsdPerBtc: conversionPrice, conversionSource: source, netUsd: netBtc * conversionPrice }; }
function pnl(btc: number, price: number, timestamp: number, source: string, identity: string) { return { btc, usd: btc * price, conversionTimestamp: timestamp, conversionPriceUsdPerBtc: price, conversionSource: source, identity }; }
function zeroPnl(timestamp: number, price: number) { return pnl(0, price, timestamp, "event-entry-price", "complete no-trade event-level PnL = 0"); }

export function aggregateObservations(observations: StrategyObservation[]) {
  const groups = new Map<string, StrategyObservation[]>(); observations.forEach(o => groups.set(o.strategyVariantId, [...(groups.get(o.strategyVariantId) ?? []), o]));
  return [...groups].map(([strategyVariantId, rows]) => { const unavailable = rows.filter(r => r.eventOutcome === "data-unavailable").length; const complete = rows.length - unavailable; const trades = rows.filter(r => ["executed", "settled"].includes(r.eventOutcome)).length; const noTrades = rows.filter(r => r.eventOutcome.startsWith("no-trade:")).length; const pnlRows = rows.filter(r => r.netPnl !== undefined); const total = pnlRows.reduce((sum, r) => sum + r.netPnl!.btc, 0); return { strategyVariantId, totalOriginalSignals: rows.length, completeEvents: complete, executedTrades: trades, noTrades, unavailableEvents: unavailable, executionRate: complete ? trades / complete : 0, coverage: rows.length ? complete / rows.length : 0, averageNetPnlBtcPerCompleteSignal: complete ? total / complete : undefined, averageNetPnlBtcPerExecutedTrade: trades ? rows.filter(r => ["executed", "settled"].includes(r.eventOutcome)).reduce((sum, r) => sum + (r.netPnl?.btc ?? 0), 0) / trades : undefined }; });
}

export function validateObservationLedger(observations: StrategyObservation[]) { const errors: string[] = []; for (const o of observations) { if (o.signalClock.orderSubmittedAt < o.signalClock.decisionAvailableTimestamp) errors.push(`${o.eventId}: entry chronology`); if (o.entryExecution?.sold.fillTimestamp !== undefined && o.entryExecution.sold.fillTimestamp <= o.signalClock.orderSubmittedAt) errors.push(`${o.eventId}: pre-order entry fill`); const x = o.selectedExitLifecycle; if (x?.fillTimestamp !== undefined && x.orderTimestamp !== undefined && x.fillTimestamp <= x.orderTimestamp) errors.push(`${o.eventId}: pre-order exit fill`); if (o.netPnl && !Number.isFinite(o.netPnl.btc)) errors.push(`${o.eventId}: non-finite PnL`); } return { valid: errors.length === 0, errors }; }

export function buildObservationExport(observations: StrategyObservation[], strategyConfiguration: unknown, originalEvents: BacktestEvent[], generatedAt = new Date().toISOString()) { const validation = validateObservationLedger(observations); return { schemaVersion: OBSERVATION_SCHEMA_VERSION, generatedAt, valid: validation.valid, validationErrors: validation.errors, strategyConfiguration, originalEvents, strategyVariants: [...new Set(observations.map(o => o.strategyVariantId))], observations, aggregateGroups: aggregateObservations(observations) }; }
