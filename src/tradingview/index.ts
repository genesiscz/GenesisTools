import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { runAlerts } from "./commands/alerts";
import { runQuotes } from "./commands/quotes";

const program = new Command();

program.name("tradingview").description("Stream TradingView live quotes and price-alert feeds");

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

await runTool(program, { tool: "tradingview" });
