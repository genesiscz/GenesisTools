import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { TV_ORIGIN } from "./ws";

const SCAN_URL = "https://scanner.tradingview.com/global/scan";

const COLUMN_ALIASES: Record<string, string[]> = {
    rsi: ["RSI", "RSI[1]"],
    macd: ["MACD.macd", "MACD.signal"],
    stoch: ["Stoch.K", "Stoch.D"],
    adx: ["ADX"],
    atr: ["ATR"],
    ema50: ["EMA50"],
    ema200: ["EMA200"],
    sma50: ["SMA50"],
    rating: ["Recommend.All"],
};

export interface ScanRow {
    symbol: string;
    values: Record<string, number | null>;
}

export function buildScanRequest(
    indicators: string[],
    tickers: string[]
): { columns: string[]; symbols: { tickers: string[] } } {
    const columns = ["close"];
    const seen = new Set(columns);

    for (const indicator of indicators) {
        const key = indicator.trim().toLowerCase();
        const expanded = COLUMN_ALIASES[key] ?? [indicator.trim()];
        for (const column of expanded) {
            if (!seen.has(column)) {
                seen.add(column);
                columns.push(column);
            }
        }
    }

    return {
        symbols: { tickers },
        columns,
    };
}

export function mapScanResponse(data: { data?: Array<{ s?: string; d?: unknown[] }> }, columns: string[]): ScanRow[] {
    const rows = data.data ?? [];
    return rows.map((row) => {
        const values: Record<string, number | null> = {};
        const cells = row.d ?? [];
        for (let i = 0; i < columns.length; i++) {
            const cell = cells[i];
            values[columns[i]] = typeof cell === "number" && Number.isFinite(cell) ? cell : null;
        }

        return {
            symbol: String(row.s ?? ""),
            values,
        };
    });
}

export async function scan({
    indicators,
    tickers,
}: {
    indicators: string[];
    tickers: string[];
}): Promise<{ columns: string[]; rows: ScanRow[] }> {
    const body = buildScanRequest(indicators, tickers);
    logger.debug({ url: SCAN_URL, tickers: body.symbols.tickers.length }, "tradingview: scanner scan");
    const res = await fetch(SCAN_URL, {
        method: "POST",
        headers: { origin: TV_ORIGIN, "content-type": "application/json" },
        body: SafeJSON.stringify(body, { strict: true }),
    });
    if (!res.ok) {
        throw new Error(`scanner HTTP ${res.status}`);
    }

    const data = SafeJSON.parse(await res.text(), { strict: true }) as {
        data?: Array<{ s?: string; d?: unknown[] }>;
    };
    return {
        columns: body.columns,
        rows: mapScanResponse(data, body.columns),
    };
}
