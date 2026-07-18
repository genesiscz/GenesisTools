import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";
import { type AxResult, runAx } from "../lib/runner";
import { addTargetOptions, targetArgs, targetLabel } from "../lib/target";

interface CheckOpts {
    app: string;
    target: string[];
    gone?: boolean;
    for?: string;
    value?: string;
    contains?: string;
}

function checkOnce(o: CheckOpts): { pass: boolean; state: AxResult } {
    const state = runAx(["get", "--app", o.app, ...o.target]);
    if (o.gone) {
        return { pass: !state.ok, state };
    }
    if (!state.ok) {
        return { pass: false, state };
    }
    if (o.for === "enabled" && state.enabled !== true) {
        return { pass: false, state };
    }
    if (o.for === "focused" && state.focused !== true) {
        return { pass: false, state };
    }
    if (o.value !== undefined && String(state.value ?? "") !== o.value) {
        return { pass: false, state };
    }
    if (o.contains !== undefined && !String(state.value ?? "").includes(o.contains)) {
        return { pass: false, state };
    }
    return { pass: true, state };
}

/** Polls until the condition holds or timeout. Shared by the CLI command and run steps. */
export function waitFor(o: CheckOpts & { timeout: number; interval: number }): AxResult {
    const t0 = performance.now();
    let last: { pass: boolean; state: AxResult } = { pass: false, state: { ok: false } };
    let polls = 0;
    while (performance.now() - t0 < o.timeout) {
        last = checkOnce(o);
        polls++;
        if (last.pass) {
            return {
                ok: true,
                action: "wait",
                waitedMs: Math.round(performance.now() - t0),
                polls,
                ...(o.gone ? { gone: true } : { element: last.state }),
            };
        }
        Bun.sleepSync(o.interval);
    }
    const cond = o.gone
        ? "gone"
        : (o.for ??
          (o.value !== undefined
              ? `value == '${o.value}'`
              : o.contains !== undefined
                ? `value contains '${o.contains}'`
                : "exists"));
    return {
        ok: false,
        action: "wait",
        error: `timeout after ${o.timeout}ms (${polls} polls) — ${o.target.join(" ")} in ${o.app}: '${cond}' not met`,
        lastState: last.state,
    };
}

/** Single-shot condition check. Shared by the CLI command and run steps. */
export function assertEl(o: CheckOpts): AxResult {
    const { pass, state } = checkOnce(o);
    if (pass) {
        return { ok: true, action: "assert", ...(o.gone ? { gone: true } : { element: state }) };
    }
    const want = o.gone
        ? "element gone"
        : (o.for ??
          (o.value !== undefined
              ? `value == '${o.value}'`
              : o.contains !== undefined
                ? `value contains '${o.contains}'`
                : "exists"));
    return {
        ok: false,
        action: "assert",
        error: `assert failed: expected ${want}`,
        actual: state.ok ? { value: state.value, enabled: state.enabled, focused: state.focused } : state.error,
    };
}

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
        .option("--for <cond>", "condition: exists (default) | enabled | focused")
        .option("--expect <value>", "wait until AXValue equals this")
        .option("--contains <text>", "wait until AXValue contains this")
        .option("--gone", "wait until the element does NOT exist (passes IMMEDIATELY if it never existed)")
        .option("--timeout <ms>", "give up after this many ms", "5000")
        .option("--interval <ms>", "poll interval", "200")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = waitFor({
                ...conditionOpts(opts),
                timeout: Number(opts.timeout),
                interval: Number(opts.interval),
            });
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                process.exit(result.ok ? 0 : 1);
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
        .action((opts) => {
            const result = assertEl(conditionOpts(opts));
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                process.exit(result.ok ? 0 : 1);
            }
            if (!result.ok) {
                logger.error(`${result.error} — actual: ${SafeJSON.stringify(result.actual)}`);
                process.exit(1);
            }
            out.println(`${pc.green("assert ok")} ${pc.cyan(targetLabel(opts, result))}`);
        });
}
