import type {Candle} from "../../app/lib/backtester.ts";
import type {FuturesMarketSnapshot,ResearchSelectionEvent} from "../../app/lib/research-selections.ts";

export const HOUR=3_600_000;
/** Hour-aligned, exactly as Deribit's hourly perpetual bars are stamped. */
export const ENTRY=1_699_999_200_000;
export const VPOC_TRIGGER=ENTRY+6*HOUR;
/** The options research layer only treats the VPOC touch as actionable one candle later. */
export const VPOC_DECISION=VPOC_TRIGGER+HOUR;
export const BARS=11;

export const barOpen=(index:number)=>100+index;
export const barClose=(index:number)=>100+index+0.5;

export const perpetualBars=(count=BARS)=>Array.from({length:count},(_,index)=>({
 timestamp:ENTRY+index*HOUR,price:barClose(index),open:barOpen(index),high:barClose(index)+0.2,low:barOpen(index)-0.2,close:barClose(index),volume:10+index,
}));

export const fundingRows=(count=BARS)=>Array.from({length:count-1},(_,index)=>({timestamp:ENTRY+(index+1)*HOUR,rate:0.0001,rate8h:0.0008,indexPrice:barOpen(index+1)-0.5}));

/** Underlying hourly path that never trades through either invalidation level. */
export const underlyingPath=(count=BARS):Candle[]=>Array.from({length:count},(_,index)=>({
 openTime:ENTRY+index*HOUR,closeTime:ENTRY+(index+1)*HOUR-1,open:barOpen(index),high:barClose(index)+0.2,low:barOpen(index)-0.2,close:barClose(index),volume:1,
}));

export const instrumentMetadata=()=>({
 instrumentName:"BTC-PERPETUAL",kind:"future",settlementPeriod:"perpetual",futureType:"reversed",isActive:true,
 contractSizeUsd:10,tickSize:0.5,minTradeAmountUsd:10,makerCommission:0.00015,takerCommission:0.00035,
 priceIndex:"btc_usd",settlementCurrency:"BTC",source:"deribit-get_instrument",retrievedAtUtc:"2024-01-01T00:00:00.000Z",authoritative:true as const,
});

export function futuresMarket(direction:"long"|"short",overrides:Partial<FuturesMarketSnapshot>={}):FuturesMarketSnapshot{
 const reference=perpetualBars();
 return{
  instrument:"BTC-PERPETUAL",instrumentKind:"perpetual",source:"deribit",priceBasis:"traded_ohlc",
  retrievedAtUtc:"2024-01-01T00:00:00.000Z",retrievalVersion:"deribit-perpetual-retrieval-v1",
  instrumentMetadata:instrumentMetadata(),reference,
  referenceCoverage:{source:"deribit-get_tradingview_chart_data",apiStatus:"ok",resolutionMs:HOUR,requestedStart:ENTRY,requestedEnd:ENTRY+(BARS-1)*HOUR,expectedPoints:BARS,receivedPoints:BARS,missingPoints:0,missingTimestamps:[],status:"complete",forwardFilled:false},
  trades:[{tradeId:"perp-trade-1",timestamp:ENTRY+1_000,price:100.25,amountUsd:1_000,direction:direction==="long"?"buy":"sell",markPrice:100.2,indexPrice:100.1,source:"deribit-get_last_trades_by_instrument_and_time"}],
  funding:fundingRows(),
  fundingCoverage:{source:"deribit-get_funding_rate_history",host:"https://www.deribit.com/api/v2/public",intervalMs:HOUR,rateField:"interest_1h",requestedStart:ENTRY,requestedEnd:ENTRY+(BARS-1)*HOUR,expectedPoints:BARS-1,receivedPoints:BARS-1,missingPoints:0,missingTimestamps:[],status:"complete",assumedZeroWhenMissing:false},
  feeRate:0.00035,retrievalErrors:[],
  ...overrides,
 };
}

export function futuresEvent(direction:"long"|"short"="long",overrides:{eventId?:string;futuresMarket?:FuturesMarketSnapshot|undefined;vpocTimestamp?:number|null;invalidationPrice?:number|null;underlyingHourlyPath?:Candle[];maximumEconomicLossUsd?:number}={}):ResearchSelectionEvent{
 const eventId=overrides.eventId??"mr-1";
 return{
  eventId,
  sourceRun:{event:{direction,entryTimestamp:ENTRY,entryPrice:100,vpocTimestamp:overrides.vpocTimestamp===undefined?VPOC_TRIGGER:overrides.vpocTimestamp,invalidationPrice:overrides.invalidationPrice===undefined?(direction==="long"?80:120):overrides.invalidationPrice}},
  generationSnapshot:{
   generatedAtUtc:"2024-01-01T00:00:00.000Z",
   configuration:{modelAssumptions:{}},
   candidates:[],
   underlyingHourlyPath:overrides.underlyingHourlyPath??underlyingPath(),
   futuresMarket:"futuresMarket" in overrides?overrides.futuresMarket:futuresMarket(direction),
  },
  selectedStructures:[{candidateId:`${eventId}~structure`,marginSnapshot:{maximumEconomicLossUsd:overrides.maximumEconomicLossUsd??500}}],
 } as unknown as ResearchSelectionEvent;
}
