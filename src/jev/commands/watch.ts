import { NativeControlDriver } from "@app/control/lib/decision/native";
import { NativeVisualDriver } from "@app/control/lib/decision/visual";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { Command } from "commander";
import { failPlain, printResult, withSigint } from "../lib/cli-output";
import { compactResult } from "../lib/output-shape";
import { runWatch } from "../lib/watch/loop";
import type { WatchOcrBlock } from "../lib/watch/state";

const prof = profiler.scope("jev-watch");
const { log } = logger.scoped("jev-watch");

const OCR_TIMEOUT_MS = 10_000;

interface WatchOptions {
    app: string;
    goal: string;
    windowId?: string;
    windowIndex?: string;
    hz: string;
    maxSeconds: string;
    maxRequests: string;
    ocr?: boolean;
    expectedUrl?: string;
    depth?: string;
    json?: boolean;
}

export function registerWatch(program: Command): void {
    program
        .command("watch")
        .description("Bounded high-Hz Jev policy on one window: delta see per tick, one fan-out per tick")
        .requiredOption("--app <name>", "Target app")
        .requiredOption("--goal <text>", "Done condition")
        .option("--window-id <id>", "Pin one window")
        .option("--window-index <n>", "On-screen window index when the app has several (0 = frontmost)", "0")
        .option("--hz <n>", "Ticks per second (1-10)", "4")
        .option("--max-seconds <n>", "Time budget", "15")
        .option("--max-requests <n>", "Paid evaluations", "20")
        .option("--ocr", "Add native OCR text regions of the window to each tick's state")
        .option("--expected-url <url>", "Pin the observed browser document; a different AXURL ends the watch")
        .option("--depth <n>", "AX traversal depth for see; raised automatically when the tree is deeper")
        .option("--json", "Full result including snapshot tokens")
        .action(async (options: WatchOptions) => {
            try {
                await runWatchCommand(program, options);
            } catch (error) {
                failPlain(error, { command: "jev watch" });
            }
        });
}

async function runWatchCommand(program: Command, options: WatchOptions): Promise<void> {
    const windowId = options.windowId ? Number(options.windowId) : undefined;
    log.info(
        {
            app: options.app,
            goal: options.goal,
            hz: options.hz,
            maxSeconds: options.maxSeconds,
            ocr: options.ocr === true,
        },
        "jev watch starting"
    );
    await withSigint(async (signal) => {
        const ocr = options.ocr === true ? await readOcrBlocks({ app: options.app, windowId, signal }) : undefined;
        const result = await runWatch({
            goal: options.goal,
            hz: Number(options.hz),
            maxSeconds: Number(options.maxSeconds),
            maxRequests: Number(options.maxRequests),
            ocr,
            signal,
            evaluate: await createEvaluator({ provider: selectedProvider(program) }),
            driver: new NativeControlDriver({
                app: options.app,
                windowId,
                windowIndex: windowId === undefined ? Number(options.windowIndex ?? 0) : undefined,
                expectedURL: options.expectedUrl,
                depth: options.depth ? Number(options.depth) : undefined,
            }),
        });
        ui.info(`${result.status} ${result.reason} after ${result.ticks} ticks (${result.observes} observes)`);
        printResult(compactResult(result, { verbose: options.json === true }));
        if (result.status !== "verified") {
            process.exitCode = 1;
        }
    });
}

/** One native OCR pass over the window; the text regions become part of every tick's state. */
async function readOcrBlocks(options: {
    app: string;
    windowId?: number;
    signal: AbortSignal;
}): Promise<WatchOcrBlock[]> {
    const driver = new NativeVisualDriver({ app: options.app, windowId: options.windowId });
    const observation = await prof.measureAsync("ocr", () =>
        driver.observe({ signal: options.signal, timeoutMs: OCR_TIMEOUT_MS })
    );
    const blocks = observation.perception.regions
        .filter((region) => region.text.trim().length > 0)
        .map((region) => ({ id: region.id, text: region.text.trim() }));
    log.info({ app: options.app, regions: blocks.length, method: observation.perception.method }, "OCR regions read");
    return blocks;
}
