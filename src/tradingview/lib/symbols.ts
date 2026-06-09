import { SafeJSON } from "@app/utils/json";

interface ProSymbolOpts {
    adjustment?: string;
    session?: string;
    currencyId?: string;
}

export function normalizeTicker(ticker: string): string {
    return ticker.trim().toUpperCase();
}

export function toProSymbol(ticker: string, opts: ProSymbolOpts = {}): string {
    const spec: Record<string, string> = {
        symbol: normalizeTicker(ticker),
        adjustment: opts.adjustment ?? "splits",
    };
    if (opts.session) {
        spec.session = opts.session;
    }
    if (opts.currencyId) {
        spec["currency-id"] = opts.currencyId;
    }
    return `=${SafeJSON.stringify(spec)}`;
}

export function parseProSymbol(spec: string): string {
    if (!spec.startsWith("=")) {
        return spec;
    }
    try {
        const obj = SafeJSON.parse(spec.slice(1)) as { symbol: string };
        return obj.symbol;
    } catch {
        return spec;
    }
}
