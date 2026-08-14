import type { RetrievedSpread } from "./backtester.ts";
import type { StrategyObservation } from "./observation-ledger.ts";

export function spreadIdentity(spread: RetrievedSpread) {
  return {
    soldStrike: spread.soldContract?.strike ?? spread.resolvedSoldStrike,
    boughtStrike: spread.boughtContract?.strike ?? spread.resolvedBoughtStrike,
    width: spread.actualWidth,
  };
}

export function observationStatus(observation: StrategyObservation) {
  if (observation.eventOutcome === "data-unavailable") return "Unavailable";
  if (observation.eventOutcome.startsWith("no-trade:")) return "No trade";
  return observation.selectedExitLifecycle?.rule ?? "Open position";
}

export function displayedProfit(observation: StrategyObservation) {
  if (observation.eventOutcome.startsWith("no-trade:") || observation.eventOutcome === "data-unavailable") return undefined;
  return (observation.executedNetPnl ?? observation.settlementNetPnl)?.usd;
}

export function entryEvidenceExplanation(observation: StrategyObservation) {
  const execution = observation.entryExecution;
  if (!execution) return observation.unavailableReason ?? "No executed entry.";
  if (execution.status === "filled") return execution.reason;
  const leg = (label: string, fill: typeof execution.sold) =>
    `${label}: ${fill.reasonCode} — ${fill.reason}`;
  return `No trade. ${leg("short leg", execution.sold)} ${leg("long leg", execution.bought)}`;
}
