import { aggregateRoutedFees, calculateOptionFee, STANDARD_INVERSE_BTC_OPTION_FEE, type ExecutionRoute } from "./accounting.ts";
import type { BacktestEvent, Candle, ContractSeries, ContractTrade, QualityFlag, RetrievedSpread } from "./backtester.ts";

export const RESEARCH_METHODOLOGY_VERSION = "bounded-historical-valuation/1.0.0";
export const RESEARCH_ESTIMATE_DISCLAIMER = "Bounded historical estimate from public trade prints; not an actual or confirmed fill and not proof that the requested size could execute.";
export const RESEARCH_WINDOWS_MINUTES = [30, 60, 120] as const;
export type PricingAssumption = "research-estimate" | "conservative-tape-check";
export type EstimateQuality = QualityFlag | "unavailable";
export type ResearchPriceSource = "direct-vwap" | "iv-normalized";

export interface ResearchLegEstimate {
  instrumentName: string; economicSide: "sold" | "bought"; priceBtcPerContract: number;
  unslippedPriceBtcPerContract: number; source: ResearchPriceSource; supportingTrades: ContractTrade[];
  supportingTimestamps: number[]; observedAmount: number; nearestGapMinutes: number;
}
export interface ResearchEstimate {
  valuationMode: "research-estimate"; targetTimestamp: number; valuationTimestamp: number;
  status: "priced"; sold: ResearchLegEstimate; bought: ResearchLegEstimate;
  grossSpreadBtcPerContract: number; grossSpreadBtc: number; openingFeesBtc: number;
  netOpeningCashFlowBtc: number; amount: number; evidenceWindowMinutes: 30 | 60 | 120 | 720;
  synchronizationGapMinutes: number; priceSource: ResearchPriceSource; estimateQuality: QualityFlag;
  qualityReason: string; slippageBps: number; observedAmount: number; observedAmountToRequestedRatio: number;
  liquidityWarning?: string; amountStepWarning?: string; disclaimer: string;
}
export interface UnavailableResearchEstimate { valuationMode: "research-estimate"; targetTimestamp: number; status: "unavailable"; estimateQuality: "unavailable"; reason: string; disclaimer: string }
export type ResearchValuation = ResearchEstimate | UnavailableResearchEstimate;
export interface EstimatedPathPoint { timestamp: number; status: "priced" | "missing"; rawEstimate?: ResearchEstimate; ivNormalizedEstimate?: ResearchEstimate; estimatedNetPnlBtc?: number; estimateQuality: EstimateQuality }
export interface EstimatedOutcome { label: string; trigger: string; decisionTimestamp?: number; valuationTimestamp?: number; estimate?: ResearchEstimate; rawEstimate?: number; ivNormalizedEstimate?: number; feesBtc?: number; estimatedNetPnl?: number; estimateQuality: EstimateQuality; status: "estimated" | "not-hit" | "unavailable" }

function weighted(rows: ContractTrade[], pick: (row: ContractTrade) => number) {
  const amount = rows.reduce((sum, row) => sum + row.amount, 0);
  return amount > 0 ? rows.reduce((sum, row) => sum + pick(row) * row.amount, 0) / amount : undefined;
}
function cdf(x: number) { const t=1/(1+.2316419*Math.abs(x)); const d=.3989423*Math.exp(-x*x/2); const p=1-d*t*(.31938153+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429)))); return x>=0?p:1-p; }
function optionPrice(series: ContractSeries, timestamp: number, spot: number, iv: number) {
  if (!(spot>0) || !(iv>0)) return undefined; const t=Math.max(series.expiryTimestamp-timestamp,0)/(365*86_400_000);
  if (!t) return series.optionType === "C" ? Math.max(spot-series.strike,0)/spot : Math.max(series.strike-spot,0)/spot;
  const sigma=iv>3?iv/100:iv, root=Math.sqrt(t), d1=(Math.log(spot/series.strike)+sigma*sigma*t/2)/(sigma*root), d2=d1-sigma*root;
  return series.optionType === "C" ? cdf(d1)-(series.strike/spot)*cdf(d2) : (series.strike/spot)*cdf(-d2)-cdf(-d1);
}
function directLeg(series: ContractSeries, target: number, minutes: number, side: "sold"|"bought", slippageBps: number): ResearchLegEstimate|undefined {
  const radius=minutes*60_000, rows=series.trades.filter(t=>Math.abs(t.timestamp-target)<=radius && t.amount>0 && t.price>=0);
  const raw=weighted(rows,r=>r.price); if(raw===undefined)return undefined; const factor=side==="sold"?1-slippageBps/10_000:1+slippageBps/10_000;
  const nearest=Math.min(...rows.map(r=>Math.abs(r.timestamp-target)/60_000));
  return {instrumentName:series.instrumentName,economicSide:side,priceBtcPerContract:raw*factor,unslippedPriceBtcPerContract:raw,source:"direct-vwap",supportingTrades:rows,supportingTimestamps:rows.map(r=>r.timestamp),observedAmount:rows.reduce((s,r)=>s+r.amount,0),nearestGapMinutes:nearest};
}
function ivLeg(series: ContractSeries,target:number,targetIndex:number,side:"sold"|"bought",slippageBps:number):ResearchLegEstimate|undefined {
  const rows=series.trades.filter(t=>Math.abs(t.timestamp-target)<=720*60_000 && t.amount>0 && t.iv!==undefined && t.iv>0 && t.indexPrice>0).sort((a,b)=>Math.abs(a.timestamp-target)-Math.abs(b.timestamp-target));
  const anchor=rows[0]; if(!anchor)return undefined; const raw=optionPrice(series,target,targetIndex,anchor.iv!); if(raw===undefined)return undefined;
  const factor=side==="sold"?1-slippageBps/10_000:1+slippageBps/10_000;
  return {instrumentName:series.instrumentName,economicSide:side,priceBtcPerContract:raw*factor,unslippedPriceBtcPerContract:raw,source:"iv-normalized",supportingTrades:[anchor],supportingTimestamps:[anchor.timestamp],observedAmount:anchor.amount,nearestGapMinutes:Math.abs(anchor.timestamp-target)/60_000};
}
function unavailable(targetTimestamp:number,reason:string):UnavailableResearchEstimate{return{valuationMode:"research-estimate",targetTimestamp,status:"unavailable",estimateQuality:"unavailable",reason,disclaimer:RESEARCH_ESTIMATE_DISCLAIMER};}

