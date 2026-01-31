import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Cross-exchange Perpetuals comparison (frontend-only)
 *
 * Binance USDⓈ-M Futures (Perps):
 *   Mark price + funding (WS): wss://fstream.binance.com/ws/!markPrice@arr@1s
 *   24h ticker stats (REST):  https://fapi.binance.com/fapi/v1/ticker/24hr
 *   Funding interval overrides (REST): https://fapi.binance.com/fapi/v1/fundingInfo
 *
 * OKX Perpetuals (SWAP):
 *   Mark price (REST):    https://www.okx.com/api/v5/public/mark-price?instType=SWAP
 *   Funding rate (REST):  https://www.okx.com/api/v5/public/funding-rate?instId=ANY
 *   24h tickers (REST):   https://www.okx.com/api/v5/market/tickers?instType=SWAP
 *
 * Notes:
 * - Public endpoints: no API keys.
 * - CORS can still block browser fetches. If OKX/Binance REST fails in browser, you need a proxy.
 * - USDT-only is enforced so 24h volumes are comparable in USDT.
 */

const BINANCE_WS_URL = "wss://fstream.binance.com/ws/!markPrice@arr@1s";
const BINANCE_REST_BASE = "https://fapi.binance.com";
const OKX_REST_BASE = "https://www.okx.com";
const OKX_WS_URL = "wss://ws.okx.com:8443/ws/v5/public";

// Update cadence.
// - Binance WS streams continuously.
// - OKX mark price via WS (push).
// - Funding + 24h volumes via REST (slow).
const UI_REFRESH_MS = 1000;
const BINANCE_24H_POLL_MS = 60_000;
const OKX_FUNDING_POLL_MS = 60_000;
const OKX_24H_POLL_MS = 60_000;

type SortKey =
  | "bnPrice"
  | "okxPrice"
  | "priceDiff"
  | "bnFunding"
  | "okxFunding"
  | "fundingDiff"
  | "bnVol24h"
  | "okxVol24h";

type SortState = { key: SortKey; dir: "asc" | "desc" };

type Row = {
  ticker: string;

  bnPrice: number | null;
  okxPrice: number | null;

  bnFunding: number | null;
  okxFunding: number | null;

  // 24h quote volume in USDT (for USDT contracts)
  bnVol24h: number | null;
  okxVol24h: number | null;

  // OKX SWAP ticker fields (derivatives):
  // - volCcy24h: 24h trading volume in base currency
  // We store base volume and convert to USDT using mark/last price.
  okxBaseVol24h: number | null;

  // Used to infer funding interval (fallback) by observing nextFundingTime step.
  bnNextFundingTime: number | null;
  okxNextFundingTime: number | null;

  // Funding interval (hours). Binance is 8h by default but can be adjusted per-symbol.
  bnIntervalHours: number | null;
  okxIntervalHours: number | null;
};

type DerivedRow = Row & {
  priceDiff: number | null; // abs fraction
  fundingDiff: number | null; // abs rate
};

const USDT_TICKER_RE = /^[A-Z0-9]+USDT$/;

function isUsdtTicker(ticker: string): boolean {
  return USDT_TICKER_RE.test(String(ticker).toUpperCase());
}

function fmtNum(n: number | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return n.toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  });
}

function fmtCompact(n: number | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtPct(rate: number | null): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  const pct = rate * 100;
  // Funding-style formatting (matches screenshot): no leading '+'; fixed 4 decimals.
  return `${pct.toFixed(4)}%`;
}

function fmtIntervalH(hours: number | null): string | null {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return null;
  const nearInt = Math.abs(hours - Math.round(hours)) < 1e-6;
  const h = nearInt ? Math.round(hours) : Number(hours.toFixed(1));
  return `${h}h`;
}

function fmtPctAbs(rate: number | null): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  const pct = Math.abs(rate) * 100;
  return `${pct.toFixed(6)}%`;
}

function fmtPctAbsFromFraction(frac: number | null): string {
  return fmtPctAbs(frac);
}

function classNames(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(" ");
}

function signColor(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "text-slate-200";
  if (rate > 0) return "text-orange-400"; // positive = orange
  if (rate < 0) return "text-emerald-300"; // negative = green
  return "text-slate-300";
}

function fundingCell(rate: number | null, intervalHours: number | null) {
  const interval = fmtIntervalH(intervalHours);
  return (
    <div className="flex items-center gap-2">
      <span className={classNames("tabular-nums", signColor(rate))}>{fmtPct(rate)}</span>
      {interval ? (
        <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-200 ring-1 ring-inset ring-emerald-500/20">
          {interval}
        </span>
      ) : null}
    </div>
  );
}

function okxInstIdToCanonical(instId: string | null | undefined): string | null {
  // BTC-USDT-SWAP -> BTCUSDT (ignore extra segments)
  if (!instId) return null;
  const upper = String(instId).toUpperCase();
  if (upper.includes("/") || upper.includes(":")) return null;
  const parts = upper.split("-");
  if (parts.length < 2) return null;
  const base = parts[0];
  const quote = parts[1];
  if (!base || quote !== "USDT") return null;
  return `${base}${quote}`;
}

