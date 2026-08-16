import { tools, type ToolId } from "./tool-registry";

export function OptionsLabFolder({ onOpenTool, onBack }: { onOpenTool: (id: ToolId) => void; onBack: () => void }) {
  return (
    <section className="shell-launcher" aria-labelledby="folder-title">
      <button className="shell-back" onClick={onBack}>← All applications</button>
      <div className="shell-heading"><p className="shell-eyebrow">Application folder</p><h1 id="folder-title">Options Lab</h1><p>Select a tool. Open tools stay available in the tab bar.</p></div>
      <div className="launcher-grid tool-grid">
        {tools.map((tool) => <button className="launcher-card" key={tool.id} onClick={() => onOpenTool(tool.id)}><span><strong>{tool.title}</strong><small>{tool.description}</small></span><b aria-hidden="true">→</b></button>)}
      </div>
    </section>
  );
}
