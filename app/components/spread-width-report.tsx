"use client";
import {useState} from "react";
import type {SpreadWidthReport} from "../lib/spread-width/report";
import type {VolatilityReport} from "../lib/volatility/volatility-report";
import {EmbeddedVolatilityContext} from "./volatility-report";
import type {WidthStructure} from "../lib/spread-width/normalize";
import {ChartMarker,ChartReadout,useChartCursor} from "./chart-cursor";
import {nearestInPlot,type PlotGeometry} from "../lib/chart-interaction";

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
const withN=(value:string,n:number,total:number)=>`${value} · n=${n}/${total}`;
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
       {label:`Gross tail benefit @ ${money(hovered.protection.deepTailIndex)}`,value:usd(hovered.protection.benefitAtDeepTailUsd.value)},
       {label:"Net",value:signedUsd(hovered.protection.netProtectionValueUsd),tone:hovered.protection.netProtectionValueUsd!>=0?"positive":"negative"},
      ]}/>
    </>}
   </svg>
  </figure>
  <small className="dd-note">Each point is one matched structure. The diagonal is the break-even line where gross tail protection equals its entry cost. The diagnostic stress is 50% of K-long for puts and 200% for calls; it is deterministic, not optimized, predicted, or an expected BTC price. A naked short call has unbounded terminal USD loss as BTC rises; a naked short put has a finite strike-related terminal USD bound even though its BTC liability diverges near zero. In both cases the protective long bounds the spread.</small>
 </>;
}

/* ---------- report ---------- */

const VIEWS:readonly {value:WidthView;label:string}[]=[
 {value:"maker",label:"Maker opportunity"},{value:"taker",label:"Taker"},{value:"compare",label:"Compare"},
];

