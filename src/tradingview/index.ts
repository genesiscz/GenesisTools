import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { runAlerts } from "./commands/alerts";
import { type ChartsOpts, runCharts } from "./commands/charts";
import { type IndicatorOpts, runIndicator } from "./commands/indicator";
import { type IndicatorsOpts, runIndicators } from "./commands/indicators";
import { runQuotes } from "./commands/quotes";
import { runScan, type ScanOpts } from "./commands/scan";

const program = new Command();

program.name("tradingview").description("Stream TradingView live quotes, indicators, charts, and scans");

program
    .command("quotes")
    .description("Stream a live quote feed for one or more symbols")
    .argument("<symbols...>", "Symbols like NASDAQ:AAPL OANDA:SPX500USD")
    .option("--auth", "Use the logged-in session (prodata host) instead of guest data")
    .option("--cookie <cookie>", "TradingView session cookie string")
    .action((symbols: string[], opts: { auth?: boolean; cookie?: string }) => runQuotes(symbols, opts));

program
    .command("alerts")
    .description("List price alerts and stream live alert fires")
    .option("--cookie <cookie>", "TradingView session cookie string")
    .option("--list-only", "Print current alerts and exit (no live feed)")
    .action((opts: { cookie?: string; listOnly?: boolean }) => runAlerts(opts));

program
    .command("indicator")
    .description("Stream an indicator's values and signal marks for a symbol (history, then live)")
    .argument("[spec]", "Indicator: alias (rsi), name, STD;/PUB; id, or script URL")
    .argument("<symbol>", "Symbol like NASDAQ:AAPL or BYBIT:BTCUSDT.P")
    .option("--from-chart <layoutId>", "Attach studies from a saved chart layout")
    .option("--tf <resolution>", "Timeframe: 1, 5, 15, 60, 240, 1D, 1W…", "1D")
    .option("--bars <n>", "History bars to load", "300")
    .option(
        "--input <name=value...>",
        "Override indicator inputs (repeatable)",
        (v: string, acc: string[]) => [...acc, v],
        []
    )
    .option("--once", "Print the history snapshot and exit")
    .option("--signals-only", "Suppress numeric rows; print only signal marks")
    .option("--json", "NDJSON to stdout (points + signals)")
    .option("--notify", "Voice notification on live signals (tools say)")
    .option("--exec <cmd>", "Run shell command on live signals (signal JSON in $TV_SIGNAL)")
    .option("--cookie <cookie>", "TradingView session cookie string")
    .action((spec: string | undefined, symbol: string, opts: IndicatorOpts) => runIndicator(spec, symbol, opts));

program
    .command("charts")
    .description("List saved chart layouts or show studies on a layout")
    .argument("[layoutId]", "Layout id from the list (e.g. YLjdL7wq)")
    .option("--cookie <cookie>", "TradingView session cookie string")
    .action((layoutId: string | undefined, opts: ChartsOpts) => runCharts(layoutId, opts));

program
    .command("indicators")
    .description("Search/list the indicator library")
    .argument("[query]", "Case-insensitive substring filter")
    .option("--filter <kind>", "standard | saved | favorites", "standard")
    .option("--cookie <cookie>", "TradingView session cookie string")
    .action((query: string | undefined, opts: IndicatorsOpts) => runIndicators(query, opts));

program
    .command("scan")
    .description("Scan multiple symbols for scanner indicator columns")
    .argument("<indicators>", "Comma-separated indicators: rsi,macd,rating or raw scanner columns")
    .requiredOption("--symbols <list>", "Comma-separated symbols, e.g. NASDAQ:AAPL,NASDAQ:MSFT")
    .option("--json", "JSON array to stdout")
    .action((indicators: string, opts: ScanOpts) => runScan(indicators, opts));

await runTool(program, { tool: "tradingview" });
