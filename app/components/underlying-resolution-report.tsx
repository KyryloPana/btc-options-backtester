"use client";
import {useState} from "react";
import type {CohortRow,UnderlyingResolutionReport} from "../lib/underlying-resolution/report";
import type {NormalizedMrEvent} from "../lib/underlying-resolution/normalize";

/**
 * Presentation only. Every number here comes from the prebuilt report view
 * model; this component performs no analysis, so the table page below cannot
 * influence any statistic above it.
 */

const PAGE_SIZE=10;
const NOT_ESTIMABLE="Not estimable";
const UNAVAILABLE="Unavailable";

const days=(x:number|null)=>x===null?NOT_ESTIMABLE:`${x.toFixed(1)}`;
const usd=(x:number|null)=>x===null?UNAVAILABLE:`${x<0?"-":""}$${Math.abs(x).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const pct=(part:number,whole:number)=>whole>0?`${(part/whole*100).toFixed(1)}%`:"—";
const rangeX=(x:number|null)=>x===null?UNAVAILABLE:`${x.toFixed(2)}x`;

const OUTCOME_LABEL:Record<string,string>={vpoc_first:"Successful",invalidation_first:"Failed",ambiguous:"Ambiguous",unresolved:"Unresolved"};

function Card({label,value,detail,tone}:{label:string;value:string;detail?:string;tone?:string}){
 return <div className="ur-card"><span className="ur-card-label">{label}</span><strong className={`ur-card-value${tone?` ${tone}`:""}`}>{value}</strong>{detail&&<small>{detail}</small>}</div>;
}

/** Step plot of the Kaplan-Meier event-free probability with its confidence band. */
function SurvivalChart({report}:{report:UnderlyingResolutionReport}){
 const curve=report.survival;
 if(curve.length<2)return <div className="ur-empty">Insufficient sample to estimate an event-free probability curve.</div>;
 const maxTime=Math.max(...curve.map(p=>p.timeDays))||1;
 const x=(t:number)=>t/maxTime*100,y=(s:number)=>40-s*36;
 let path=`M 0 ${y(1)}`,band="";
 for(const point of curve)path+=` L ${x(point.timeDays)} ${y(curve[curve.indexOf(point)-1]?.survival??1)} L ${x(point.timeDays)} ${y(point.survival)}`;
 const withBand=curve.filter(p=>p.lower!==null&&p.upper!==null);
 if(withBand.length>1){
  band="M "+withBand.map(p=>`${x(p.timeDays)} ${y(p.upper!)}`).join(" L ")
   +" L "+[...withBand].reverse().map(p=>`${x(p.timeDays)} ${y(p.lower!)}`).join(" L ")+" Z";
 }
 return <figure className="ur-chart" aria-label="Kaplan-Meier event-free probability">
  <svg viewBox="0 0 100 44" preserveAspectRatio="none" role="img">
   {band&&<path className="ur-band" d={band}/>}
   <path className="ur-curve" d={path}/>
  </svg>
  <figcaption>Event-free probability S(t): chance an MR event has <em>not</em> yet reached first resolution by t. Shaded band is the 95% log-log interval where estimable. Horizontal axis 0–{maxTime.toFixed(1)} days.</figcaption>
 </figure>;
}

/** Honest small-sample distribution: a count histogram of actual observed times. */
function Histogram({series}:{series:readonly {label:string;days:readonly number[]}[]}){
 const all=series.flatMap(s=>s.days);
 if(!all.length)return <div className="ur-empty">No observed resolutions to distribute.</div>;
 const max=Math.max(...all)||1,bins=6;
 return <div className="ur-hist">{series.map(s=>{
  if(!s.days.length)return <div key={s.label} className="ur-hist-row"><span>{s.label}</span><em className="ur-muted">Insufficient sample</em></div>;
  const counts=Array.from({length:bins},(_,i)=>s.days.filter(d=>{const lo=i*max/bins,hi=(i+1)*max/bins;return i===bins-1?d>=lo&&d<=hi:d>=lo&&d<hi}).length);
  const peak=Math.max(...counts)||1;
  return <div key={s.label} className="ur-hist-row"><span>{s.label}</span>
   <div className="ur-bars">{counts.map((c,i)=><i key={i} style={{height:`${c/peak*100}%`}} title={`${c} event(s)`}/>)}</div>
   <em>n={s.days.length}</em></div>;
 })}<small className="ur-axis">0 – {max.toFixed(1)} days (time to first resolution)</small></div>;
}

function CohortTable({rows,caption}:{rows:readonly CohortRow[];caption:string}){
 return <div className="table-scroll"><table className="ur-table"><caption className="ur-caption">{caption}</caption>
  <thead><tr><th>Cohort</th><th>Effective N</th><th>Observed</th><th>Censored</th><th>VPOC</th><th>Invalidation</th><th>Ambiguous</th><th>Median MFE</th><th>Median MAE</th></tr></thead>
  <tbody>{rows.map(r=><tr key={r.label}>
   <td>{r.label}</td><td>{r.effectiveN}</td><td>{r.observed}</td><td>{r.censored}</td>
   <td>{r.counts.vpocFirst}</td><td>{r.counts.invalidationFirst}</td><td>{r.counts.ambiguous}</td>
   <td className={r.medianMfeUsd===null?"ur-muted":"positive"}>{usd(r.medianMfeUsd)}</td>
   <td className={r.medianMaeUsd===null?"ur-muted":"negative"}>{usd(r.medianMaeUsd)}</td>
  </tr>)}</tbody></table>
  {rows.some(r=>r.excursionUnavailable>0)&&<small className="ur-note">MFE/MAE unavailable for {rows.reduce((n,r)=>n+r.excursionUnavailable,0)} event(s) with no stored hourly path.</small>}
 </div>;
}

function EventRow({event}:{event:NormalizedMrEvent}){
 return <tr>
  <td>{event.eventId}</td>
  <td>{event.entryDateUtc??UNAVAILABLE}</td>
  <td className={event.direction==="long"?"positive":event.direction==="short"?"negative":"ur-muted"}>{event.direction==="long"?"Bullish":event.direction==="short"?"Bearish":UNAVAILABLE}</td>
  <td>{event.entryPrice===null?UNAVAILABLE:event.entryPrice.toLocaleString()}</td>
  <td>{usd(event.rangeWidthUsd)}</td>
  <td>{usd(event.remainingDistanceUsd)} {event.remainingDistanceRange!==null&&<small className="ur-muted">({rangeX(event.remainingDistanceRange)})</small>}</td>
  <td>{event.timeToVpocDays===null?"—":days(event.timeToVpocDays)}</td>
  <td>{event.timeToInvalidationDays===null?"—":days(event.timeToInvalidationDays)}</td>
  <td>{event.timeToResolutionDays===null?"—":days(event.timeToResolutionDays)}</td>
  <td className={event.excursion===null?"ur-muted":"positive"}>{event.excursion===null?UNAVAILABLE:usd(event.excursion.mfeUsd)}</td>
  <td className={event.excursion===null?"ur-muted":"negative"}>{event.excursion===null?UNAVAILABLE:usd(event.excursion.maeUsd)}</td>
  <td><em className={`ur-outcome ${event.outcome}`}>{OUTCOME_LABEL[event.outcome]}</em>{event.ineligibility&&<small className="ur-muted"> · {event.ineligibility.replaceAll("_"," ")}</small>}</td>
 </tr>;
}

export function UnderlyingResolutionReportView({report}:{report:UnderlyingResolutionReport}){
 const [page,setPage]=useState(0);
 const pages=Math.max(1,Math.ceil(report.events.length/PAGE_SIZE));
 const current=Math.min(page,pages-1);
 const rows=report.events.slice(current*PAGE_SIZE,(current+1)*PAGE_SIZE);
 const n=report.effectiveN;

 return <section className="workspace-section ur-report" data-testid="underlying-resolution-report">
  <div className="section-heading"><div>
   <p className="eyebrow">0 · Underlying market analysis, before any options analysis</p>
   <h2>Underlying Resolution Before Options</h2>
   <p className="ur-sub">How long the underlying MR thesis takes to resolve through VPOC or invalidation.</p>
  </div><div className="ur-meta"><small>All times in calendar days</small><small>Effective N {n} of {report.totalEvents} MR events</small></div></div>

  {report.excludedByReason.length>0&&<p className="resolution-banner">{report.excludedByReason.map(x=>`${x.count} event(s) ${x.reason.replaceAll("_"," ")}`).join("; ")} — held out of time-to-event analysis and never counted as failures.</p>}

  <div className="ur-cards">
   <Card label="Total Events" value={String(report.totalEvents)} detail={`${n} eligible`}/>
   <Card label="VPOC Before Invalidation" value={String(report.counts.vpocFirst)} detail={pct(report.counts.vpocFirst,n)} tone="positive"/>
   <Card label="Invalidation Before VPOC" value={String(report.counts.invalidationFirst)} detail={pct(report.counts.invalidationFirst,n)} tone="negative"/>
   <Card label="Ambiguous (simultaneous)" value={String(report.counts.ambiguous)} detail={pct(report.counts.ambiguous,n)}/>
   <Card label="Neither Reached (Unresolved)" value={String(report.counts.unresolved)} detail={pct(report.counts.unresolved,n)}/>
  </div>

  <div className="ur-percentiles">{report.timeToEvent.map(block=><div key={block.endpoint} className="ur-card">
   <span className="ur-card-label">{block.label} (days)</span>
   <div className="ur-p-grid">{block.percentiles.map(p=><div key={p.p}><small>P{Math.round(p.p*100)}</small><strong className={p.days===null?"ur-muted":undefined}>{days(p.days)}</strong></div>)}</div>
   <small>{block.observed} observed · {block.censored} censored</small>
  </div>)}</div>

  <div className="ur-grid-2">
   <div className="card"><h3>Event-free probability (Kaplan-Meier)</h3><SurvivalChart report={report}/></div>
   <div className="card"><h3>Successful vs Failed MR events</h3><Histogram series={report.resolutionTimesByOutcome}/></div>
   <div className="card"><h3>By remaining distance to VPOC</h3><Histogram series={report.resolutionTimesByDistance}/><small className="ur-note">Canonical vpoc_distance expressed in range widths (× range). ATR is not part of the canonical bundle.</small></div>
   <div className="card"><h3>By direction</h3><Histogram series={report.resolutionTimesByDirection}/></div>
  </div>

  <div className="table-scroll"><table className="ur-table"><caption className="ur-caption">Outcome breakdown by direction</caption>
   <thead><tr><th>Direction</th><th>VPOC before invalidation</th><th>Invalidation before VPOC</th><th>Ambiguous</th><th>Unresolved</th><th>Effective N</th></tr></thead>
   <tbody>{report.directional.map(row=><tr key={row.direction} className={row.direction==="total"?"ur-total":undefined}>
    <td>{row.label}</td>
    <td>{row.counts.vpocFirst} <small className="ur-muted">{pct(row.counts.vpocFirst,row.effectiveN)}</small></td>
    <td>{row.counts.invalidationFirst} <small className="ur-muted">{pct(row.counts.invalidationFirst,row.effectiveN)}</small></td>
    <td>{row.counts.ambiguous} <small className="ur-muted">{pct(row.counts.ambiguous,row.effectiveN)}</small></td>
    <td>{row.counts.unresolved} <small className="ur-muted">{pct(row.counts.unresolved,row.effectiveN)}</small></td>
    <td>{row.effectiveN}</td>
   </tr>)}</tbody></table></div>

  <CohortTable rows={report.distanceCohorts} caption="Remaining-distance cohorts (descriptive, not optimized thresholds)"/>
  <CohortTable rows={report.speedCohorts} caption="Resolution-speed cohorts (descriptive, not optimized thresholds)"/>

  <div className="table-scroll"><table className="ur-table"><caption className="ur-caption">Event-level summary</caption>
   <thead><tr><th>Event ID</th><th>Date</th><th>Direction</th><th>Entry</th><th>Range width</th><th>Remaining dist. to VPOC</th><th>T_VPOC</th><th>T_Inv</th><th>T_Resolution</th><th>MFE</th><th>MAE</th><th>Outcome</th></tr></thead>
   <tbody>{rows.map(event=><EventRow key={event.eventId} event={event}/>)}</tbody></table></div>
  <div className="ur-pager">
   <small>Showing {report.events.length?current*PAGE_SIZE+1:0}–{Math.min((current+1)*PAGE_SIZE,report.events.length)} of {report.events.length} events. Paging never changes the statistics above.</small>
   <div><button disabled={current<=0} onClick={()=>setPage(current-1)}>Previous</button><span>{current+1} / {pages}</span><button disabled={current>=pages-1} onClick={()=>setPage(current+1)}>Next</button></div>
  </div>

  <details className="ur-methodology"><summary>Methodology, censoring and missing data</summary>
   {report.methodology.map((line,i)=><p className="fine-print" key={i}>{line}</p>)}
  </details>
 </section>;
}
