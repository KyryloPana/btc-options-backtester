export function formatUsdValue(x:number|null,signed=false,unavailable="Unavailable"){
 if(x===null)return unavailable;
 const decimals=Math.abs(x)<10?2:0,rounded=Number(Math.abs(x).toFixed(decimals));
 if(rounded===0)return decimals?"$0.00":"$0";
 return `${x<0?"−":signed?"+":""}$${rounded.toLocaleString(undefined,{minimumFractionDigits:decimals,maximumFractionDigits:decimals})}`;
}
