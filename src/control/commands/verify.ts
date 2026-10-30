import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { assertEl, type CheckOpts, conditionExitCode, waitFor } from "../lib/conditions";
import { addTargetOptions, targetArgs, targetLabel } from "../lib/target";

function conditionOpts(opts: Record<string, string | undefined> & { gone?: boolean }): CheckOpts {
    return {
        app: opts.app as string,
        target: targetArgs(opts),
        gone: !!opts.gone,
        for: opts.for,
        value: opts.expect,
        contains: opts.contains,
    };
}

export function registerVerifyCommands(program: Command): void {
    addTargetOptions(
        program
            .command("wait")
            .description(
                "Poll until an element condition holds — replaces sleep-guessing. Default condition: element exists."
            )
            .requiredOption("--app <name>", "app process name")
    )
        .option(
            "--for <cond>",
            "state condition: exists (default) | enabled | focused (value checks are the separate --expect/--contains flags)"
        )
        .option("--expect <value>", "wait until AXValue equals this")
        .option("--contains <text>", "wait until AXValue contains this")
        .option("--gone", "wait until the element does NOT exist (passes IMMEDIATELY if it never existed)")
        .option("--timeout <ms>", "give up after this many ms", "5000")
        .option("--interval <ms>", "poll interval", "200")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action(async (opts) => {
            const result = await waitFor({
                ...conditionOpts(opts),
                timeout: Number(opts.timeout),
                interval: Number(opts.interval),
            });
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                process.exit(conditionExitCode(result));
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(`${pc.green("wait ok")} ${pc.cyan(targetLabel(opts, result))} after ${result.waitedMs}ms`);
        });

    addTargetOptions(
        program
            .command("assert")
            .description("Assert an element condition NOW (exists/enabled/focused/value) — plans become UI tests.")
            .requiredOption("--app <name>", "app process name")
    )
        .option("--for <cond>", "condition: exists (default) | enabled | focused")
        .option("--expect <value>", "assert AXValue equals this")
        .option("--contains <text>", "assert AXValue contains this")
        .option("--gone", "assert the element does NOT exist (a never-existing element passes)")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action(async (opts) => {
            const result = await assertEl(conditionOpts(opts));
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                process.exit(conditionExitCode(result));
            }
            if (!result.ok) {
                logger.error(`${result.error} — actual: ${SafeJSON.stringify(result.actual)}`);
                process.exit(1);
            }
            out.println(`${pc.green("assert ok")} ${pc.cyan(targetLabel(opts, result))}`);
        });
}
