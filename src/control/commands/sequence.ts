import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import type { Command } from "commander";
import { z } from "zod";
import { NativeControlSession } from "../lib/decision/native-session";

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
        .option("--restore-selected", "Restore the target that was selected when each window was observed")
        .action(async (intent: string, options) => {
            const scope = z.enum(["window", "chrome"]).parse(options.scope);
            const intervalMs = z.number().int().min(0).max(5000).parse(Number(options.interval));
            const attribute =
                options.verify === undefined
                    ? undefined
                    : z.enum(["selected", "expanded", "value"]).parse(options.verify);
            const verifyAttribute =
                attribute === "selected"
                    ? ("AXSelected" as const)
                    : attribute === "expanded"
                      ? ("AXExpanded" as const)
                      : attribute === "value"
                        ? ("AXValue" as const)
                        : undefined;
            const windowIds =
                options.windowIds === undefined
                    ? [undefined]
                    : z
                          .array(z.number().int().positive())
                          .min(1)
                          .max(10)
                          .parse(options.windowIds.split(",").map(Number));
            const clock = new Stopwatch();
            const session = new NativeControlSession({
                app: options.app,
                provider: selectedProvider(program),
                cursor: program.optsWithGlobals().cursor !== false,
            });
            const cancel = () => session.close();
            process.once("SIGINT", cancel);
            const windows = [];
            let failure: string | undefined;
            try {
                for (const windowId of windowIds) {
                    const observation = await session.observe({
                        role: options.role,
                        rootRole: options.within,
                        rootIndex:
                            options.withinIndex === undefined
                                ? undefined
                                : z.number().int().nonnegative().parse(Number(options.withinIndex)),
                        scope,
                        windowId,
                        focus: options.focus,
                    });
                    const chosen = await session.chooseAll(intent);
                    const result = await session.batch({
                        steps: chosen.targets.map((target) => ({
                            target,
                            verifyAttribute,
                            verifyValue: verifyAttribute ? true : undefined,
                        })),
                        intervalMs,
                    });
                    const original = observation.targets.find((target) => target.selected);
                    const restored =
                        result.ok && options.restoreSelected && original
                            ? await session.act({
                                  target: original.id,
                                  verifyAttribute: "AXSelected",
                                  verifyValue: true,
                              })
                            : null;
                    windows.push({
                        windowId: observation.windowId,
                        targets: chosen.targets.length,
                        decision: chosen.decision,
                        result,
                        restored,
                    });
                    if (!result.ok || restored?.ok === false) {
                        break;
                    }
                }
            } catch (error) {
                logger.debug({ error }, "Native control sequence stopped");
                failure = error instanceof Error ? error.message : "Sequence stopped.";
            } finally {
                session.close();
                process.off("SIGINT", cancel);
            }
            const ok =
                !failure &&
                windows.length === windowIds.length &&
                windows.every((window) => window.result.ok && window.restored?.ok !== false);
            out.result({ ok, elapsedMs: clock.elapsedMs, backend: "native-AXPress", windows, error: failure });
            if (!ok) {
                process.exitCode = 1;
            }
        });
}