/** Prices both exact resolved legs in the smallest common centered evidence window. */
export function estimateResearchSpread(input:{spread:RetrievedSpread;targetTimestamp:number;targetIndex:number;amount?:number;slippageBps:number;executionRoute?:ExecutionRoute}):ResearchValuation {
  const {spread,targetTimestamp,targetIndex,slippageBps}=input, amount=input.amount??1;
  if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(slippageBps)||slippageBps<0)return unavailable(targetTimestamp,"Essential numerical inputs are invalid.");
  if(spread.dataStatus==="data-unavailable"||spread.retrievalStatus==="partial")return unavailable(targetTimestamp,"Contract retrieval is incomplete.");
  if(!spread.soldContract||!spread.boughtContract||spread.retrievalStatus!=="ready")return unavailable(targetTimestamp,"Both exact contracts must be resolved.");
  let sold:ResearchLegEstimate|undefined,bought:ResearchLegEstimate|undefined,window:30|60|120|720=30;
  for(const candidate of RESEARCH_WINDOWS_MINUTES){sold=directLeg(spread.soldContract,targetTimestamp,candidate,"sold",slippageBps);bought=directLeg(spread.boughtContract,targetTimestamp,candidate,"bought",slippageBps);if(sold&&bought){window=candidate;break;}}
  if(!sold||!bought){window=720;sold=ivLeg(spread.soldContract,targetTimestamp,targetIndex,"sold",slippageBps);bought=ivLeg(spread.boughtContract,targetTimestamp,targetIndex,"bought",slippageBps);}
  if(!sold||!bought)return unavailable(targetTimestamp,"Either leg lacks bounded direct evidence or required IV/index evidence within ±12 hours.");
  const source:ResearchPriceSource=sold.source==="direct-vwap"&&bought.source==="direct-vwap"?"direct-vwap":"iv-normalized";
  const soldTime=sold.supportingTrades.reduce((best,t)=>Math.abs(t.timestamp-targetTimestamp)<Math.abs(best.timestamp-targetTimestamp)?t:best).timestamp;
  const boughtTime=bought.supportingTrades.reduce((best,t)=>Math.abs(t.timestamp-targetTimestamp)<Math.abs(best.timestamp-targetTimestamp)?t:best).timestamp;
  const sync=Math.abs(soldTime-boughtTime)/60_000, maxGap=Math.max(sold.nearestGapMinutes,bought.nearestGapMinutes);
  let quality:QualityFlag,reason:string;
  if(source==="direct-vwap"&&window===30&&sync<=30){quality="green";reason="Both legs use direct trades within ±30 minutes and are synchronized within 30 minutes.";}
  else if((source==="direct-vwap"&&window<=120&&sync<=120)||(source==="iv-normalized"&&maxGap<=120)){quality="yellow";reason=source==="direct-vwap"?"Both legs use bounded direct trades within ±2 hours.":"IV normalization is anchored to observed IV/index evidence within two hours.";}
  else {quality="red";reason=source==="iv-normalized"?"IV evidence is more than two but no more than twelve hours from the target.":"Direct evidence is bounded but leg synchronization is weak.";}
  const route=input.executionRoute??"synchronized-leg-proxy", fees=aggregateRoutedFees([{side:"sell",fee:calculateOptionFee(sold.priceBtcPerContract,amount,"taker",STANDARD_INVERSE_BTC_OPTION_FEE)},{side:"buy",fee:calculateOptionFee(bought.priceBtcPerContract,amount,"taker",STANDARD_INVERSE_BTC_OPTION_FEE)}],route).finalFee;
  const per=sold.priceBtcPerContract-bought.priceBtcPerContract,gross=per*amount,observed=Math.min(sold.observedAmount,bought.observedAmount);
  return {valuationMode:"research-estimate",targetTimestamp,valuationTimestamp:targetTimestamp,status:"priced",sold,bought,grossSpreadBtcPerContract:per,grossSpreadBtc:gross,openingFeesBtc:fees,netOpeningCashFlowBtc:gross-fees,amount,evidenceWindowMinutes:window,synchronizationGapMinutes:sync,priceSource:source,estimateQuality:quality,qualityReason:reason,slippageBps,observedAmount:observed,observedAmountToRequestedRatio:observed/amount,liquidityWarning:observed<amount?"Historical tape does not prove execution of this size.":undefined,amountStepWarning:(!spread.soldContract.amountMetadata||!spread.boughtContract.amountMetadata)?"Exchange increment validation was unavailable; this research scenario is not claimed to be exchange-valid.":undefined,disclaimer:RESEARCH_ESTIMATE_DISCLAIMER};
}

