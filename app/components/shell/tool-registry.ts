import type { ComponentType } from "react";
import { OptionsBacktester } from "../../options-backtester";
import { ResearchAnalytics } from "./research-analytics";

export type ToolId = "options-backtester" | "research-analytics";

export interface ToolDefinition {
  id: ToolId;
  title: string;
  description: string;
  component: ComponentType;
}

export const tools: readonly ToolDefinition[] = [
  {
    id: "options-backtester",
    title: "Options Backtester",
    description: "Build, price, and inspect historical BTC options strategies.",
    component: OptionsBacktester,
  },
  {
    id: "research-analytics",
    title: "Research Analytics",
    description: "Statistical analysis and reporting for completed research.",
    component: ResearchAnalytics,
  },
];

export const toolById = new Map(tools.map((tool) => [tool.id, tool]));
export const isToolId = (value: string): value is ToolId => toolById.has(value as ToolId);
