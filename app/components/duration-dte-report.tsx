"use client";
import {useState} from "react";
import type {
 CaptureThresholdRow,DteBufferRow,DurationDteReport,OutcomeBeforeExpiryRow,OverviewRow,PnlByOutcomeRow,
} from "../lib/duration-dte/report";
import type {DteCandidate,OutcomeBeforeExpiry} from "../lib/duration-dte/normalize";

/**
 * Presentation only. Every number comes from the prebuilt Duration & DTE view
 * model; this file performs no analysis, and event-table pagination cannot
 * reach any statistic above it.
 */

const PAGE_SIZE=10;
const NOT_ESTIMABLE="Not estimable";
const UNAVAILABLE="Unavailable";

const d1=(x:number)=>x.toFixed(1);
const days=(x:number|null)=>x===null?NOT_ESTIMABLE:`${d1(x)}d`;
const usd=(x:number|null)=>x===null?UNAVAILABLE:`${x<0?"−":""}$${Math.abs(x).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const pct=(x:number|null)=>x===null?NOT_ESTIMABLE:`${(x*100).toFixed(1)}%`;
const OUTCOME_LABEL:Record<OutcomeBeforeExpiry,string>={vpoc_before_expiry:"VPOC before expiry",invalidation_before_expiry:"Invalidation before expiry",ambiguous_before_expiry:"Ambiguous before expiry",no_resolution_before_expiry:"No resolution before expiry"};
const OUTCOME_TONE:Record<OutcomeBeforeExpiry,string>={vpoc_before_expiry:"positive",invalidation_before_expiry:"negative",ambiguous_before_expiry:"warn",no_resolution_before_expiry:"warn"};

function HeadlineCard({label,value,detail}:{label:string;value:string;detail?:string}){
 return <div className="dd-card"><span className="dd-label">{label}</span><strong>{value}</strong>{detail&&<small className="dd-muted">{detail}</small>}</div>;
}

/* ---------- 2. DTE Overview ---------- */

function OverviewTable({rows}:{rows:readonly OverviewRow[]}){
 return <div className="table-scroll"><table className="dd-table">
  <thead><tr><th>Horizon</th><th>Actual DTE (median / range)</th><th>N</th><th>Generated</th><th>Priced</th><th>Taker exec.</th><th>Res. coverage</th><th>No res. before expiry</th><th>Median buffer</th><th>Median T50%</th><th>Capital-day return</th></tr></thead>
  <tbody>{rows.map(r=><tr key={r.horizon.nominalDays}>
   <td>{r.horizon.label}{r.horizon.eligibleDteRange&&<small className="dd-muted"> ({r.horizon.eligibleDteRange.min}–{r.horizon.eligibleDteRange.max}d)</small>}</td>
   <td>{r.actualDte?`${d1(r.actualDte.median)}d (${d1(r.actualDte.min)}–${d1(r.actualDte.max)}d)`:NOT_ESTIMABLE}</td>
   <td>{r.selectedN}</td>
   <td>{pct(r.candidatesGeneratedShare)}</td>
   <td>{pct(r.pricedShare)}</td>
   <td>{pct(r.takerExecutableShare)}</td>
   <td className={r.resolutionCoverageShare===null?"dd-muted":"positive"}>{pct(r.resolutionCoverageShare)}</td>
   <td className={r.noResolutionBeforeExpiryShare===null?"dd-muted":"negative"}>{pct(r.noResolutionBeforeExpiryShare)}</td>
   <td>{days(r.medianDteBufferDays)}</td>
   <td>{days(r.medianTimeToCapture50Days)}</td>
   <td>{r.medianCapitalDayReturn===null?UNAVAILABLE:r.medianCapitalDayReturn.toFixed(3)}</td>
  </tr>)}</tbody>
 </table></div>;
}

/* ---------- 3. Availability & Executability ---------- */

function CoverageFunnel({report}:{report:DurationDteReport}){
 return <div className="dd-funnel">{report.availability.map(a=><div key={a.nominalDays} className="dd-funnel-row">
  <span>{a.label}</span>
  <div className="dd-funnel-bars">
   {([["All events",a.totalEvents,a.totalEvents],["Generated",a.candidatesGenerated,a.totalEvents],["Priced",a.priced,a.totalEvents],["Taker exec.",a.takerExecutable,a.totalEvents],["Maker opp.",a.makerOpportunity,a.totalEvents]] as const).map(([label,n,whole])=>
    <div key={label} className="dd-funnel-bar"><small>{label}</small><div className="dd-funnel-track"><i style={{width:`${whole>0?n/whole*100:0}%`}}/></div><em>{n} · {pct(whole>0?n/whole:null)}</em></div>)}
  </div>
 </div>)}
 <small className="dd-note">&ldquo;Generated&rdquo; and &ldquo;Priced&rdquo; collapse the canonical bundle&rsquo;s single per-candidate availability status; eligible-expiry and both-legs-available are not separately recorded. Maker opportunity is not confirmed execution.</small>
</div>;
}

function EntryQualityBars({report}:{report:DurationDteReport}){
 return <div className="dd-quality">{report.availability.map(a=>{
  const total=a.entryQuality.green+a.entryQuality.yellow+a.entryQuality.red+a.entryQuality.unavailable;
  return <div key={a.nominalDays} className="dd-quality-row"><span>{a.label}</span>
   <div className="dd-quality-bar">
    {(["green","yellow","red","unavailable"] as const).map(k=>total>0&&a.entryQuality[k]>0?<i key={k} className={`dd-q-${k}`} style={{width:`${a.entryQuality[k]/total*100}%`}} title={`${k}: ${a.entryQuality[k]}`}/>:null)}
   </div>
   <em>{total?`${a.entryQuality.green}G / ${a.entryQuality.yellow}Y / ${a.entryQuality.red}R`:NOT_ESTIMABLE}</em>
  </div>;
 })}</div>;
}

function SynchronizationTable({report}:{report:DurationDteReport}){
 return <div className="table-scroll"><table className="dd-table dd-compact">
  <thead><tr><th>Horizon</th><th>Median sync (min)</th><th>Worst (95th pct.)</th><th>N</th></tr></thead>
  <tbody>{report.availability.map(a=>{
   const sorted=[...a.synchronizationMinutes].sort((x,y)=>x-y);
   const med=sorted.length?sorted[Math.floor((sorted.length-1)/2)]!:null;
   const worst=sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*0.95)-1)]!:null;
   return <tr key={a.nominalDays}><td>{a.label}</td><td>{med===null?NOT_ESTIMABLE:`${med.toFixed(2)}m`}</td><td>{worst===null?NOT_ESTIMABLE:`${worst.toFixed(2)}m`}</td><td>{sorted.length}</td></tr>;
  })}</tbody>
 </table></div>;
}

/* ---------- 4. Thesis survival vs actual DTE (centrepiece) ---------- */

const W=880,H=300,ML=54,MR=18,MT=16,MB=42;

function CoverageChart({report}:{report:DurationDteReport}){
 const curve=report.coverageCurve;
 if(curve.length<2)return <div className="dd-empty">{NOT_ESTIMABLE} — no eligible events with a usable observation window.</div>;
 const maxT=Math.max(...curve.map(p=>p.timeDays),...report.horizons.flatMap(h=>h.eligibleDteRange?[h.eligibleDteRange.max]:[]))||1;
 const px=(t:number)=>ML+t/maxT*(W-ML-MR),py=(c:number)=>MT+(1-c)*(H-MT-MB);
 let path=`M ${px(0)} ${py(0)}`,prev=0;
 for(const point of curve.slice(1)){path+=` L ${px(point.timeDays)} ${py(prev)} L ${px(point.timeDays)} ${py(point.coverage)}`;prev=point.coverage}
 path+=` L ${px(maxT)} ${py(prev)}`;
 const banded=curve.filter(p=>p.lower!==null&&p.upper!==null);
 const band=banded.length>1?"M "+banded.map(p=>`${px(p.timeDays)} ${py(p.upper!)}`).join(" L ")+" L "+[...banded].reverse().map(p=>`${px(p.timeDays)} ${py(p.lower!)}`).join(" L ")+" Z":"";
 const yTicks=[0,0.25,0.5,0.75,1],xTicks=Array.from({length:5},(_,i)=>maxT*i/4);
 return <>
  <figure className="dd-chart">
   <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="MR first-resolution coverage versus actual DTE">
    {report.horizons.map(h=>h.eligibleDteRange&&<rect key={h.nominalDays} className="dd-band-ref" x={px(h.eligibleDteRange.min)} width={Math.max(px(h.eligibleDteRange.max)-px(h.eligibleDteRange.min),1)} y={MT} height={H-MT-MB}>
     <title>{`${h.label} eligible DTE ${h.eligibleDteRange.min}–${h.eligibleDteRange.max}d`}</title>
    </rect>)}
    {yTicks.map(t=><g key={t}><line className="dd-grid" x1={ML} x2={W-MR} y1={py(t)} y2={py(t)}/><text className="dd-tick" x={ML-9} y={py(t)+4} textAnchor="end">{(t*100).toFixed(0)}%</text></g>)}
    {xTicks.map(t=><text key={t} className="dd-tick" x={px(t)} y={H-MB+20} textAnchor="middle">{d1(t)}</text>)}
    {band&&<path className="dd-band" d={band}/>}
    <path className="dd-curve" d={path}/>
    {curve.slice(1).map(p=><circle key={p.timeDays} className="dd-step-dot" cx={px(p.timeDays)} cy={py(p.coverage)} r={3}><title>{`DTE=${d1(p.timeDays)}d · coverage=${(p.coverage*100).toFixed(1)}%`}</title></circle>)}
    <line className="dd-axis" x1={ML} x2={ML} y1={MT} y2={H-MB}/>
    <line className="dd-axis" x1={ML} x2={W-MR} y1={H-MB} y2={H-MB}/>
    <text className="dd-axis-label" x={W/2} y={H-6} textAnchor="middle">Actual DTE (days)</text>
   </svg>
  </figure>
  <div className="dd-legend">{report.horizons.map(h=><span key={h.nominalDays} className="dd-band-swatch">{h.label}{h.eligibleDteRange&&` (${h.eligibleDteRange.min}–${h.eligibleDteRange.max}d)`}</span>)}</div>
  <small className="dd-note">Same Kaplan-Meier curve as Underlying Resolution, relabelled as coverage = 1 − S(t). Shaded regions are each horizon family&rsquo;s configured eligible DTE range, shown for reference only.</small>
 </>;
}

/* ---------- 5. Outcome before expiry ---------- */

function OutcomeBeforeExpiryBars({rows}:{rows:readonly OutcomeBeforeExpiryRow[]}){
 return <div className="dd-stacked">{rows.map(r=><div key={r.horizon.nominalDays} className="dd-stacked-row"><span>{r.horizon.label}</span>
  <div className="dd-stacked-bar">{(["vpoc_before_expiry","invalidation_before_expiry","ambiguous_before_expiry","no_resolution_before_expiry"] as const).map(k=>r.counts[k]>0&&r.determinateN>0?
   <i key={k} className={`dd-o-${k}`} style={{width:`${r.counts[k]/r.determinateN*100}%`}} title={`${OUTCOME_LABEL[k]}: ${r.counts[k]}`}/>:null)}</div>
  <em>n={r.determinateN}{r.notDeterminableN>0&&<small className="dd-muted"> · {r.notDeterminableN} not determinable</small>}</em>
 </div>)}
 <div className="dd-legend">{(["vpoc_before_expiry","invalidation_before_expiry","ambiguous_before_expiry","no_resolution_before_expiry"] as const).map(k=><span key={k} className={`dd-legend-${OUTCOME_TONE[k]}`}>{OUTCOME_LABEL[k]}</span>)}</div>
 </div>;
}

/* ---------- 6. DTE buffer ---------- */

function BufferStrip({rows}:{rows:readonly DteBufferRow[]}){
 const all=rows.flatMap(r=>r.values);
 if(!all.length)return <div className="dd-empty">No resolved events with a known actual DTE to compute a buffer.</div>;
 const max=Math.max(...all.map(Math.abs))||1;
 const x=(v:number)=>50+v/(max*1.1)*50;
 return <div className="dd-strips">
  <div className="dd-strip-zero" style={{left:"50%"}}/>
  {rows.map(r=>{
   if(!r.summary)return <div key={r.horizon.nominalDays} className="dd-strip-row"><span>{r.horizon.label}</span><em className="dd-muted">No resolved events</em></div>;
   const box=r.summary.n>=4;
   return <div key={r.horizon.nominalDays} className="dd-strip-row"><span>{r.horizon.label}</span>
    <div className="dd-strip">
     {box&&<i className="ur-iqr" style={{left:`${x(r.summary.q1)}%`,width:`${Math.max(x(r.summary.q3)-x(r.summary.q1),0.5)}%`}}/>}
     {r.values.map((v,i)=><i key={i} className={`dd-obs${v<0?" negative-dot":""}`} style={{left:`${x(v)}%`}} title={`${d1(v)}d buffer`}/>)}
     <i className="ur-median" style={{left:`${x(r.summary.median)}%`}} title={`median ${d1(r.summary.median)}d`}/>
    </div>
    <em>median {days(r.summary.median)} · n={r.summary.n}</em>
   </div>;
  })}
  <small className="dd-note">Positive = time remaining after resolution. Negative = the thesis resolved after this candidate&rsquo;s actual expiry. Axis spans ±{d1(max*1.1)} days.</small>
 </div>;
}

/* ---------- 7. Credit capture ---------- */

function CaptureSection({report}:{report:DurationDteReport}){
 const [threshold,setThreshold]=useState<25|50|70>(50);
 const rows=report.captureByThreshold[threshold];
 return <>
  <div className="dd-tabs" role="tablist">{([25,50,70] as const).map(t=><button key={t} role="tab" aria-selected={t===threshold} className={t===threshold?"dd-tab-active":undefined} onClick={()=>setThreshold(t)}>{t}%</button>)}</div>
  <div className="table-scroll"><table className="dd-table dd-compact">
   <thead><tr><th>Horizon</th><th>Reached</th><th>Median time to capture</th><th>Before VPOC</th><th>Before invalidation</th></tr></thead>
   <tbody>{rows.map((r:CaptureThresholdRow)=>{
    const sorted=[...r.timeToCaptureDays].sort((a,b)=>a-b),med=sorted.length?sorted[Math.floor((sorted.length-1)/2)]!:null;
    return <tr key={r.horizon.nominalDays}><td>{r.horizon.label}</td>
     <td>{r.totalN?`${r.reachedN} / ${r.totalN} (${(r.reachedN/r.totalN*100).toFixed(0)}%)`:NOT_ESTIMABLE}</td>
     <td>{days(med)}</td><td>{pct(r.beforeVpocShare)}</td><td>{pct(r.beforeInvalidationShare)}</td>
    </tr>;
   })}</tbody>
  </table></div>
  <small className="dd-note">Capture timestamps use canonical valuation/outcome evidence only; a threshold never reached leaves its time Not estimable, never zero.</small>
 </>;
}

/* ---------- 8. PnL by MR outcome ---------- */

function PnlSection({rows}:{rows:readonly PnlByOutcomeRow[]}){
 return <div className="table-scroll"><table className="dd-table dd-compact">
  <thead><tr><th>Horizon</th><th>Bucket</th><th>N (priced)</th><th>Median PnL</th><th>Median worst adverse</th></tr></thead>
  <tbody>{rows.flatMap(r=>r.buckets.map(b=>{
   const sorted=[...b.pnlUsd].sort((x,y)=>x-y),med=sorted.length?sorted[Math.floor((sorted.length-1)/2)]!:null;
   const adverseSorted=[...b.worstAdverseUsd].sort((x,y)=>x-y),medAdverse=adverseSorted.length?adverseSorted[Math.floor((adverseSorted.length-1)/2)]!:null;
   return <tr key={`${r.horizon.nominalDays}-${b.label}`}><td>{r.horizon.label}</td><td>{b.label}</td><td>{b.pnlUsd.length}</td>
    <td className={med===null?"dd-muted":med>=0?"positive":"negative"}>{usd(med)}</td>
    <td className={medAdverse===null?"dd-muted":"negative"}>{usd(medAdverse)}</td>
   </tr>;
  }))}</tbody>
 </table></div>;
}

/* ---------- 9. Capital-time efficiency ---------- */

function CapitalTimeSection({report}:{report:DurationDteReport}){
 const c=report.capitalTime;
 if(!c.available)return <p className="dd-empty-inline">{UNAVAILABLE} — {c.reason}</p>;
 return <div className="dd-endpoints">
  <div className="dd-endpoint"><span className="dd-label">Median holding period</span><strong>{days(c.medianHoldingDays)}</strong></div>
  <div className="dd-endpoint"><span className="dd-label">Median capital-days</span><strong>{c.medianCapitalDays===null?UNAVAILABLE:c.medianCapitalDays.toFixed(1)}</strong></div>
  <div className="dd-endpoint"><span className="dd-label">Median capital-day return</span><strong>{c.medianCapitalDayReturn===null?UNAVAILABLE:c.medianCapitalDayReturn.toFixed(4)}</strong></div>
 </div>;
}

/* ---------- 10. Actual DTE distribution ---------- */

function DteHistogram({report}:{report:DurationDteReport}){
 const values=report.actualDteAll;
 if(!values.length)return <div className="dd-empty">No selected structure has a known actual DTE.</div>;
 const max=Math.max(...values,...report.horizons.flatMap(h=>h.eligibleDteRange?[h.eligibleDteRange.max]:[]))||1,bins=24;
 const counts=Array.from({length:bins},(_,i)=>values.filter(v=>{const lo=i*max/bins,hi=(i+1)*max/bins;return i===bins-1?v>=lo&&v<=hi:v>=lo&&v<hi}).length);
 const peak=Math.max(...counts)||1;
 return <div className="dd-hist"><div className="dd-hist-bars">{counts.map((c,i)=><i key={i} style={{height:`${c/peak*100}%`}} title={`${c} structure(s)`}/>)}</div>
  <small className="dd-note">0 – {d1(max)} days actual DTE across {values.length} selected structure(s). Horizon families: {report.horizons.map(h=>h.label).join(", ")}.</small>
 </div>;
}

/* ---------- 11. event-level audit ---------- */

function EventRow({c}:{c:DteCandidate}){
 return <tr>
  <td>{c.eventId}</td>
  <td>{c.horizonNominalDays===null?"—":`~${c.horizonNominalDays}D`}</td>
  <td>{c.actualDteDays===null?UNAVAILABLE:d1(c.actualDteDays)}</td>
  <td>{c.entryQuality??UNAVAILABLE}</td>
  <td>{c.executionMode??UNAVAILABLE}</td>
  <td>{c.timeToResolutionDays===null?"—":d1(c.timeToResolutionDays)}</td>
  <td>{c.underlyingOutcome.replaceAll("_"," ")}</td>
  <td>{c.outcomeBeforeExpiry?OUTCOME_LABEL[c.outcomeBeforeExpiry]:"—"}</td>
  <td className={c.dteBufferDays===null?"dd-muted":c.dteBufferDays<0?"negative":"positive"}>{c.dteBufferDays===null?"—":d1(c.dteBufferDays)}</td>
  <td>{c.capture50?.reached?days(c.capture50.timeToCaptureDays):c.capture50===null?UNAVAILABLE:"not reached"}</td>
  <td className={c.pnlAtVpocUsd===null?"dd-muted":"positive"}>{usd(c.pnlAtVpocUsd)}</td>
  <td className={c.pnlAtInvalidationUsd===null?"dd-muted":"negative"}>{usd(c.pnlAtInvalidationUsd)}</td>
  <td className={c.worstAdverseUsd===null?"dd-muted":"negative"}>{usd(c.worstAdverseUsd)}</td>
 </tr>;
}

/* ---------- report ---------- */

export function DurationDteReportView({report}:{report:DurationDteReport}){
 const [page,setPage]=useState(0);
 const pages=Math.max(1,Math.ceil(report.candidates.length/PAGE_SIZE));
 const current=Math.min(page,pages-1);
 const rows=report.candidates.slice(current*PAGE_SIZE,(current+1)*PAGE_SIZE);
 const h=report.headline;

 return <section className="workspace-section dd-report" data-testid="duration-dte-report">
  <header className="dd-header">
   <div>
    <p className="eyebrow">Options structure analysis · after underlying resolution</p>
    <h2>Duration &amp; DTE Analysis</h2>
    <p className="dd-sub">How much time does the option structure need for the underlying MR thesis to resolve?</p>
    <p className="dd-note">All analysis uses actual selected contract DTE; horizon labels are grouping bands only.</p>
   </div>
   <div className="dd-horizons">{report.horizons.map(hz=><span key={hz.nominalDays} className="dd-horizon-pill">{hz.label}{hz.eligibleDteRange&&<small> {hz.eligibleDteRange.min}–{hz.eligibleDteRange.max}d</small>}</span>)}</div>
  </header>

  {report.excludedIneligible>0&&<p className="dd-notice">{report.excludedIneligible} structure(s) excluded — their underlying MR event is ineligible for time-to-event analysis, never counted as a resolution or a failure.</p>}

  <div className="dd-cards">
   <HeadlineCard label="Effective MR events" value={String(h.effectiveEvents)} detail={h.totalEvents!==h.effectiveEvents?`of ${h.totalEvents}`:"100% of dataset"}/>
   <HeadlineCard label="Taker executable" value={pct(h.takerExecutableShare)}/>
   <HeadlineCard label="Median actual DTE" value={h.medianActualDteDays===null?NOT_ESTIMABLE:`${d1(h.medianActualDteDays)}d`}/>
   <HeadlineCard label="No resolution before expiry" value={pct(h.noResolutionBeforeExpiryShare)}/>
   <HeadlineCard label="Median T resolution" value={days(h.medianFirstResolutionDays)}/>
  </div>

  <section className="dd-block"><h3>1 · DTE overview</h3><OverviewTable rows={report.overview}/></section>

  <section className="dd-block"><h3>2 · Availability &amp; executability</h3>
   <div className="dd-two-col">
    <div><h4 className="dd-subhead">Coverage funnel</h4><CoverageFunnel report={report}/></div>
    <div><h4 className="dd-subhead">Entry quality</h4><EntryQualityBars report={report}/><h4 className="dd-subhead">Leg synchronization</h4><SynchronizationTable report={report}/></div>
   </div>
  </section>

  <section className="dd-block dd-centerpiece"><h3>3 · Thesis survival vs actual DTE</h3><CoverageChart report={report}/></section>

  <section className="dd-block"><h3>4 · Outcome before expiry</h3><OutcomeBeforeExpiryBars rows={report.outcomeBeforeExpiry}/></section>

  <div className="dd-two-col">
   <section className="dd-block"><h3>5 · DTE buffer</h3><BufferStrip rows={report.dteBuffer}/></section>
   <section className="dd-block"><h3>6 · Credit capture</h3><CaptureSection report={report}/></section>
  </div>

  <section className="dd-block"><h3>7 · PnL by MR outcome</h3><PnlSection rows={report.pnlByOutcome}/></section>

  <div className="dd-two-col">
   <section className="dd-block"><h3>8 · Capital-time efficiency</h3><CapitalTimeSection report={report}/></section>
   <section className="dd-block"><h3>9 · Actual DTE distribution</h3><DteHistogram report={report}/></section>
  </div>

  <section className="dd-block">
   <h3>Event-level observations</h3>
   <p className="dd-sub">Inspect the individual selected structures underlying this report.</p>
   <div className="table-scroll"><table className="dd-table">
    <thead><tr><th>Event</th><th>Horizon</th><th>Actual DTE</th><th>Quality</th><th>Mode</th><th>T_Res</th><th>Underlying outcome</th><th>Resolved before expiry</th><th>DTE buffer</th><th>T50%</th><th>PnL@VPOC</th><th>PnL@Inv.</th><th>Worst adverse</th></tr></thead>
    <tbody>{rows.map(c=><EventRow key={c.candidateId} c={c}/>)}</tbody>
   </table></div>
   <div className="ur-pager">
    <small>Showing {report.candidates.length?current*PAGE_SIZE+1:0}–{Math.min((current+1)*PAGE_SIZE,report.candidates.length)} of {report.candidates.length}. Paging never changes the statistics above.</small>
    <div><button disabled={current<=0} onClick={()=>setPage(current-1)}>Previous</button><span>{current+1} / {pages}</span><button disabled={current>=pages-1} onClick={()=>setPage(current+1)}>Next</button></div>
   </div>
  </section>

  <details className="ur-methodology"><summary>Methodology, availability and missing data</summary>
   {report.methodology.map((line,i)=><p className="fine-print" key={i}>{line}</p>)}
  </details>
 </section>;
}