export function buildEstimatedPath(input:{spread:RetrievedSpread;timestamps:number[];indexAt:(timestamp:number)=>number|undefined;entry:ResearchEstimate;slippageBps:number;executionRoute?:ExecutionRoute}):EstimatedPathPoint[]{
 return input.timestamps.map(timestamp=>{const index=input.indexAt(timestamp);if(index===undefined)return{timestamp,status:"missing",estimateQuality:"unavailable"};const mark=estimateResearchSpread({spread:input.spread,targetTimestamp:timestamp,targetIndex:index,amount:input.entry.amount,slippageBps:input.slippageBps,executionRoute:input.executionRoute});if(mark.status==="unavailable")return{timestamp,status:"missing",estimateQuality:"unavailable"};const closingGross=(mark.bought.priceBtcPerContract-mark.sold.priceBtcPerContract)*mark.amount;const pnl=input.entry.netOpeningCashFlowBtc+closingGross-mark.openingFeesBtc;return{timestamp,status:"priced",rawEstimate:mark.priceSource==="direct-vwap"?mark:undefined,ivNormalizedEstimate:mark.priceSource==="iv-normalized"?mark:undefined,estimatedNetPnlBtc:pnl,estimateQuality:mark.estimateQuality};});
}

export function completedCandleTrigger(candles:Candle[],after:number,predicate:(candle:Candle)=>boolean){return [...candles].sort((a,b)=>a.closeTime-b.closeTime).find(c=>c.closeTime>after&&predicate(c));}

export function buildResearchExport(input:{event:BacktestEvent;spread:RetrievedSpread;entry:ResearchValuation;path?:EstimatedPathPoint[];outcomes?:EstimatedOutcome[]}){
 return {methodology:{version:RESEARCH_METHODOLOGY_VERSION,objective:"Estimate how a realistically similar spread could have been priced and evolved from imperfect historical Deribit trade data.",hierarchy:["direct amount-weighted VWAP in ±30 minutes","direct amount-weighted VWAP in ±1 hour","direct amount-weighted VWAP in ±2 hours","IV-normalized price anchored to a valid observed trade and its IV/index evidence within ±12 hours"],missingPointPolicy:"gap; never forward-filled"},mode:"research-estimate" as const,eventId:input.event.id,contracts:{sold:input.spread.soldContract?.instrumentName,bought:input.spread.boughtContract?.instrumentName,soldStrike:input.spread.soldContract?.strike,boughtStrike:input.spread.boughtContract?.strike,expiryTimestamp:input.spread.expiryTimestamp},windowsUsed:input.entry.status==="priced"?[input.entry.evidenceWindowMinutes]:[],priceSource:input.entry.status==="priced"?input.entry.priceSource:"unavailable",supportingTimestamps:input.entry.status==="priced"?{sold:input.entry.sold.supportingTimestamps,bought:input.entry.bought.supportingTimestamps}:{},quality:input.entry.estimateQuality,slippageAssumptionBps:input.entry.status==="priced"?input.entry.slippageBps:undefined,estimateDisclaimer:RESEARCH_ESTIMATE_DISCLAIMER,estimatedEntry:input.entry,estimatedPath:input.path??[],estimatedOutcomes:input.outcomes??[]};
}
