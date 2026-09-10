"use client";
import type {AnalysisConfiguration,PrimaryExitPolicy} from "../lib/analysis-configuration";
import {CAPITAL_BASIS_COMPATIBILITY_NOTE,CAPITAL_BASIS_LABELS} from "../lib/analytical-track-layers";

const EXIT_POLICIES=["thesis","capture_50","capture_70","time_cap_3d","time_cap_5d","time_cap_7d","settlement_benchmark"] as const;

export function ResearchControls({value,researchExitPolicy,onChange,onResearchExitPolicyChange}:{value:AnalysisConfiguration;researchExitPolicy:PrimaryExitPolicy|null;onChange:(next:AnalysisConfiguration)=>void;onResearchExitPolicyChange:(next:PrimaryExitPolicy|null)=>void}){
 const set=<K extends keyof AnalysisConfiguration>(key:K,next:AnalysisConfiguration[K])=>onChange({...value,[key]:next});
 return <details className="workspace-section scoped-controls" data-testid="research-controls"><summary><strong>Research Controls</strong><small>Duration/DTE and Exit report inputs</small></summary><p className="dd-note">Exploratory analytical controls only. These settings do not define a completed strategy or change another report&apos;s analytical track.</p><div className="analytics-form-grid">
  <label>Holding-period valuation track<small className="dd-note">Duration &amp; DTE operational holding only.</small><select value={value.pricingTrack??""} onChange={event=>set("pricingTrack",event.target.value as AnalysisConfiguration["pricingTrack"]||null)}><option value="">Not configured</option><option value="raw_vwap">Raw VWAP</option><option value="iv_normalized">IV normalized</option></select></label>
  <label>Minimum valuation confidence<select value={value.includedQualityLevels.join(",")} onChange={event=>set("includedQualityLevels",event.target.value?event.target.value.split(","):[])}><option value="">All (no confidence exclusion)</option><option value="green,yellow">Medium or better</option><option value="green">High only</option></select></label>
  <label>Duration capital basis<small className="dd-note">Duration &amp; DTE only.</small><select value={value.capitalBasis} onChange={event=>set("capitalBasis",event.target.value as AnalysisConfiguration["capitalBasis"])}>{Object.entries(CAPITAL_BASIS_LABELS).map(([token,label])=><option key={token} value={token}>{label}</option>)}</select></label>
  <label>Research exit policy<select value={researchExitPolicy??""} onChange={event=>onResearchExitPolicyChange(event.target.value as PrimaryExitPolicy||null)}><option value="">Required</option>{EXIT_POLICIES.map(policy=><option key={policy}>{policy}</option>)}</select></label>
  <label>Near-full-loss fraction<input type="number" min="0" max="1" step="0.01" value={value.nearFullLossFraction??""} onChange={event=>set("nearFullLossFraction",event.target.value===""?null:Number(event.target.value))} placeholder="Not configured"/></label>
 </div><small className="dd-note">{CAPITAL_BASIS_COMPATIBILITY_NOTE}</small></details>;
}
