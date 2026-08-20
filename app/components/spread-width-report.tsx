"use client";
import {useState} from "react";
import type {SpreadWidthReport} from "../lib/spread-width/report";
import type {WidthStructure} from "../lib/spread-width/normalize";
import {ChartMarker,ChartReadout,useChartCursor} from "./chart-cursor";
import {nearestInPlot,type PlotGeometry} from "../lib/chart-interaction";
import {executionScenarioStatusLabel} from "../lib/execution-scenario";

/**
 * Presentation only. Every number comes from the prebuilt Spread-Width view
 * model; this file performs no analysis and selects no width.
 *
 * Styling is the shared Kyron-derived design system already in globals.css --
 * the dd-* panel, card, table and note primitives -- so no new visual language
 * or colour literal is introduced here.
 */

export type WidthView="maker"|"taker"|"compare";

const NOT_ESTIMABLE="Not estimable";
const UNAVAILABLE="Unavailable";
const d1=(x:number)=>x.toFixed(1);
const usd=(x:number|null)=>x===null?UNAVAILABLE:`${x<0?"−":""}$${Math.abs(x).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const signedUsd=(x:number|null)=>x===null?UNAVAILABLE:`${x<0?"−":"+"}$${Math.abs(x).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const pct=(x:number|null)=>x===null?NOT_ESTIMABLE:`${(x*100).toFixed(1)}%`;
const ratio=(x:number|null)=>x===null?UNAVAILABLE:x.toFixed(3);
const money=(x:number|null)=>x===null?UNAVAILABLE:`$${x.toLocaleString(undefined,{maximumFractionDigits:0})}`;
const widthLabel=(x:number)=>`$${x.toLocaleString()}`;

function Card({label,value,detail,title}:{label:string;value:string;detail?:string;title?:string}){
 return <div className="dd-card" title={title}><span className="dd-label">{label}</span><strong>{value}</strong>{detail&&<small className="dd-muted">{detail}</small>}</div>;
}

/* ---------- 3. Protection vs cost (centrepiece) ---------- */

const W=760,H=320,ML=68,MR=20,MT=18,MB=48;

function ProtectionVsCost({report}:{report:SpreadWidthReport}){
 const points=report.groups.flatMap(g=>g.structures).filter(s=>
  s.protection.totalProtectionCostUsd!==null&&s.protection.benefitAtDeepTailUsd.value!==null);
 const xs=points.map(p=>p.protection.totalProtectionCostUsd!),ys=points.map(p=>p.protection.benefitAtDeepTailUsd.value!);
 const xMin=Math.min(0,...xs),xMax=Math.max(0,...xs)||1,yMin=Math.min(0,...ys),yMax=Math.max(0,...ys)||1;
 const padX=(xMax-xMin)*.12||1,padY=(yMax-yMin)*.12||1;
 const geometry:PlotGeometry={width:W,height:H,left:ML,right:MR,top:MT,bottom:MB,
  xRange:{min:xMin-padX,max:xMax+padX},yRange:{min:yMin-padY,max:yMax+padY}};
 const px=(v:number)=>ML+(v-geometry.xRange.min)/(geometry.xRange.max-geometry.xRange.min)*(W-ML-MR);
 const py=(v:number)=>H-MB-(v-geometry.yRange.min)/(geometry.yRange.max-geometry.yRange.min)*(H-MT-MB);
 const cursor=useChartCursor(geometry);
 const hovered=cursor.position?nearestInPlot(
  points.map(p=>({...p,x:p.protection.totalProtectionCostUsd!,y:p.protection.benefitAtDeepTailUsd.value!})),
  cursor.position.x,cursor.position.y,geometry.xRange,geometry.yRange):null;
 if(!points.length)return <p className="dd-empty-inline">{UNAVAILABLE} — no matched structure has both a protective-long cost and a priced counterfactual, so the insurance tradeoff cannot be plotted. The width tables below still report what is known.</p>;
 // Break-even line: protection worth exactly what it cost.
 const lo=Math.max(geometry.xRange.min,geometry.yRange.min),hi=Math.min(geometry.xRange.max,geometry.yRange.max);
 return <>
  <figure className="dd-chart">
   <svg className="chart-interactive" viewBox={`0 0 ${W} ${H}`} role="img"
    aria-label={`Protective-long cost versus tail protection purchased, ${points.length} matched structures. Move the pointer to inspect one.`}
    {...cursor.handlers}>
    {hi>lo&&<line className="dd-grid" x1={px(lo)} y1={py(lo)} x2={px(hi)} y2={py(hi)}/>}
    {[geometry.yRange.min,geometry.yRange.max].map(v=><text key={`y${v}`} className="dd-tick" x={ML-9} y={py(v)+4} textAnchor="end">{money(Math.round(v))}</text>)}
    {[geometry.xRange.min,geometry.xRange.max].map(v=><text key={`x${v}`} className="dd-tick" x={px(v)} y={H-MB+18} textAnchor="middle">{money(Math.round(v))}</text>)}
    {points.map(p=><circle key={p.structureExecutionId}
     className={`ur-dot ${p.protection.netProtectionValueUsd!>=0?"vpoc_first":"invalidation_first"}`}
     cx={px(p.protection.totalProtectionCostUsd!)} cy={py(p.protection.benefitAtDeepTailUsd.value!)} r={4}/>)}
    <line className="dd-axis" x1={ML} x2={ML} y1={MT} y2={H-MB}/>
    <line className="dd-axis" x1={ML} x2={W-MR} y1={H-MB} y2={H-MB}/>
    <text className="dd-axis-label" x={W/2} y={H-6} textAnchor="middle">Protective-long cost (USD)</text>
    {hovered&&<>
     <ChartMarker px={px(hovered.protection.totalProtectionCostUsd!)} py={py(hovered.protection.benefitAtDeepTailUsd.value!)} r={6}/>
     <ChartReadout geometry={geometry} px={px(hovered.protection.totalProtectionCostUsd!)} py={py(hovered.protection.benefitAtDeepTailUsd.value!)}
      title={`${hovered.eventId} · ${widthLabel(hovered.identity.actualWidthUsd??0)} wide`}
      lines={[
       {label:"Protection cost",value:usd(hovered.protection.totalProtectionCostUsd)},
       {label:"Tail benefit",value:usd(hovered.protection.benefitAtDeepTailUsd.value)},
       {label:"At long strike",value:usd(hovered.protection.benefitAtLongStrikeUsd.value),tone:"muted"},
       {label:"Net",value:signedUsd(hovered.protection.netProtectionValueUsd),tone:hovered.protection.netProtectionValueUsd!>=0?"positive":"negative"},
      ]}/>
    </>}
   </svg>
  </figure>
  <small className="dd-note">Each point is one matched structure. The diagonal is the break-even line where the tail protection is worth exactly what the long leg cost. The counterfactual removes only the protective long — same event, short option, entry timing, execution scenario and settlement index — so the difference is attributable to the leg itself. An unprotected inverse short has no finite worst case, which is what the long leg bounds; the deep-tail reference index is stated rather than predicted.</small>
 </>;
}

/* ---------- report ---------- */

const VIEWS:readonly {value:WidthView;label:string}[]=[
 {value:"maker",label:"Maker opportunity"},{value:"taker",label:"Taker"},{value:"compare",label:"Compare"},
];

export function SpreadWidthReportView({report,view="maker",onViewChange}:{
 report:SpreadWidthReport;view?:WidthView;onViewChange?:(view:WidthView)=>void;
}){
 const [page,setPage]=useState(0);
 const s=report.summary,pageSize=10;
 const audit=report.groups.flatMap(g=>g.structures);
 const pages=Math.max(1,Math.ceil(audit.length/pageSize));
 const current=Math.min(page,pages-1);
 const rows=audit.slice(current*pageSize,(current+1)*pageSize);
 const steps=report.groups.flatMap(g=>g.steps);
 const scenarioLabel=report.scenario==="maker"?"maker opportunity":"taker";

 return <section className="workspace-section dd-report" data-testid="spread-width-report">
  <header className="dd-header">
   <div>
    <p className="eyebrow">Options structure analysis · protective width</p>
    <h2>Spread-Width Analysis</h2>
    <p className="dd-sub">For a fixed event, expiry, short strike, execution scenario and exit policy, how much protective width best trades credit retained against tail-risk reduction, fees and capital efficiency?</p>
    <p className="dd-note">Every comparison holds the short strike constant — placement is a separate report and is never re-optimized here. Economics use ACTUAL historical width; requested width is retained for audit only. Scoped to the {scenarioLabel} scenario. This report identifies whether a stable width region exists; it does not select one, and never prefers a width merely for the highest historical PnL.</p>
   </div>
   {onViewChange&&<div className="dd-tabs dd-scenario-tabs" role="tablist" aria-label="Execution view">
    {VIEWS.map(v=><button key={v.value} role="tab" aria-selected={v.value===view} className={v.value===view?"dd-tab-active":undefined} onClick={()=>onViewChange(v.value)}>{v.label}</button>)}
   </div>}
  </header>

  {/* 1 · Summary */}
  <div className="dd-cards">
   <Card label="Matched observations" value={String(s.matchedObservations)} detail={`${s.matchedGroups} ladder(s), ${s.adjacentSteps} step(s)`}/>
   <Card label="Actual widths" value={s.distinctActualWidths.length?s.distinctActualWidths.map(widthLabel).join(" · "):NOT_ESTIMABLE}/>
   <Card label="Width substituted" value={String(s.substitutedWidthN)} detail="requested ≠ actual" title="Historical strike availability forced the protective long onto a different strike. Economics use the actual contracts."/>
   <Card label="Median net credit" value={usd(s.medianNetCreditUsd)}/>
   <Card label="Median max economic loss" value={usd(s.medianMaxEconomicLossUsd)} detail="exact inverse payoff"/>
   <Card label="Median fee drag" value={pct(s.medianFeeDragRoundTrip)} detail="estimated round trip"/>
   <Card label="Capital data" value={`${s.openingMarginAvailableN} / ${s.matchedObservations}`} detail="opening margin available" title="Margin depends on the account model, so it is Unavailable unless the canonical margin scenario reports it."/>
  </div>

  {/* 2 · Entry economics */}
  <section className="dd-block"><h3>1 · Entry economics by actual width</h3>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>N</th><th>Gross credit</th><th>Net credit</th><th>Credit / actual width</th><th>Credit / requested</th><th>Credit / max loss</th><th>Long-leg cost</th><th>Long share of short</th><th>Fee drag (open)</th><th>Fee drag (round trip)</th><th>Breakeven index</th><th>Max economic loss</th></tr></thead>
    <tbody>{report.entryEconomics.map(r=><tr key={r.actualWidthUsd}>
     <td>{widthLabel(r.actualWidthUsd)}{r.substitutedN>0&&<small className="dd-muted"> · {r.substitutedN} substituted</small>}</td>
     <td>{r.n}</td>
     <td>{usd(r.medianGrossCreditUsd)}</td><td>{usd(r.medianNetCreditUsd)}</td>
     <td>{ratio(r.medianCreditPerActualWidth)}</td>
     <td className="dd-muted">{ratio(r.medianCreditPerRequestedWidth)}</td>
     <td>{ratio(r.medianCreditPerMaxLoss)}</td>
     <td>{usd(r.medianLongLegCostUsd)}</td><td>{pct(r.medianLongLegShareOfShortPremium)}</td>
     <td>{pct(r.medianFeeDragOnOpening)}</td><td>{pct(r.medianFeeDragRoundTrip)}</td>
     <td>{money(r.medianBreakEvenIndex)}</td>
     <td className="negative">{usd(r.medianMaxEconomicLossUsd)}</td>
    </tr>)}</tbody>
   </table></div>
   <small className="dd-note">Maximum economic loss is the exact inverse-option payoff, not width minus credit: intrinsic value is non-linear in the settlement index, per-leg settlement fees apply, and the USD result depends on both entry and settlement price. Credit-per-requested-width is shown muted because it is audit information — the actual contracts drive every economic figure.</small>
  </section>

  {/* 3 · Protection vs cost */}
  <section className="dd-block dd-centerpiece"><h3>2 · Protection purchased vs its cost</h3><ProtectionVsCost report={report}/>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>N</th><th>Protection cost</th><th>Benefit at long strike</th><th>Benefit deep in the tail</th><th>Net</th></tr></thead>
    <tbody>{report.protection.map(r=><tr key={r.actualWidthUsd}>
     <td>{widthLabel(r.actualWidthUsd)}</td><td>{r.n}</td>
     <td className="negative">{usd(r.medianProtectionCostUsd)}</td>
     <td>{usd(r.medianBenefitAtLongStrikeUsd)}</td>
     <td className="positive">{usd(r.medianBenefitAtDeepTailUsd)}</td>
     <td className={r.medianNetProtectionValueUsd===null?"dd-muted":r.medianNetProtectionValueUsd>=0?"positive":"negative"}>{signedUsd(r.medianNetProtectionValueUsd)}</td>
    </tr>)}</tbody>
   </table></div>
  </section>

  {/* 4 · Path risk */}
  <section className="dd-block"><h3>3 · Path risk by width</h3>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>N</th><th>PnL at VPOC</th><th>PnL at invalidation</th><th>Worst adverse</th><th>MAE</th><th>Settlement</th><th>Touched</th><th>Breached</th><th>Touched PnL</th><th>Breached PnL</th></tr></thead>
    <tbody>{report.pathRisk.map(r=><tr key={r.actualWidthUsd}>
     <td>{widthLabel(r.actualWidthUsd)}</td><td>{r.n}</td>
     <td className={r.medianPnlAtVpocUsd===null?"dd-muted":"positive"}>{usd(r.medianPnlAtVpocUsd)}</td>
     <td className={r.medianPnlAtInvalidationUsd===null?"dd-muted":"negative"}>{usd(r.medianPnlAtInvalidationUsd)}</td>
     <td className={r.medianWorstAdverseUsd===null?"dd-muted":"negative"}>{usd(r.medianWorstAdverseUsd)}</td>
     <td className={r.medianMaeUsd===null?"dd-muted":"negative"}>{usd(r.medianMaeUsd)}</td>
     <td>{usd(r.medianSettlementUsd)}</td>
     <td>{r.touchedN}</td><td className={r.breachedN>0?"negative":undefined}>{r.breachedN}</td>
     <td>{usd(r.medianTouchedPnlUsd)}</td><td>{usd(r.medianBreachedPnlUsd)}</td>
    </tr>)}</tbody>
   </table></div>
   <small className="dd-note">Touch and breach depend on the short strike and the path alone, so every width in a ladder shares the same challenge state — what changes with width is the loss those states produce. PnL at invalidation is used only where the invalidation genuinely fell inside the structure&rsquo;s life.</small>
  </section>

  {/* 4b · Slow resolution */}
  <section className="dd-block"><h3>4 · Behaviour by MR resolution speed</h3>
   <p className="dd-sub">Canonical Duration &amp; DTE cohorts: fast &lt; P25 ({report.cohortBoundaries.p25Days===null?NOT_ESTIMABLE:`${d1(report.cohortBoundaries.p25Days)}d`}), slow &gt; P75 ({report.cohortBoundaries.p75Days===null?NOT_ESTIMABLE:`${d1(report.cohortBoundaries.p75Days)}d`}), over {report.cohortBoundaries.resolvedEventsN} resolved event(s). Unresolved stays its own cohort.</p>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>Cohort</th><th>N</th><th>Median realized PnL</th><th>Median worst adverse</th></tr></thead>
    <tbody>{report.slowResolution.flatMap(row=>row.cells.filter(c=>c.n>0).map(c=>
     <tr key={`${row.actualWidthUsd}-${c.cohort}`}>
      <td>{widthLabel(row.actualWidthUsd)}</td>
      <td className={c.cohort==="unresolved"?"dd-muted":undefined}>{c.cohort}</td><td>{c.n}</td>
      <td className={c.medianRealizedPnlUsd===null?"dd-muted":c.medianRealizedPnlUsd>=0?"positive":"negative"}>{usd(c.medianRealizedPnlUsd)}</td>
      <td className={c.medianWorstAdverseUsd===null?"dd-muted":"negative"}>{usd(c.medianWorstAdverseUsd)}</td>
     </tr>))}</tbody>
   </table></div>
   <small className="dd-note">Cohorts come from the observed first-resolution distribution; no hypothetical path is fabricated, and DTE is held constant inside each matched ladder.</small>
  </section>

  {/* 5 · Capital economics */}
  <section className="dd-block"><h3>5 · Capital economics</h3>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>N</th><th>Max economic loss</th><th>Opening margin</th><th>Peak margin</th><th>Return on max loss</th><th>Return on opening margin</th><th>Return on peak capital</th></tr></thead>
    <tbody>{report.capital.map(r=><tr key={r.actualWidthUsd}>
     <td>{widthLabel(r.actualWidthUsd)}</td><td>{r.n}</td>
     <td className="negative">{usd(r.medianMaxEconomicLossUsd)}</td>
     <td className={r.openingMarginAvailableN?undefined:"dd-muted"} title={r.marginUnavailableReason??undefined}>{r.openingMarginAvailableN?usd(r.medianOpeningMarginUsd):UNAVAILABLE}</td>
     <td className={r.peakMarginAvailableN?undefined:"dd-muted"} title={r.marginUnavailableReason??undefined}>{r.peakMarginAvailableN?usd(r.medianPeakMarginUsd):UNAVAILABLE}</td>
     <td>{ratio(r.medianReturnOnMaxLoss)}</td>
     <td className={r.medianReturnOnOpeningMargin===null?"dd-muted":undefined}>{ratio(r.medianReturnOnOpeningMargin)}</td>
     <td className={r.medianReturnOnPeakCapital===null?"dd-muted":undefined}>{ratio(r.medianReturnOnPeakCapital)}</td>
    </tr>)}</tbody>
   </table></div>
   <small className="dd-note">Three separate concepts. Maximum economic loss is a property of the payoff and is computed here. Opening and peak margin are properties of the ACCOUNT — they depend on Deribit&rsquo;s margin model, standard versus portfolio margin and segregated versus cross collateral — so where the canonical margin scenario does not report them they stay Unavailable. The protective-leg cost, the width and the maximum loss are never substituted for a margin figure, and a return whose denominator is Unavailable is itself Unavailable rather than zero.</small>
  </section>

  {/* 6 · Stability across width */}
  <section className="dd-block"><h3>6 · Stability across adjacent widths</h3>
   {steps.length===0
    ?<p className="dd-empty-inline">{UNAVAILABLE} — no matched ladder contains two different actual widths, so no adjacent step can be formed.</p>
    :<><div className="table-scroll"><table className="dd-table dd-compact">
     <thead><tr><th>Event</th><th>Short K</th><th>DTE</th><th>Step</th><th>Δ net credit</th><th>Δ fee drag</th><th>Δ max loss</th><th>Δ invalidation PnL</th><th>Δ worst adverse</th><th>Δ settlement</th><th>Δ protection benefit</th><th>Δ return on max loss</th></tr></thead>
     <tbody>{steps.map(step=><tr key={`${step.matchKey}-${step.narrowerWidthUsd}`}>
      <td>{step.eventId}</td><td>{money(step.shortStrike)}</td><td>{step.actualDteDays===null?"—":d1(step.actualDteDays)}</td>
      <td>{widthLabel(step.narrowerWidthUsd)} → {widthLabel(step.widerWidthUsd)}</td>
      <td className={step.deltaNetCreditUsd===null?"dd-muted":step.deltaNetCreditUsd>=0?"positive":"negative"}>{signedUsd(step.deltaNetCreditUsd)}</td>
      <td>{step.deltaFeeDragRoundTrip===null?UNAVAILABLE:pct(step.deltaFeeDragRoundTrip)}</td>
      <td className={step.deltaMaxEconomicLossUsd===null?"dd-muted":"negative"}>{signedUsd(step.deltaMaxEconomicLossUsd)}</td>
      <td className={step.deltaPnlAtInvalidationUsd===null?"dd-muted":undefined}>{signedUsd(step.deltaPnlAtInvalidationUsd)}</td>
      <td className={step.deltaWorstAdverseUsd===null?"dd-muted":undefined}>{signedUsd(step.deltaWorstAdverseUsd)}</td>
      <td className={step.deltaSettlementUsd===null?"dd-muted":undefined}>{signedUsd(step.deltaSettlementUsd)}</td>
      <td className={step.deltaProtectionBenefitUsd===null?"dd-muted":undefined}>{signedUsd(step.deltaProtectionBenefitUsd)}</td>
      <td className={step.deltaReturnOnMaxLoss===null?"dd-muted":undefined}>{step.deltaReturnOnMaxLoss===null?UNAVAILABLE:step.deltaReturnOnMaxLoss.toFixed(3)}</td>
     </tr>)}</tbody>
    </table></div>
    <small className="dd-note">Each row is one step between two ADJACENT actual widths inside a single matched ladder, never a difference of aggregate totals. A region where consecutive steps are small in every column is a plateau; a step where credit rises sharply while protection benefit collapses is the edge of one. The report stops here deliberately — identifying the region is its job, choosing inside it is not.</small></>}
  </section>

  {/* 7 · Audit */}
  <section className="dd-block"><h3>7 · Matched structures</h3>
   <div className="table-scroll"><table className="dd-table">
    <thead><tr><th>Event</th><th>DTE</th><th>Short K</th><th>Requested</th><th>Actual</th><th>Scenario</th><th>Gross</th><th>Net</th><th>Long-leg cost</th><th>Fees</th><th>Max economic loss</th><th>PnL VPOC</th><th>PnL inval.</th><th>Worst adverse</th><th>Settlement</th><th>Protection benefit</th><th>Return on max loss</th></tr></thead>
    <tbody>{rows.map((r:WidthStructure)=><tr key={r.structureExecutionId}>
     <td>{r.eventId}</td><td>{r.actualDteDays===null?"—":d1(r.actualDteDays)}</td>
     <td>{money(r.identity.shortStrike)}</td>
     <td className={r.identity.widthSubstituted?"dd-muted":undefined} title={r.identity.widthSubstituted?"Historical availability forced a different protective long; economics use the actual width.":undefined}>{r.identity.requestedWidthUsd===null?"—":widthLabel(r.identity.requestedWidthUsd)}</td>
     <td>{r.identity.actualWidthUsd===null?"—":widthLabel(r.identity.actualWidthUsd)}{r.identity.widthSubstituted&&<small className="dd-muted"> ⓘ</small>}</td>
     <td className="dd-muted" title={r.executionScenarioReason??undefined}>{r.executionScenario??"—"} · {executionScenarioStatusLabel(r.executionScenarioStatus)}{r.executionScenarioLegacyUndifferentiated?" · legacy undifferentiated":""}</td>
     <td>{usd(r.entry.grossCreditUsd)}</td><td>{usd(r.entry.netCreditUsd)}</td>
     <td>{usd(r.protection.longLegPremiumUsd)}</td>
     <td>{r.entry.openingFeesBtc===null?UNAVAILABLE:`${r.entry.openingFeesBtc.toFixed(5)} BTC`}</td>
     <td className="negative">{usd(r.payoff.maxEconomicLossUsd.value)}</td>
     <td>{usd(r.pnlAtVpocUsd)}</td><td>{usd(r.pnlAtInvalidationUsd)}</td>
     <td className={r.worstAdverseUsd===null?"dd-muted":"negative"} title={r.adverse.reason??undefined}>{usd(r.worstAdverseUsd)}</td>
     <td>{usd(r.pnlAtSettlementUsd)}</td>
     <td>{usd(r.protection.benefitAtDeepTailUsd.value)}</td>
     <td className={r.capital.returnOnMaxLoss.value===null?"dd-muted":undefined} title={r.capital.returnOnMaxLoss.reason??undefined}>{ratio(r.capital.returnOnMaxLoss.value)}</td>
    </tr>)}</tbody>
   </table></div>
   <div className="ur-pager">
    <small>Showing {audit.length?current*pageSize+1:0}–{Math.min((current+1)*pageSize,audit.length)} of {audit.length}. Paging never changes the statistics above.</small>
    <div><button disabled={current<=0} onClick={()=>setPage(current-1)}>Previous</button><span>{current+1} / {pages}</span><button disabled={current>=pages-1} onClick={()=>setPage(current+1)}>Next</button></div>
   </div>
   {report.unmatched.length>0&&<p className="dd-notice">{report.unmatched.length} structure(s) have no adjacent width sharing their event, expiry, short strike and scenario, so they contribute to no pairwise figure. They are listed here rather than silently dropped.</p>}
  </section>

  <details className="ur-methodology"><summary>Methodology, availability and missing data</summary>
   {report.methodology.map((line,i)=><p className="fine-print" key={i}>{line}</p>)}
  </details>
 </section>;
}
