interface HomeLauncherProps { onOpenOptionsLab: () => void; }

export function HomeLauncher({ onOpenOptionsLab }: HomeLauncherProps) {
  return (
    <section className="shell-launcher" aria-labelledby="launcher-title">
      <div className="shell-heading"><p className="shell-eyebrow">Workspace</p><h1 id="launcher-title">Applications</h1><p>Choose a workspace to begin.</p></div>
      <div className="launcher-grid">
        <button className="launcher-card folder-card" onClick={onOpenOptionsLab}>
          <span className="folder-icon" aria-hidden="true" />
          <span><strong>Options Lab</strong><small>Options research and backtesting tools</small></span>
          <b aria-hidden="true">→</b>
        </button>
      </div>
    </section>
  );
}
