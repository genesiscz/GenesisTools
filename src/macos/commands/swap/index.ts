import logger from "@app/logger";
import { renderJson, renderResult } from "@app/macos/lib/swap/display";
import { scan } from "@app/macos/lib/swap/scanner";
import * as p from "@clack/prompts";
import { Command } from "commander";

interface SwapOptions {
    limit: string;
    top: string;
    all?: boolean;
    json?: boolean;
}

export function registerSwapCommand(program: Command): void {
    const swap = new Command("swap");

    swap.description("List processes by swap usage (with RSS and uptime)")
        .option("-l, --limit <n>", "number of top-RSS processes to vmmap-scan", "60")
        .option("-t, --top <n>", "number of rows to display", "25")
        .option("-a, --all", "scan ALL processes (slow, 1–2 min)", false)
        .option("--json", "machine-readable JSON output", false)
        .action(async (options: SwapOptions) => {
            try {
                await main(options);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error(`swap command failed: ${message}`);
                p.log.error(message);
                process.exit(1);
            }
        });

    program.addCommand(swap);
}

async function main(options: SwapOptions): Promise<void> {
    const limit = Math.max(1, Number.parseInt(options.limit, 10) || 60);
    const top = Math.max(1, Number.parseInt(options.top, 10) || 25);
    const all = Boolean(options.all);

    if (!options.json) {
        p.log.info(`Scanning ${all ? "all" : `top ${limit} by RSS`}…`);
    }

    const result = await scan({ limit, all });

    if (options.json) {
        renderJson(result);
        return;
    }

    renderResult(result, top);
}
