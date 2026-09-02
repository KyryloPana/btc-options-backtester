"use client";
import {useState} from "react";
import type {ConditionalBucket,MatchedPair,ShortStrikeReport} from "../lib/short-strike/report";
import type {VolatilityReport} from "../lib/volatility/volatility-report";
import {EmbeddedVolatilityContext} from "./volatility-report";
import type {ExecutionScenario} from "../lib/short-strike/normalize";
import {executionScenarioStatusLabel} from "../lib/execution-scenario";
import {ChartMarker,ChartReadout,useChartCursor} from "./chart-cursor";
import {nearestInPlot,type PlotGeometry} from "../lib/chart-interaction";

/**
 * Presentation only. Every number comes from the prebuilt Short-Strike view
 * model; this file performs no analysis and reaches no conclusion about which
 * placement is better.
 *
 * Styling is entirely the shared Kyron-derived design system already in
 * globals.css -- the dd-* panel, card, table and note primitives -- so no new
 * visual language or colour literal is introduced here.
 */

export type StrikeView="maker"|"taker"|"compare";

const NOT_ESTIMABLE="Not estimable";
const UNAVAILABLE="Unavailable";
const d1=(x:number)=>x.toFixed(1);
const usd=(x:number|null)=>x===null?UNAVAILABLE:`${x<0?"−":""}$${Math.abs(x).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const signedUsd=(x:number|null)=>x===null?UNAVAILABLE:`${x<0?"−":"+"}$${Math.abs(x).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const pct=(x:number|null)=>x===null?NOT_ESTIMABLE:`${(x*100).toFixed(1)}%`;
const money=(x:number|null)=>x===null?UNAVAILABLE:`$${x.toLocaleString(undefined,{maximumFractionDigits:0})}`;
const BUCKET_LABEL:Record<ConditionalBucket,string>={
 breached:"Breached",touched_not_breached:"Touched, not breached",never_touched:"Never touched",
};

function Card({label,value,detail,title}:{label:string;value:string;detail?:string;title?:string}){
 return <div className="dd-card" title={title}><span className="dd-label">{label}</span><strong>{value}</strong>{detail&&<small className="dd-muted">{detail}</small>}</div>;
}

/* ---------- 4. Credit vs protection (centrepiece) ---------- */

const W=760,H=320,ML=64,MR=20,MT=18,MB=48;

function CreditVsProtection({report}:{report:ShortStrikeReport}){
 const points=report.pairs.filter(p=>p.grossCreditSacrificedUsd!==null&&p.worstAdverseReductionUsd!==null);
 const xs=points.map(p=>p.grossCreditSacrificedUsd!),ys=points.map(p=>p.worstAdverseReductionUsd!);
 const xMin=Math.min(0,...xs),xMax=Math.max(0,...xs)||1,yMin=Math.min(0,...ys),yMax=Math.max(0,...ys)||1;
 const padX=(xMax-xMin)*.1||1,padY=(yMax-yMin)*.1||1;
 const geometry:PlotGeometry={width:W,height:H,left:ML,right:MR,top:MT,bottom:MB,
  xRange:{min:xMin-padX,max:xMax+padX},yRange:{min:yMin-padY,max:yMax+padY}};
 const px=(v:number)=>ML+(v-geometry.xRange.min)/(geometry.xRange.max-geometry.xRange.min)*(W-ML-MR);
 const py=(v:number)=>H-MB-(v-geometry.yRange.min)/(geometry.yRange.max-geometry.yRange.min)*(H-MT-MB);
 const cursor=useChartCursor(geometry);
 const hovered=cursor.position
  ?nearestInPlot(points.map(p=>({...p,x:p.grossCreditSacrificedUsd!,y:p.worstAdverseReductionUsd!})),cursor.position.x,cursor.position.y,geometry.xRange,geometry.yRange)
  :null;
 if(!points.length)return <p className="dd-empty-inline">{UNAVAILABLE} — no matched pair has both a credit figure and an adverse-path figure on each side, so the tradeoff cannot be plotted. The pair table below still lists what is known.</p>;
 return <>
  <figure className="dd-chart">
   <svg className="chart-interactive" viewBox={`0 0 ${W} ${H}`} role="img"
    aria-label={`Credit sacrificed by buffering versus reduction in worst adverse mark, ${points.length} matched pairs. Move the pointer to inspect a pair.`}
    {...cursor.handlers}>
    <line className="dd-grid" x1={ML} x2={W-MR} y1={py(0)} y2={py(0)}/>
    <line className="dd-grid" x1={px(0)} x2={px(0)} y1={MT} y2={H-MB}/>
    {[geometry.yRange.min,0,geometry.yRange.max].map(v=><text key={`y${v}`} className="dd-tick" x={ML-9} y={py(v)+4} textAnchor="end">{money(Math.round(v))}</text>)}
    {[geometry.xRange.min,0,geometry.xRange.max].map(v=><text key={`x${v}`} className="dd-tick" x={px(v)} y={H-MB+18} textAnchor="middle">{money(Math.round(v))}</text>)}
    {points.map(p=><circle key={p.matchKey} className={`ur-dot ${p.worstAdverseReductionUsd!>=0?"vpoc_first":"invalidation_first"}`}
     cx={px(p.grossCreditSacrificedUsd!)} cy={py(p.worstAdverseReductionUsd!)} r={4}/>)}
    <line className="dd-axis" x1={ML} x2={ML} y1={MT} y2={H-MB}/>
    <line className="dd-axis" x1={ML} x2={W-MR} y1={H-MB} y2={H-MB}/>
    <text className="dd-axis-label" x={W/2} y={H-6} textAnchor="middle">Credit sacrificed by buffering (USD)</text>
    {hovered&&<>
     <ChartMarker px={px(hovered.grossCreditSacrificedUsd!)} py={py(hovered.worstAdverseReductionUsd!)} r={6}/>
     <ChartReadout geometry={geometry} px={px(hovered.grossCreditSacrificedUsd!)} py={py(hovered.worstAdverseReductionUsd!)}
      title={hovered.eventId}
      lines={[
       {label:"Credit given up",value:usd(hovered.grossCreditSacrificedUsd)},
       {label:"Worst-adverse reduction",value:signedUsd(hovered.worstAdverseReductionUsd),tone:hovered.worstAdverseReductionUsd!>=0?"positive":"negative"},
       {label:"Extra distance",value:usd(hovered.extraDistanceUsd)},
       {label:"DTE / width",value:`${hovered.actualDteDays===null?"—":d1(hovered.actualDteDays)}d / ${money(hovered.widthUsd)}`,tone:"muted"},
      ]}/>
    </>}
   </svg>
  </figure>
  <small className="dd-note">Each point is one matched pair — same event, expiry, width and structure, differing only in short-strike placement, scoped to this analytical track. To the RIGHT means credit was given up to buffer; ABOVE the zero line means that purchased a smaller worst adverse mark.</small>
 </>;
}

/* ---------- report ---------- */

const VIEWS:readonly {value:StrikeView;label:string}[]=[
 {value:"maker",label:"Maker opportunity"},{value:"taker",label:"Taker"},{value:"compare",label:"Compare"},
];

export function ShortStrikeReportView({report,takerReport,volatility,view="maker",onViewChange}:{
 report:ShortStrikeReport;takerReport?:ShortStrikeReport;volatility?:VolatilityReport;view?:StrikeView;onViewChange?:(view:StrikeView)=>void;
}){
 const [page,setPage]=useState(0);
 const s=report.summary,pageSize=10;
 const pages=Math.max(1,Math.ceil(report.pairs.length/pageSize));
 const current=Math.min(page,pages-1);
 const rows=report.pairs.slice(current*pageSize,(current+1)*pageSize);
 const compare=view==="compare";
 const scenarioLabel=report.scenario==="reference"?"Reference fair-value economics":report.scenario==="maker"?"maker opportunity":"taker";

 return <section className="workspace-section dd-report" data-testid="short-strike-report">
  <header className="dd-header">
   <div>
    <p className="eyebrow">Options structure analysis · short-strike placement</p>
    <h2>Short-Strike Analysis</h2>
    <p className="dd-sub">Does moving the short strike farther from the failed-breakout area reduce challenged-position and tail losses enough to justify the credit sacrificed?</p>
    <p className="dd-note">Pair diagnostics hold event, expiry, width and structure fixed. Headline inference first aggregates within each MR event so events have equal weight. Thesis Exit is frozen to first post-entry VPOC or invalidation, then settlement. Scoped to {scenarioLabel}{compare&&takerReport?"; the compare column shows the same pairs priced under taker":""}.</p>
   </div>
   {onViewChange&&<div className="dd-tabs dd-scenario-tabs" role="tablist" aria-label="Execution view">
    {VIEWS.map(v=><button key={v.value} role="tab" aria-selected={v.value===view} className={v.value===view?"dd-tab-active":undefined} onClick={()=>onViewChange(v.value)}>{v.label}</button>)}
   </div>}
  </header>

  {volatility&&<EmbeddedVolatilityContext report={volatility} kind="strike"/>}
  {/* 1 · Summary */}
  <div className="dd-cards">
   <Card label="Matched pairs" value={String(s.matchedPairs)} detail={`${s.matchedEvents} event(s)`}/>
   <Card label="Buffer-eligible share" value={pct(s.bufferEligibleShare)} detail={`${s.bufferEligibleTechnicalStructures} of ${s.technicalStructures} technical structures`}/>
   <Card label="Technical structures" value={String(s.technicalStructures)} detail={s.unmatchedTechnical>0?`${s.unmatchedTechnical} unpaired`:undefined}/>
   <Card label="Buffered structures" value={String(s.bufferedStructures)} detail={s.unmatchedBuffered>0?`${s.unmatchedBuffered} unpaired`:undefined}/>
   <Card label="Median credit sacrificed" value={usd(s.medianGrossCreditSacrificedUsd)} detail={s.medianRelativeCreditSacrifice===null?undefined:`${pct(s.medianRelativeCreditSacrifice)} of technical credit`}/>
   <Card label="Event-weighted adverse reduction" value={signedUsd(s.eventWeighted.medianWorstAdverseReductionUsd)} detail={`${s.eventWeighted.independentEventN} independent event(s)`} title="Within-event median pair delta, then median across equally weighted MR events."/>
   <Card label="Breach-rate difference" value={s.breachRateDifference===null?NOT_ESTIMABLE:`${s.breachRateDifference>0?"+":""}${(s.breachRateDifference*100).toFixed(1)} pp`} detail="buffered − technical"/>
   <Card label="Median extra distance" value={usd(s.medianExtraDistanceUsd)} detail="farther out of the money"/>
  </div>
  {report.robustness&&<section className="dd-block"><h3>Execution Robustness</h3><p className="dd-note">Observed execution remains strict and separate from the reference result. Matched N: Maker {report.robustness.maker.pairs.filter(p=>p.economicsComparable).length}; Taker {report.robustness.taker.pairs.filter(p=>p.economicsComparable).length}. Missing tape is not replaced by reference or modeled values.</p></section>}

  {/* 2 · Strike geometry */}
  <section className="dd-block"><h3>1 · Strike geometry</h3>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Placement</th><th>N</th><th>From entry spot</th><th>Beyond extreme</th><th>Beyond invalidation</th><th>% of spot</th><th>% of range</th><th>Entry delta</th></tr></thead>
    <tbody>{report.geometry.map(g=><tr key={g.method}>
     <td>{g.method==="technical"?"Technical":"Buffered"}</td><td>{g.n}</td>
     <td>{usd(g.medianDistanceFromSpotUsd)}</td><td>{usd(g.medianDistanceFromExtremeUsd)}</td>
     <td className={g.medianDistanceFromInvalidationUsd===null?"dd-muted":g.medianDistanceFromInvalidationUsd<0?"negative":"positive"}>{usd(g.medianDistanceFromInvalidationUsd)}</td>
     <td>{pct(g.medianDistancePctOfSpot)}</td><td>{pct(g.medianDistancePctOfRange)}</td>
     <td className="dd-muted" title={g.entryDeltaReason??undefined}>{UNAVAILABLE}</td>
    </tr>)}</tbody>
   </table></div>
   <small className="dd-note">Medians, signed so positive always means farther out of the money for both directions. &ldquo;Beyond invalidation&rdquo; negative means the strike sits inside the invalidation level, so the thesis stops out only after the strike is challenged. Entry delta is Unavailable: the canonical bundle carries implied volatility but no delta, and deriving one would present a model output as an observation.</small>
  </section>

  {/* 3 · Challenge frequency */}
  <section className="dd-block"><h3>2 · Challenge frequency</h3>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Placement</th><th>Observable</th><th>Touched</th><th>Breached</th><th>Breach before invalidation</th><th>Invalidated without breach</th><th>Ambiguous order</th></tr></thead>
    <tbody>{report.challenge.map(c=><tr key={c.method}>
     <td>{c.method==="technical"?"Technical":"Buffered"}</td><td>{c.observableN}</td>
     <td>{c.touchedN} · {pct(c.touchShare)}</td>
     <td className={c.breachedN>0?"negative":undefined}>{c.breachedN} · {pct(c.breachShare)}</td>
     <td>{c.breachBeforeInvalidationN}</td><td>{c.invalidatedWithoutBreachN}</td>
     <td className="dd-muted">{c.ambiguousOrderingN}</td>
    </tr>)}</tbody>
   </table></div>
   <small className="dd-note">A touch is an intrabar extreme reaching the strike; a breach is a completed hourly close beyond it. Only candles opening inside the structure&rsquo;s own life count. Where a breach and an invalidation fall in the same hourly candle their order is unknown at the path&rsquo;s precision, so the pair is counted as ambiguous rather than assigned a sequence.</small>
  </section>

  {/* 4 · Credit vs protection */}
  <section className="dd-block dd-centerpiece"><h3>3 · Credit sacrificed vs protection purchased</h3><CreditVsProtection report={report}/></section>

  {/* 5 · Conditional PnL */}
  <section className="dd-block"><h3>4 · Conditional PnL</h3>
   <div className="table-scroll"><table className="dd-table dd-compact">
    <thead><tr><th>Technical challenge condition</th><th>Pairs / events</th><th>Technical PnL / adverse n</th><th>Buffered PnL / adverse n</th><th>Technical median PnL</th><th>Buffered median PnL</th><th>Technical worst adverse</th><th>Buffered worst adverse</th><th>Paired Δ PnL / adverse</th><th>Buffered transition B / T / N</th></tr></thead>
    <tbody>{report.conditionalPnl.filter(r=>r.technicalN>0||r.bufferedN>0).map(r=><tr key={r.bucket}>
     <td>{BUCKET_LABEL[r.bucket]}</td><td>{r.pairedN} / {r.independentEventN}</td><td>{r.technicalPnlN} / {r.technicalAdverseN}</td><td>{r.bufferedPnlN} / {r.bufferedAdverseN}</td>
     <td className={r.technicalMedianPnlUsd===null?"dd-muted":r.technicalMedianPnlUsd>=0?"positive":"negative"}>{usd(r.technicalMedianPnlUsd)}</td>
     <td className={r.bufferedMedianPnlUsd===null?"dd-muted":r.bufferedMedianPnlUsd>=0?"positive":"negative"}>{usd(r.bufferedMedianPnlUsd)}</td>
     <td className={r.technicalMedianWorstAdverseUsd===null?"dd-muted":"negative"}>{usd(r.technicalMedianWorstAdverseUsd)}</td>
     <td className={r.bufferedMedianWorstAdverseUsd===null?"dd-muted":"negative"}>{usd(r.bufferedMedianWorstAdverseUsd)}</td>
     <td title={`${r.pairedN} pair(s), conditioned on the technical strike`}>{r.pairedN?`${signedUsd(r.medianPairedPnlDeltaUsd)} / ${signedUsd(r.medianPairedAdverseReductionUsd)}`:<span className="dd-muted">{NOT_ESTIMABLE}</span>}</td>
     <td>{r.bufferedTransitions.breached} / {r.bufferedTransitions.touched_not_breached} / {r.bufferedTransitions.never_touched}</td>
    </tr>)}</tbody>
   </table></div>
   <small className="dd-note">Each row conditions on the technical strike&rsquo;s observed state, then compares both placements in those exact pairs. Thus technical breach → buffered touch or no challenge remains evidence rather than disappearing. Counts disclose pairs, independent events, and available PnL/adverse denominators; transitions are breached / touched-not-breached / never-touched.</small>
  </section>

  {/* 6 · Matched pair audit */}
  <section className="dd-block"><h3>5 · Matched pairs</h3>
   <div className="table-scroll"><table className="dd-table">
    <thead><tr><th>Event</th><th>DTE</th><th>Width</th><th>Scenario</th><th>Technical K</th><th>Buffered K</th><th>Extra distance</th><th>Technical credit</th><th>Buffered credit</th><th>Credit sacrificed</th><th>Challenge (tech → buff)</th><th>Δ worst adverse</th><th>Δ realized PnL</th></tr></thead>
    <tbody>{rows.map((p:MatchedPair)=>{
     const state=(x:MatchedPair["technical"])=>x.challenge.reason!==null?"—":x.challenge.breached?"breach":x.challenge.invalidatedInWindow?"invalidated":x.challenge.touched?"touch":"clean";
     const realized=p.deltas.find(d=>d.label==="Δ realized PnL")?.value??null;
     return <tr key={p.matchKey}>
      <td>{p.eventId}</td><td>{p.actualDteDays===null?"—":d1(p.actualDteDays)}</td><td>{money(p.widthUsd)}</td>
      <td className="dd-muted" title={p.technical.executionScenarioReason??p.buffered.executionScenarioReason??undefined}>{report.scenario==="reference"?"Reference fair value":p.executionScenario??"—"} · {executionScenarioStatusLabel(p.technical.executionScenarioStatus)} / {executionScenarioStatusLabel(p.buffered.executionScenarioStatus)}</td>
      <td>{money(p.technical.geometry.shortStrike)}</td><td>{money(p.buffered.geometry.shortStrike)}</td>
      <td>{usd(p.extraDistanceUsd)}</td>
      <td>{usd(p.technical.grossCreditUsd)}</td><td>{usd(p.buffered.grossCreditUsd)}</td>
      <td className={p.grossCreditSacrificedUsd===null?"dd-muted":"negative"}>{usd(p.grossCreditSacrificedUsd)}</td>
      <td>{state(p.technical)} → {state(p.buffered)}{p.technical.challenge.ambiguousOrdering&&<small className="dd-muted"> (order ambiguous)</small>}</td>
      <td className={p.worstAdverseReductionUsd===null?"dd-muted":p.worstAdverseReductionUsd>=0?"positive":"negative"}>{signedUsd(p.worstAdverseReductionUsd)}</td>
      <td className={realized===null?"dd-muted":realized>=0?"positive":"negative"}>{signedUsd(realized)}</td>
     </tr>;
    })}</tbody>
   </table></div>
   <div className="ur-pager">
    <small>Showing {report.pairs.length?current*pageSize+1:0}–{Math.min((current+1)*pageSize,report.pairs.length)} of {report.pairs.length}. Paging never changes the statistics above.</small>
    <div><button disabled={current<=0} onClick={()=>setPage(current-1)}>Previous</button><span>{current+1} / {pages}</span><button disabled={current>=pages-1} onClick={()=>setPage(current+1)}>Next</button></div>
   </div>
   {report.unpaired.length>0&&<p className="dd-notice">{report.unpaired.length} structure(s) could not be paired and are excluded from every pairwise figure — most often because the canonical generator produces a buffered variant only when the failed-breakout extreme sits within 100 of the rounded strike boundary. They are never compared against an unmatched partner.</p>}
  </section>

  <details className="ur-methodology"><summary>Methodology, availability and missing data</summary>
   {report.methodology.map((line,i)=><p className="fine-print" key={i}>{line}</p>)}
  </details>
 </section>;
}

export type {ExecutionScenario};
