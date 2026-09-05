import {
  buildExpiryCandidates,
  generateShortStrikeResearchSpreads,
  valuationTimestamps,
  type BacktestEvent,
  type Candle,
  type ContractCandidateManifest,
  type ContractSeries,
  type ExecutionMode,
  type ExpirySelectionMode,
  type RetrievedSpread,
  type SpreadKind,
} from "../backtester.ts";
import { buildEstimatedPath, buildResearchOutcomes, evaluateResearchEntryLayers, type EstimatedOutcome, type EstimatedPathPoint, type ResearchEntryLayers, type ResearchValuation } from "../research-valuation.ts";

export interface DteWindow { min:number; max:number }
export interface HistoryRequest { requestId:string; targetDte:number; minDte:number; maxDte:number; soldStrike:number; boughtStrike:number; optionType:"C"|"P" }

export function historyRequests(spreads:ReturnType<typeof generateShortStrikeResearchSpreads>,windows:Record<number,DteWindow>):HistoryRequest[]{
 return spreads.map(spread=>({requestId:spread.id,targetDte:spread.targetDte,minDte:Math.min(windows[spread.targetDte]!.min,windows[spread.targetDte]!.max),maxDte:Math.max(windows[spread.targetDte]!.min,windows[spread.targetDte]!.max),soldStrike:spread.soldStrike,boughtStrike:spread.boughtStrike,optionType:spread.optionType}));
}

export interface ShortStrikeReferenceMaterialization {
 spread:RetrievedSpread;
 researchLayers:ResearchEntryLayers;
 researchEntry:ResearchValuation;
 researchPath:EstimatedPathPoint[];
 researchOutcomes:EstimatedOutcome[];
 eventQuality:"green"|"yellow"|"red";
}
export function controlledResearchRole(spread:Pick<RetrievedSpread,"buffered">):"short_strike_technical"|"short_strike_buffered"{
 return spread.buffered?"short_strike_buffered":"short_strike_technical";
}

/** Reference-only seam. It never constructs production observations or execution scenarios. */
export function materializeShortStrikeReference(input:{event:BacktestEvent;dtes:number[];widths:number[];spreadKind:SpreadKind;manifests:ContractCandidateManifest[];inventory:ContractSeries[];entryTimestamp:number;candles:Candle[];amount:number;executionMode:ExecutionMode;expirySelectionMode:ExpirySelectionMode;pricingAssumption:"research-estimate"|"conservative-tape-check"}):ShortStrikeReferenceMaterialization[]{
 const desired=generateShortStrikeResearchSpreads(input.event,input.dtes,input.widths,input.spreadKind);
 const candidates=buildExpiryCandidates(desired,input.manifests,input.entryTimestamp,input.event.entryPrice,input.inventory,input.executionMode,input.expirySelectionMode,input.pricingAssumption);
 return candidates.map(spread=>{
  const researchLayers=evaluateResearchEntryLayers({spread,targetTimestamp:input.entryTimestamp,targetIndex:input.event.entryPrice,amount:input.amount,slippageBps:0,executionRoute:"synchronized-leg-proxy"});
  const researchEntry=researchLayers.model.entry;
  const grid=spread.expiryTimestamp===undefined?[input.entryTimestamp]:valuationTimestamps(input.entryTimestamp,spread.expiryTimestamp,[input.event.vpocTimestamp??0]);
  const researchPath=researchEntry.status==="priced"?buildEstimatedPath({spread,timestamps:grid,candles:input.candles,entry:researchEntry,slippageBps:0,executionRoute:"synchronized-leg-proxy"}):[];
  const researchOutcomes=researchEntry.status==="priced"?buildResearchOutcomes({event:input.event,spread,entry:researchEntry,path:researchPath,candles:input.candles}):[];
  return{spread,researchLayers,researchEntry,researchPath,researchOutcomes,eventQuality:researchEntry.status==="priced"?researchEntry.estimateQuality:"red"};
 });
}
