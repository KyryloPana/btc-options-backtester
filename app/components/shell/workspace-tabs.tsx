import { toolById, type ToolId } from "./tool-registry";

interface WorkspaceTabsProps { open: ToolId[]; active?: ToolId; onSelect: (id: ToolId) => void; onClose: (id: ToolId) => void; onLaunch: () => void; }
export function WorkspaceTabs({ open, active, onSelect, onClose, onLaunch }: WorkspaceTabsProps) {
  return <header className="workspace-tabs"><div className="tabs-inner"><button className="shell-home" onClick={onLaunch} aria-label="Open application launcher">OL</button><div className="tab-list" role="tablist" aria-label="Open tools">{open.map((id) => { const tool=toolById.get(id)!; return <div className={`workspace-tab ${active===id?"active":""}`} key={id}><button role="tab" aria-selected={active===id} onClick={()=>onSelect(id)}>{tool.title}</button><button className="tab-close" aria-label={`Close ${tool.title}`} onClick={()=>onClose(id)}>×</button></div>; })}<button className="new-tab" aria-label="Open launcher" title="Open launcher" onClick={onLaunch}>+</button></div></div></header>;
}
