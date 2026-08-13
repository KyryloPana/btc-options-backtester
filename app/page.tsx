"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { BUNDLED_EVENTS, durationSummary } from "./data";
import {
  type BacktestEvent,
  type Candle,
  type ContractCandidateManifest,
  type ContractSeries,
  type DteTolerance,
  type ExecutionMode,
  type ExpirySelectionMode,
  type ExitResult,
  type EntryLedger,
  type EntryLedgers,
  type QualityFlag,
  type RetrievedSpread,
  type SpreadKind,
  type ValuationPoint,
  buildExpiryCandidates,
  buildValuation,
  evaluateExits,
  firstTouch,
  formatUtc,
  generateDesiredSpreads,
  parseUtcDate,
  qualityRank,
  windowComparison,
} from "./lib/backtester";

type Section = "events" | "construction" | "contracts" | "analysis";

interface AnalysisResult {
  spread: RetrievedSpread;
  path: ValuationPoint[];
  entryLedgers?: EntryLedgers;
  exits: ExitResult[];
  selectedExit?: ExitResult;
  eventQuality: QualityFlag;
}

const DTE_OPTIONS = [7, 14, 30];
const WIDTH_OPTIONS = [1000, 2000, 3000];
const DEFAULT_DTE_TOLERANCES: Record<number, DteTolerance> = {
  7: { min: 5, max: 10 },
  14: { min: 11, max: 18 },
  30: { min: 24, max: 38 },
};
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function money(value?: number) {
  return value === undefined || !Number.isFinite(value) ? "—" : usd.format(value);
}

function btc(value?: number) {
  return value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(6)} BTC`;
}

function pct(value?: number) {
  return value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
}

function flagClass(flag: QualityFlag | "ready" | "partial" | "missing") {
  const normalized = flag === "ready" ? "green" : flag === "partial" ? "yellow" : flag === "missing" ? "red" : flag;
  return `flag flag-${normalized}`;
}

async function fetchCandles(start: number, end: number): Promise<Candle[]> {
  try {
    const response = await fetch(`/api/ohlc?interval=1h&start=${start}&end=${end}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "BTC candles could not be loaded.");
    return payload.candles as Candle[];
  } catch (serverError) {
    const rows: unknown[][] = [];
    let cursor = start;
    for (let page = 0; page < 10 && cursor < end; page += 1) {
      const url = new URL("https://data-api.binance.vision/api/v3/klines");
      url.searchParams.set("symbol", "BTCUSDT");
      url.searchParams.set("interval", "1h");
      url.searchParams.set("startTime", String(cursor));
      url.searchParams.set("endTime", String(end));
      url.searchParams.set("limit", "1000");
      const response = await fetch(url);
      if (!response.ok) throw serverError;
      const pageRows = await response.json() as unknown[][];
      if (!pageRows.length) break;
      rows.push(...pageRows);
      cursor = Number(pageRows[pageRows.length - 1][0]) + 3_600_000;
      if (pageRows.length < 1000) break;
    }
    return rows.map(values => ({
      openTime: Number(values[0]), open: Number(values[1]), high: Number(values[2]), low: Number(values[3]), close: Number(values[4]), volume: Number(values[5]), closeTime: Number(values[6]),
    }));
  }
}

function CheckboxGroup({ values, selected, onChange, formatter }: {
  values: number[];
  selected: number[];
  onChange: (values: number[]) => void;
  formatter: (value: number) => string;
}) {
  return (
    <div className="check-row">
      {values.map(value => (
        <label className={`check-chip ${selected.includes(value) ? "checked" : ""}`} key={value}>
          <input
            type="checkbox"
            checked={selected.includes(value)}
            onChange={() => onChange(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value].sort((a, b) => a - b))}
          />
          {formatter(value)}
        </label>
      ))}
    </div>
  );
}

function QualityDot({ flag }: { flag: QualityFlag }) {
  return <span className={`quality-dot ${flag}`} aria-label={`${flag} quality`} />;
}

function Ledger({ ledger }: { ledger: EntryLedger }) {
  const flowLabel = ledger.spreadKind === "credit" ? "Gross net credit" : "Gross net debit";
  return <section className="opening-ledger" aria-label={`${ledger.pricingMethod} opening ledger`}>
    <div className="ledger-heading"><h4>{ledger.pricingMethod === "raw-vwap" ? "Raw VWAP" : "IV-normalized"}</h4><span className={flagClass(ledger.qualityFlag)}>{ledger.qualityFlag} evidence</span></div>
    <p className="quality-reason"><strong>Pricing evidence:</strong> {ledger.qualityReason}</p>
    <dl>
      <div><dt>Sold instrument</dt><dd className="mono">{ledger.soldInstrumentName}</dd></div><div><dt>Bought instrument</dt><dd className="mono">{ledger.boughtInstrumentName}</dd></div>
      <div><dt>Structure</dt><dd>{ledger.expiryLabel} · {ledger.optionType === "C" ? "Call" : "Put"} · sold ${ledger.soldStrikeUsd.toLocaleString()} / bought ${ledger.boughtStrikeUsd.toLocaleString()}</dd></div>
      <div><dt>Selected contract amount</dt><dd>{ledger.contractAmount} contracts</dd></div>
      <div><dt>Sold price received</dt><dd>{btc(ledger.soldPriceBtcPerContract)} / contract</dd></div><div><dt>Total sold proceeds</dt><dd>{btc(ledger.soldProceedsBtc)} · {money(ledger.soldProceedsUsd)}</dd></div>
      <div><dt>Bought price paid</dt><dd>{btc(ledger.boughtPriceBtcPerContract)} / contract</dd></div><div><dt>Total bought cost</dt><dd>{btc(ledger.boughtCostBtc)} · {money(ledger.boughtCostUsd)}</dd></div>
      <div><dt>Sold-leg fee</dt><dd>{btc(ledger.soldLegFeeBtc)}</dd></div><div><dt>{ledger.comboFeeBtc !== undefined ? "Combo fee" : "Bought-leg fee"}</dt><dd>{btc(ledger.comboFeeBtc ?? ledger.boughtLegFeeBtc)}</dd></div>
      <div><dt>Total opening fees</dt><dd>{btc(ledger.totalOpeningFeesBtc)} · {money(ledger.totalOpeningFeesUsd)}</dd></div>
      <div><dt>{flowLabel} / contract</dt><dd>{btc(ledger.grossEntryBtcPerContract)}</dd></div><div><dt>{flowLabel} total</dt><dd>{btc(ledger.grossEntryTotalBtc)} · {money(ledger.grossEntryTotalUsd)}</dd></div>
      <div><dt>Net opening cash flow after fees</dt><dd>{btc(ledger.netOpeningCashFlowBtc)} · {money(ledger.netOpeningCashFlowUsd)}</dd></div>
      <div><dt>Entry BTC index</dt><dd>{money(ledger.entryIndexUsdPerBtc)} / BTC</dd></div>
      <div><dt>Sold pricing timestamp</dt><dd>{formatUtc(ledger.soldPricingTimestamp)}</dd></div><div><dt>Bought pricing timestamp</dt><dd>{formatUtc(ledger.boughtPricingTimestamp)}</dd></div>
      <div><dt>Normalization window</dt><dd>±{ledger.normalizationWindowMinutes} minutes</dd></div><div><dt>Execution mode</dt><dd>{ledger.executionMode}{ledger.comboFeeBtc !== undefined ? " · combo" : " · legs"}</dd></div>
    </dl>
  </section>;
}

