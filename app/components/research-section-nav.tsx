"use client";
import {useEffect,useState} from "react";
import type {DisplayCurrency} from "./display-currency";

export interface ResearchSectionLink {id:string;label:string}
export const RESEARCH_SECTION_LINKS:readonly ResearchSectionLink[]=[
 {id:"research-summary",label:"Summary"},{id:"research-context",label:"Global Context"},{id:"research-controls",label:"Research Controls"},{id:"research-underlying",label:"Underlying Resolution"},{id:"research-volatility",label:"Volatility"},{id:"research-duration",label:"Duration & DTE"},{id:"research-strike",label:"Short Strike"},{id:"research-spread",label:"Spread Width"},{id:"research-exit",label:"Exit Policy"},{id:"research-workbench",label:"Diagnostics & Audit"},
];
export const ECONOMICS_SECTION_LINKS:readonly ResearchSectionLink[]=[{id:"strategy-dataset",label:"Dataset"},{id:"strategy-candidate",label:"Candidate"},{id:"strategy-account",label:"Account & Margin"},{id:"strategy-economics",label:"Economic Analysis"}];
export const FUTURES_SECTION_LINKS:readonly ResearchSectionLink[]=[{id:"strategy-dataset",label:"Dataset"},{id:"strategy-candidate",label:"Candidate"},{id:"strategy-benchmark",label:"Benchmark Scope"},{id:"strategy-futures",label:"Options vs Futures"}];

export function ResearchSectionNav({items,currency,onCurrencyChange}:{items:readonly ResearchSectionLink[];currency:DisplayCurrency;onCurrencyChange:(currency:DisplayCurrency)=>void}){
 const [active,setActive]=useState(items[0]?.id??"");
 useEffect(()=>{setActive(items[0]?.id??"");if(typeof IntersectionObserver==="undefined")return;const observer=new IntersectionObserver(entries=>{const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top)[0];if(visible)setActive(visible.target.id)},{rootMargin:"-56px 0px -65%",threshold:[0,.1]});for(const item of items){const node=document.getElementById(item.id);if(node)observer.observe(node)}return()=>observer.disconnect()},[items]);
 return <nav className="research-section-nav" aria-label="Research Analytics sections"><fieldset className="display-currency-control"><legend>Display</legend>{(["usd","btc"] as const).map(option=><button type="button" key={option} aria-pressed={currency===option} onClick={()=>onCurrencyChange(option)}>{option.toUpperCase()}</button>)}</fieldset><strong>Sections</strong><div>{items.map(item=><button type="button" key={item.id} aria-current={active===item.id?"location":undefined} onClick={()=>{document.getElementById(item.id)?.scrollIntoView({behavior:"smooth",block:"start"});setActive(item.id)}}>{item.label}</button>)}</div></nav>;
}
