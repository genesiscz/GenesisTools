import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { runNativeSequence } from "../lib/decision/sequence";
import { withSigintAbort } from "./decision";

export function registerSequenceCommand(program: Command) {
    program
        .command("sequence <intent>")
        .description("Resolve one bounded set through Jev and perform native AX actions in a persistent session")
        .requiredOption("--app <name>", "App name or PID")
        .requiredOption("--role <role>", "Observed target AX role")
        .requiredOption("--within <role>", "Root AX role inside each selected window")
        .option("--within-index <n>", "Index among freshly observed matching roots")
        .option("--window-ids <ids>", "Comma-separated native window IDs; defaults to window index 0")
        .option("--scope [scope]", "window or chrome", "chrome")
        .option("--verify [attribute]", "selected, expanded or value")
        .option("--interval <ms>", "Spacing between action starts (0–5000)", "0")
        .option("--focus", "Focus each selected window before observing")
        .option("--restore-selected", "Restore the target selected at the beginning of each successful window")
        .option("--timeout <ms>", "Whole sequence deadline", "120000")
        .action(async (intent: string, options) => {
            const attribute =
                options.verify === undefined
                    ? undefined
                    : z.enum(["selected", "expanded", "value"]).parse(options.verify);
            await withSigintAbort(async (signal) => {
                const result = await runNativeSequence({
                    signal,
                    input: {
                        app: options.app,
                        intent,
                        role: options.role,
                        rootRole: options.within,
                        rootIndex: options.withinIndex === undefined ? undefined : Number(options.withinIndex),
                        windowIds:
                            options.windowIds === undefined ? undefined : options.windowIds.split(",").map(Number),
                        scope: options.scope,
                        intervalMs: Number(options.interval),
                        timeoutMs: Number(options.timeout),
                        verifyAttribute:
                            attribute === "selected"
                                ? "AXSelected"
                                : attribute === "expanded"
                                  ? "AXExpanded"
                                  : attribute === "value"
                                    ? "AXValue"
                                    : undefined,
                        focus: options.focus,
                        restoreSelected: options.restoreSelected,
                        cursor: program.optsWithGlobals().cursor !== false,
                        provider: selectedProvider(program),
                        jev: true,
                    },
                });
                out.result(result);
                if (!result.ok) {
                    process.exitCode = 1;
                }
            });
        });
}