export default function Home() {
  const stats = useMemo(() => durationSummary(), []);
  const [section, setSection] = useState<Section>("events");
  const [events, setEvents] = useState<BacktestEvent[]>(BUNDLED_EVENTS);
  const [selectedEventId, setSelectedEventId] = useState(BUNDLED_EVENTS[1].id);
  const [dtes, setDtes] = useState(DTE_OPTIONS);
  const [dteTolerances, setDteTolerances] = useState<Record<number, DteTolerance>>(DEFAULT_DTE_TOLERANCES);
  const [expirySelectionMode, setExpirySelectionMode] = useState<ExpirySelectionMode>("liquidity-aware");
  const [widths, setWidths] = useState(WIDTH_OPTIONS);
  const [spreadKind, setSpreadKind] = useState<SpreadKind>("credit");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("maker");
  const [comboExecution, setComboExecution] = useState(false);
  const [amount, setAmount] = useState(1);
  const [pricingModes, setPricingModes] = useState(["vwap", "iv"]);
  const [inventory, setInventory] = useState<ContractSeries[]>([]);
  const [candidateManifests, setCandidateManifests] = useState<ContractCandidateManifest[]>([]);
  const [parseStatus, setParseStatus] = useState("Checking Deribit instrument manifest…");
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceReady, setSourceReady] = useState(false);
  const [selectedSpreadId, setSelectedSpreadId] = useState<string>();
  const [resolveStatus, setResolveStatus] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState("");
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[]>([]);
  const [resultsFilter, setResultsFilter] = useState<"all" | "trusted" | "green">("all");
  const [selectedResultId, setSelectedResultId] = useState<string>();
  const [expandedResultIds, setExpandedResultIds] = useState<string[]>([]);
  const sectionRefs = useRef<Record<Section, HTMLElement | null>>({ events: null, construction: null, contracts: null, analysis: null });

  const selectedEvent = events.find(event => event.id === selectedEventId) ?? events[0];
  const effectiveEntryTimestamp = selectedEvent.entryTimestamp ?? parseUtcDate(selectedEvent.entryDate);
  const desiredSpreads = useMemo(
    () => generateDesiredSpreads(selectedEvent, dtes, widths, spreadKind),
    [selectedEvent, dtes, widths, spreadKind],
  );
  const retrievedSpreads = useMemo(
    () => buildExpiryCandidates(desiredSpreads, candidateManifests, effectiveEntryTimestamp, selectedEvent.entryPrice, inventory, executionMode, expirySelectionMode),
    [desiredSpreads, candidateManifests, effectiveEntryTimestamp, selectedEvent.entryPrice, inventory, executionMode, expirySelectionMode],
  );
  const selectedSpread = retrievedSpreads.find(spread => spread.id === selectedSpreadId) ?? retrievedSpreads[0];
  const selectedAnalysis = analysisResults.find(result => result.spread.id === selectedResultId) ?? analysisResults[0];
  const entryWindowRows = selectedSpread?.soldContract && selectedSpread?.boughtContract
    ? windowComparison(selectedSpread, effectiveEntryTimestamp, selectedEvent.entryPrice, executionMode)
    : [];
  const inventoryTrades = inventory.reduce((sum, series) => sum + series.trades.length, 0);
  const inventoryExpiries = new Set(inventory.map(series => series.expiryTimestamp)).size;
  const filteredResults = analysisResults.filter(result => {
    if (resultsFilter === "green") return result.eventQuality === "green";
    if (resultsFilter === "trusted") return qualityRank(result.eventQuality) >= 1;
    return true;
  });

  function jump(next: Section) {
    setSection(next);
    sectionRefs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function patchEvent(patch: Partial<BacktestEvent>) {
    setEvents(current => current.map(event => event.id === selectedEvent.id ? { ...event, ...patch } : event));
    setAnalysisResults([]);
    setCandidateManifests([]);
    setInventory([]);
  }

  function changeHorizons(next: number[]) {
    setDtes(next);
    setCandidateManifests([]);
    setInventory([]);
    setAnalysisResults([]);
  }

  function updateTolerance(target: number, field: keyof DteTolerance, value: number) {
    setDteTolerances(current => ({ ...current, [target]: { ...current[target], [field]: Math.max(0, value) } }));
    setCandidateManifests([]);
    setInventory([]);
    setAnalysisResults([]);
  }

  function addEvent() {
    const id = `manual-${Date.now()}`;
    const event: BacktestEvent = {
      id,
      label: `Manual MR · ${events.length + 1}`,
      direction: "long",
      entryDate: "2026-08-12",
      entryPrice: 0,
      invalidationPrice: 0,
    };
    setEvents(current => [...current, event]);
    setSelectedEventId(id);
    setSection("events");
  }

  async function resolveTimestamps() {
    setResolveStatus("Resolving hourly touches…");
    try {
      const entryStart = parseUtcDate(selectedEvent.entryDate);
      const entryCandles = await fetchCandles(entryStart, entryStart + 86_400_000 - 1);
      const entryTouch = firstTouch(entryCandles, selectedEvent.entryPrice);
      const patch: Partial<BacktestEvent> = {};
      if (entryTouch) {
        patch.entryTimestamp = entryTouch.openTime;
        patch.entryTimeSource = "resolved";
      }
      if (selectedEvent.exitDate && selectedEvent.exitPrice) {
        const exitStart = parseUtcDate(selectedEvent.exitDate);
        const exitCandles = await fetchCandles(exitStart, exitStart + 86_400_000 - 1);
        patch.exitTimestamp = firstTouch(exitCandles, selectedEvent.exitPrice)?.openTime;
      }
      if (selectedEvent.vpocDate && selectedEvent.vpocPrice) {
        const vpocStart = parseUtcDate(selectedEvent.vpocDate);
        const vpocCandles = await fetchCandles(vpocStart, vpocStart + 86_400_000 - 1);
        patch.vpocTimestamp = firstTouch(vpocCandles, selectedEvent.vpocPrice)?.openTime ?? selectedEvent.vpocTimestamp;
      }
      patchEvent(patch);
      setResolveStatus(entryTouch
        ? `Entry resolved to the first 1H candle containing ${money(selectedEvent.entryPrice)}.`
        : "No hourly candle contained the entry price on that UTC date. Set the timestamp manually or verify the source market.");
    } catch (error) {
      setResolveStatus(error instanceof Error ? `${error.message} Enter the UTC time manually.` : "Resolution failed. Enter the UTC time manually.");
    }
  }

  async function refreshSourceStatus() {
    try {
      const response = await fetch("/__deribit/history/status");
      const status = await response.json();
      if (!response.ok) throw new Error(status.error ?? "Contract source status failed.");
      setSourceReady(status.phase === "ready");
      if (status.phase === "ready") {
        setParseStatus(`${status.contractsFound.toLocaleString()} Deribit option instruments · manifest cache ready`);
      } else if (status.phase === "synchronizing") {
        setParseStatus("Synchronizing Deribit instrument manifest…");
      } else {
        setParseStatus("Deribit manifest is ready to synchronize.");
      }
      return status;
    } catch (error) {
      setParseStatus(error instanceof Error ? error.message : "Deribit History API service is unavailable.");
      return undefined;
    }
  }

  async function waitForIndex() {
    for (let attempt = 0; attempt < 2400; attempt += 1) {
      const status = await refreshSourceStatus();
      if (status?.phase === "ready") return;
      if (status?.phase === "error") throw new Error(status.error ?? "Deribit manifest is unavailable.");
      await new Promise(resolve => window.setTimeout(resolve, 750));
    }
    throw new Error("Manifest synchronization is still running. Retry once the status is ready.");
  }

  async function loadRequiredContracts(forceIndex = false) {
    if (!desiredSpreads.length) {
      setParseStatus("Enter a failed extreme before loading required contracts.");
      return;
    }
    setSourceBusy(true);
    setAnalysisResults([]);
    try {
      const indexResponse = await fetch("/__deribit/history/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: forceIndex }),
      });
      const indexStatus = await indexResponse.json();
      if (!indexResponse.ok) throw new Error(indexStatus.error ?? "Manifest synchronization could not start.");
      if (indexStatus.phase !== "ready") await waitForIndex();
      setParseStatus("Loading exact resolved contracts from Deribit History API…");
      const response = await fetch("/__deribit/history/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryTimestamp: effectiveEntryTimestamp,
          requests: desiredSpreads.map(spread => ({
            requestId: spread.id,
            targetDte: spread.targetDte,
            minDte: Math.min(dteTolerances[spread.targetDte].min, dteTolerances[spread.targetDte].max),
            maxDte: Math.max(dteTolerances[spread.targetDte].min, dteTolerances[spread.targetDte].max),
            soldStrike: spread.soldStrike,
            boughtStrike: spread.boughtStrike,
            optionType: spread.optionType,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Required contracts could not be loaded.");
      const nextInventory = payload.inventory as ContractSeries[];
      setInventory(nextInventory);
      setCandidateManifests(payload.candidates as ContractCandidateManifest[]);
      setSourceReady(true);
      setSelectedSpreadId(undefined);
      setParseStatus(`${payload.diagnostics.apiRequestCount.toLocaleString()} API requests · ${payload.diagnostics.candidateExpiries.toLocaleString()} expiry candidates · ${payload.diagnostics.contractsLoaded.toLocaleString()} contracts loaded · ${payload.diagnostics.validTrades.toLocaleString()} valid trades · ${payload.diagnostics.cacheHits.toLocaleString()} cache hits · ${payload.diagnostics.failedContracts.length.toLocaleString()} failures`);
    } catch (error) {
      setParseStatus(error instanceof Error ? error.message : "Contract loading failed.");
    } finally {
      setSourceBusy(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshSourceStatus(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function runBacktest() {
    const runnable = retrievedSpreads.filter(spread => spread.selectedForTest && spread.entryLiquidity?.viable && spread.soldContract && spread.boughtContract && spread.expiryTimestamp);
    if (!runnable.length) {
      setAnalysisStatus("No complete spread can be valued. Load both legs for at least one generated combination.");
      return;
    }
    setAnalysisStatus("Loading BTC index path and valuing every generated spread…");
    try {
      const entryTimestamp = selectedEvent.entryTimestamp ?? effectiveEntryTimestamp;
      const maxExpiry = Math.max(...runnable.map(spread => spread.expiryTimestamp!));
      const candles = await fetchCandles(entryTimestamp - 3_600_000, maxExpiry + 3_600_000);
      const vpocTouch = selectedEvent.vpocPrice ? firstTouch(candles, selectedEvent.vpocPrice, entryTimestamp)?.openTime : undefined;
      const next = runnable.map(spread => {
        const specials = [selectedEvent.vpocTimestamp, selectedEvent.exitTimestamp, vpocTouch].filter(Boolean) as number[];
        const valuation = buildValuation(spread, { ...selectedEvent, entryTimestamp }, candles, executionMode, amount, comboExecution, specials);
        const { path, entryLedgers } = valuation;
        const exits = evaluateExits(path, spread, { ...selectedEvent, entryTimestamp }, candles);
        const selectedExit = exits.find(exit => exit.rule === "VPOC hit" && exit.status === "hit") ?? exits.find(exit => exit.status === "hit");
        const entryQuality = entryLedgers?.iv.qualityFlag ?? entryLedgers?.raw.qualityFlag ?? "red";
        const exitQuality = selectedExit?.qualityFlag ?? "red";
        const eventQuality: QualityFlag = entryQuality === "red" || exitQuality === "red" ? "red" : entryQuality === "green" && exitQuality === "green" ? "green" : "yellow";
        return { spread, path, entryLedgers, exits, selectedExit, eventQuality };
      });
      setAnalysisResults(next);
      setSelectedResultId(next[0]?.spread.id);
      setAnalysisStatus(`${next.length} spread${next.length === 1 ? "" : "s"} valued on a 4H grid. Results retain raw VWAP and IV-normalized ledgers separately.`);
      jump("analysis");
    } catch (error) {
      setAnalysisStatus(error instanceof Error ? error.message : "The valuation run failed.");
    }
  }

  function exportResults() {
    const payload = {
      generatedAt: new Date().toISOString(),
      event: selectedEvent,
      configuration: { expiryHorizons: dtes, dteTolerances, expirySelectionMode, widths, spreadKind, executionMode, comboExecution, amount, pricingModes },
      results: analysisResults,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedEvent.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-options-backtest.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark">O</span><div><strong>Options Lab</strong><span>BTC mean-reversion backtester</span></div></div>
        <nav aria-label="Backtest pipeline">
          {(["events", "construction", "contracts", "analysis"] as Section[]).map((item, index) => (
            <button className={section === item ? "active" : ""} onClick={() => jump(item)} key={item}><span>{index + 1}</span>{item}</button>
          ))}
        </nav>
        <div className="status-lockup"><span className="live-dot" /> local session</div>
      </header>

      <div className="page-shell">
        <section className="hero">
          <div><p className="eyebrow">Historical Deribit execution research</p><h1>Test the trade you could have priced.</h1><p className="hero-copy">Resolve the signal, construct every eligible spread, normalize sparse prints, then inspect the full path—not just the terminal payoff.</p></div>
          <div className="hero-badges"><span>MR only</span><span>{executionMode} execution</span><span>r = 0</span><span>BTC + USD ledgers</span></div>
        </section>

        <section className="workspace-section" ref={node => { sectionRefs.current.events = node; }}>
          <div className="section-heading"><div><span className="step-number">01</span><p className="eyebrow">Signal definition</p><h2>Event & exact touch time</h2></div><button className="secondary-button" onClick={addEvent}>Add manual event</button></div>
          <div className="event-layout">
            <aside className="event-list card">
              <div className="card-title-row"><div><p className="eyebrow">Imported sample</p><h3>{events.length} MR trades</h3></div><span className="tiny-badge">BO excluded</span></div>
              <div className="event-scroll">
                {events.map(event => (
                  <button className={`event-row ${event.id === selectedEvent.id ? "selected" : ""}`} onClick={() => { setSelectedEventId(event.id); setAnalysisResults([]); setCandidateManifests([]); setInventory([]); }} key={event.id}>
                    <span className={`direction ${event.direction}`}>{event.direction === "long" ? "L" : "S"}</span>
                    <span><strong>{event.label}</strong><small>{money(event.entryPrice)} entry</small></span>
                    <span className={event.extremePrice ? "data-ready" : "data-missing"}>{event.extremePrice ? "ready" : "needs extreme"}</span>
                  </button>
                ))}
              </div>
            </aside>

            <div className="event-editor card">
              <div className="card-title-row"><div><p className="eyebrow">Selected thesis</p><h3>{selectedEvent.label}</h3></div><span className={`direction-pill ${selectedEvent.direction}`}>{selectedEvent.direction} BTC</span></div>
              <div className="form-grid four">
                <label>Label<input value={selectedEvent.label} onChange={event => patchEvent({ label: event.target.value })} /></label>
                <label>Direction<select value={selectedEvent.direction} onChange={event => patchEvent({ direction: event.target.value as "long" | "short" })}><option value="long">Long / bullish MR</option><option value="short">Short / bearish MR</option></select></label>
                <label>Entry date<input type="date" value={selectedEvent.entryDate} onChange={event => patchEvent({ entryDate: event.target.value, entryTimestamp: undefined })} /></label>
                <label>Entry price<input type="number" value={selectedEvent.entryPrice || ""} onChange={event => patchEvent({ entryPrice: Number(event.target.value), entryTimestamp: undefined })} /></label>
                <label>Failed extreme<input type="number" placeholder="Required for strikes" value={selectedEvent.extremePrice ?? ""} onChange={event => patchEvent({ extremePrice: Number(event.target.value) || undefined })} /></label>
                <label>VPOC target<input type="number" placeholder="Auction target" value={selectedEvent.vpocPrice ?? ""} onChange={event => patchEvent({ vpocPrice: Number(event.target.value) || undefined })} /></label>
                <label>VPOC date<input type="date" value={selectedEvent.vpocDate ?? ""} onChange={event => patchEvent({ vpocDate: event.target.value || undefined, vpocTimestamp: undefined })} /></label>
                <label>Invalidation / SL<input type="number" value={selectedEvent.invalidationPrice ?? ""} onChange={event => patchEvent({ invalidationPrice: Number(event.target.value) || undefined })} /></label>
              </div>
              <div className="time-resolver">
                <div><p className="eyebrow">Entry timestamp</p><strong>{selectedEvent.entryTimestamp ? formatUtc(selectedEvent.entryTimestamp) : `${selectedEvent.entryDate} · unresolved`}</strong><small>{selectedEvent.entryTimestamp ? "First BTCUSDT 1H candle whose low/high contains the entry price." : "Contract retrieval uses 00:00 UTC provisionally until resolved."}</small></div>
                <label className="manual-time">Manual UTC time<input type="datetime-local" value={selectedEvent.entryTimestamp ? new Date(selectedEvent.entryTimestamp).toISOString().slice(0, 16) : ""} onChange={event => patchEvent({ entryTimestamp: event.target.value ? Date.parse(`${event.target.value}Z`) : undefined, entryTimeSource: "manual" })} /></label>
                <button className="primary-button" onClick={resolveTimestamps}>Resolve first touch</button>
              </div>
              {resolveStatus && <p className="inline-status">{resolveStatus}</p>}
              <div className="source-strip"><span><small>Backtest exit</small><strong>{selectedEvent.exitDate ?? "—"} · {money(selectedEvent.exitPrice)}</strong></span><span><small>VPOC touch</small><strong>{formatUtc(selectedEvent.vpocTimestamp)}</strong></span><span><small>Range</small><strong>{money(selectedEvent.rangeLow)} — {money(selectedEvent.rangeHigh)}</strong></span></div>
            </div>

            <aside className="duration-card card">
              <p className="eyebrow">Duration prior</p><h3>{stats.count} observed moves</h3>
              <div className="duration-figure"><strong>{Math.round(stats.medianEntryToTargetHours / 24)}d</strong><span>median entry → target</span></div>
              <div className="quartile-track"><span style={{ left: "24%" }} /><span style={{ left: "50%" }} /><span style={{ left: "76%" }} /></div>
              <div className="quartile-labels"><span>P25<br/><strong>{Math.round(stats.p25EntryToTargetHours / 24)}d</strong></span><span>Median<br/><strong>{Math.round(stats.medianEntryToTargetHours / 24)}d</strong></span><span>P75<br/><strong>{Math.round(stats.p75EntryToTargetHours / 24)}d</strong></span></div>
              <p className="fine-print">Duration records inform fixed-time exits only. They do not overwrite the price-action event.</p>
            </aside>
          </div>
        </section>

        <section className="workspace-section" ref={node => { sectionRefs.current.construction = node; }}>
          <div className="section-heading"><div><span className="step-number">02</span><p className="eyebrow">Mechanical search space</p><h2>Spread construction</h2></div><span className="count-chip">{desiredSpreads.length} base combinations · {retrievedSpreads.length} expiry candidates</span></div>
          <div className="construction-layout">
            <div className="config-card card">
              <div className="config-block"><label className="config-label">Expiry Horizon <small>admissible listing band</small></label><CheckboxGroup values={DTE_OPTIONS} selected={dtes} onChange={changeHorizons} formatter={value => `~${value}D`} /></div>
              <div className="config-block"><label className="config-label">Spread width <small>desired USD strike gap</small></label><CheckboxGroup values={WIDTH_OPTIONS} selected={widths} onChange={setWidths} formatter={value => `$${value / 1000}k`} /></div>
              <div className="config-block"><span className="config-label">Expiry selection mode <small>entry-time evidence only</small></span><div className="mode-list">
                <label><input type="radio" name="expiry-mode" checked={expirySelectionMode === "liquidity-aware"} onChange={() => setExpirySelectionMode("liquidity-aware")} />Liquidity-aware</label>
                <label><input type="radio" name="expiry-mode" checked={expirySelectionMode === "closest-dte"} onChange={() => setExpirySelectionMode("closest-dte")} />Closest DTE</label>
                <label><input type="radio" name="expiry-mode" checked={expirySelectionMode === "all-eligible"} onChange={() => setExpirySelectionMode("all-eligible")} />Test all eligible</label>
              </div></div>
              <div className="config-block two-col">
                <label>Payoff engine<select value={spreadKind} onChange={event => setSpreadKind(event.target.value as SpreadKind)}><option value="credit">Credit · MR default</option><option value="debit">Debit · same anchor rule</option></select></label>
                <label>Historical execution<select value={executionMode} onChange={event => setExecutionMode(event.target.value as ExecutionMode)}><option value="maker">Maker · default</option><option value="taker">Taker</option></select></label>
              </div>
              <div className="config-block two-col"><label>Order packaging<select value={comboExecution ? "combo" : "legs"} onChange={event => setComboExecution(event.target.value === "combo")}><option value="legs">Separate legs · conservative</option><option value="combo">Deribit option combo</option></select></label><label>Contracts<input type="number" min="0.1" step="0.1" value={amount} onChange={event => setAmount(Math.max(0.1, Number(event.target.value)))} /></label></div>
              <div className="config-block"><label className="config-label">Pricing output <small>both retained by default</small></label><div className="check-row"><label className={`check-chip ${pricingModes.includes("vwap") ? "checked" : ""}`}><input type="checkbox" checked={pricingModes.includes("vwap")} onChange={() => setPricingModes(current => current.includes("vwap") ? current.filter(value => value !== "vwap") : [...current, "vwap"])} />Raw VWAP</label><label className={`check-chip ${pricingModes.includes("iv") ? "checked" : ""}`}><input type="checkbox" checked={pricingModes.includes("iv")} onChange={() => setPricingModes(current => current.includes("iv") ? current.filter(value => value !== "iv") : [...current, "iv"])} />IV normalized</label></div></div>
            </div>
            <details className="advanced-settings card">
              <summary>Advanced Settings <small>DTE tolerance</small></summary>
              <div className="tolerance-grid">
                {DTE_OPTIONS.map(target => <div className="tolerance-row" key={target}><strong>~{target}D</strong><label>Min<input type="number" min="0" step="0.5" value={dteTolerances[target].min} onChange={event => updateTolerance(target, "min", Number(event.target.value))} /></label><span>to</span><label>Max<input type="number" min="0" step="0.5" value={dteTolerances[target].max} onChange={event => updateTolerance(target, "max", Number(event.target.value))} /></label><span>actual DTE</span></div>)}
              </div>
            </details>
            <div className="logic-card card">
              <p className="eyebrow">Strike rule applied</p>
              <div className="logic-flow"><span><small>Extreme</small><strong>{money(selectedEvent.extremePrice)}</strong></span><i>→</i><span><small>{selectedEvent.direction === "long" ? "Round down" : "Round up"}</small><strong>{desiredSpreads[0] ? money(desiredSpreads[0].anchorStrike) : "Needs extreme"}</strong></span><i>→</i><span><small>Structure</small><strong>{desiredSpreads[0]?.structure ?? "—"}</strong></span></div>
              <p className="fine-print">When the extreme is less than $100 from the rounded strike, the engine adds a separate $1k outward-buffer test. Both legs always use the same expiry. Liquidity-aware mode ranks Green above Yellow, then uses proximity to the target horizon; it retains the winner and one viable alternative.</p>
            </div>
          </div>
          <div className="table-card card">
            <div className="card-title-row"><div><p className="eyebrow">Generated matrix</p><h3>Desired → historical contract</h3></div><button className="secondary-button" onClick={() => jump("contracts")}>Load contracts</button></div>
            <div className="table-scroll"><table><thead><tr><th>Structure</th><th>Expiry horizon</th><th>Actual expiry</th><th>Desired → actual legs</th><th>Entry liquidity</th><th>DTE fit</th><th>Selection</th></tr></thead><tbody>
              {retrievedSpreads.map(spread => (
                <tr className={selectedSpread?.id === spread.id ? "row-selected" : ""} key={spread.id} onClick={() => setSelectedSpreadId(spread.id)}>
                  <td><strong>{spread.structure}</strong>{spread.buffered && <small className="buffer-tag">buffer</small>}</td>
                  <td><strong>~{spread.targetDte}D</strong><small>{spread.dteMin}–{spread.dteMax}D eligible</small></td>
                  <td>{spread.expiryLabel ?? "—"}<small>{spread.actualDte !== undefined ? `${spread.actualDte.toFixed(1)}D actual` : "awaiting contracts"}</small></td>
                  <td><span className="mono">S {money(spread.soldStrike)} → {money(spread.soldContract?.strike)}</span><small className="mono">B {money(spread.boughtStrike)} → {money(spread.boughtContract?.strike)}</small></td>
                  <td><span className={flagClass(spread.entryLiquidityQuality ?? "red")}>{spread.entryLiquidityQuality ?? "unscored"}</span><small>S {spread.entryLiquidity?.shortTrades2h ?? 0} / L {spread.entryLiquidity?.longTrades2h ?? 0} prints · {(spread.entryLiquidity?.shortAmount2h ?? 0).toFixed(2)} / {(spread.entryLiquidity?.longAmount2h ?? 0).toFixed(2)} amount</small><small>sync {spread.entryLiquidity?.legTimeDiffMin?.toFixed(0) ?? "—"}m · index {spread.entryLiquidity?.indexDiffPct?.toFixed(2) ?? "—"}%</small><small>compatible prior 24h / 7d: {(spread.entryLiquidity?.previous24hShort.compatibleTradeCount ?? 0) + (spread.entryLiquidity?.previous24hLong.compatibleTradeCount ?? 0)} / {(spread.entryLiquidity?.previous7dShort.compatibleTradeCount ?? 0) + (spread.entryLiquidity?.previous7dLong.compatibleTradeCount ?? 0)}</small></td>
                  <td>{spread.dteDistance !== undefined ? `Δ ${spread.dteDistance.toFixed(1)}D` : "—"}<small>vs target ~{spread.targetDte}D</small></td>
                  <td><span className={`candidate-status ${spread.candidateStatus ?? "rejected"}`}>{spread.candidateStatus ?? "unscored"}{spread.expiryRank ? ` · #${spread.expiryRank}` : ""}</span><small className="selection-reason">{spread.expirySelectionReason ?? spread.retrievalNote}</small></td>
                </tr>
              ))}
              {!retrievedSpreads.length && <tr><td colSpan={7} className="empty-cell">Load eligible contract histories to discover and rank every listed expiry in the selected horizon bands.</td></tr>}
            </tbody></table></div>
          </div>
        </section>

        <section className="workspace-section" ref={node => { sectionRefs.current.contracts = node; }}>
          <div className="section-heading"><div><span className="step-number">03</span><p className="eyebrow">Historical tape</p><h2>Contracts & normalization</h2></div><div className="inventory-summary"><span><strong>{inventory.length}</strong> contracts</span><span><strong>{inventoryTrades.toLocaleString()}</strong> prints</span><span><strong>{inventoryExpiries}</strong> expiries</span></div></div>
          <div className="import-card card"><div><p className="eyebrow">Deribit History API</p><h3>Load historical option contracts</h3><p>The server resolves eligible instruments from Deribit listing metadata and retrieves only the exact contract histories required by the current matrix.</p></div><div className="import-actions"><button className="primary-button" disabled={sourceBusy} onClick={() => loadRequiredContracts(false)}>{sourceBusy ? "Loading contracts…" : "Load contracts"}</button><button className="secondary-button" disabled={sourceBusy} onClick={() => loadRequiredContracts(true)}>Refresh API manifest</button></div><div className="parse-status"><span className={inventory.length || sourceReady ? "live-dot" : "idle-dot"} />{parseStatus}</div></div>

          <div className="normalization-grid">
            <div className="table-card card">
              <div className="card-title-row"><div><p className="eyebrow">Selected spread · entry</p><h3>Five-window normalization</h3></div>{selectedSpread && <span className="tiny-badge">{selectedSpread.structure}</span>}</div>
              <div className="table-scroll compact"><table><thead><tr><th>Window</th><th>Sold prints</th><th>Bought prints</th><th>Sold VWAP</th><th>Bought VWAP</th><th>Sold IV px</th><th>Bought IV px</th><th>Index mismatch</th><th>Quality</th></tr></thead><tbody>
                {entryWindowRows.map(row => <tr key={row.sold.windowMinutes}><td>±{row.sold.windowMinutes < 60 ? `${row.sold.windowMinutes}m` : `${row.sold.windowMinutes / 60}h`}</td><td>{row.sold.compatibleTradeCount}/{row.sold.tradeCount}<small>{row.sold.totalAmount.toFixed(2)} BTC</small></td><td>{row.bought.compatibleTradeCount}/{row.bought.tradeCount}<small>{row.bought.totalAmount.toFixed(2)} BTC</small></td><td>{btc(row.sold.vwapPriceBtc)}</td><td>{btc(row.bought.vwapPriceBtc)}</td><td>{btc(row.sold.ivNormalizedPriceBtc)}</td><td>{btc(row.bought.ivNormalizedPriceBtc)}</td><td>{pct(row.indexDiffPct)}</td><td><span className={flagClass(row.qualityFlag)}>{row.qualityFlag}</span></td></tr>)}
                {!entryWindowRows.length && <tr><td colSpan={9} className="empty-cell">Select a complete retrieved spread to compute window metrics.</td></tr>}
              </tbody></table></div>
            </div>
            <aside className="quality-card card">
              <p className="eyebrow">Synchronization gate</p><h3>{entryWindowRows.find(row => row.sold.nearestTrade && row.bought.nearestTrade)?.qualityFlag ?? "No score"}</h3>
              {(() => { const best = entryWindowRows.find(row => row.sold.nearestTrade && row.bought.nearestTrade); return best ? <><dl><div><dt>Sold timestamp</dt><dd>{formatUtc(best.soldLegTimestamp)}</dd></div><div><dt>Bought timestamp</dt><dd>{formatUtc(best.boughtLegTimestamp)}</dd></div><div><dt>Leg time difference</dt><dd>{best.legTimeDiffMin?.toFixed(1) ?? "—"} min</dd></div><div><dt>Index difference</dt><dd>{pct(best.indexDiffPct)}</dd></div><div><dt>IV difference</dt><dd>{best.ivDiff?.toFixed(2) ?? "—"} pts</dd></div></dl><p className="quality-reason">{best.qualityReason}</p></> : <p className="empty-note">Both legs need historical prints before synchronization can be scored.</p>; })()}
              <div className="legend"><span><QualityDot flag="green" />≤30m / ≤0.5%</span><span><QualityDot flag="yellow" />≤2h / ≤1.5%</span><span><QualityDot flag="red" />fallback / missing</span></div>
            </aside>
          </div>
          <div className="action-bar"><div><strong>Ready to value {retrievedSpreads.filter(spread => spread.selectedForTest && spread.entryLiquidity?.viable).length} selected expiry candidates</strong><span>4H grid · VPOC · credit capture · fixed time · invalidation · expiry</span></div><button className="primary-button" onClick={runBacktest}>Run full backtest</button></div>
          {analysisStatus && <p className="inline-status strong">{analysisStatus}</p>}
        </section>

        <section className="workspace-section" ref={node => { sectionRefs.current.analysis = node; }}>
          <div className="section-heading"><div><span className="step-number">04</span><p className="eyebrow">Path-aware output</p><h2>PnL, exits & trust filters</h2></div><button className="secondary-button" disabled={!analysisResults.length} onClick={exportResults}>Export JSON</button></div>
          <div className="filter-row"><div className="segmented">{([['all','All tests'],['trusted','Green / yellow'],['green','Green only']] as const).map(([value,label]) => <button className={resultsFilter === value ? "active" : ""} onClick={() => setResultsFilter(value)} key={value}>{label}</button>)}</div><span>{filteredResults.length} / {analysisResults.length} results visible</span></div>
          <div className="cashflow-explainer card"><strong>Cash-flow identities</strong><p>Credit: gross entry credit = sold premium received − bought premium paid; net opening cash flow = gross entry credit × amount − opening fees; mark-to-close PnL = opening cash flow − closing cost − exit fees. Debit spreads mirror the cash-flow direction: opening cash flow is negative and closing proceeds are positive.</p><p>The first path point is a hypothetical immediate close, including both opening and closing fees. It can be negative and is not the gross entry credit or debit.</p></div>
          <div className="table-card card"><div className="table-scroll"><table><thead><tr><th><span className="sr-only">Expand</span></th><th>Selected-exit trust</th><th>Spread</th><th>Expiry</th><th>Width</th><th>{spreadKind === "credit" ? "Gross entry credit · Raw" : "Gross entry debit · Raw"}</th><th>{spreadKind === "credit" ? "Gross entry credit · IV" : "Gross entry debit · IV"}</th><th>Best IV PnL</th><th>Worst IV PnL</th><th>Selected exit</th></tr></thead><tbody>
            {filteredResults.map(result => {
              const best = Math.max(...result.path.map(point => point.ivPnlUsd ?? -Infinity));
              const worst = Math.min(...result.path.map(point => point.ivPnlUsd ?? Infinity));
              const expanded = expandedResultIds.includes(result.spread.id);
              return <Fragment key={result.spread.id}><tr className={selectedAnalysis?.spread.id === result.spread.id ? "row-selected" : ""} onClick={() => setSelectedResultId(result.spread.id)}><td><button className="expand-button" aria-expanded={expanded} aria-controls={`ledger-${result.spread.id}`} aria-label={`${expanded ? "Collapse" : "Expand"} opening ledgers for ${result.spread.structure}`} onClick={event => { event.stopPropagation(); setExpandedResultIds(current => expanded ? current.filter(id => id !== result.spread.id) : [...current, result.spread.id]); }}>⌄</button></td><td><span className={flagClass(result.eventQuality)}>{result.eventQuality}</span><small>Entry {result.entryLedgers?.iv.qualityFlag ?? "red"} · exit {result.selectedExit?.qualityFlag ?? "red"}</small></td><td><strong>{result.spread.structure}</strong><small className="mono">{result.spread.soldContract?.strike} / {result.spread.boughtContract?.strike} {result.spread.optionType}</small></td><td>{result.spread.expiryLabel}<small>Target ~{result.spread.targetDte}D · actual {result.spread.actualDte?.toFixed(1)}D · rank #{result.spread.expiryRank}</small></td><td>{money(result.spread.actualWidth)}</td><td>{btc(result.entryLedgers?.raw.grossEntryBtcPerContract)}</td><td>{btc(result.entryLedgers?.iv.grossEntryBtcPerContract)}</td><td className="positive">{best === -Infinity ? "—" : money(best)}</td><td className="negative">{worst === Infinity ? "—" : money(worst)}</td><td>{result.selectedExit?.rule ?? "—"}<small>{money(result.selectedExit?.ivPnlUsd ?? result.selectedExit?.rawPnlUsd)}</small></td></tr>{expanded && <tr className="ledger-detail-row"><td colSpan={10}><div id={`ledger-${result.spread.id}`} className="ledger-pair">{result.entryLedgers ? <><Ledger ledger={result.entryLedgers.raw}/><Ledger ledger={result.entryLedgers.iv}/></> : <p>Opening evidence was insufficient to produce complete ledgers.</p>}</div></td></tr>}</Fragment>;
            })}
            {!filteredResults.length && <tr><td colSpan={10} className="empty-cell">Run the backtest after importing eligible contract histories. Red tests remain visible in “All tests.”</td></tr>}
          </tbody></table></div></div>

          {selectedAnalysis && <div className="analysis-detail">
            <div className="path-card card">
              <div className="card-title-row"><div><p className="eyebrow">Selected combination</p><h3>4H valuation path</h3></div><span className={flagClass(selectedAnalysis.eventQuality)}>{selectedAnalysis.eventQuality} event</span></div>
              <div className="mini-chart" aria-label="IV normalized PnL path chart">{(() => {
                const points = selectedAnalysis.path.filter(point => point.ivPnlUsd !== undefined);
                if (points.length < 2) return <p className="empty-note">Not enough IV-normalized points to draw the path.</p>;
                const values = points.map(point => point.ivPnlUsd!);
                const min = Math.min(...values); const max = Math.max(...values); const range = max - min || 1;
                const polyline = points.map((point, index) => `${(index / (points.length - 1)) * 100},${92 - ((point.ivPnlUsd! - min) / range) * 78}`).join(" ");
                const zeroY = 92 - ((0 - min) / range) * 78;
                return <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img"><line x1="0" x2="100" y1={zeroY} y2={zeroY} className="zero-line"/><polygon points={`0,92 ${polyline} 100,92`} className="pnl-area"/><polyline points={polyline} className="pnl-line"/></svg>;
              })()}</div>
              <div className="path-metrics"><span><small>Best unrealized</small><strong className="positive">{money(Math.max(...selectedAnalysis.path.map(point => point.ivPnlUsd ?? point.rawPnlUsd ?? -Infinity)))}</strong></span><span><small>Max adverse</small><strong className="negative">{money(Math.min(...selectedAnalysis.path.map(point => point.ivPnlUsd ?? point.rawPnlUsd ?? Infinity)))}</strong></span><span><small>Grid points</small><strong>{selectedAnalysis.path.length}</strong></span></div>
              <div className="table-scroll compact path-table"><table><thead><tr><th>Timestamp</th><th>BTC index</th><th>Raw value</th><th>IV value</th><th>Raw PnL USD</th><th>IV PnL USD</th><th>Data</th></tr></thead><tbody>{selectedAnalysis.path.slice(0, 80).map(point => <tr key={point.timestamp}><td>{formatUtc(point.timestamp)}</td><td>{money(point.btcIndex)}</td><td>{btc(point.rawSpreadValue)}</td><td>{btc(point.ivSpreadValue)}</td><td>{money(point.rawPnlUsd)}</td><td className={(point.ivPnlUsd ?? 0) >= 0 ? "positive" : "negative"}>{money(point.ivPnlUsd)}</td><td><span className={flagClass(point.qualityFlag)}>{point.qualityFlag}</span></td></tr>)}</tbody></table></div>
            </div>
            <aside className="exit-card card"><p className="eyebrow">Exit engine</p><h3>Independent outcomes</h3><p className="quality-reason"><strong>Entry pricing evidence:</strong> {selectedAnalysis.entryLedgers?.iv.qualityReason ?? "Unavailable"}</p><div className="exit-list">{selectedAnalysis.exits.map(exit => <div className={`exit-row ${exit.status}`} key={exit.rule}><span>{exit.qualityFlag ? <QualityDot flag={exit.qualityFlag} /> : <span className="quality-dot muted" />}{exit.rule}<small>{exit.timestamp ? formatUtc(exit.timestamp) : exit.status.replace("-", " ")} · {exit.qualityReason}</small></span><strong>{money(exit.ivPnlUsd ?? exit.rawPnlUsd)}</strong></div>)}</div><div className="ledger-note"><strong>Trust means reliability</strong><p>Red, Yellow, and Green describe pricing evidence only—not profitability. Displayed trust combines entry evidence with the selected exit’s own evidence.</p></div></aside>
          </div>}
        </section>

        <footer><span>BTC Options Lab · local research environment</span><span>All timestamps UTC · expiry settlement 08:00 UTC</span></footer>
      </div>
    </main>
  );
}
