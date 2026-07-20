import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { CAPTURE_HELP, type Plan } from "../lib/capture-plan";
import {
    buildPreflightReport,
    CaptureRunError,
    type RunResult,
    runCapturePlan,
    runClickmap,
    runRecrop,
} from "../lib/capture-runner";

function fail(msg: string, exitCode = 2): never {
    console.error(`capture-with-actions: ${msg}`);
    process.exit(exitCode);
}

function printRunResult(result: RunResult): void {
    // captureFailed is internal (drives the exit code); keep the printed JSON
    // shape identical to the legacy runner script
    const { captureFailed, ...printable } = result;
    out.println(SafeJSON.stringify(printable, null, 2));

    if (captureFailed) {
        process.exit(1);
    }
}

export function registerCaptureCommands(program: Command): void {
    const capture = program
        .command("capture")
        .description(
            "Screen recording with timed UI actions (peekaboo capture live) + crop compositing and vitrinka publish.\nSubcommands: run <plan.json> (default — `capture <plan.json>` works too), preflight, clickmap, recrop.\nFull plan contract: `tools control capture --help`."
        )
        .addHelpText("after", `\n${CAPTURE_HELP}`);

    capture
        .command("run [plan]", { isDefault: true })
        .description("Record + act + crop + (optional) publish, driven by a plan.json — see `capture --help`")
        .action(async (planPath: string | undefined) => {
            if (!planPath) {
                out.println(CAPTURE_HELP);
                process.exit(2);
            }

            let plan: Plan;
            try {
                plan = SafeJSON.parse(await Bun.file(planPath).text());
            } catch (e) {
                fail(`cannot read plan ${planPath}: ${e instanceof Error ? e.message : String(e)}`);
            }

            try {
                printRunResult(await runCapturePlan(plan));
            } catch (e) {
                if (e instanceof CaptureRunError) {
                    fail(e.message, e.exitCode);
                }

                throw e;
            }
        });

    capture
        .command("recrop <result> <plan>")
        .description("Re-crop frames of a PRIOR run (no re-record) — the offline reframing flow")
        .action(async (resultPath: string, planPath: string) => {
            try {
                const recropped = await runRecrop(resultPath, planPath);
                out.println(SafeJSON.stringify(recropped, null, 2));
            } catch (e) {
                if (e instanceof CaptureRunError) {
                    fail(e.message, e.exitCode);
                }

                throw e;
            }
        });

    capture
        .command("preflight")
        .description(
            "RUN THIS FIRST when writing a capture plan: screens (scale/origins), frontmost app + window bounds in points AND frame px, browser tab, units reminder, suggested plan skeleton"
        )
        .option("--app <name>", "inspect this app's windows (default: the frontmost app)")
        .action((opts: { app?: string }) => {
            out.println(SafeJSON.stringify(buildPreflightReport(opts.app), null, 2));
        });

    capture
        .command("clickmap")
        .description(
            "Coordinate-finder for clicking INSIDE WEB PAGES: screenshots the app's window and overlays a grid labeled in GLOBAL SCREEN POINTS — read coords off the gridlines, use directly in click actions"
        )
        .requiredOption("--app <name>", "app whose window to map")
        .option("--window-title <t>", "target a specific window by title substring")
        .option("--grid <points>", "grid step in screen points (min 20)", "100")
        .option("--out <png>", "output path (default $TMPDIR/clickmap-<ts>.png)")
        .action((opts: { app: string; windowTitle?: string; grid: string; out?: string }) => {
            const gridStep = Math.max(20, Number(opts.grid) || 100);
            const outPath = opts.out ?? join(process.env.TMPDIR ?? "/tmp/", `clickmap-${Date.now()}.png`);
            try {
                const result = runClickmap({ app: opts.app, windowTitle: opts.windowTitle, gridStep, outPath });
                out.println(SafeJSON.stringify(result, null, 2));
            } catch (e) {
                if (e instanceof CaptureRunError) {
                    fail(e.message, e.exitCode);
                }

                throw e;
            }
        });
}