function getOrInitRow(map: Map<string, Row>, ticker: string): Row {
  const prev = map.get(ticker);
  if (prev) return prev;
  const fresh: Row = {
    ticker,
    bnPrice: null,
    okxPrice: null,
    bnFunding: null,
    okxFunding: null,
    bnVol24h: null,
    okxVol24h: null,
    okxBaseVol24h: null,
    bnNextFundingTime: null,
    okxNextFundingTime: null,
    bnIntervalHours: 8,
    okxIntervalHours: null,
  };
  map.set(ticker, fresh);
  return fresh;
}

function inferIntervalHours(prevNext: number | null, next: number | null): number | null {
  if (!prevNext || !next) return null;
  const delta = next - prevNext;
  if (!Number.isFinite(delta) || delta <= 0) return null;
  if (delta < 30 * 60 * 1000) return null;
  if (delta > 24 * 60 * 60 * 1000) return null;
  return delta / (60 * 60 * 1000);
}

function cmpNullableNumber(a: number | null, b: number | null, dirMul: number): number {
  const aOk = Number.isFinite(a as number);
  const bOk = Number.isFinite(b as number);
  if (!aOk && !bOk) return 0;
  if (!aOk) return 1;
  if (!bOk) return -1;
  return ((a as number) - (b as number)) * dirMul;
}

function priceDiffAbsFrac(row: Row): number | null {
  if (!Number.isFinite(row.bnPrice as number) || !Number.isFinite(row.okxPrice as number)) return null;
  if ((row.bnPrice as number) === 0) return null;
  return Math.abs(((row.okxPrice as number) - (row.bnPrice as number)) / (row.bnPrice as number));
}

function fundingDiffAbs(row: Row): number | null {
  if (!Number.isFinite(row.bnFunding as number) || !Number.isFinite(row.okxFunding as number)) return null;
  return Math.abs((row.okxFunding as number) - (row.bnFunding as number));
}

function convertOkxBaseVolToUsdt(baseVol: number | null, px: number | null): number | null {
  if (!Number.isFinite(baseVol as number) || !Number.isFinite(px as number)) return null;
  return (baseVol as number) * (px as number);
}

// -------------------------
// Lightweight self-tests (dev only)
// -------------------------
function runSelfTests() {
  const assert = (name: string, cond: boolean) => {
    if (!cond) throw new Error(`Self-test failed: ${name}`);
  };

  assert("okxInstIdToCanonical BTC-USDT-SWAP", okxInstIdToCanonical("BTC-USDT-SWAP") === "BTCUSDT");
  assert("okxInstIdToCanonical BTC-USDT", okxInstIdToCanonical("BTC-USDT") === "BTCUSDT");
  assert("isUsdtTicker true", isUsdtTicker("BTCUSDT") === true);
  assert("isUsdtTicker false", isUsdtTicker("BTCUSD") === false);

  assert("inferIntervalHours 8h", inferIntervalHours(1000, 1000 + 8 * 60 * 60 * 1000) === 8);
  assert("inferIntervalHours rejects <30m", inferIntervalHours(1000, 1000 + 10 * 60 * 1000) === null);

  assert("fmtPct 0.0002 -> 0.0200%", fmtPct(0.0002) === "0.0200%");
  assert("fmtIntervalH 8 -> 8h", fmtIntervalH(8) === "8h");
  assert("signColor + -> orange", signColor(0.1) === "text-orange-400");
  assert("signColor - -> green", signColor(-0.1) === "text-emerald-300");

  const r: Row = {
    ticker: "X",
    bnPrice: 100,
    okxPrice: 101,
    bnFunding: 0.0001,
    okxFunding: 0.0002,
    bnVol24h: 1234,
    okxVol24h: 5678,
    okxBaseVol24h: 56.78,
    bnNextFundingTime: null,
    okxNextFundingTime: null,
    bnIntervalHours: 8,
    okxIntervalHours: 1,
  };

  assert("priceDiffAbsFrac 1%", Math.abs((priceDiffAbsFrac(r) as number) - 0.01) < 1e-12);
  assert("fundingDiffAbs", Math.abs((fundingDiffAbs(r) as number) - 0.0001) < 1e-12);
  assert("convertOkxBaseVolToUsdt", Math.abs((convertOkxBaseVolToUsdt(2, 100) as number) - 200) < 1e-12);
  assert("fmtPctAbsFromFraction", fmtPctAbsFromFraction(-0.01).includes("1.000000%"));
}

