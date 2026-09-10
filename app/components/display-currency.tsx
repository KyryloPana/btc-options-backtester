"use client";
import {createContext,useContext,type ReactNode} from "react";
import {formatDisplayMoney,selectDisplayMoney,type DisplayCurrency} from "./monetary-format";

export type {DisplayCurrency} from "./monetary-format";
const DisplayCurrencyContext=createContext<DisplayCurrency>("usd");
export const DisplayCurrencyProvider=({value,children}:{value:DisplayCurrency;children:ReactNode})=><DisplayCurrencyContext.Provider value={value}>{children}</DisplayCurrencyContext.Provider>;
export const useDisplayCurrency=()=>useContext(DisplayCurrencyContext);
export function MonetaryValue({btc=null,usd=null,unavailableReason="Requested currency unavailable from canonical evidence.",allowFallback=true}:{btc?:number|null;usd?:number|null;unavailableReason?:string;allowFallback?:boolean}){const preferred=useDisplayCurrency(),selected=selectDisplayMoney(preferred,{btc,usd});if(!selected||selected.fallback&&!allowFallback)return <span className="metric-unavailable" title={unavailableReason}>Unavailable</span>;return <span className={selected.fallback?"currency-fallback":undefined} title={selected.fallback?unavailableReason:undefined}>{formatDisplayMoney(selected.value,selected.currency)}{selected.fallback&&<small> · {preferred.toUpperCase()} unavailable</small>}</span>}
export function NativeCurrencyNotice({currency,reason}:{currency:DisplayCurrency;reason:string}){const preferred=useDisplayCurrency();return preferred===currency?null:<p className="dd-note currency-native-notice">Values in this report remain {currency.toUpperCase()}-native where no canonical {preferred.toUpperCase()} counterpart exists. {reason}</p>}