export function SpreadWidthReportView({report,volatility,view="maker",onViewChange}:{
 report:SpreadWidthReport;volatility?:VolatilityReport;view?:WidthView;onViewChange?:(view:WidthView)=>void;
}){
 const [page,setPage]=useState(0);
 const s=report.summary,pageSize=10;
 const audit=report.groups.flatMap(g=>g.structures);
 const pages=Math.max(1,Math.ceil(audit.length/pageSize));
 const current=Math.min(page,pages-1);
 const rows=audit.slice(current*pageSize,(current+1)*pageSize);
 const steps=report.groups.flatMap(g=>g.steps);
 const scenarioLabel=report.scenario==="reference"?"Reference fair value":report.scenario==="maker"?"Immediate Maker opportunity":"Immediate Taker execution";

 return <section className="workspace-section dd-report" data-testid="spread-width-report">
  <header className="dd-header">
   <div>
    <p className="eyebrow">Options structure analysis · protective width</p>
    <h2>Spread-Width Analysis</h2>
    <p className="dd-sub">For a fixed event, expiry, short strike, execution scenario and exit policy, how much protective width best trades credit retained against tail-risk reduction, fees and capital efficiency?</p>
    <p className="dd-note">Every primary comparison holds the short strike constant — placement is separate and execution scenario is not a primary match dimension. Economics use ACTUAL historical width; requested width is retained for audit only. Scoped to {scenarioLabel}. This report identifies a stable width region; it does not select one.</p>
   </div>
   {onViewChange&&<div className="dd-tabs dd-scenario-tabs" role="tablist" aria-label="Execution view">
    {VIEWS.map(v=><button key={v.value} role="tab" aria-selected={v.value===view} className={v.value===view?"dd-tab-active":undefined} onClick={()=>onViewChange(v.value)}>{v.label}</button>)}
   </div>}
  </header>

  {volatility&&<EmbeddedVolatilityContext report={volatility} kind="width" candidateIds={new Set(report.structures.map(s=>s.candidateId))}/>}
  {/* 1 · Summary */}
  <div className="dd-cards">
   <Card label="Matched observations" value={String(s.matchedObservations)} detail={`${s.matchedGroups} ladder(s), ${s.adjacentSteps} step(s)`}/>
   <Card label="Actual widths" value={s.distinctActualWidths.length?s.distinctActualWidths.map(widthLabel).join(" · "):NOT_ESTIMABLE}/>
   <Card label="Width substituted" value={s.structures?String(s.substitutedWidthN):"Not evaluated"} detail={s.structures?"requested ≠ actual":undefined} title="Historical strike availability forced the protective long onto a different strike. Economics use the actual contracts."/>
   <Card label="Median net credit" value={usd(s.medianNetCreditUsd)}/>
   <Card label="Median max structural loss" value={usd(s.medianStructuralLossUsd)} detail="canonical bounded structural risk"/>
   <Card label="Median fee drag" value={pct(s.medianFeeDragRoundTrip)} detail="estimated round trip"/>
   <Card label="Capital data" value={`${s.openingMarginAvailableN} / ${s.matchedObservations}`} detail="opening margin available" title="Margin depends on the account model, so it is Unavailable unless the canonical margin scenario reports it."/>
  </div>
  {report.robustness&&<section className="dd-block"><h3>Execution Robustness</h3><p className="dd-note">Observed adjacent steps remain strict and separate. Matched N: Maker {report.robustness.maker.groups.flatMap(g=>g.steps).filter(s=>s.economicsComparable).length}; Taker {report.robustness.taker.groups.flatMap(g=>g.steps).filter(s=>s.economicsComparable).length}. Reference and modeled values are never relabeled as fills.</p></section>}
  <p className="dd-note"><strong>Descriptive support versus primary evidence.</strong> Width-level medians below may contain different event compositions and are descriptive. The paired adjacent-width section is the controlled within-ladder evidence used to assess width stability.</p>

  {/* 2 · Entry economics */}
  <section className="dd-block"><h3>1 · Descriptive entry economics by actual width</h3>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>N</th><th>Gross credit</th><th>Net credit</th><th>Credit / actual width</th><th>Credit / requested</th><th>Credit / structural loss</th><th>Long-leg cost</th><th>Long share of short</th><th>Fee drag (open)</th><th>Fee drag (round trip)</th><th>Breakeven index</th><th>Max structural loss</th></tr></thead>
    <tbody>{report.entryEconomics.map(r=><tr key={r.actualWidthUsd}>
     <td>{widthLabel(r.actualWidthUsd)}{r.substitutedN>0&&<small className="dd-muted"> · {r.substitutedN} substituted</small>}</td>
     <td>{r.n} structures · {r.eventN} events</td>
     <td>{withN(usd(r.medianGrossCreditUsd),r.metricN.grossCredit!,r.n)}</td><td>{withN(usd(r.medianNetCreditUsd),r.metricN.netCredit!,r.n)}</td>
     <td>{withN(ratio(r.medianCreditPerActualWidth),r.metricN.creditActual!,r.n)}</td>
     <td className="dd-muted">{withN(ratio(r.medianCreditPerRequestedWidth),r.metricN.creditRequested!,r.n)}</td>
     <td>{withN(ratio(r.medianCreditPerStructuralLoss),r.metricN.creditStructural!,r.n)}</td>
     <td>{withN(usd(r.medianLongLegCostUsd),r.metricN.longLegCost!,r.n)}</td><td>{withN(pct(r.medianLongLegShareOfShortPremium),r.metricN.longShare!,r.n)}</td>
     <td>{withN(pct(r.medianFeeDragOnOpening),r.metricN.feeDragOpening!,r.n)}</td><td>{withN(pct(r.medianFeeDragRoundTrip),r.metricN.feeDrag!,r.n)}</td>
     <td>{withN(money(r.medianBreakEvenIndex),r.metricN.breakeven!,r.n)}</td>
     <td className="negative">{withN(usd(r.medianStructuralLossUsd),r.metricN.structuralLoss!,r.n)}</td>
    </tr>)}</tbody>
   </table></div>
   <small className="dd-note">Maximum structural loss is the canonical bounded structural risk exported by the research bundle, not width minus credit and not recomputed here. It deliberately excludes settlement delivery fees: a delivery fee is a fixed BTC amount, so its USD value grows without bound as the settlement index grows and no finite fee-inclusive maximum exists for a bear call. Delivery fees are reported separately at a named settlement scenario. Credit-per-requested-width is shown muted because it is audit information — the actual contracts drive every economic figure.</small>
  </section>

  {/* 3 · Protection vs cost */}
  <section className="dd-block dd-centerpiece"><h3>2 · Descriptive protection economics by actual width</h3><ProtectionVsCost report={report}/>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>N</th><th>Protection cost</th><th>Gross tail benefit at diagnostic stress</th><th>Net tail protection value</th></tr></thead>
    <tbody>{report.protection.map(r=><tr key={r.actualWidthUsd}>
     <td>{widthLabel(r.actualWidthUsd)}</td><td>{r.n} structures · {r.eventN} events</td>
     <td className="negative">{withN(usd(r.medianProtectionCostUsd),r.metricN.protectionCost!,r.n)}</td>
     <td className="positive">{withN(usd(r.medianBenefitAtDeepTailUsd),r.metricN.grossBenefit!,r.n)}</td>
     <td className={r.medianNetProtectionValueUsd===null?"dd-muted":r.medianNetProtectionValueUsd>=0?"positive":"negative"}>{withN(signedUsd(r.medianNetProtectionValueUsd),r.metricN.netProtection!,r.n)}</td>
    </tr>)}</tbody>
   </table></div>
  </section>

  {/* 4 · Path risk */}
  <section className="dd-block"><h3>3 · Descriptive path risk by actual width</h3>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>N</th><th>PnL at VPOC</th><th>PnL at invalidation</th><th>Worst adverse</th><th>MAE</th><th>Settlement</th><th>Touched</th><th>Breached</th><th>Touched PnL</th><th>Breached PnL</th></tr></thead>
    <tbody>{report.pathRisk.map(r=><tr key={r.actualWidthUsd}>
     <td>{widthLabel(r.actualWidthUsd)}</td><td>{r.n} structures · {r.eventN} events</td>
     <td className={r.medianPnlAtVpocUsd===null?"dd-muted":"positive"}>{withN(usd(r.medianPnlAtVpocUsd),r.metricN.vpoc!,r.n)}</td>
     <td className={r.medianPnlAtInvalidationUsd===null?"dd-muted":"negative"}>{withN(usd(r.medianPnlAtInvalidationUsd),r.metricN.invalidation!,r.n)}</td>
     <td className={r.medianWorstAdverseUsd===null?"dd-muted":"negative"}>{withN(usd(r.medianWorstAdverseUsd),r.metricN.worstAdverse!,r.n)}</td>
     <td className={r.medianMaeUsd===null?"dd-muted":"negative"}>{withN(usd(r.medianMaeUsd),r.metricN.mae!,r.n)}</td>
     <td>{withN(usd(r.medianSettlementUsd),r.metricN.settlement!,r.n)}</td>
     <td>{r.touchedN}</td><td className={r.breachedN>0?"negative":undefined}>{r.breachedN}</td>
     <td>{withN(r.touchedN?usd(r.medianTouchedPnlUsd):NOT_ESTIMABLE,r.metricN.touched!,r.touchedN)}</td><td>{withN(r.breachedN?usd(r.medianBreachedPnlUsd):NOT_ESTIMABLE,r.metricN.breached!,r.breachedN)}</td>
    </tr>)}</tbody>
   </table></div>
   <small className="dd-note">Touch and breach depend on the short strike and the path alone, so every width in a ladder shares the same challenge state — what changes with width is the loss those states produce. PnL at invalidation is used only where the invalidation genuinely fell inside the structure&rsquo;s life.</small>
  </section>

  {/* 4b · Slow resolution */}
  <section className="dd-block"><h3>4 · Descriptive behaviour by MR resolution speed</h3>
   <p className="dd-sub">Canonical Duration &amp; DTE cohorts: fast &lt; P25 ({report.cohortBoundaries.p25Days===null?NOT_ESTIMABLE:`${d1(report.cohortBoundaries.p25Days)}d`}), slow &gt; P75 ({report.cohortBoundaries.p75Days===null?NOT_ESTIMABLE:`${d1(report.cohortBoundaries.p75Days)}d`}), over {report.cohortBoundaries.resolvedEventsN} resolved event(s). Unresolved stays its own cohort.</p>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>Cohort</th><th>N</th><th>Median realized PnL</th><th>Median worst adverse</th></tr></thead>
    <tbody>{report.slowResolution.flatMap(row=>row.cells.filter(c=>c.n>0).map(c=>
     <tr key={`${row.actualWidthUsd}-${c.cohort}`}>
      <td>{widthLabel(row.actualWidthUsd)}</td>
      <td className={c.cohort==="unresolved"?"dd-muted":undefined}>{c.cohort}</td><td>{c.n} structures · {c.eventN} events</td>
      <td className={c.medianRealizedPnlUsd===null?"dd-muted":c.medianRealizedPnlUsd>=0?"positive":"negative"}>{withN(usd(c.medianRealizedPnlUsd),c.realizedN,c.n)}</td>
      <td className={c.medianWorstAdverseUsd===null?"dd-muted":"negative"}>{withN(usd(c.medianWorstAdverseUsd),c.adverseN,c.n)}</td>
     </tr>))}</tbody>
   </table></div>
   <small className="dd-note">Cohorts come from the observed first-resolution distribution; no hypothetical path is fabricated, and DTE is held constant inside each matched ladder.</small>
  </section>

  {/* 5 · Capital economics */}
  <section className="dd-block"><h3>5 · Descriptive capital economics by actual width</h3>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Actual width</th><th>N</th><th>Max structural loss</th><th>Opening margin</th><th>Peak margin</th><th>Return on structural loss</th><th>Return on opening margin</th><th>Return on peak capital</th></tr></thead>
    <tbody>{report.capital.map(r=><tr key={r.actualWidthUsd}>
     <td>{widthLabel(r.actualWidthUsd)}</td><td>{r.n} structures · {r.eventN} events</td>
     <td className="negative">{withN(usd(r.medianStructuralLossUsd),r.metricN.structuralLoss!,r.n)}</td>
     <td className={r.openingMarginAvailableN?undefined:"dd-muted"} title={r.marginUnavailableReason??undefined}>{withN(r.openingMarginAvailableN?usd(r.medianOpeningMarginUsd):UNAVAILABLE,r.metricN.openingMargin!,r.n)}</td>
     <td className={r.peakMarginAvailableN?undefined:"dd-muted"} title={r.marginUnavailableReason??undefined}>{withN(r.peakMarginAvailableN?usd(r.medianPeakMarginUsd):UNAVAILABLE,r.metricN.peakMargin!,r.n)}</td>
     <td>{withN(ratio(r.medianReturnOnStructuralLoss),r.metricN.returnStructural!,r.n)}</td>
     <td className={r.medianReturnOnOpeningMargin===null?"dd-muted":undefined}>{withN(ratio(r.medianReturnOnOpeningMargin),r.metricN.returnOpening!,r.n)}</td>
     <td className={r.medianReturnOnPeakCapital===null?"dd-muted":undefined}>{withN(ratio(r.medianReturnOnPeakCapital),r.metricN.returnPeak!,r.n)}</td>
    </tr>)}</tbody>
   </table></div>
   <small className="dd-note">Three separate concepts. Maximum structural loss is an economic property of the structure, consumed from the canonical export; it is not Initial Margin and not Maintenance Margin. Opening and peak margin are properties of the ACCOUNT — they depend on Deribit&rsquo;s margin model, standard versus portfolio margin and segregated versus cross collateral — so where the canonical margin scenario does not report them they stay Unavailable. The protective-leg cost, the width and the structural loss are never substituted for a margin figure, and a return whose denominator is Unavailable is itself Unavailable rather than zero.</small>
  </section>

  {/* 6 · Stability across width */}
  <section className="dd-block"><h3>6 · Primary paired stability across adjacent widths</h3>
   {steps.length===0
    ?<p className="dd-empty-inline">{UNAVAILABLE} — no matched ladder contains two different actual widths, so no adjacent step can be formed.</p>
    :<><div className="table-scroll"><table className="dd-table dd-compact">
     <thead><tr><th>Event</th><th>Short K</th><th>DTE</th><th>Step</th><th>Δ net credit</th><th>Δ fee drag</th><th>Δ structural loss</th><th>Δ invalidation PnL</th><th>Δ worst adverse</th><th>Δ settlement</th><th>Δ protection benefit</th><th>Δ return on structural loss</th></tr></thead>
     <tbody>{steps.map(step=><tr key={`${step.matchKey}-${step.narrowerWidthUsd}`}>
      <td>{step.eventId}</td><td>{money(step.shortStrike)}</td><td>{step.actualDteDays===null?"—":d1(step.actualDteDays)}</td>
      <td>{widthLabel(step.narrowerWidthUsd)} → {widthLabel(step.widerWidthUsd)}</td>
      <td className={step.deltaNetCreditUsd===null?"dd-muted":step.deltaNetCreditUsd>=0?"positive":"negative"}>{signedUsd(step.deltaNetCreditUsd)}</td>
      <td>{step.deltaFeeDragRoundTrip===null?UNAVAILABLE:pct(step.deltaFeeDragRoundTrip)}</td>
      <td className={step.deltaStructuralLossUsd===null?"dd-muted":"negative"}>{signedUsd(step.deltaStructuralLossUsd)}</td>
      <td className={step.deltaPnlAtInvalidationUsd===null?"dd-muted":undefined}>{signedUsd(step.deltaPnlAtInvalidationUsd)}</td>
      <td className={step.deltaWorstAdverseUsd===null?"dd-muted":undefined}>{signedUsd(step.deltaWorstAdverseUsd)}</td>
      <td className={step.deltaSettlementUsd===null?"dd-muted":undefined}>{signedUsd(step.deltaSettlementUsd)}</td>
      <td className={step.deltaProtectionBenefitUsd===null?"dd-muted":undefined}>{signedUsd(step.deltaProtectionBenefitUsd)}</td>
      <td className={step.deltaReturnOnStructuralLoss===null?"dd-muted":undefined}>{step.deltaReturnOnStructuralLoss===null?UNAVAILABLE:step.deltaReturnOnStructuralLoss.toFixed(3)}</td>
     </tr>)}</tbody>
    </table></div>
    <small className="dd-note">Each row is one step between two ADJACENT actual widths inside a single matched ladder, never a difference of aggregate totals. A region where consecutive steps are small in every column is a plateau; a step where credit rises sharply while protection benefit collapses is the edge of one. The report stops here deliberately — identifying the region is its job, choosing inside it is not.</small></>}
  </section>

  {/* 7 · Audit */}
  <section className="dd-block"><h3>7 · Matched structures audit</h3>
   <div className="table-scroll"><table className="dd-table">
    <thead><tr><th>Event</th><th>Candidate</th><th>DTE</th><th>Short / long K</th><th>Requested</th><th>Actual</th><th>Analytical layer</th><th>Gross</th><th>Net</th><th>Long-leg cost</th><th>Fees</th><th>Max structural loss</th><th>Resolution</th><th>PnL VPOC</th><th>PnL inval.</th><th>Worst adverse</th><th>Settlement</th><th>Realized thesis exit</th><th>Gross protection</th><th>Net protection</th><th>Return on structural loss</th></tr></thead>
    <tbody>{rows.map((r:WidthStructure)=><tr key={r.structureExecutionId}>
     <td>{r.eventId}</td><td>{r.candidateId}</td><td>{r.actualDteDays===null?"—":d1(r.actualDteDays)}</td>
     <td>{money(r.identity.shortStrike)} / {money(r.identity.longStrike)}</td>
     <td className={r.identity.widthSubstituted?"dd-muted":undefined} title={r.identity.widthSubstituted?"Historical availability forced a different protective long; economics use the actual width.":undefined}>{r.identity.requestedWidthUsd===null?"—":widthLabel(r.identity.requestedWidthUsd)}</td>
     <td>{r.identity.actualWidthUsd===null?"—":widthLabel(r.identity.actualWidthUsd)}{r.identity.widthSubstituted&&<small className="dd-muted"> ⓘ</small>}</td>
     <td className="dd-muted" title={r.executionScenarioReason??undefined}>{r.analyticsTrack==="reference"?"Reference fair value":r.executionScenario==="maker"?"Immediate Maker opportunity":"Immediate Taker execution"}{r.executionScenarioLegacyUndifferentiated?" · legacy undifferentiated":""}</td>
     <td>{usd(r.entry.grossCreditUsd)}</td><td>{usd(r.entry.netCreditUsd)}</td>
     <td>{usd(r.protection.longLegPremiumUsd)}</td>
     <td>{r.entry.openingFeesBtc===null?UNAVAILABLE:`${r.entry.openingFeesBtc.toFixed(5)} BTC`}</td>
     <td className="negative">{usd(r.payoff.maximumStructuralLossUsd.value)}</td><td title={r.resolutionReason??undefined}>{r.resolution}</td>
     <td>{usd(r.pnlAtVpocUsd)}</td><td>{usd(r.pnlAtInvalidationUsd)}</td>
     <td className={r.worstAdverseUsd===null?"dd-muted":"negative"} title={r.adverse.reason??undefined}>{usd(r.worstAdverseUsd)}</td>
     <td>{usd(r.pnlAtSettlementUsd)}</td><td title={r.resolutionReason??undefined}>{usd(r.realizedPnlUsd)}</td>
     <td>{usd(r.protection.benefitAtDeepTailUsd.value)}</td><td>{signedUsd(r.protection.netProtectionValueUsd)}</td>
     <td className={r.capital.returnOnStructuralLoss.value===null?"dd-muted":undefined} title={r.capital.returnOnStructuralLoss.reason??undefined}>{ratio(r.capital.returnOnStructuralLoss.value)}</td>
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
