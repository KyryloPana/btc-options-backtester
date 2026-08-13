const INTERVAL_MS: Record<string, number> = {
  "1h": 3_600_000,
  "4h": 14_400_000,
};

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const interval = params.get("interval") ?? "1h";
  const start = Number(params.get("start"));
  const end = Number(params.get("end"));
  if (!INTERVAL_MS[interval] || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    return Response.json({ error: "Use valid start/end timestamps and interval=1h or 4h." }, { status: 400 });
  }
  const hardEnd = Math.min(end, start + 370 * 86_400_000);
  const candles: unknown[] = [];
  let cursor = start;
  try {
    for (let page = 0; page < 10 && cursor < hardEnd; page += 1) {
      const url = new URL("https://data-api.binance.vision/api/v3/klines");
      url.searchParams.set("symbol", "BTCUSDT");
      url.searchParams.set("interval", interval);
      url.searchParams.set("startTime", String(cursor));
      url.searchParams.set("endTime", String(hardEnd));
      url.searchParams.set("limit", "1000");
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Market data returned ${response.status}.`);
      const pageRows = await response.json() as unknown[][];
      if (!Array.isArray(pageRows) || !pageRows.length) break;
      candles.push(...pageRows);
      const last = pageRows[pageRows.length - 1];
      const lastOpen = Number(last?.[0]);
      if (!Number.isFinite(lastOpen)) break;
      cursor = lastOpen + INTERVAL_MS[interval];
      if (pageRows.length < 1000) break;
    }
    return Response.json({
      source: "Binance BTCUSDT",
      interval,
      candles: candles.map(row => {
        const values = row as unknown[];
        return {
          openTime: Number(values[0]),
          open: Number(values[1]),
          high: Number(values[2]),
          low: Number(values[3]),
          close: Number(values[4]),
          volume: Number(values[5]),
          closeTime: Number(values[6]),
        };
      }),
    }, { headers: { "Cache-Control": "public, max-age=3600" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "BTC market data could not be loaded.",
      fallback: "Import candles manually or enter a UTC timestamp.",
    }, { status: 502 });
  }
}
