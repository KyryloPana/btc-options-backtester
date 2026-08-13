"use client";

import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import { INFO_TOOLTIP_DEFINITIONS, type InfoTooltipTerm } from "../info-tooltip-definitions";

import { tooltipOpenAfter } from "./info-tooltip-state";

export function InfoTooltip({ term, label }: { term: InfoTooltipTerm; label?: string }) {
  const id = `info-${useId().replace(/:/g, "")}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const accessibleLabel = label ?? `More information about ${term}`;

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.min(window.innerWidth - 12, Math.max(12, rect.left + rect.width / 2)), top: rect.bottom + 7 });
    setOpen(current => tooltipOpenAfter(current, "show"));
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(current => tooltipOpenAfter(current, "escape")); buttonRef.current?.focus(); } };
    const repositionOrDismiss = () => setOpen(false);
    document.addEventListener("keydown", dismiss);
    window.addEventListener("scroll", repositionOrDismiss, true);
    window.addEventListener("resize", repositionOrDismiss);
    return () => { document.removeEventListener("keydown", dismiss); window.removeEventListener("scroll", repositionOrDismiss, true); window.removeEventListener("resize", repositionOrDismiss); };
  }, [open]);

  const tooltip = <span id={id} role="tooltip" className={`info-tooltip-popover${open ? " is-open" : ""}`} style={open ? { left: position.left, top: position.top } : undefined}>{INFO_TOOLTIP_DEFINITIONS[term]}</span>;
  return <span className="info-tooltip-anchor" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
    <button ref={buttonRef} type="button" className="info-tooltip-trigger" aria-label={accessibleLabel} aria-describedby={id} aria-expanded={open} onFocus={show} onBlur={() => setOpen(false)} onClick={show}>i</button>
    {typeof document === "undefined" ? tooltip : createPortal(tooltip, document.body)}
  </span>;
}
