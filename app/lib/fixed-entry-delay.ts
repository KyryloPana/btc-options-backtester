import {IMMEDIATE_FILL_SEARCH_WINDOWS_MS} from "./execution-policy.ts";

export const FIXED_ENTRY_DELAY_HOURS=[0,4,8,12] as const;
/** The established maximum immediate causal fill-search window, applied equally to every offset. */
export const FIXED_ENTRY_DELAY_SEARCH_WINDOW_MS=Math.max(...IMMEDIATE_FILL_SEARCH_WINDOWS_MS);
export const fixedEntryDelaySearchEnd=(targetMs:number)=>targetMs+FIXED_ENTRY_DELAY_SEARCH_WINDOW_MS;
export const isInsideFixedEntryDelayWindow=(targetMs:number,actualMs:number)=>actualMs>targetMs&&actualMs<=fixedEntryDelaySearchEnd(targetMs);
