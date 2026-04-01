import { withCancel } from "@app/utils/prompts/clack/helpers";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { displayComparison, displayResults } from "../lib/display";
import { getLastResult } from "../lib/results";
import { ensureHyperfine, runBenchmark } from "../lib/runner";
import { getAllSuites } from "../lib/suites";
import type { EditOptions, RunOptions } from "../lib/types";
import { cmdEdit } from "./edit";
import { cmdHistory } from "./history";
import { cmdRemove } from "./remove";
import { cmdShow } from "./show";

export async function interactiveMode(): Promise<void> {
    if (!(await ensureHyperfine())) {
        process.exit(1);
    }

    p.intro(pc.bgCyan(pc.black(" benchmark ")));

    const allSuites = await getAllSuites();

    if (allSuites.length === 0) {
        p.log.info("No suites available. Add one with:");
        p.log.info(pc.bold('tools benchmark add "name" "label1:cmd1" "label2:cmd2"'));
        p.outro(pc.dim("Done."));
        return;
    }

    const suiteName = await withCancel(
        p.select({
            message: "Select a benchmark suite",
            options: allSuites.map((s) => ({
                value: s.name,
                label: `${s.name} ${pc.dim(`(${s.commands.length} commands${s.builtIn ? ", built-in" : ""})`)}`,
            })),
        })
    );

    const suite = allSuites.find((s) => s.name === suiteName);

    if (!suite) {
        p.cancel("Suite not found.");
        process.exit(1);
    }

    const actionOptions: Array<{ value: string; label: string }> = [
        { value: "run", label: "Run benchmark" },
        { value: "compare", label: "Run and compare with last result" },
        { value: "show", label: "Show suite details" },
        { value: "history", label: "View result history" },
    ];

    if (!suite.builtIn) {
        actionOptions.push({ value: "edit", label: "Edit suite" }, { value: "delete", label: pc.red("Delete suite") });
    }

    const action = await withCancel(
        p.select({
            message: "What would you like to do?",
            options: actionOptions,
        })
    );

    if (action === "delete") {
        const confirmed = await withCancel(p.confirm({ message: `Delete suite "${suite.name}"?` }));

        if (confirmed) {
            await cmdRemove(suite.name);
        } else {
            p.cancel("Cancelled.");
        }

        p.outro(pc.dim("Done."));
        return;
    }

    if (action === "show") {
        await cmdShow(suite.name);
        p.outro(pc.dim("Done."));
        return;
    }

    if (action === "history") {
        await cmdHistory(suite.name);
        p.outro(pc.dim("Done."));
        return;
    }

    if (action === "edit") {
        const editChoice = await withCancel(
            p.select({
                message: "What to edit?",
                options: [
                    { value: "hooks", label: "Suite hooks (setup/prepare/conclude/cleanup)" },
                    { value: "cwd", label: "Working directory" },
                    { value: "defaults", label: "Default runs/warmup" },
                    { value: "commands", label: "Add/remove commands" },
                ],
            })
        );

        if (editChoice === "hooks") {
            const hookType = await withCancel(
                p.select({
                    message: "Which hook?",
                    options: [
                        { value: "setup", label: `Setup${suite.setup ? pc.dim(` (current: ${suite.setup})`) : ""}` },
                        {
                            value: "prepare",
                            label: `Prepare${suite.prepare ? pc.dim(` (current: ${suite.prepare})`) : ""}`,
                        },
                        {
                            value: "conclude",
                            label: `Conclude${suite.conclude ? pc.dim(` (current: ${suite.conclude})`) : ""}`,
                        },
                        {
                            value: "cleanup",
                            label: `Cleanup${suite.cleanup ? pc.dim(` (current: ${suite.cleanup})`) : ""}`,
                        },
                    ],
                })
            );

            const hookAction = await withCancel(
                p.select({
                    message: "Action?",
                    options: [
                        { value: "set", label: "Set new value" },
                        { value: "clear", label: "Clear (remove)" },
                    ],
                })
            );

            if (hookAction === "set") {
                const hookKey = hookType as "setup" | "prepare" | "conclude" | "cleanup";
                const value = await withCancel(
                    p.text({
                        message: `Enter ${hookType} command:`,
                        placeholder: suite[hookKey] ?? "",
                    })
                );

                await cmdEdit(suite.name, { [hookKey]: value } as EditOptions);
            } else {
                const clearKey = `clear${hookType.charAt(0).toUpperCase()}${hookType.slice(1)}` as keyof EditOptions;
                await cmdEdit(suite.name, { [clearKey]: true } as EditOptions);
            }
        } else if (editChoice === "cwd") {
            const value = await withCancel(
                p.text({
                    message: "Working directory (empty to clear):",
                    placeholder: suite.cwd ?? "",
                    defaultValue: "",
                })
            );

            if (value) {
                await cmdEdit(suite.name, { cwd: value });
            } else {
                await cmdEdit(suite.name, { clearCwd: true });
            }
        } else if (editChoice === "defaults") {
            const runsInput = await withCancel(
                p.text({
                    message: "Default runs (empty for auto):",
                    placeholder: suite.runs?.toString() ?? "auto",
                    defaultValue: "",
                })
            );

            const warmupInput = await withCancel(
                p.text({
                    message: "Default warmup:",
                    placeholder: suite.warmup?.toString() ?? "3",
                    defaultValue: "",
                })
            );

            const editOpts: EditOptions = {};

            if (runsInput) {
                const val = parseInt(runsInput, 10);

                if (!Number.isNaN(val)) {
                    editOpts.runs = val;
                }
            }

            if (warmupInput) {
                const val = parseInt(warmupInput, 10);

                if (!Number.isNaN(val)) {
                    editOpts.warmup = val;
                }
            }

            if (editOpts.runs || editOpts.warmup) {
                await cmdEdit(suite.name, editOpts);
            }
        } else if (editChoice === "commands") {
            const cmdAction = await withCancel(
                p.select({
                    message: "Action?",
                    options: [
                        { value: "add", label: "Add a new command" },
                        { value: "remove", label: "Remove a command" },
                    ],
                })
            );

            if (cmdAction === "add") {
                const input = await withCancel(
                    p.text({
                        message: "New command (label:command):",
                        placeholder: "my-label:echo hello",
                    })
                );

                await cmdEdit(suite.name, { addCmd: [input] });
            } else {
                const label = await withCancel(
                    p.select({
                        message: "Remove which command?",
                        options: suite.commands.map((c) => ({
                            value: c.label,
                            label: `${c.label} ${pc.dim(`(${c.cmd})`)}`,
                        })),
                    })
                );

                await cmdEdit(suite.name, { removeCmd: [label] });
            }
        }

        p.outro(pc.green("Done."));
        return;
    }

    const runCountInput = await withCancel(
        p.text({
            message: "Number of runs (leave empty for auto)",
            placeholder: "auto",
            defaultValue: "",
        })
    );

    const warmupInput = await withCancel(
        p.text({
            message: "Warmup runs",
            placeholder: "3",
            defaultValue: "3",
        })
    );

    const runOpts: RunOptions = {
        compare: action === "compare",
        runs: runCountInput ? parseInt(runCountInput, 10) || undefined : undefined,
        warmup: warmupInput ? parseInt(warmupInput, 10) : undefined,
        noWarmup: warmupInput === "0",
    };

    const previous = runOpts.compare ? await getLastResult(suite.name) : null;
    const results = await runBenchmark(suite, runOpts);

    if (!results) {
        p.outro(pc.red("Benchmark failed."));
        return;
    }

    displayResults(results);

    if (runOpts.compare && previous) {
        displayComparison(results, previous);
    } else if (runOpts.compare) {
        p.log.warn("No previous results to compare against.");
    }

    p.outro(pc.green("Done."));
}
