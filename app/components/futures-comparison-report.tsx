"use client";
import type {FuturesComparisonReport} from "../lib/futures-comparison/report";

const UNAVAILABLE="Unavailable";
const usd=(x:number|null)=>x===null?UNAVAILABLE:`$${x.toLocaleString("en-US",{maximumFractionDigits:2})}`;
const qty=(x:number|null)=>x===null?UNAVAILABLE:x.toFixed(4);
const time=(x:string|null)=>x??UNAVAILABLE;
const days=(x:number|null)=>x===null?UNAVAILABLE:`${x.toFixed(1)}d`;
const hours=(x:number|null)=>x===null?UNAVAILABLE:`${x.toFixed(1)}h`;

/**
 * Read-only. Every figure is consumed from the exported canonical futures
 * tables; nothing here re-runs the perpetual engine or contacts an exchange.
 */
export function FuturesComparisonReportView({report}:{report:FuturesComparisonReport}){
 const s=report.summary;
 return <section className="workspace-section" data-testid="futures-comparison-report" aria-labelledby="futures-comparison-title">
  <div className="section-heading"><div><p className="eyebrow">Canonical BTC-PERPETUAL baseline · read-only</p><h2 id="futures-comparison-title">Options vs BTC Perpetual</h2></div><em className={`report-state ${report.availability}`}>{report.availability}</em></div>
  <p className="resolution-banner">For the same MR event, under identical causal event timing. {report.unavailableReason??"Every futures figure is read from the exported canonical futures tables; no exchange request is made and the perpetual engine is not re-run here."}</p>

  <h3>Event-level futures population</h3>
  <div className="count-grid" data-testid="futures-event-denominator">
   <span><b>{s.eventsWithBaseline}</b>Events with a valid BTC-PERP baseline</span>
   <span><b>{s.eventsTotal}</b>MR events in the dataset</span>
   <span><b>{s.eventsWithVpocEndpoint}</b>VPOC comparable endpoint</span>
   <span><b>{s.eventsWithInvalidationEndpoint}</b>Invalidation comparable endpoint</span>
   <span><b>{s.eventsWithFixed3d}</b>Fixed 3D</span>
   <span><b>{s.eventsWithFixed5d}</b>Fixed 5D</span>
   <span><b>{s.eventsWithFixed7d}</b>Fixed 7D</span>
   <span><b>{s.eventsWithCompleteFunding}</b>Complete funding</span>
   <span><b>{s.eventsWithPartialOrMissingFunding}</b>Partial or missing funding</span>
   <span><b>{usd(s.medianFuturesNetPnlUsdPerUnit)}</b>Median per-unit net futures PnL</span>
   <span><b>{usd(s.medianRiskToInvalidationUsdPerUnit)}</b>Median per-unit risk to invalidation</span>
  </div>

  <h3>Structure-level options population</h3>
  <div className="count-grid" data-testid="futures-structure-denominator">
   <span><b>{s.optionConfigurations}</b>Option configurations</span>
   <span><b>{s.pairedComparableN}</b>Directly comparable endpoint pairs</span>
   <span><b>{s.benchmarkOnlyN}</b>Benchmark-only (no futures analogue)</span>
   <span><b>{s.equalRiskComparableN}</b>Equal-risk comparable pairs</span>
   <span><b>{usd(s.medianPairedDifferenceUsd)}</b>Median paired Options − Futures</span>
  </div>
  <small className="dd-note">These are two different denominators and are never mixed. One perpetual observation exists per MR event, however many option structures were selected for it; a futures median computed over structure rows would reweight the futures population by option selection density. The paired difference uses matched event and endpoint observations only — unmatched aggregate means are never differenced and called an options advantage. No strategy is recommended.</small>

  {report.events.map(({baseline,options})=><div key={baseline.eventId} className="dd-event-block">
   <h3>{baseline.eventId} · {baseline.instrument??UNAVAILABLE} · {baseline.direction??UNAVAILABLE}</h3>
   {baseline.unavailableReason&&<p className="preflight-warning">{baseline.unavailableReason}</p>}
   <div className="table-wrap"><table>
    <thead><tr><th>Causal entry</th><th>Entry price</th><th>Selected endpoint</th><th>Endpoint time / price</th><th>Holding</th><th>Gross / unit</th><th>Fees + slippage / unit</th><th>Funding / unit</th><th>Funding status</th><th>Net / unit</th><th>Risk to invalidation / unit</th></tr></thead>
    <tbody><tr>
     <td>{time(baseline.referenceEntryTimestampUtc)}<br/><small>{baseline.referenceEntryBasis??""}</small></td>
     <td>{usd(baseline.referenceEntryPrice)}</td>
     <td>{baseline.selectedExitPolicy??UNAVAILABLE}<br/><small>{baseline.exitStatus??""}</small></td>
     <td>{time(baseline.exitTimestampUtc)}<br/>{usd(baseline.exitPrice)}</td>
     <td>{hours(baseline.holdingHours)}</td>
     <td>{usd(baseline.grossPnlUsdPerUnit)}</td>
     <td>{usd(baseline.feesUsdPerUnit)} + {usd(baseline.slippageUsdPerUnit)}</td>
     <td className={baseline.fundingUsdPerUnit===null?"dd-muted":undefined}>{usd(baseline.fundingUsdPerUnit)}</td>
     <td className={baseline.fundingStatus==="available"?undefined:"dd-muted"} title={baseline.fundingSource??undefined}>{baseline.fundingStatus??UNAVAILABLE}<br/><small>{baseline.fundingIntervalsObserved??0} / {baseline.fundingIntervalsExpected??0} intervals</small></td>
     <td>{usd(baseline.netPnlUsdPerUnitAfterFunding)}</td>
     <td>{usd(baseline.riskToInvalidationUsdPerUnit)}</td>
    </tr></tbody>
   </table></div>
   <small className="dd-note">{baseline.unitConvention??"Per-unit economics."} Missing funding stays explicit and is never treated as zero, and spot or index prices are never substituted for missing perpetual data. This event keeps its other canonical endpoints even where one is unavailable.</small>

   <div className="table-wrap"><table>
    <thead><tr><th>Endpoint</th><th>Outcome</th><th>Status</th><th>Decision</th><th>Observation</th><th>Price</th><th>Reason</th></tr></thead>
    <tbody>{baseline.endpoints.map(e=><tr key={e.policy}>
     <td>{e.policy}</td><td>{e.outcome??UNAVAILABLE}</td>
     <td className={e.status==="available"?undefined:"dd-muted"}>{e.status??UNAVAILABLE}</td>
     <td>{time(e.decisionTimestampUtc)}</td><td>{time(e.observationTimestampUtc)}</td>
     <td>{usd(e.observationPrice)}</td><td className="dd-muted">{e.reasonCode??"—"}</td>
    </tr>)}</tbody>
   </table></div>

   <div className="table-wrap"><table>
    <thead><tr><th>Candidate</th><th>Actual DTE</th><th>Strikes / width</th><th>Endpoint</th><th>Comparability</th><th>Reference option PnL</th><th>Max structural loss</th><th>Opening IM</th><th>Peak IM</th><th>Risk budget</th><th>Equal-risk futures qty</th><th>Equal-risk futures PnL</th><th>Options − Futures</th></tr></thead>
    <tbody>{options.map(o=><tr key={o.candidateId}>
     <th>{o.candidateId}</th>
     <td>{days(o.actualDteDays)}</td>
     <td>{o.shortStrike??UNAVAILABLE} / {o.longStrike??UNAVAILABLE}<br/><small>{o.widthUsd===null?UNAVAILABLE:`$${o.widthUsd}`}</small></td>
     <td>{o.endpoint??UNAVAILABLE}</td>
     <td className={o.comparability==="paired"?undefined:"dd-muted"} title={o.comparabilityReason??undefined}>{o.comparability.replaceAll("_"," ")}</td>
     <td className={o.optionPnlUsd===null?"dd-muted":undefined}>{usd(o.optionPnlUsd)}<br/><small>{o.optionStatus}</small></td>
     <td className={o.maximumStructuralLossUsd===null?"dd-muted":undefined} title={o.structuralLossReason??undefined}>{usd(o.maximumStructuralLossUsd)}</td>
     <td className={o.openingInitialMarginUsd===null?"dd-muted":undefined} title={o.marginReason??undefined}>{usd(o.openingInitialMarginUsd)}</td>
     <td className={o.peakInitialMarginUsd===null?"dd-muted":undefined} title={o.marginReason??undefined}>{usd(o.peakInitialMarginUsd)}</td>
     <td>{usd(o.equalRisk.riskBudgetUsd)}</td>
     <td>{qty(o.equalRisk.futuresQuantity)}</td>
     <td className={o.equalRisk.futuresPnlUsd===null?"dd-muted":undefined} title={o.equalRisk.reason??undefined}>{usd(o.equalRisk.futuresPnlUsd)}</td>
     <td className={o.equalRisk.differenceUsd===null?"dd-muted":undefined} title={o.equalRisk.reason??undefined}>{usd(o.equalRisk.differenceUsd)}</td>
    </tr>)}</tbody>
   </table></div>
  </div>)}

  {report.diagnostics.length>0&&<details><summary>Diagnostics ({report.diagnostics.length})</summary><ul>{report.diagnostics.slice(0,50).map((x,i)=><li key={`${x.eventId}-${x.candidateId??"event"}-${i}`}><b>{x.eventId}{x.candidateId?` · ${x.candidateId}`:""}:</b> {x.reason}</li>)}</ul></details>}
  <details><summary>Methodology</summary><p><b>Equal-risk sizing:</b> <code>{report.equalRiskSizingMethod}</code></p>{report.methodology.map(x=><p key={x}>{x}</p>)}</details>
 </section>;
}
