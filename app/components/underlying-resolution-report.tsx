"use client";
import {useMemo,useState} from "react";
import type {DirectionSample,EndpointBlock,ScatterPoint,UnderlyingResolutionReport} from "../lib/underlying-resolution/report";
import type {NormalizedMrEvent} from "../lib/underlying-resolution/normalize";
import {ChartAxisTag,ChartCrosshair,ChartMarker,ChartReadout,useChartCursor} from "./chart-cursor";
import {formatValue,nearestInPlot,stepValueAt,type PlotGeometry} from "../lib/chart-interaction";

/**
 * Presentation only. Every number comes from the prebuilt report view model, so
 * the table page below cannot influence any statistic above it.
 */

const PAGE_SIZE=10;
const NOT_ESTIMABLE="Not estimable";
const UNAVAILABLE="Unavailable";

const d1=(x:number)=>x.toFixed(1);
const days=(x:number|null)=>x===null?NOT_ESTIMABLE:d1(x);
const usd=(x:number|null)=>x===null?UNAVAILABLE:`${x<0?"−":""}$${Math.abs(x).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const pct=(part:number,whole:number)=>whole>0?`${(part/whole*100).toFixed(1)}%`:"—";
const OUTCOME_LABEL:Record<string,string>={vpoc_first:"VPOC first",invalidation_first:"Invalidation first",ambiguous:"Ambiguous",unresolved:"Unresolved"};
const RESOLVED_BY:Record<string,string>={vpoc_first:"VPOC",invalidation_first:"Invalidation",ambiguous:"Simultaneous",unresolved:"—"};

/* ---------- primary outcome cards ---------- */

function OutcomeCard({label,count,whole,tone}:{label:string;count:number;whole:number;tone?:string}){
 return <div className={`ur-outcome-card${tone?` ${tone}`:""}`}>
  <span className="ur-label">{label}</span>
  <strong>{count}</strong>
  <small>{pct(count,whole)}</small>
 </div>;
}

/* ---------- resolution-time blocks ---------- */

function EndpointCard({block}:{block:EndpointBlock}){
 return <div className="ur-endpoint">
  <div className="ur-endpoint-head">
   <span className="ur-label">{block.label}</span>
   <small className="ur-muted">{block.method==="kaplan-meier"?"Kaplan-Meier":"observed"}</small>
  </div>
  {block.emptyReason
   ?<p className="ur-empty-inline">{NOT_ESTIMABLE} — {block.emptyReason}</p>
   :<><div className="ur-p-grid">{block.percentiles.map(p=>
     <div key={p.p}><small>P{Math.round(p.p*100)}</small><strong className={p.days===null?"ur-muted":undefined}>{days(p.days)}</strong></div>)}
    </div>
    <small className="ur-muted">n={block.observed} observed{block.censored!==null&&` · ${block.censored} censored`}</small></>}
 </div>;
}

/* ---------- centrepiece: Kaplan-Meier ---------- */

const W=880,H=300,ML=54,MR=18,MT=16,MB=42;

function SurvivalChart({report}:{report:UnderlyingResolutionReport}){
 const curve=report.survival;
 // With the statistics fix, any eligible event with valid follow-up produces
 // at least an anchor plus a trailing follow-up point -- curve.length<2 means
 // there is genuinely no eligible event to plot, not merely no resolutions.
 // maxT is computed before the empty guard so the hooks below run on every
 // render; an empty curve simply yields the fallback extent and is discarded.
 const maxT=Math.max(0,...curve.map(p=>p.timeDays))||1;
 const px=(t:number)=>ML+t/maxT*(W-ML-MR);
 const py=(s:number)=>MT+(1-s)*(H-MT-MB);

 // Proper step function: hold the previous level to the next event time.
 let path=`M ${px(0)} ${py(1)}`,prev=1;
 for(const point of curve.slice(1)){path+=` L ${px(point.timeDays)} ${py(prev)} L ${px(point.timeDays)} ${py(point.survival)}`;prev=point.survival}
 path+=` L ${px(maxT)} ${py(prev)}`;

 const banded=curve.filter(p=>p.lower!==null&&p.upper!==null);
 const band=banded.length>1
  ?"M "+banded.map(p=>`${px(p.timeDays)} ${py(p.upper!)}`).join(" L ")+" L "+[...banded].reverse().map(p=>`${px(p.timeDays)} ${py(p.lower!)}`).join(" L ")+" Z"
  :"";

 const yTicks=[0,0.25,0.5,0.75,1],xTicks=Array.from({length:5},(_,i)=>maxT*i/4);
 const resolution=report.endpoints.find(b=>b.endpoint==="resolution")!;

 // Kaplan-Meier is a continuous estimator defined for every t, so reading it
 // between event times is legitimate -- the cursor reports the step's own held
 // value, never a value interpolated toward the next drop.
 const geometry:PlotGeometry=useMemo(()=>({width:W,height:H,left:ML,right:MR,top:MT,bottom:MB,
  xRange:{min:0,max:maxT},yRange:{min:0,max:1}}),[maxT]);
 const cursor=useChartCursor(geometry);
 const reading=cursor.position?stepValueAt(curve.map(p=>({...p,x:p.timeDays,y:p.survival})),cursor.position.x):null;
 if(curve.length<2)return <div className="ur-empty">{NOT_ESTIMABLE} — no eligible events with a usable observation window.</div>;
 const p50=resolution.percentiles.find(p=>p.p===0.5)?.days??null,p80=resolution.percentiles.find(p=>p.p===0.8)?.days??null;

 return <>
  <figure className="ur-km">
   <svg className="chart-interactive" viewBox={`0 0 ${W} ${H}`} role="img"
    aria-label={`Kaplan-Meier event-free probability over ${d1(maxT)} days. Move the pointer across the plot to read the estimator at a given time.`}
    {...cursor.handlers}>
    {yTicks.map(t=><g key={t}>
     <line className="ur-grid" x1={ML} x2={W-MR} y1={py(t)} y2={py(t)}/>
     <text className="ur-tick" x={ML-9} y={py(t)+4} textAnchor="end">{(t*100).toFixed(0)}%</text>
    </g>)}
    {xTicks.map(t=><text key={t} className="ur-tick" x={px(t)} y={H-MB+20} textAnchor="middle">{d1(t)}</text>)}
    {band&&<path className="ur-band" d={band}/>}
    <path className="ur-curve" d={path}/>
    {curve.slice(1).map(p=><circle key={p.timeDays} className="ur-step-dot" cx={px(p.timeDays)} cy={py(p.survival)} r={3}>
     <title>{`t=${d1(p.timeDays)}d · S(t)=${(p.survival*100).toFixed(1)}% · ${p.events} event(s), ${p.atRisk} at risk`}</title>
    </circle>)}
    <line className="ur-axis" x1={ML} x2={ML} y1={MT} y2={H-MB}/>
    <line className="ur-axis" x1={ML} x2={W-MR} y1={H-MB} y2={H-MB}/>
    <text className="ur-axis-label" x={W/2} y={H-6} textAnchor="middle">Calendar days from event entry</text>
    {cursor.position&&reading&&<>
     <ChartCrosshair geometry={geometry} px={cursor.position.px} py={py(reading.y)}/>
     <ChartMarker px={px(reading.point.timeDays)} py={py(reading.y)}/>
     <ChartAxisTag geometry={geometry} px={cursor.position.px} text={`${d1(cursor.position.x)}d`}/>
     <ChartReadout geometry={geometry} px={cursor.position.px} py={py(reading.y)}
      title={`t = ${d1(cursor.position.x)}d`}
      lines={[
       {label:"S(t) event-free",value:`${(reading.y*100).toFixed(1)}%`},
       {label:"Resolved by t",value:`${((1-reading.y)*100).toFixed(1)}%`},
       {label:"At risk",value:formatValue(reading.point.atRisk,undefined,0),tone:"muted"},
       {label:"Events at step",value:`${reading.point.events} @ ${d1(reading.point.timeDays)}d`,tone:"muted"},
      ]}/>
    </>}
   </svg>
  </figure>
  <div className="ur-interp">
   <span>Median first resolution <strong className={p50===null?"ur-muted":undefined}>{p50===null?NOT_ESTIMABLE:`${d1(p50)}d`}</strong></span>
   <span>P80 <strong className={p80===null?"ur-muted":undefined}>{p80===null?NOT_ESTIMABLE:`${d1(p80)}d`}</strong></span>
   <span>{resolution.observed} observed · {resolution.censored} censored</span>
  </div>
  {resolution.observed===0&&<p className="ur-empty-inline">No resolutions observed within the follow-up window shown — the curve correctly remains at 100% and percentiles are {NOT_ESTIMABLE}.</p>}
 </>;
}

/* ---------- distance vs resolution time (descriptive) ---------- */

const SW=420,SH=240,SL=46,SB=36,ST=12,SRt=12;

function DistanceScatter({points,missing}:{points:readonly ScatterPoint[];missing:number}){
 const maxX=Math.max(0,...points.map(p=>p.distanceRange))||1,maxY=Math.max(0,...points.map(p=>p.resolutionDays))||1;
 const px=(x:number)=>SL+x/(maxX*1.1)*(SW-SL-SRt),py=(y:number)=>SH-SB-y/(maxY*1.1)*(SH-SB-ST);
 // Discrete observations: the cursor snaps to a real event, never to a point
 // between two of them, because nothing was observed in between.
 const geometry:PlotGeometry={width:SW,height:SH,left:SL,right:SRt,top:ST,bottom:SB,
  xRange:{min:0,max:maxX*1.1},yRange:{min:0,max:maxY*1.1}};
 const cursor=useChartCursor(geometry);
 const hovered=cursor.position
  ?nearestInPlot(points.map(p=>({...p,x:p.distanceRange,y:p.resolutionDays})),cursor.position.x,cursor.position.y,geometry.xRange,geometry.yRange)
  :null;
 if(!points.length)return <div className="ur-empty">No events have both a canonical remaining distance and an observed resolution time.</div>;
 return <>
  <figure className="ur-scatter">
   <svg className="chart-interactive" viewBox={`0 0 ${SW} ${SH}`} role="img"
    aria-label={`Remaining distance to VPOC versus time to first resolution, ${points.length} events. Move the pointer to inspect the nearest event.`}
    {...cursor.handlers}>
    <line className="ur-axis" x1={SL} x2={SL} y1={ST} y2={SH-SB}/>
    <line className="ur-axis" x1={SL} x2={SW-SRt} y1={SH-SB} y2={SH-SB}/>
    {[0,0.5,1].map(f=><text key={f} className="ur-tick" x={SL-8} y={py(maxY*1.1*f)+4} textAnchor="end">{d1(maxY*1.1*f)}</text>)}
    {[0,0.5,1].map(f=><text key={f} className="ur-tick" x={px(maxX*1.1*f)} y={SH-SB+16} textAnchor="middle">{(maxX*1.1*f).toFixed(2)}</text>)}
    {points.map(p=><circle key={p.eventId} className={`ur-dot ${p.outcome}`} cx={px(p.distanceRange)} cy={py(p.resolutionDays)} r={4}>
     <title>{`${p.eventId} · ${p.distanceRange.toFixed(2)}x range · ${d1(p.resolutionDays)}d · ${OUTCOME_LABEL[p.outcome]}`}</title>
    </circle>)}
    <text className="ur-axis-label" x={SW/2} y={SH-4} textAnchor="middle">Remaining distance to VPOC (× range)</text>
    {hovered&&<>
     <ChartMarker px={px(hovered.distanceRange)} py={py(hovered.resolutionDays)} r={6}/>
     <ChartReadout geometry={geometry} px={px(hovered.distanceRange)} py={py(hovered.resolutionDays)}
      title={hovered.eventId}
      lines={[
       {label:"Distance",value:`${hovered.distanceRange.toFixed(2)}× range`},
       {label:"First resolution",value:`${d1(hovered.resolutionDays)}d`},
       {label:"Outcome",value:OUTCOME_LABEL[hovered.outcome]??hovered.outcome,tone:"muted"},
      ]}/>
    </>}
   </svg>
  </figure>
  <div className="ur-legend">
   <span className="vpoc_first">VPOC first</span><span className="invalidation_first">Invalidation first</span><span className="ambiguous">Ambiguous</span>
  </div>
  <small className="ur-note">Descriptive only — no relationship is fitted. Y axis is time to first resolution in days.{missing>0&&` ${missing} event(s) omitted here for missing canonical distance, but retained in all counts.`}</small>
 </>;
}

/* ---------- direction comparison (small-sample friendly) ---------- */

function DirectionStrip({samples}:{samples:readonly DirectionSample[]}){
 const all=samples.flatMap(s=>s.days);
 if(!all.length)return <div className="ur-empty">No observed resolutions to compare by direction.</div>;
 const max=Math.max(...all)||1;
 return <div className="ur-strips">
  {samples.map(s=>{
   if(!s.summary)return <div key={s.direction} className="ur-strip-row"><span>{s.label}</span><em className="ur-muted">No observed resolutions</em></div>;
   const x=(v:number)=>v/(max*1.05)*100,box=s.summary.n>=4;
   return <div key={s.direction} className="ur-strip-row">
    <span>{s.label}</span>
    <div className="ur-strip">
     {box&&<i className="ur-iqr" style={{left:`${x(s.summary.q1)}%`,width:`${Math.max(x(s.summary.q3)-x(s.summary.q1),0.5)}%`}}/>}
     {s.days.map((v,i)=><i key={i} className="ur-obs" style={{left:`${x(v)}%`}} title={`${d1(v)} days`}/>)}
     <i className="ur-median" style={{left:`${x(s.summary.median)}%`}} title={`median ${d1(s.summary.median)} days`}/>
    </div>
    <em>n={s.summary.n}{!box&&<small className="ur-muted"> · points only</small>}</em>
   </div>;
  })}
  <small className="ur-note">Individual observations with a median marker; the inter-quartile box appears only where n ≥ 4. Axis spans 0–{d1(max)} days.</small>
 </div>;
}

/* ---------- event-level audit ---------- */

function EventRow({event}:{event:NormalizedMrEvent}){
 const x=event.excursion;
 return <tr>
  <td>{event.eventId}</td>
  <td>{event.entryDateUtc??UNAVAILABLE}</td>
  <td className={event.direction==="long"?"positive":event.direction==="short"?"negative":"ur-muted"}>{event.direction==="long"?"Bullish":event.direction==="short"?"Bearish":UNAVAILABLE}</td>
  <td>{event.entryPrice===null?UNAVAILABLE:event.entryPrice.toLocaleString()}</td>
  <td>{usd(event.rangeWidthUsd)}</td>
  <td>{event.remainingDistanceRange===null?UNAVAILABLE:`${event.remainingDistanceRange.toFixed(2)}×`}</td>
  <td>{event.timeToVpocDays===null?"—":d1(event.timeToVpocDays)}</td>
  <td>{event.timeToInvalidationDays===null?"—":d1(event.timeToInvalidationDays)}</td>
  <td>{event.timeToResolutionDays===null?"—":d1(event.timeToResolutionDays)}</td>
  <td>{RESOLVED_BY[event.outcome]}</td>
  <td className={x===null?"ur-muted":"positive"}>{x===null?UNAVAILABLE:usd(x.mfeUsd)}</td>
  <td className={x===null?"ur-muted":"negative"}>{x===null?UNAVAILABLE:usd(x.maeUsd)}</td>
  <td><em className={`ur-pill ${event.outcome}`}>{OUTCOME_LABEL[event.outcome]}</em></td>
 </tr>;
}

/* ---------- report ---------- */

export function UnderlyingResolutionReportView({report}:{report:UnderlyingResolutionReport}){
 const [page,setPage]=useState(0);
 const pages=Math.max(1,Math.ceil(report.events.length/PAGE_SIZE));
 const current=Math.min(page,pages-1);
 const rows=report.events.slice(current*PAGE_SIZE,(current+1)*PAGE_SIZE);
 const n=report.effectiveN,c=report.counts;
 const x=report.excursionOverall;

 return <section className="workspace-section ur-report" data-testid="underlying-resolution-report">
  <header className="ur-header">
   <div>
    <p className="eyebrow">Underlying market analysis · before any options analysis</p>
    <h2>Underlying Resolution Before Options</h2>
    <p className="ur-sub">How long does the underlying MR thesis take to resolve through VPOC or invalidation?</p>
   </div>
   <dl className="ur-meta">
    <div><dt>Eligible events</dt><dd>{n}{report.totalEvents!==n&&<small className="ur-muted"> of {report.totalEvents}</small>}</dd></div>
    <div><dt>Observed</dt><dd>{report.observedResolutions}</dd></div>
    <div><dt>Right-censored</dt><dd>{report.censoredObservations}</dd></div>
    <div><dt>Units</dt><dd>calendar days</dd></div>
   </dl>
  </header>

  {report.excludedByReason.length>0&&<p className="ur-notice">{report.excludedByReason.map(r=>`${r.count} event(s) ${r.reason.replaceAll("_"," ")}`).join("; ")} — held out of time-to-event analysis, never counted as failures.</p>}

  <div className="ur-outcomes">
   <OutcomeCard label="VPOC first" count={c.vpocFirst} whole={n} tone="positive"/>
   <OutcomeCard label="Invalidation first" count={c.invalidationFirst} whole={n} tone="negative"/>
   <OutcomeCard label="Unresolved" count={c.unresolved} whole={n} tone="warn"/>
   {c.ambiguous>0&&<OutcomeCard label="Ambiguous" count={c.ambiguous} whole={n} tone="warn"/>}
  </div>

  <div className="ur-endpoints">{report.endpoints.map(b=><EndpointCard key={b.endpoint} block={b}/>)}</div>

  <section className="ur-block">
   <h3>Resolution through time</h3>
   <SurvivalChart report={report}/>
  </section>

  <div className="ur-two-col">
   <section className="ur-block"><h3>Remaining distance vs resolution time</h3><DistanceScatter points={report.distanceVsResolution} missing={report.distanceMissing}/></section>
   <section className="ur-block"><h3>Resolution time by direction</h3><DirectionStrip samples={report.byDirection}/></section>
  </div>

  <section className="ur-block">
   <h3>Outcome by direction</h3>
   <div className="table-scroll"><table className="ur-table ur-compact">
    <thead><tr><th>Direction</th><th>VPOC first</th><th>Invalidation first</th><th>Ambiguous</th><th>Unresolved</th><th>Effective N</th></tr></thead>
    <tbody>{report.directional.map(row=><tr key={row.direction} className={row.direction==="total"?"ur-total":undefined}>
     <td>{row.label}</td>
     {[row.counts.vpocFirst,row.counts.invalidationFirst,row.counts.ambiguous,row.counts.unresolved].map((v,i)=>
      <td key={i}>{v} <small className="ur-muted">{pct(v,row.effectiveN)}</small></td>)}
     <td>{row.effectiveN}</td>
    </tr>)}</tbody></table></div>
  </section>

  <section className="ur-block">
   <h3>Path before resolution</h3>
   <p className="ur-sub">The underlying excursion the position had to survive while the thesis was open — entry to first resolution, or to censoring for unresolved events.</p>
   <div className="ur-excursion">
    <div className="ur-endpoint"><span className="ur-label">Median MFE</span><strong className={x.medianMfeUsd===null?"ur-muted":"positive"}>{usd(x.medianMfeUsd)}</strong></div>
    <div className="ur-endpoint"><span className="ur-label">Median MAE</span><strong className={x.medianMaeUsd===null?"ur-muted":"negative"}>{usd(x.medianMaeUsd)}</strong></div>
    <div className="ur-endpoint"><span className="ur-label">Path coverage</span><strong>{x.available} of {x.total}</strong><small className="ur-muted">events with a stored hourly path</small></div>
   </div>
   {x.available>0
    ?<div className="table-scroll"><table className="ur-table ur-compact">
      <thead><tr><th>Outcome</th><th>Median MFE</th><th>Median MAE</th><th>Available</th></tr></thead>
      <tbody>{report.excursionByOutcome.map(row=><tr key={row.label}>
       <td>{row.label}</td>
       <td className={row.medianMfeUsd===null?"ur-muted":"positive"}>{usd(row.medianMfeUsd)}</td>
       <td className={row.medianMaeUsd===null?"ur-muted":"negative"}>{usd(row.medianMaeUsd)}</td>
       <td>{row.available} of {row.total}</td>
      </tr>)}</tbody></table></div>
    :<p className="ur-empty-inline">{UNAVAILABLE} — no eligible event has a stored hourly underlying path.</p>}
  </section>

  <section className="ur-block">
   <h3>Event-level observations</h3>
   <p className="ur-sub">Inspect the individual MR events underlying this report.</p>
   <div className="table-scroll"><table className="ur-table">
    <thead><tr><th>Event ID</th><th>Date</th><th>Direction</th><th>Entry</th><th>Range width</th><th>Rem. dist.</th><th>T_VPOC</th><th>T_Inv</th><th>T_Res</th><th>Resolved by</th><th>MFE</th><th>MAE</th><th>Outcome</th></tr></thead>
    <tbody>{rows.map(event=><EventRow key={event.eventId} event={event}/>)}</tbody>
   </table></div>
   <div className="ur-pager">
    <small>Showing {report.events.length?current*PAGE_SIZE+1:0}–{Math.min((current+1)*PAGE_SIZE,report.events.length)} of {report.events.length}. Paging never changes the statistics above.</small>
    <div><button disabled={current<=0} onClick={()=>setPage(current-1)}>Previous</button><span>{current+1} / {pages}</span><button disabled={current>=pages-1} onClick={()=>setPage(current+1)}>Next</button></div>
   </div>
  </section>

  <details className="ur-methodology"><summary>Methodology, censoring and missing data</summary>
   {report.methodology.map((line,i)=><p className="fine-print" key={i}>{line}</p>)}
  </details>
 </section>;
}
