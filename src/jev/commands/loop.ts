import { NativeControlDriver } from "@app/control/lib/decision/native";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { failPlain, parseEnum, printResult, withSigint } from "../lib/cli-output";
import { createAutoSurface } from "../lib/loop/auto";
import { createAxSurface } from "../lib/loop/ax";
import { createBrowserSurface } from "../lib/loop/browser";
import { runGoalLoop } from "../lib/loop/run";
import type { GoalSurface } from "../lib/loop/surface";
import { compactResult } from "../lib/output-shape";

const { log } = logger.scoped("jev-loop");

const SURFACES = ["ax", "browser", "auto"] as const;
type Surface = (typeof SURFACES)[number];

interface LoopOptions {
    goal: string;
    app?: string;
    windowId?: string;
    windowIndex?: string;
    browser?: boolean;
    surface?: string | boolean;
    port: string;
    pageUrl?: string;
    pageIndex?: string;
    url?: string;
    inputs?: string;
    prepare?: boolean;
    expectedUrl?: string;
    depth?: string;
    maxSteps: string;
    yes?: boolean;
    json?: boolean;
}

export function registerLoop(program: Command): void {
    program
        .command("loop")
        .description("Goal-driven see/act loop for a native app, a CDP page, or both merged")
        .requiredOption("--goal <text>", "Task scoped to this surface")
        .option("--app <name>", "Native AX target")
        .option("--window-id <id>", "Pin one window")
        .option("--window-index <n>", "On-screen window index when the app has several (0 = frontmost)", "0")
        .option("--browser", "Shorthand for --surface browser")
        .option("--surface [kind]", "ax, browser, or auto (AX rows + CDP page rows in one state)")
        .option("--port <n>", "CDP port", "9222")
        .option("--page-url <substring>", "Select the CDP page whose URL contains this text before acting")
        .option("--page-index <n>", "Select the CDP page by list_pages index before acting")
        .option("--url <url>", "Open this URL as a NEW page before the first snapshot")
        .option(
            "--inputs <json>",
            "JSON object of values the loop may type into observed fields; Jev never invents text"
        )
        .option("--prepare", "AX surface: verify the semantic target natively before each act")
        .option("--expected-url <url>", "AX surface: pin the observed browser document by its AXURL")
        .option("--depth <n>", "AX traversal depth for see; raised automatically when the tree is deeper")
        .option("--max-steps <n>", "Action attempts", "8")
        .option("--yes", "Allow high-risk acts")
        .option("--json", "Full result including snapshot tokens")
        .action(async (options: LoopOptions) => {
            try {
                await runLoop(program, options);
            } catch (error) {
                failPlain(error, { command: "jev loop" });
            }
        });
}

function resolveSurface(options: LoopOptions): Surface | undefined {
    const requested = typeof options.surface === "string" ? options.surface : undefined;
    const kind = requested ?? (options.browser ? "browser" : options.app ? "ax" : undefined);
    if (kind === undefined) {
        ui.err("loop needs --app, --browser, or --surface auto.");
        process.exitCode = 1;
        return undefined;
    }

    return parseEnum(kind, SURFACES, "--surface", "tools jev loop");
}

async function runLoop(program: Command, options: LoopOptions): Promise<void> {
    const surfaceKind = resolveSurface(options);
    if (!surfaceKind) {
        return;
    }

    if (surfaceKind !== "browser" && !options.app) {
        ui.err(`--surface ${surfaceKind} needs --app <name>.`);
        process.exitCode = 1;
        return;
    }

    const port = Number(options.port) || 9222;
    log.info(
        { goal: options.goal, surface: surfaceKind, app: options.app, port, maxSteps: options.maxSteps },
        "jev loop starting"
    );
    await withSigint(async (signal) => {
        const ax = options.app
            ? createAxSurface(
                  new NativeControlDriver({
                      app: options.app,
                      windowId: options.windowId ? Number(options.windowId) : undefined,
                      windowIndex: options.windowId ? undefined : Number(options.windowIndex ?? 0),
                      prepare: options.prepare === true,
                      expectedURL: options.expectedUrl,
                      depth: options.depth ? Number(options.depth) : undefined,
                  })
              )
            : undefined;
        const browser =
            surfaceKind === "browser" || surfaceKind === "auto"
                ? createBrowserSurface({
                      port,
                      pageUrl: options.pageUrl,
                      pageIndex: options.pageIndex ? Number(options.pageIndex) : undefined,
                      url: options.url,
                      inputs: options.inputs ? parseInputs(options.inputs) : undefined,
                  })
                : undefined;
        let surface: GoalSurface;
        if (surfaceKind === "auto") {
            surface = createAutoSurface({ ax, browser });
        } else if (surfaceKind === "browser" && browser) {
            surface = browser;
        } else if (ax) {
            surface = ax;
        } else {
            ui.err("loop could not bind a surface.");
            process.exitCode = 1;
            return;
        }

        try {
            const result = await runGoalLoop({
                goal: options.goal,
                surface,
                maxSteps: Number(options.maxSteps),
                allowYes: options.yes === true,
                signal,
                evaluate: await createEvaluator({ provider: selectedProvider(program) }),
            });
            for (const step of result.trace) {
                ui.info(
                    `step ${step.step} ${step.status.padEnd(9)} ${step.reason.padEnd(20)} ${step.target ?? "-"}${step.dispatched === undefined ? "" : step.dispatched ? " dispatched" : ` failed: ${step.error ?? ""}`}`
                );
            }

            printResult(compactResult(result, { verbose: options.json === true }));
            if (result.status !== "verified") {
                process.exitCode = 1;
            }
        } finally {
            // The MCP child would otherwise keep the event loop alive and the process would hang.
            await browser?.close();
        }
    });
}

function parseInputs(raw: string): Record<string, string> {
    const parsed = SafeJSON.parse(raw, { strict: true });
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--inputs must be a JSON object of field name to value.");
    }

    const inputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "string") {
            throw new Error(`--inputs value for "${key}" must be a string.`);
        }

        inputs[key] = value;
    }

    return inputs;
}
