import { out } from "@app/logger";
import pc from "picocolors";
import { formatScanTable } from "../lib/format";
import { scan } from "../lib/scanner";

export interface ScanOpts {
    symbols: string;
    json?: boolean;
}

export async function runScan(indicatorsArg: string, opts: ScanOpts): Promise<void> {
    const indicators = indicatorsArg
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    const tickers = opts.symbols
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    if (indicators.length === 0 || tickers.length === 0) {
        out.error("Provide comma-separated indicators and --symbols EXCHANGE:TICKER,...");
        process.exit(1);
    }

    const { columns, rows } = await scan({ indicators, tickers });
    if (opts.json) {
        out.result(
            rows.map((row) => ({
                symbol: row.symbol,
                ...row.values,
            }))
        );
        return;
    }

    out.printlnErr(pc.dim(`\nScanned ${rows.length} symbol(s):\n`));
    out.printlnErr(formatScanTable(columns, rows));
}
