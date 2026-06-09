import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage";
import { TV_ORIGIN } from "./ws";

export interface StandardScript {
    scriptIdPart: string;
    scriptName: string;
    version: string;
}

const ALIASES: Record<string, string> = {
    rsi: "relative strength index",
    macd: "macd",
    ema: "moving average exponential",
    sma: "moving average simple",
    bb: "bollinger bands",
    vwap: "vwap",
    atr: "average true range",
    stoch: "stochastic",
    supertrend: "supertrend",
    adx: "average directional index",
    obv: "on balance volume",
};

const LIST_URL = "https://pine-facade.tradingview.com/pine-facade/list/?filter=standard";
const CACHE_KEY = "standard-scripts";
const CACHE_TTL = "24 hours" as const;

export function resolveAlias(query: string, list: StandardScript[]): StandardScript | null {
    const q = (ALIASES[query.trim().toLowerCase()] ?? query.trim().toLowerCase()).trim();
    const exact = list.find((s) => s.scriptName.toLowerCase() === q);
    if (exact) {
        return exact;
    }

    const partial = list.filter((s) => s.scriptName.toLowerCase().includes(q));
    return partial.length === 1 ? partial[0] : null;
}

export async function fetchStandardList(): Promise<StandardScript[]> {
    const storage = new Storage("tradingview");
    return storage.getFileOrPut<StandardScript[]>(
        CACHE_KEY,
        async () => {
            logger.debug({ url: LIST_URL }, "tradingview: fetching standard script list");
            const res = await fetch(LIST_URL, { headers: { origin: TV_ORIGIN } });
            if (!res.ok) {
                throw new Error(`pine-facade list HTTP ${res.status}`);
            }

            const raw = SafeJSON.parse(await res.text(), { strict: true }) as Array<Record<string, unknown>>;
            return raw
                .map((e) => ({
                    scriptIdPart: String(e.scriptIdPart ?? ""),
                    scriptName: String(e.scriptName ?? ""),
                    version: String(e.version ?? "last"),
                }))
                .filter((e) => e.scriptIdPart.length > 0);
        },
        CACHE_TTL
    );
}
