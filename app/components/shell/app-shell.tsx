"use client";
import { useCallback, useEffect, useState } from "react";
import { HomeLauncher } from "./home-launcher";
import { OptionsLabFolder } from "./options-lab-folder";
import { toolById, isToolId, type ToolId } from "./tool-registry";
import { WorkspaceTabs } from "./workspace-tabs";

type Location = "home" | "options-lab" | ToolId;
interface ShellState { location: Location; open: ToolId[]; }
const initialState: ShellState = { location: "home", open: [] };

function readHash(): ShellState {
  const raw=window.location.hash.slice(1); const [path,query=""]=raw.split("?");
  const route=path.replace(/^\//,""); const params=new URLSearchParams(query);
  const open=(params.get("tabs")??"").split(",").filter(isToolId);
  const location:Location=isToolId(route)?route:route==="options-lab"?"options-lab":"home";
  if(isToolId(location)&&!open.includes(location)) open.push(location);
  return {location,open:[...new Set(open)]};
}
function hashFor({location,open}:ShellState){const query=open.length?`?tabs=${open.join(",")}`:"";return `#/${location}${query}`;}

export function AppShell() {
  const [state,setState]=useState(initialState);
  useEffect(()=>{const sync=()=>setState(readHash());sync();window.addEventListener("hashchange",sync);return()=>window.removeEventListener("hashchange",sync);},[]);
  const navigate=useCallback((next:ShellState)=>{const hash=hashFor(next);if(window.location.hash===hash)setState(next);else window.location.hash=hash;},[]);
  const openTool=(id:ToolId)=>navigate({location:id,open:state.open.includes(id)?state.open:[...state.open,id]});
  const closeTool=(id:ToolId)=>{const index=state.open.indexOf(id);const open=state.open.filter(item=>item!==id);const location=state.location===id?(open[Math.min(index,open.length-1)]??"options-lab"):state.location;navigate({location,open});};
  const active=isToolId(state.location)?state.location:undefined;
  return <div className="app-shell"><WorkspaceTabs open={state.open} active={active} onSelect={id=>navigate({location:id,open:state.open})} onClose={closeTool} onLaunch={()=>navigate({location:"options-lab",open:state.open})}/><div className="shell-content">{state.location==="home"&&<HomeLauncher onOpenOptionsLab={()=>navigate({location:"options-lab",open:state.open})}/>} {state.location==="options-lab"&&<OptionsLabFolder onOpenTool={openTool} onBack={()=>navigate({location:"home",open:state.open})}/>} {state.open.map(id=>{const Tool=toolById.get(id)!.component;return <div className="tool-view" hidden={active!==id} key={id}><Tool/></div>;})}</div></div>;
}
