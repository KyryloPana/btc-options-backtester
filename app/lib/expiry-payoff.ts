import { calculateDeliveryFee } from "./accounting.ts";
import type { OptionType } from "./backtester.ts";

export type PayoffCurrency = "usd-cash-flow" | "btc-settlement";
export type CreditSpreadKind = "bear-call-credit" | "bull-put-credit";

export class InvalidCreditSpreadError extends Error {
  readonly code = "INVALID_CREDIT_SPREAD";
  constructor(message: string) { super(message); this.name = "InvalidCreditSpreadError"; }
}

export interface ExpiryPayoffInput {
  optionType: OptionType; shortStrike: number; longStrike: number;
  shortEntryPremiumBtc: number; longEntryPremiumBtc: number;
  entryIndex: number; amount: number; openingFeesBtc: number;
  expiryTimestamp: number; dailyOption?: boolean;
}

export interface ExpiryPayoffPoint {
  expirationIndex: number; currency: PayoffCurrency; pnl: number;
  grossEntryCreditBtc: number; netEntryCashFlowBtc: number;
  grossPositionValueBtc: number; settlementFeesBtc: number; netPositionValueBtc: number;
}

export function creditSpreadKind(input: Pick<ExpiryPayoffInput,"optionType"|"shortStrike"|"longStrike">): CreditSpreadKind {
  if (input.shortStrike <= 0 || input.longStrike <= 0 || input.shortStrike === input.longStrike)
    throw new InvalidCreditSpreadError("Credit-spread strikes must be positive and distinct.");
  if (input.optionType === "C" && input.shortStrike < input.longStrike) return "bear-call-credit";
  if (input.optionType === "P" && input.shortStrike > input.longStrike) return "bull-put-credit";
  throw new InvalidCreditSpreadError(input.optionType === "C" ? "A bear call credit requires the short strike below the long strike." : "A bull put credit requires the short strike above the long strike.");
}

export function intrinsicBtc(optionType: OptionType, strike: number, index: number) {
  if (!Number.isFinite(index) || index <= 0) throw new RangeError("Expiration index must be greater than zero.");
  return optionType === "C" ? Math.max(index-strike,0)/index : Math.max(strike-index,0)/index;
}

export function expiryPayoff(input: ExpiryPayoffInput, expirationIndex: number, currency: PayoffCurrency): ExpiryPayoffPoint {
  creditSpreadKind(input);
  if (![input.shortEntryPremiumBtc,input.longEntryPremiumBtc,input.entryIndex,input.amount,input.openingFeesBtc].every(Number.isFinite) || input.entryIndex<=0 || input.amount<=0 || input.openingFeesBtc<0)
    throw new RangeError("Premiums, entry index, amount, and opening fees must be valid.");
  const amount=Math.abs(input.amount), shortIntrinsic=intrinsicBtc(input.optionType,input.shortStrike,expirationIndex), longIntrinsic=intrinsicBtc(input.optionType,input.longStrike,expirationIndex);
  const grossEntryCreditBtc=(input.shortEntryPremiumBtc-input.longEntryPremiumBtc)*amount;
  const netEntryCashFlowBtc=grossEntryCreditBtc-input.openingFeesBtc;
  const grossPositionValueBtc=(longIntrinsic-shortIntrinsic)*amount;
  const settlementFeesBtc=calculateDeliveryFee(shortIntrinsic,amount,input.dailyOption??false).finalFeeBtc+calculateDeliveryFee(longIntrinsic,amount,input.dailyOption??false).finalFeeBtc;
  const netPositionValueBtc=grossPositionValueBtc-settlementFeesBtc;
  const pnl=currency==="btc-settlement"?netEntryCashFlowBtc+netPositionValueBtc:netEntryCashFlowBtc*input.entryIndex+netPositionValueBtc*expirationIndex;
  return {expirationIndex,currency,pnl,grossEntryCreditBtc,netEntryCashFlowBtc,grossPositionValueBtc,settlementFeesBtc,netPositionValueBtc};
}

export function breakEven(input: ExpiryPayoffInput,currency:PayoffCurrency){
  const low=Math.max(.01,Math.min(input.shortStrike,input.longStrike)*.01), high=Math.max(input.shortStrike,input.longStrike,input.entryIndex)*4;
  const samples=4000; let a=low,fa=expiryPayoff(input,a,currency).pnl;
  for(let i=1;i<=samples;i++){const b=low+(high-low)*i/samples,fb=expiryPayoff(input,b,currency).pnl;if(fa===0)return{index:a,method:"numerical bisection over canonical net payoff" as const};if(fa*fb<0){let left=a,right=b,leftValue=fa;for(let n=0;n<80;n++){const mid=(left+right)/2,value=expiryPayoff(input,mid,currency).pnl;if(Math.abs(value)<1e-10){left=right=mid;break}if(leftValue*value<=0)right=mid;else{left=mid;leftValue=value}}return{index:(left+right)/2,method:"numerical bisection over canonical net payoff" as const};}a=b;fa=fb;}return undefined;
}

export function payoffExtrema(input:ExpiryPayoffInput,currency:PayoffCurrency){
  const kind=creditSpreadKind(input), epsilon=Math.min(input.shortStrike,input.longStrike)*1e-9;
  const indices=kind==="bear-call-credit"?[epsilon,input.shortStrike,input.longStrike,Number.MAX_SAFE_INTEGER]:[epsilon,input.longStrike,input.shortStrike,Number.MAX_SAFE_INTEGER];
  const values=indices.map(index=>expiryPayoff(input,index,currency).pnl);
  return {maximumProfit:Math.max(...values),maximumLoss:Math.min(...values)};
}