export default function BinanceFuturesFundingDashboard() {
  // Health
  const [bnConnected, setBnConnected] = useState(false);
  const [bn24hOk, setBn24hOk] = useState(true);
  const [okxMarkOk, setOkxMarkOk] = useState(true);
  const [okxFundingOk, setOkxFundingOk] = useState(true);
  const [okx24hOk, setOkx24hOk] = useState(true);

  // UI
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "priceDiff", dir: "desc" });

  // Data store
  const rowsRef = useRef<Map<string, Row>>(new Map());
  // Binance funding interval overrides (only returned for symbols with adjusted interval).
  const bnFundingIntervalOverridesRef = useRef<Map<string, number>>(new Map());
  // Active symbol sets (best-effort). If empty, we fall back to the original behavior.
  const bnUsdtPerpTickersRef = useRef<Set<string>>(new Set());
  const okxUsdtSwapTickersRef = useRef<Set<string>>(new Set());
  const okxInstIdToTickerRef = useRef<Map<string, string>>(new Map());
  const commonUsdtPerpsRef = useRef<Set<string>>(new Set());

  function recomputeCommonUniverse() {
    const bn = bnUsdtPerpTickersRef.current;
    const okx = okxUsdtSwapTickersRef.current;
    if (bn.size && okx.size) {
      const common = new Set<string>();
      for (const t of bn) {
        if (okx.has(t)) common.add(t);
      }
      commonUsdtPerpsRef.current = common;

      // Prune stale rows that are no longer in the common universe.
      const m = rowsRef.current;
      for (const [ticker] of m.entries()) {
        if (!common.has(ticker)) m.delete(ticker);
      }
      dirtyRef.current = true;
    } else {
      commonUsdtPerpsRef.current = new Set<string>();
    }
  }

  // We collect updates continuously, but only re-render the table every UI_REFRESH_MS.
  const dirtyRef = useRef(false);
  const [rowsVersion, setRowsVersion] = useState(0);

  // Timestamps are updated via refs to avoid re-render spam.
  const bnLastMsRef = useRef<number | null>(null);
  const bn24hLastMsRef = useRef<number | null>(null);
  const okxMarkLastMsRef = useRef<number | null>(null);
  const okxFundingLastMsRef = useRef<number | null>(null);
  const okx24hLastMsRef = useRef<number | null>(null);

  const [bnLastMs, setBnLastMs] = useState<number | null>(null);
  const [bn24hLastMs, setBn24hLastMs] = useState<number | null>(null);
  const [okxLastMarkMs, setOkxLastMarkMs] = useState<number | null>(null);
  const [okxLastFundingMs, setOkxLastFundingMs] = useState<number | null>(null);
  const [okx24hLastMs, setOkx24hLastMs] = useState<number | null>(null);

  // Self-tests (dev only)
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isDev = typeof (import.meta as any) !== "undefined" && (import.meta as any).env?.DEV;
    if (isDev) {
      try {
        runSelfTests();
        // eslint-disable-next-line no-console
        console.log("Self-tests: OK");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
      }
    }
  }, []);

  // -------------------------
  // Binance REST: active USDT-margined perpetual symbols
  // -------------------------
  useEffect(() => {
    let alive = true;

    async function fetchBinanceSymbols() {
      try {
        const url = `${BINANCE_REST_BASE}/fapi/v1/exchangeInfo`;
        const res = await fetch(url, { method: "GET" });
        const json = await res.json();

        if (!alive) return;
        if (!res.ok || !Array.isArray(json?.symbols)) return;

        const active = new Set<string>();
        for (const x of json.symbols) {
          if (x?.contractType !== "PERPETUAL") continue;
          if (String(x?.quoteAsset ?? "").toUpperCase() !== "USDT") continue;
          if (x?.status !== "TRADING") continue;
          const ticker = String(x?.symbol ?? "").toUpperCase();
          if (!isUsdtTicker(ticker)) continue;
          active.add(ticker);
        }

        bnUsdtPerpTickersRef.current = active;
        recomputeCommonUniverse();
      } catch {
        // ignore; fall back to loose filtering
      }
    }

    fetchBinanceSymbols();
    const t = window.setInterval(fetchBinanceSymbols, 5 * 60_000);

    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  // UI refresh tick: update the table every 5 seconds.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setRowsVersion((v) => v + 1);
      }

      setBnLastMs(bnLastMsRef.current);
      setBn24hLastMs(bn24hLastMsRef.current);
      setOkxLastMarkMs(okxMarkLastMsRef.current);
      setOkxLastFundingMs(okxFundingLastMsRef.current);
      setOkx24hLastMs(okx24hLastMsRef.current);
    }, UI_REFRESH_MS);

    return () => window.clearInterval(t);
  }, []);

  // -------------------------
  // Binance WebSocket (mark price + funding)
  // -------------------------
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByUser = false;

    function connect() {
      ws = new WebSocket(BINANCE_WS_URL);

      ws.onopen = () => setBnConnected(true);
      ws.onclose = () => {
        setBnConnected(false);
        if (!closedByUser) window.setTimeout(connect, 1000);
      };

      ws.onmessage = (evt) => {
        try {
          const payload = JSON.parse(evt.data as string);
          if (!Array.isArray(payload)) return;

          const m = rowsRef.current;
          const overrides = bnFundingIntervalOverridesRef.current;

          for (const x of payload) {
            const s = x?.s;
            const p = x?.p;
            const r = x?.r;
            const T = x?.T;
            if (!s || p === undefined || r === undefined) continue;

            const ticker = String(s).toUpperCase();
            if (!isUsdtTicker(ticker)) continue;
            if (bnUsdtPerpTickersRef.current.size && !bnUsdtPerpTickersRef.current.has(ticker)) continue;
            if (commonUsdtPerpsRef.current.size && !commonUsdtPerpsRef.current.has(ticker)) continue;

            const row = getOrInitRow(m, ticker);
            row.bnPrice = Number(p);
            row.bnFunding = Number(r);

            // Funding next time (ms). Use it to infer interval as fallback.
            if (T !== undefined && T !== null) {
              const next = Number(T);
              if (Number.isFinite(next)) {
                const inferred = inferIntervalHours(row.bnNextFundingTime, next);
                if (inferred !== null) row.bnIntervalHours = inferred;
                row.bnNextFundingTime = next;
              }
            }

            // Default is 8h. Some symbols can be adjusted; we fetch overrides via REST.
            const ov = overrides.get(ticker);
            row.bnIntervalHours = ov ?? row.bnIntervalHours ?? 8;
          }

          bnLastMsRef.current = Date.now();
          dirtyRef.current = true;
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error("Error handling Binance WS message:", error);
        }
      };
    }

    connect();

    return () => {
      closedByUser = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  // -------------------------
  // Binance REST: 24h volume (quoteVolume in USDT for USDT pairs)
  // -------------------------
  useEffect(() => {
    let alive = true;

    async function fetchBinance24h() {
      try {
        const url = `${BINANCE_REST_BASE}/fapi/v1/ticker/24hr`;
        const res = await fetch(url, { method: "GET" });
        const json = await res.json();

        if (!alive) return;

        if (!res.ok || !Array.isArray(json)) {
          setBn24hOk(false);
          return;
        }

        const m = rowsRef.current;
        for (const x of json) {
          const symbol = x?.symbol;
          if (!symbol) continue;

          const ticker = String(symbol).toUpperCase();
          if (!isUsdtTicker(ticker)) continue;
          if (bnUsdtPerpTickersRef.current.size && !bnUsdtPerpTickersRef.current.has(ticker)) continue;
          if (commonUsdtPerpsRef.current.size && !commonUsdtPerpsRef.current.has(ticker)) continue;

          // quoteVolume is in quote asset (USDT here)
          const qv = x?.quoteVolume;
          const v = qv !== undefined ? Number(qv) : Number(x?.volume);

          const row = getOrInitRow(m, ticker);
          row.bnVol24h = Number.isFinite(v) ? v : row.bnVol24h;
        }

        bn24hLastMsRef.current = Date.now();
        setBn24hOk(true);
        dirtyRef.current = true;
      } catch (error) {
        if (!alive) return;
        setBn24hOk(false);
        // eslint-disable-next-line no-console
        console.error("Error fetching Binance 24h ticker stats:", error);
      }
    }

    fetchBinance24h();
    const t = window.setInterval(fetchBinance24h, BINANCE_24H_POLL_MS);

    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  // -------------------------
  // Binance REST: funding interval overrides (1h/4h/etc.)
  // Only returns symbols that had fundingIntervalHours adjustment.
  // Default for the rest is 8h.
  // -------------------------
  useEffect(() => {
    let alive = true;

    async function fetchBinanceFundingInfo() {
      try {
        const url = `${BINANCE_REST_BASE}/fapi/v1/fundingInfo`;
        const res = await fetch(url, { method: "GET" });
        const json = await res.json();

        if (!alive) return;

        if (!res.ok || !Array.isArray(json)) {
          return;
        }

        const overrides = new Map<string, number>();
        for (const x of json) {
          const sym = x?.symbol;
          const hrs = x?.fundingIntervalHours;
          if (!sym || hrs === undefined) continue;
          const ticker = String(sym).toUpperCase();
          if (!isUsdtTicker(ticker)) continue;
          if (bnUsdtPerpTickersRef.current.size && !bnUsdtPerpTickersRef.current.has(ticker)) continue;
          if (commonUsdtPerpsRef.current.size && !commonUsdtPerpsRef.current.has(ticker)) continue;
          const h = Number(hrs);
          if (Number.isFinite(h) && h > 0 && h <= 24) overrides.set(ticker, h);
        }

        bnFundingIntervalOverridesRef.current = overrides;

        // Apply overrides to already-known rows.
        const m = rowsRef.current;
        for (const [ticker, row] of m.entries()) {
          if (!isUsdtTicker(ticker)) continue;
          if (bnUsdtPerpTickersRef.current.size && !bnUsdtPerpTickersRef.current.has(ticker)) continue;
          if (commonUsdtPerpsRef.current.size && !commonUsdtPerpsRef.current.has(ticker)) continue;
          row.bnIntervalHours = overrides.get(ticker) ?? row.bnIntervalHours ?? 8;
        }

        dirtyRef.current = true;
      } catch {
        // ignore; fall back to default 8h
      }
    }

    fetchBinanceFundingInfo();
    // Interval changes are rare; 60s is fine.
    const t = window.setInterval(fetchBinanceFundingInfo, 60_000);

    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  // -------------------------
  // OKX WebSocket (mark price) — faster + avoids REST CORS.
  // We fetch the SWAP instruments list once, then subscribe in batches.
  // -------------------------
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByUser = false;
    let pingTimer: number | null = null;
    let reconnectTimer: number | null = null;

    async function fetchOkxUsdtSwapInstIds(): Promise<string[]> {
      const url = `${OKX_REST_BASE}/api/v5/public/instruments?instType=SWAP`;
      const res = await fetch(url, { method: "GET" });
      const json = await res.json();
      if (!res.ok || json?.code !== "0" || !Array.isArray(json?.data)) return [];

        const instIds: string[] = [];
        const tickerSet = new Set<string>();
        const instToTicker = new Map<string, string>();
        for (const x of json.data) {
          const state = String(x?.state ?? "").toLowerCase();
          if (state && state !== "live") continue;
          const instId = String(x?.instId ?? "").toUpperCase();
          // Only subscribe to USDT-margined swaps so volumes are comparable in USDT.
          if (!instId.endsWith("-USDT-SWAP")) continue;
          const ticker = okxInstIdToCanonical(instId);
          if (!ticker || !isUsdtTicker(ticker)) continue;
          instIds.push(instId);
          tickerSet.add(ticker);
          instToTicker.set(instId, ticker);
        }
      okxUsdtSwapTickersRef.current = tickerSet;
      okxInstIdToTickerRef.current = instToTicker;
      recomputeCommonUniverse();
      return instIds;
    }

    async function connect() {
      try {
        const instIds = await fetchOkxUsdtSwapInstIds();
        if (closedByUser) return;

        if (instIds.length === 0) {
          setOkxMarkOk(false);
          // retry later
          if (!closedByUser) reconnectTimer = window.setTimeout(connect, 2000);
          return;
        }

        ws = new WebSocket(OKX_WS_URL);

        ws.onopen = () => {
          setOkxMarkOk(true);

          // Keepalive: OKX accepts "ping" and replies "pong".
          pingTimer = window.setInterval(() => {
            try {
              ws?.send("ping");
            } catch {
              // ignore
            }
          }, 20_000);

          // Subscribe in batches to respect WS request limits.
          // Conservative batching: 50 instruments per request, 350ms between requests.
          const BATCH = 50;
          let reqId = 1;

          const sendBatch = (start: number) => {
            if (closedByUser) return;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;

            const slice = instIds.slice(start, start + BATCH);
            if (slice.length === 0) return;

            const msg = {
              id: String(reqId++),
              op: "subscribe",
              args: slice.map((instId) => ({ channel: "mark-price", instId })),
            };

            try {
              ws.send(JSON.stringify(msg));
            } catch {
              // ignore
            }

            if (start + BATCH < instIds.length) {
              window.setTimeout(() => sendBatch(start + BATCH), 350);
            }
          };

          sendBatch(0);
        };

        ws.onclose = () => {
          setOkxMarkOk(false);
          if (pingTimer !== null) window.clearInterval(pingTimer);
          pingTimer = null;

          if (!closedByUser) reconnectTimer = window.setTimeout(connect, 1000);
        };

        ws.onmessage = (evt) => {
          // Keepalive response
          if (evt.data === "pong") return;

          try {
            const msg = JSON.parse(evt.data as string);

            // subscription acks look like { event: 'subscribe', arg: {...} }
            if (msg?.event) return;

            const arg = msg?.arg;
            if (arg?.channel !== "mark-price") return;

            const data = msg?.data;
            if (!Array.isArray(data) || data.length === 0) return;

            const instId = String(arg?.instId ?? data[0]?.instId ?? "").toUpperCase();
            const markPx = data[0]?.markPx;
            if (!instId || markPx === undefined) return;

            const mapped = okxInstIdToTickerRef.current.get(instId);
            if (okxInstIdToTickerRef.current.size && !mapped) return;
            const ticker = mapped ?? okxInstIdToCanonical(instId);
            if (!ticker || !isUsdtTicker(ticker)) return;
            if (okxUsdtSwapTickersRef.current.size && !okxUsdtSwapTickersRef.current.has(ticker)) return;
            if (commonUsdtPerpsRef.current.size && !commonUsdtPerpsRef.current.has(ticker)) return;

            const row = getOrInitRow(rowsRef.current, ticker);
            row.okxPrice = Number(markPx);

            // If we have base volume already, convert immediately.
            const vUsdt = convertOkxBaseVolToUsdt(row.okxBaseVol24h, row.okxPrice);
            if (vUsdt !== null) row.okxVol24h = vUsdt;

            okxMarkLastMsRef.current = Date.now();
            dirtyRef.current = true;
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error("Error handling OKX WS message:", error);
          }
        };
      } catch (error) {
        setOkxMarkOk(false);
        if (!closedByUser) reconnectTimer = window.setTimeout(connect, 2000);
      }
    }

    connect();

    return () => {
      closedByUser = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pingTimer !== null) window.clearInterval(pingTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  // -------------------------
  // OKX REST polling: funding + 24h volume (slow)
  // -------------------------
  useEffect(() => {
    let alive = true;

    async function fetchOkxFunding() {
      try {
        const url = `${OKX_REST_BASE}/api/v5/public/funding-rate?instId=ANY`;
        const res = await fetch(url, { method: "GET" });
        const json = await res.json();

        if (!alive) return;

        if (!res.ok || json?.code !== "0" || !Array.isArray(json?.data)) {
          setOkxFundingOk(false);
          return;
        }

        const m = rowsRef.current;
        for (const x of json.data) {
          const instId = String(x?.instId ?? "").toUpperCase();
          const fr = x?.fundingRate;
          const nextFundingTime = x?.nextFundingTime;
          const fundingTime = x?.fundingTime;

          const mapped = okxInstIdToTickerRef.current.get(instId);
          if (okxInstIdToTickerRef.current.size && !mapped) continue;
          const ticker = mapped ?? okxInstIdToCanonical(instId);
          if (!ticker || fr === undefined) continue;
          if (!isUsdtTicker(ticker)) continue;
          if (okxUsdtSwapTickersRef.current.size && !okxUsdtSwapTickersRef.current.has(ticker)) continue;
          if (commonUsdtPerpsRef.current.size && !commonUsdtPerpsRef.current.has(ticker)) continue;

          const row = getOrInitRow(m, ticker);
          row.okxFunding = Number(fr);

          // Prefer exact interval if OKX provides both fundingTime and nextFundingTime.
          const ft = fundingTime !== undefined && fundingTime !== null ? Number(fundingTime) : null;
          const nt = nextFundingTime !== undefined && nextFundingTime !== null ? Number(nextFundingTime) : null;

          if (Number.isFinite(ft as number) && Number.isFinite(nt as number) && (nt as number) > (ft as number)) {
            const hrs = ((nt as number) - (ft as number)) / (60 * 60 * 1000);
            if (Number.isFinite(hrs) && hrs > 0 && hrs <= 24) row.okxIntervalHours = hrs;
            row.okxNextFundingTime = nt as number;
          } else if (Number.isFinite(nt as number)) {
            // Fallback: infer by observing jumps across settlements.
            const inferred = inferIntervalHours(row.okxNextFundingTime, nt as number);
            if (inferred !== null) row.okxIntervalHours = inferred;
            row.okxNextFundingTime = nt as number;
          }
        }

        okxFundingLastMsRef.current = Date.now();
        setOkxFundingOk(true);
        dirtyRef.current = true;
      } catch (error) {
        if (!alive) return;
        setOkxFundingOk(false);
        // eslint-disable-next-line no-console
        console.error("Error fetching OKX funding rate:", error);
      }
    }

    async function fetchOkx24h() {
      try {
        const url = `${OKX_REST_BASE}/api/v5/market/tickers?instType=SWAP`;
        const res = await fetch(url, { method: "GET" });
        const json = await res.json();

        if (!alive) return;

        if (!res.ok || json?.code !== "0" || !Array.isArray(json?.data)) {
          setOkx24hOk(false);
          return;
        }

        const m = rowsRef.current;
        for (const x of json.data) {
          const instId = String(x?.instId ?? "").toUpperCase();
          const mapped = okxInstIdToTickerRef.current.get(instId);
          if (okxInstIdToTickerRef.current.size && !mapped) continue;
          const ticker = mapped ?? okxInstIdToCanonical(instId);
          if (!ticker) continue;
          if (!isUsdtTicker(ticker)) continue;
          if (okxUsdtSwapTickersRef.current.size && !okxUsdtSwapTickersRef.current.has(ticker)) continue;
          if (commonUsdtPerpsRef.current.size && !commonUsdtPerpsRef.current.has(ticker)) continue;

          const row = getOrInitRow(m, ticker);

          // Convert OKX 24h volume to USDT:
          // okxVol24h(USDT) = volCcy24h(base) * markPrice (preferred) else last
          const baseVol = Number(x?.volCcy24h);
          const lastPx = Number(x?.last);

          if (Number.isFinite(baseVol)) {
            row.okxBaseVol24h = baseVol;

            const px = Number.isFinite(row.okxPrice as number)
              ? (row.okxPrice as number)
              : Number.isFinite(lastPx)
                ? lastPx
                : null;

            const vUsdt = convertOkxBaseVolToUsdt(baseVol, px);
            if (vUsdt !== null) row.okxVol24h = vUsdt;
          }
        }

        okx24hLastMsRef.current = Date.now();
        setOkx24hOk(true);
        dirtyRef.current = true;
      } catch (error) {
        if (!alive) return;
        setOkx24hOk(false);
        // eslint-disable-next-line no-console
        console.error("Error fetching OKX 24h tickers:", error);
      }
    }

    fetchOkxFunding();
    fetchOkx24h();

    const tFunding = window.setInterval(fetchOkxFunding, OKX_FUNDING_POLL_MS);
    const t24h = window.setInterval(fetchOkx24h, OKX_24H_POLL_MS);

    return () => {
      alive = false;
      window.clearInterval(tFunding);
      window.clearInterval(t24h);
    };
  }, []);

  const rows: DerivedRow[] = useMemo(() => {
    void rowsVersion;

    const common = commonUsdtPerpsRef.current;
    const all = Array.from(rowsRef.current.values()).filter(
      (x) => isUsdtTicker(x.ticker) && (!common.size || common.has(x.ticker))
    );

    const q = search.trim().toUpperCase();
    const filtered = q ? all.filter((x) => x.ticker.includes(q)) : all;

    const dirMul = sort.dir === "asc" ? 1 : -1;

    const sorted = filtered.slice().sort((a, b) => {
      if (sort.key === "bnPrice") return cmpNullableNumber(a.bnPrice, b.bnPrice, dirMul);
      if (sort.key === "okxPrice") return cmpNullableNumber(a.okxPrice, b.okxPrice, dirMul);
      if (sort.key === "priceDiff") return cmpNullableNumber(priceDiffAbsFrac(a), priceDiffAbsFrac(b), dirMul);
      if (sort.key === "bnFunding") return cmpNullableNumber(a.bnFunding, b.bnFunding, dirMul);
      if (sort.key === "okxFunding") return cmpNullableNumber(a.okxFunding, b.okxFunding, dirMul);
      if (sort.key === "fundingDiff") return cmpNullableNumber(fundingDiffAbs(a), fundingDiffAbs(b), dirMul);
      if (sort.key === "bnVol24h") return cmpNullableNumber(a.bnVol24h, b.bnVol24h, dirMul);
      if (sort.key === "okxVol24h") return cmpNullableNumber(a.okxVol24h, b.okxVol24h, dirMul);
      return 0;
    });

    return sorted.map((r) => ({
      ...r,
      priceDiff: priceDiffAbsFrac(r),
      fundingDiff: fundingDiffAbs(r),
    }));
  }, [rowsVersion, search, sort.key, sort.dir]);

  function toggleSort(key: SortKey) {
    setSort((s) => {
      if (s.key !== key) return { key, dir: "asc" };
      return { key, dir: s.dir === "asc" ? "desc" : "asc" };
    });
  }

  function sortIcon(key: SortKey) {
    if (sort.key !== key) return "";
    return sort.dir === "asc" ? "▲" : "▼";
  }

  const anyRestError = !bn24hOk || !okxMarkOk || !okxFundingOk || !okx24hOk;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Cross-Exchange Perps — Binance vs OKX (USDT-only)</h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-slate-300">
              <span
                className={classNames(
                  "inline-flex items-center gap-2 rounded-full px-3 py-1",
                  bnConnected ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"
                )}
              >
                <span className={classNames("h-2 w-2 rounded-full", bnConnected ? "bg-emerald-400" : "bg-rose-400")} />
                Binance WS: {bnConnected ? "Connected" : "Disconnected"}
              </span>

              <span
                className={classNames(
                  "inline-flex items-center gap-2 rounded-full px-3 py-1",
                  bn24hOk ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"
                )}
              >
                <span className={classNames("h-2 w-2 rounded-full", bn24hOk ? "bg-emerald-400" : "bg-rose-400")} />
                Binance 24h: {bn24hOk ? "OK" : "Error"}
              </span>

              <span
                className={classNames(
                  "inline-flex items-center gap-2 rounded-full px-3 py-1",
                  okxMarkOk ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"
                )}
              >
                <span className={classNames("h-2 w-2 rounded-full", okxMarkOk ? "bg-emerald-400" : "bg-rose-400")} />
                OKX mark: {okxMarkOk ? "OK" : "Error"}
              </span>

              <span
                className={classNames(
                  "inline-flex items-center gap-2 rounded-full px-3 py-1",
                  okxFundingOk ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"
                )}
              >
                <span className={classNames("h-2 w-2 rounded-full", okxFundingOk ? "bg-emerald-400" : "bg-rose-400")} />
                OKX funding: {okxFundingOk ? "OK" : "Error"}
              </span>

              <span
                className={classNames(
                  "inline-flex items-center gap-2 rounded-full px-3 py-1",
                  okx24hOk ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"
                )}
              >
                <span className={classNames("h-2 w-2 rounded-full", okx24hOk ? "bg-emerald-400" : "bg-rose-400")} />
                OKX 24h: {okx24hOk ? "OK" : "Error"}
              </span>

              <span className="opacity-80">
                Rows: <span className="font-medium text-slate-200">{rows.length}</span>
              </span>

              <span className="opacity-80">Binance ws: {bnLastMs ? new Date(bnLastMs).toLocaleTimeString() : "—"}</span>
              <span className="opacity-80">Binance 24h: {bn24hLastMs ? new Date(bn24hLastMs).toLocaleTimeString() : "—"}</span>
              <span className="opacity-80">OKX mark: {okxLastMarkMs ? new Date(okxLastMarkMs).toLocaleTimeString() : "—"}</span>
              <span className="opacity-80">OKX funding: {okxLastFundingMs ? new Date(okxLastFundingMs).toLocaleTimeString() : "—"}</span>
              <span className="opacity-80">OKX 24h: {okx24hLastMs ? new Date(okx24hLastMs).toLocaleTimeString() : "—"}</span>
            </div>
          </div>

          <div className="flex w-full flex-col gap-2 sm:w-[420px]">
            <label className="text-xs uppercase tracking-wider text-slate-400">Search ticker</label>
            <div className="flex gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="e.g., BTCUSDT"
                className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-600"
              />
              <button
                onClick={() => setSearch("")}
                className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                Clear
              </button>
            </div>
            <div className="mt-1 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-300">
              USDT-only is <span className="font-semibold">enabled</span> (locked). OKX 24h volume is converted to USDT via{" "}
              <span className="font-mono">volCcy24h * markPrice</span>.
            </div>

            <div className="text-xs text-slate-400">All columns except ticker are sortable. UI refresh: 5s.</div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/40 shadow-sm">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-slate-900/95 backdrop-blur">
                <tr className="text-left text-xs uppercase tracking-wider text-slate-300">
                  <th className="px-4 py-3">Ticker</th>

                  <th
                    className="cursor-pointer px-4 py-3 hover:text-white"
                    onClick={() => toggleSort("bnPrice")}
                    title="Sort by Binance mark price"
                  >
                    Binance Mark {sortIcon("bnPrice")}
                  </th>

                  <th
                    className="cursor-pointer px-4 py-3 hover:text-white"
                    onClick={() => toggleSort("okxPrice")}
                    title="Sort by OKX mark price"
                  >
                    OKX Mark {sortIcon("okxPrice")}
                  </th>

                  <th
                    className="cursor-pointer px-4 py-3 hover:text-white"
                    onClick={() => toggleSort("priceDiff")}
                    title="Sort by absolute price difference (%)"
                  >
                    Price Difference (%) {sortIcon("priceDiff")}
                  </th>

                  <th
                    className="cursor-pointer px-4 py-3 hover:text-white"
                    onClick={() => toggleSort("bnFunding")}
                    title="Sort by Binance funding rate"
                  >
                    Binance Funding {sortIcon("bnFunding")}
                  </th>

                  <th
                    className="cursor-pointer px-4 py-3 hover:text-white"
                    onClick={() => toggleSort("okxFunding")}
                    title="Sort by OKX funding rate"
                  >
                    OKX Funding {sortIcon("okxFunding")}
                  </th>

                  <th
                    className="cursor-pointer px-4 py-3 hover:text-white"
                    onClick={() => toggleSort("fundingDiff")}
                    title="Sort by absolute funding difference"
                  >
                    Funding Difference {sortIcon("fundingDiff")}
                  </th>

                  <th
                    className="cursor-pointer px-4 py-3 hover:text-white"
                    onClick={() => toggleSort("bnVol24h")}
                    title="Sort by Binance 24h volume (USDT)"
                  >
                    Binance 24h Vol (USDT) {sortIcon("bnVol24h")}
                  </th>

                  <th
                    className="cursor-pointer px-4 py-3 hover:text-white"
                    onClick={() => toggleSort("okxVol24h")}
                    title="Sort by OKX 24h volume (converted to USDT)"
                  >
                    OKX 24h Vol (USDT) {sortIcon("okxVol24h")}
                  </th>
                </tr>
              </thead>

              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-slate-400" colSpan={9}>
                      No matches.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.ticker} className="border-t border-slate-800/60 hover:bg-slate-800/30">
                      <td className="px-4 py-2 font-mono text-slate-100">{r.ticker}</td>

                      <td className="px-4 py-2 tabular-nums text-slate-100">{fmtNum(r.bnPrice)}</td>
                      <td className="px-4 py-2 tabular-nums text-slate-100">{fmtNum(r.okxPrice)}</td>
                      <td className="px-4 py-2 tabular-nums text-slate-200">{fmtPctAbsFromFraction(r.priceDiff)}</td>

                      <td className="px-4 py-2">{fundingCell(r.bnFunding, r.bnIntervalHours)}</td>
                      <td className="px-4 py-2">{fundingCell(r.okxFunding, r.okxIntervalHours)}</td>

                      <td className="px-4 py-2 tabular-nums text-slate-200">{fmtPctAbs(r.fundingDiff)}</td>

                      <td className="px-4 py-2 tabular-nums text-slate-100">{fmtCompact(r.bnVol24h)}</td>
                      <td className="px-4 py-2 tabular-nums text-slate-100">{fmtCompact(r.okxVol24h)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-1 border-t border-slate-800 px-4 py-3 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
            <div>
              Price Difference (%) = |(OKX − Binance) / Binance|. Funding Difference = |OKX − Binance|. Volumes are 24h (USDT-only). Missing tickers show “—”.
            </div>
            <div className="font-mono">
              Binance: {bnConnected ? "ws live" : "ws reconnecting"} • REST: {bn24hOk ? "24h ok" : "24h err"} • OKX: {okxMarkOk ? "mark ok" : "mark err"} /{" "}
              {okxFundingOk ? "funding ok" : "funding err"} / {okx24hOk ? "24h ok" : "24h err"}
            </div>
          </div>
        </div>

        {anyRestError && (
          <div className="mt-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            One or more REST requests failed. In a browser, this is often CORS or network filtering. If you want this reliable, add a tiny proxy (Express/Cloudflare Worker).
          </div>
        )}
      </div>
    </div>
  );
}
