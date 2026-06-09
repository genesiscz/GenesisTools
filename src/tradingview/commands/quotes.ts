import { logger, out } from "@app/logger";
import pc from "picocolors";
import { fetchAuthToken, resolveSession } from "../lib/auth";
import { formatQuoteLine } from "../lib/format";
import { QuoteClient } from "../lib/quote-client";
import { normalizeTicker } from "../lib/symbols";

interface QuotesOpts {
    auth?: boolean;
    cookie?: string;
}

export async function runQuotes(symbols: string[], opts: QuotesOpts): Promise<void> {
    if (symbols.length === 0) {
        out.error("Provide at least one symbol, e.g. NASDAQ:AAPL");
        process.exit(1);
    }

    const tickers = symbols.map(normalizeTicker);
    let authToken = "unauthorized_user_token";
    let host = "data.tradingview.com";

    if (opts.auth) {
        const session = await resolveSession({ cookie: opts.cookie });
        if (session) {
            authToken = await fetchAuthToken(session.cookie);
            host = "prodata.tradingview.com";
        } else {
            out.warn("No session found; falling back to guest data.");
        }
    }

    out.printErr(pc.dim(`Streaming ${tickers.length} symbol(s) from ${host} — Ctrl-C to stop\n`));
    const client = new QuoteClient({ authToken, host });

    client.on("open", () => client.addSymbols(tickers));
    client.on("quote", (snap) => out.printlnErr(formatQuoteLine(snap)));
    client.on("symbolError", ({ symbol, errmsg }) =>
        out.printlnErr(pc.red(`✗ ${symbol}: ${errmsg === "no_such_symbol" ? "no such symbol (check the EXCHANGE:TICKER spelling)" : errmsg}`))
    );
    client.on("error", (err) => logger.error({ err }, "tradingview: quote socket error"));
    client.on("close", () => out.printErr(pc.dim("\nConnection closed.")));

    process.on("SIGINT", () => {
        client.close();
        process.exit(0);
    });

    client.connect();
    await new Promise(() => {});
}
