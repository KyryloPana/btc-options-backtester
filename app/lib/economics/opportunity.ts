import type {AnalysisDataset} from "../research-analysis.ts";
import type {PositionEconomics} from "./position.ts";
export type EconomicOpportunityStatus="trade"|"explicit_no_trade"|"unavailable";
export type FinalEconomicOpportunityStatus="priced_trade"|"explicit_no_trade"|"unavailable";
export interface ConfigurationOpportunity {eventId:string;structuralConfigurationId:string|null;structuralConfiguration:Readonly<Record<string,unknown>>|null;status:FinalEconomicOpportunityStatus;generationStatus:EconomicOpportunityStatus;candidateId:string|null;pnlBtc:number|null;reasonCode:string|null;reason:string|null}
type Row=Readonly<Record<string,unknown>>;
const rec=(x:unknown):Row=>x&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};
const str=(x:unknown)=>typeof x==="string"&&x?x:null;
export const EXPLICIT_NO_TRADE_CODES=new Set(["empirical_nonpositive_credit_after_fees"]);
export function classifyEconomicOpportunity(value:unknown):{status:EconomicOpportunityStatus;reasonCode:string|null;reason:string|null}{const x=rec(value),code=str(x.reason_code)??str(x.reasonCode),declared=str(x.status),reason=str(x.reason);if(declared==="trade")return{status:"trade",reasonCode:code,reason};if(declared==="explicit_no_trade"||EXPLICIT_NO_TRADE_CODES.has(code??""))return{status:"explicit_no_trade",reasonCode:code,reason};return{status:"unavailable",reasonCode:code??"economic_opportunity_unavailable",reason};}
/** Generation state is authoritative; policy economics join by event × structural configuration. */
export function projectConfigurationOpportunities(dataset:AnalysisDataset,positions:readonly PositionEconomics[]):readonly ConfigurationOpportunity[]{
 const grouped=new Map<string,PositionEconomics[]>();for(const position of positions){if(!position.structuralConfigurationId)continue;const key=`${position.eventId}|${position.structuralConfigurationId}`,rows=grouped.get(key)??[];rows.push(position);grouped.set(key,rows)}
 return(dataset.tables.configuration_opportunities??dataset.tables.availability??[]).map(row=>{const eventId=str(row.event_id)??"",structuralConfigurationId=str(row.structural_configuration_id),candidateId=str(row.candidate_id),matches=structuralConfigurationId?grouped.get(`${eventId}|${structuralConfigurationId}`)??[]:[],position=matches.length===1?matches[0]:undefined,declared=classifyEconomicOpportunity(row.economic_opportunity),pricedEntry=matches.some(p=>p.status!=="not_evaluated"&&[p.grossOpeningCreditBtc,p.netOpeningCashFlowBtc].some(value=>value!==null&&Number.isFinite(value))),contradiction=declared.status!=="trade"&&pricedEntry;
  const common={eventId,structuralConfigurationId,structuralConfiguration:row.structural_configuration&&typeof row.structural_configuration==="object"?row.structural_configuration as Row:null,candidateId};
  if(contradiction)return{...common,status:"unavailable",generationStatus:declared.status,pnlBtc:null,reasonCode:declared.status==="explicit_no_trade"?"explicit_no_trade_conflicts_with_priced_position":"unavailable_q50_opportunity_conflicts_with_priced_position",reason:`Canonical Q50 ${declared.status} conflicts with a priced modeled-expected entry.`};
  if(declared.status==="explicit_no_trade")return{...common,status:"explicit_no_trade",generationStatus:declared.status,pnlBtc:0,reasonCode:declared.reasonCode,reason:declared.reason};
  const priced=declared.status==="trade"&&matches.length===1&&position?.status==="priced"&&position.pnlBtc!==null&&Number.isFinite(position.pnlBtc),reasonCode=declared.status!=="trade"?declared.reasonCode:matches.length!==1?matches.length?"conflicting_selected_policy_positions":"selected_policy_position_missing":"selected_policy_pnl_unavailable";
  return{...common,status:priced?"priced_trade":"unavailable",generationStatus:declared.status,pnlBtc:priced?position!.pnlBtc:null,reasonCode:priced?null:reasonCode,reason:priced?null:declared.status!=="trade"?declared.reason:matches.length!==1?`Expected exactly one selected-policy event × configuration position; found ${matches.length}.`:position?.missingReason??"The intended Q50 trade has no priced selected-policy endpoint PnL."};
 });
}
