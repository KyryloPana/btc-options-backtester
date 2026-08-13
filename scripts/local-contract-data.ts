import { mkdir, opendir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { buildInventory, parseContractText } from "../app/lib/backtester.ts";

const API_PREFIX = "/__local/contracts";
const CACHE_VERSION = 1;
const DAY_MS = 86_400_000;
const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

type IndexPhase = "unconfigured" | "idle" | "indexing" | "ready" | "error";

interface IndexedContract {
  instrumentName: string;
  expiryTimestamp: number;
  expiryLabel: string;
  strike: number;
  optionType: "C" | "P";
  files: string[];
}

interface ContractIndex {
  version: number;
  rootPath: string;
  createdAt: string;
  filesScanned: number;
  jsonFiles: number;
  unrecognizedFiles: number;
  contracts: IndexedContract[];
}

interface IndexState {
  phase: IndexPhase;
  configuredPath?: string;
  filesScanned: number;
  jsonFiles: number;
  contractsFound: number;
  unrecognizedFiles: number;
  createdAt?: string;
  error?: string;
}

interface DesiredRequest {
  requestId: string;
  targetDte: number;
  minDte: number;
  maxDte: number;
  soldStrike: number;
  boughtStrike: number;
  optionType: "C" | "P";
}

interface ContractCandidateManifest {
  requestId: string;
  targetDte: number;
  minDte: number;
  maxDte: number;
  desiredSoldStrike: number;
  desiredBoughtStrike: number;
  expiryTimestamp: number;
  expiryLabel: string;
  actualDte: number;
  soldInstrumentName?: string;
  boughtInstrumentName?: string;
  soldStrike?: number;
  boughtStrike?: number;
  strikeResolutionSensible: boolean;
  strikeResolutionNote: string;
}

function parseInstrument(value: string) {
  const match = value.toUpperCase().match(/BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-(C|P)/);
  if (!match || MONTHS[match[2]] === undefined) return null;
  const expiryTimestamp = Date.UTC(2000 + Number(match[3]), MONTHS[match[2]], Number(match[1]), 8, 0, 0);
  return {
    instrumentName: match[0],
    expiryTimestamp,
    expiryLabel: `${match[1]}${match[2]}${match[3]}`,
    strike: Number(match[4]),
    optionType: match[5] as "C" | "P",
  };
}

async function pathExists(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function nearestStrike(chain: IndexedContract[], desired: number) {
  return [...chain].sort((a, b) => Math.abs(a.strike - desired) - Math.abs(b.strike - desired) || a.strike - b.strike)[0];
}

export class LocalContractService {
  private rootPath: string | undefined;
  private cachePath: string;
  private index?: ContractIndex;
  private indexing?: Promise<void>;
  private cacheChecked = false;
  private state: IndexState;

  constructor(rootPath: string | undefined, cachePath: string) {
    this.rootPath = rootPath?.trim().replace(/^['"]|['"]$/g, "");
    this.cachePath = cachePath;
    this.state = this.rootPath
      ? { phase: "idle", configuredPath: this.rootPath, filesScanned: 0, jsonFiles: 0, contractsFound: 0, unrecognizedFiles: 0 }
      : { phase: "unconfigured", filesScanned: 0, jsonFiles: 0, contractsFound: 0, unrecognizedFiles: 0 };
  }

  private async loadCache() {
    if (this.cacheChecked || !this.rootPath) return;
    this.cacheChecked = true;
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as ContractIndex;
      if (parsed.version !== CACHE_VERSION || resolve(parsed.rootPath) !== resolve(this.rootPath)) return;
      this.index = parsed;
      this.state = {
        phase: "ready",
        configuredPath: this.rootPath,
        filesScanned: parsed.filesScanned,
        jsonFiles: parsed.jsonFiles,
        contractsFound: parsed.contracts.length,
        unrecognizedFiles: parsed.unrecognizedFiles,
        createdAt: parsed.createdAt,
      };
    } catch {
      // A missing or invalid cache simply means the folder must be indexed.
    }
  }

  async status() {
    await this.loadCache();
    return { ...this.state, pathExists: this.rootPath ? await pathExists(this.rootPath) : false };
  }

  async startIndex(force = false) {
    await this.loadCache();
    if (!this.rootPath) throw new Error("CONTRACT_DATA_PATH is not configured.");
    if (!(await pathExists(this.rootPath))) throw new Error(`Configured contract folder does not exist: ${this.rootPath}`);
    if (this.indexing) return this.status();
    if (this.index && !force) return this.status();
    this.indexing = this.buildIndex().finally(() => { this.indexing = undefined; });
    return this.status();
  }

  private async buildIndex() {
    if (!this.rootPath) return;
    const contracts = new Map<string, IndexedContract>();
    this.state = { phase: "indexing", configuredPath: this.rootPath, filesScanned: 0, jsonFiles: 0, contractsFound: 0, unrecognizedFiles: 0 };
    try {
      const pending = [this.rootPath];
      while (pending.length) {
        const directory = pending.pop()!;
        const handle = await opendir(directory);
        for await (const entry of handle) {
          const absolutePath = join(directory, entry.name);
          if (entry.isDirectory()) {
            pending.push(absolutePath);
            continue;
          }
          if (!entry.isFile()) continue;
          this.state.filesScanned += 1;
          if (!/\.jsonl?$/i.test(entry.name)) continue;
          this.state.jsonFiles += 1;
          const filePath = relative(this.rootPath, absolutePath);
          const parsed = parseInstrument(filePath);
          if (!parsed) {
            this.state.unrecognizedFiles += 1;
            continue;
          }
          const existing = contracts.get(parsed.instrumentName);
          if (existing) existing.files.push(filePath);
          else contracts.set(parsed.instrumentName, { ...parsed, files: [filePath] });
          this.state.contractsFound = contracts.size;
        }
      }
      const createdAt = new Date().toISOString();
      this.index = {
        version: CACHE_VERSION,
        rootPath: this.rootPath,
        createdAt,
        filesScanned: this.state.filesScanned,
        jsonFiles: this.state.jsonFiles,
        unrecognizedFiles: this.state.unrecognizedFiles,
        contracts: [...contracts.values()].sort((a, b) => a.expiryTimestamp - b.expiryTimestamp || a.strike - b.strike),
      };
      await mkdir(resolve(this.cachePath, ".."), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify(this.index), "utf8");
      this.state = { ...this.state, phase: "ready", createdAt };
    } catch (error) {
      this.state = { ...this.state, phase: "error", error: error instanceof Error ? error.message : "Contract indexing failed." };
    }
  }

  async resolve(entryTimestamp: number, requests: DesiredRequest[]) {
    await this.loadCache();
    if (!this.rootPath || !this.index) throw new Error("Index the configured contract folder before loading contracts.");
    if (!Number.isFinite(entryTimestamp) || !Array.isArray(requests)) throw new Error("A valid entry timestamp and spread requests are required.");

    const selected = new Map<string, IndexedContract>();
    const unavailable: string[] = [];
    const candidates: ContractCandidateManifest[] = [];
    for (const request of requests) {
      const expiries = [...new Set(this.index.contracts
        .filter(item => item.optionType === request.optionType && item.expiryTimestamp > entryTimestamp)
        .map(item => item.expiryTimestamp))]
        .filter(expiry => {
          const actualDte = (expiry - entryTimestamp) / DAY_MS;
          return actualDte >= request.minDte && actualDte <= request.maxDte;
        })
        .sort((a, b) => a - b);
      if (!expiries.length) {
        unavailable.push(`${request.optionType} ~${request.targetDte}D: no expiry in ${request.minDte}–${request.maxDte}D band`);
        continue;
      }
      for (const expiry of expiries) {
        const chain = this.index.contracts.filter(item => item.optionType === request.optionType && item.expiryTimestamp === expiry);
        const sold = nearestStrike(chain, request.soldStrike);
        const bought = nearestStrike(chain, request.boughtStrike);
        const expectedDirection = Math.sign(request.soldStrike - request.boughtStrike);
        const resolvedDirection = sold && bought ? Math.sign(sold.strike - bought.strike) : 0;
        const strikeResolutionSensible = Boolean(sold && bought && sold.instrumentName !== bought.instrumentName && expectedDirection === resolvedDirection);
        const strikeResolutionNote = !sold || !bought
          ? "One or both desired strikes could not be resolved from the indexed chain."
          : sold.instrumentName === bought.instrumentName
            ? "Both desired legs resolve to the same listed contract."
            : expectedDirection !== resolvedDirection
              ? "Nearest listed strikes reverse the intended spread structure."
              : `Resolved ${request.soldStrike}/${request.boughtStrike} to ${sold.strike}/${bought.strike}.`;
        candidates.push({
          requestId: request.requestId,
          targetDte: request.targetDte,
          minDte: request.minDte,
          maxDte: request.maxDte,
          desiredSoldStrike: request.soldStrike,
          desiredBoughtStrike: request.boughtStrike,
          expiryTimestamp: expiry,
          expiryLabel: sold?.expiryLabel ?? bought?.expiryLabel ?? new Date(expiry).toISOString().slice(0, 10),
          actualDte: (expiry - entryTimestamp) / DAY_MS,
          soldInstrumentName: sold?.instrumentName,
          boughtInstrumentName: bought?.instrumentName,
          soldStrike: sold?.strike,
          boughtStrike: bought?.strike,
          strikeResolutionSensible,
          strikeResolutionNote,
        });
        if (sold) selected.set(sold.instrumentName, sold);
        if (bought) selected.set(bought.instrumentName, bought);
      }
    }

    const parsedFiles: Array<{ name: string; trades: ReturnType<typeof parseContractText> }> = [];
    const failedFiles: string[] = [];
    for (const contract of selected.values()) {
      for (const file of contract.files) {
        try {
          parsedFiles.push({ name: file, trades: parseContractText(await readFile(join(this.rootPath, file), "utf8")) });
        } catch {
          failedFiles.push(file);
        }
      }
    }
    const inventory = buildInventory(parsedFiles);
    return {
      inventory,
      candidates,
      diagnostics: {
        indexedContracts: this.index.contracts.length,
        selectedContracts: selected.size,
        filesRead: parsedFiles.length,
        failedFiles,
        unavailable,
        candidateExpiries: candidates.length,
        validTrades: inventory.reduce((sum, item) => sum + item.trades.length, 0),
      },
    };
  }
}

export function localContractDataPlugin(options: { rootPath?: string; cachePath: string }): Plugin {
  const service = new LocalContractService(options.rootPath, options.cachePath);
  return {
    name: "local-contract-data",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(API_PREFIX, async (request, response, next) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname.replace(API_PREFIX, "") || "/";
        try {
          if (request.method === "GET" && path === "/status") return sendJson(response, 200, await service.status());
          if (request.method === "POST" && path === "/index") {
            const body = await readBody(request);
            return sendJson(response, 202, await service.startIndex(body.force === true));
          }
          if (request.method === "POST" && path === "/resolve") {
            const body = await readBody(request);
            const payload = await service.resolve(Number(body.entryTimestamp), (body.requests ?? []) as DesiredRequest[]);
            return sendJson(response, 200, payload);
          }
          next();
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : "Local contract request failed." });
        }
      });
    },
  };
}
