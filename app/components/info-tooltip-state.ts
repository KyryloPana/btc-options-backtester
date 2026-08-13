export function tooltipOpenAfter(open: boolean, action: "show" | "toggle" | "dismiss" | "escape") {
  return action === "show" ? true : action === "toggle" ? !open : false;
}
