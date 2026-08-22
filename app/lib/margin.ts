import type { OptionType } from "./backtester.ts";

export const STANDARD_MARGIN_ENGINE_VERSION = "deribit-standard-margin-v2" as const;
export const STANDARD_MARGIN_RULE_ID = "deribit-btc-option-sm-2019-08-01/open-formula" as const;
export const STANDARD_MARGIN_VERIFIED_FROM = Date.parse("2019-08-01T00:00:00Z");
export const STANDARD_MARGIN_SOURCE = "Deribit Support: Standard Margin (BTC option formulas; retrieved 2026-08-22)" as const;
export type DeploymentModel = "segregated_sm" | "cross_sm" | "segregated_pm" | "cross_pm";
export interface DeploymentConfig {
  model: DeploymentModel; collateralCurrency: string; accountAssumption: string;
  modelEffectiveDate: string; marginSource: "historical-formula-reconstruction" | "deribit-authenticated" | "portfolio-simulation";
}
export const DEFAULT_DEPLOYMENT: DeploymentConfig = {
  model: "segregated_sm", collateralCurrency: "BTC", accountAssumption: "dedicated-empty-strategy-subaccount",
  modelEffectiveDate: new Date(STANDARD_MARGIN_VERIFIED_FROM).toISOString(), marginSource: "historical-formula-reconstruction",
};

export interface MarginResult {
  deployment: DeploymentConfig; theoreticalMaximumSpreadLossBtc: number; initialMarginBtc?: number;
  maintenanceMarginBtc?: number; peakInitialMarginBtc?: number; peakMaintenanceMarginBtc?: number;
  marginBalanceBtc?: number; utilization?: number; availableBalanceBtc?: number;
  state: "ok" | "insufficient-margin" | "liquidation" | "unavailable";
  indexPrice?: number; markPriceBtc?: number; observationTimestamp?: number;
  activeMarginModel?: string; accountState?: unknown; simulationTimestamp?: number;
  requestedModel?: DeploymentModel; evidenceModel?: string; unavailabilityReason?: string; ruleVersion?: string; provenance?: string;
}

export function estimateStandardOptionMargin(input: {
  side: "long" | "short"; optionType: OptionType; amount: number; strike: number;
  indexPrice?: number; markPriceBtc?: number; observationTimestamp: number; theoreticalMaximumSpreadLossBtc: number;
  deployment?: DeploymentConfig;
}): MarginResult {
  const deployment = input.deployment ?? DEFAULT_DEPLOYMENT;
  const unavailable=(reason:string):MarginResult=>({deployment,theoreticalMaximumSpreadLossBtc:input.theoreticalMaximumSpreadLossBtc,state:"unavailable",observationTimestamp:input.observationTimestamp,ruleVersion:STANDARD_MARGIN_RULE_ID,provenance:STANDARD_MARGIN_SOURCE,unavailabilityReason:reason});
  if (deployment.model !== "segregated_sm") return unavailable(deployment.model.includes("pm")?"Historical Portfolio Margin is unsupported without complete account state and a contemporaneous risk engine.":"Cross-account Standard Margin is unsupported; only independent segregated reconstruction is implemented.");
  if(input.observationTimestamp<STANDARD_MARGIN_VERIFIED_FROM)return unavailable("The applicable historical Deribit Standard Margin rule period is not verified.");
  if (!input.indexPrice || input.indexPrice<=0) return unavailable("A causal positive BTC index price is required.");
  if(input.markPriceBtc===undefined||!Number.isFinite(input.markPriceBtc)||input.markPriceBtc<0)return unavailable("A causal non-negative option mark in BTC is required.");
  const amount = Math.abs(input.amount);
  const otm = input.optionType === "C" ? Math.max(input.strike - input.indexPrice, 0) / input.indexPrice : Math.max(input.indexPrice - input.strike, 0) / input.indexPrice;
  const initialMarginBtc = input.side === "long" ? 0 : (input.markPriceBtc + Math.max(0.15 - otm, 0.1)) * amount;
  const maintenanceMarginBtc = input.side === "long" ? 0 : (input.markPriceBtc + 0.075) * amount;
  return { deployment, theoreticalMaximumSpreadLossBtc: input.theoreticalMaximumSpreadLossBtc,
    initialMarginBtc, maintenanceMarginBtc, peakInitialMarginBtc: initialMarginBtc, peakMaintenanceMarginBtc: maintenanceMarginBtc,
    state: "ok", indexPrice: input.indexPrice, markPriceBtc: input.markPriceBtc, observationTimestamp: input.observationTimestamp,ruleVersion:STANDARD_MARGIN_RULE_ID,provenance:STANDARD_MARGIN_SOURCE,evidenceModel:"historical Standard Margin formula reconstruction" };
}

