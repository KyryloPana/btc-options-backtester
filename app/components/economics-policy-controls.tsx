"use client";
import {useEffect,useState} from "react";
import type {AnalysisConfiguration} from "../lib/analysis-configuration";
import {validateEconomicPolicy} from "../lib/analysis-configuration";

export function EconomicsPolicyControls({value,onChange}:{value:AnalysisConfiguration;onChange:(next:AnalysisConfiguration)=>void}){
 const set=<K extends keyof AnalysisConfiguration>(key:K,next:AnalysisConfiguration[K])=>onChange({...value,[key]:next}),errors=validateEconomicPolicy(value),inputsSet=value.accountEquity!==null&&value.maximumRiskFraction!==null&&value.maximumMarginUtilization!==null&&!errors.length,supported=value.marginModel==="standard"&&value.collateralMode==="segregated",status=!inputsSet?"Inputs incomplete":supported?"Ready":"Inputs set · capability unavailable";
 const [open,setOpen]=useState(!inputsSet);useEffect(()=>setOpen(!inputsSet),[inputsSet]);
 return <details className="workspace-section scoped-controls" data-testid="economics-policy-controls" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary><strong>Account &amp; Margin Policy</strong><small>{value.marginModel} margin · {value.collateralMode} collateral · {status}</small></summary><p className="dd-note">Existing Economics portfolio and deployment-policy inputs. Reference, empirical Q50, and conservative Q90 execution layers remain simultaneous read-only report scope.</p><div className="analytics-form-grid">
  <label>Margin model<select value={value.marginModel} onChange={event=>set("marginModel",event.target.value as AnalysisConfiguration["marginModel"])}><option value="standard">Standard Margin</option><option value="portfolio">Portfolio Margin (capability gated)</option></select></label>
  <label>Collateral mode<select value={value.collateralMode} onChange={event=>set("collateralMode",event.target.value as AnalysisConfiguration["collateralMode"])}><option value="segregated">Segregated</option><option value="cross">Cross</option></select></label>
  <label>Initial collateral (Native BTC)<input type="number" min="0" step="0.01" value={value.accountEquity??""} onChange={event=>set("accountEquity",event.target.value===""?null:Number(event.target.value))}/></label>
  <label>Maximum risk fraction<input type="number" min="0" max="1" step="0.001" value={value.maximumRiskFraction??""} onChange={event=>set("maximumRiskFraction",event.target.value===""?null:Number(event.target.value))} placeholder="Not configured"/></label>
  <label>Maximum margin utilization<input type="number" min="0" max="1" step="0.01" value={value.maximumMarginUtilization??""} onChange={event=>set("maximumMarginUtilization",event.target.value===""?null:Number(event.target.value))} placeholder="Not configured"/></label>
 </div><p className="dd-note">This is the starting BTC-collateral scenario used for account-path diagnostics. USD minimum-account requirements are calculated independently from canonical USD risk and margin states.</p>{errors.length>0&&<ul className="preflight-warning">{errors.map(error=><li key={error}>{error}</li>)}</ul>}</details>;
}
