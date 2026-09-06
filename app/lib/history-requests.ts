import type { DesiredSpread } from "./backtester.ts";

export interface DteWindow { min:number; max:number }
export interface HistoryRequest { requestId:string; targetDte:number; minDte:number; maxDte:number; soldStrike:number; boughtStrike:number; optionType:"C"|"P" }

/** Neutral mapping shared by production and opt-in research retrievals. */
export function historyRequests(spreads:DesiredSpread[],windows:Record<number,DteWindow>):HistoryRequest[]{
 return spreads.map(spread=>({requestId:spread.id,targetDte:spread.targetDte,minDte:Math.min(windows[spread.targetDte]!.min,windows[spread.targetDte]!.max),maxDte:Math.max(windows[spread.targetDte]!.min,windows[spread.targetDte]!.max),soldStrike:spread.soldStrike,boughtStrike:spread.boughtStrike,optionType:spread.optionType}));
}