export interface MarginPointInput {timestamp:number;indexPrice?:number;shortMarkPriceBtc?:number;longMarkPriceBtc?:number}
/** Reconstructs an independently deployed SM vertical. The protective long has zero SM requirement and is not a max-loss shortcut. */
export function reconstructStandardVerticalMargin(input:{optionType:OptionType;amount:number;shortStrike:number;longStrike:number;expiryTimestamp:number;theoreticalMaximumSpreadLossBtc:number;points:readonly MarginPointInput[];entryTimestamp:number;terminalTimestamp:number;deployment?:DeploymentConfig}){
 const deployment=input.deployment??DEFAULT_DEPLOYMENT,terminal=Math.min(input.terminalTimestamp,input.expiryTimestamp),points=input.points.filter(p=>p.timestamp>=input.entryTimestamp&&p.timestamp<=terminal).sort((a,b)=>a.timestamp-b.timestamp);
 if(!points.length)return{status:"unavailable" as const,reason:"No canonical valuation points exist inside the actual holding window.",engineVersion:STANDARD_MARGIN_ENGINE_VERSION,ruleVersion:STANDARD_MARGIN_RULE_ID,deployment,path:[]};
 const path:{timestamp:number;initialMarginBtc:number;maintenanceMarginBtc:number;indexPrice:number;shortMarkPriceBtc:number;longMarkPriceBtc:number}[]=[];
 for(const p of points){if(p.longMarkPriceBtc===undefined)return{status:"unavailable" as const,reason:"A causal protective-long mark is required to establish the active vertical state.",engineVersion:STANDARD_MARGIN_ENGINE_VERSION,ruleVersion:STANDARD_MARGIN_RULE_ID,deployment,path:[]};const r=estimateStandardOptionMargin({side:"short",optionType:input.optionType,amount:input.amount,strike:input.shortStrike,indexPrice:p.indexPrice,markPriceBtc:p.shortMarkPriceBtc,observationTimestamp:p.timestamp,theoreticalMaximumSpreadLossBtc:input.theoreticalMaximumSpreadLossBtc,deployment});if(r.state!=="ok")return{status:"unavailable" as const,reason:r.unavailabilityReason??"Standard Margin reconstruction unavailable.",engineVersion:STANDARD_MARGIN_ENGINE_VERSION,ruleVersion:STANDARD_MARGIN_RULE_ID,deployment,path:[]};path.push({timestamp:p.timestamp,initialMarginBtc:r.initialMarginBtc!,maintenanceMarginBtc:r.maintenanceMarginBtc!,indexPrice:p.indexPrice!,shortMarkPriceBtc:p.shortMarkPriceBtc!,longMarkPriceBtc:p.longMarkPriceBtc});}
 let capitalDaysMarginBtc=0;for(let i=0;i<path.length;i++){const end=path[i+1]?.timestamp??terminal;capitalDaysMarginBtc+=path[i]!.initialMarginBtc*Math.max(0,end-path[i]!.timestamp)/86_400_000;}const peakInitial=path.reduce((a,b)=>b.initialMarginBtc>a.initialMarginBtc?b:a),peakMaintenance=path.reduce((a,b)=>b.maintenanceMarginBtc>a.maintenanceMarginBtc?b:a);
 return{status:"available" as const,engineVersion:STANDARD_MARGIN_ENGINE_VERSION,ruleVersion:STANDARD_MARGIN_RULE_ID,method:"historical Standard Margin reconstruction" as const,provenance:STANDARD_MARGIN_SOURCE,deployment,verticalTreatment:"protective long has zero SM requirement and supplies no short-leg offset" as const,integrationConvention:"piecewise-constant between canonical valuation points; final point held to terminal timestamp" as const,openingInitialMarginBtc:path[0]!.initialMarginBtc,openingMaintenanceMarginBtc:path[0]!.maintenanceMarginBtc,peakInitialMarginBtc:peakInitial.initialMarginBtc,peakMaintenanceMarginBtc:peakMaintenance.maintenanceMarginBtc,peakInitialTimestamp:peakInitial.timestamp,peakMaintenanceTimestamp:peakMaintenance.timestamp,capitalDaysMarginBtc,path};
}

export function portfolioMarginResult(input: { deployment: DeploymentConfig; theoreticalMaximumSpreadLossBtc: number; response: { margin_model: string; initial_margin: number; maintenance_margin: number; margin_balance?: number; available_funds?: number }; accountState: unknown; simulationTimestamp: number }): MarginResult {
  if (input.deployment.model !== "segregated_pm" && input.deployment.model !== "cross_pm") throw new Error("Portfolio simulation requires a PM deployment model");
  const balance = input.response.margin_balance;
  return { deployment: { ...input.deployment, marginSource: "portfolio-simulation" }, theoreticalMaximumSpreadLossBtc: input.theoreticalMaximumSpreadLossBtc,
    initialMarginBtc: input.response.initial_margin, maintenanceMarginBtc: input.response.maintenance_margin,
    marginBalanceBtc: balance, availableBalanceBtc: input.response.available_funds,
    utilization: balance && balance > 0 ? input.response.initial_margin / balance : undefined,
    state: input.response.available_funds !== undefined && input.response.available_funds < 0 ? "insufficient-margin" : "ok", provenance:"current authenticated simulation; never historical evidence",
    activeMarginModel: input.response.margin_model, accountState: input.accountState, simulationTimestamp: input.simulationTimestamp };
}
