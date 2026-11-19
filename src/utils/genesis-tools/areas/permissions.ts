import { defineAction, defineArea, type Pass } from "@genesiscz/utils/genesis-tools/actions/define";
import { Need } from "@genesiscz/utils/genesis-tools/capability/needs";
import { genesisAppLauncherPath } from "@genesiscz/utils/macos/genesis-app";
import { PERMISSION_KINDS } from "@genesiscz/utils/macos/permission-kinds";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";
import { z } from "zod";

const args = z.object({ kind: z.enum(PERMISSION_KINDS) });
const result = z.object({ kind: z.enum(PERMISSION_KINDS), status: z.string() });
const PROBE_TIMEOUT_MS = 10_000;

/** How a launcher run ended: its exit, output and signal, and whether our deadline or the caller's cancel stopped it. */
export interface LauncherRun {
    exit: number;
    stdout: string;
    stderr: string;
    signal: string | null;
    timedOut: boolean;
    cancelled: boolean;
}

/**
 * Why a launcher run gave no answer, or null when it exited 0. A run our deadline stopped says so: its grant is
 * unknown, which a person must not read as denied.
 */
export function launcherFailure(what: string, run: LauncherRun, limitMs: number): string | null {
    const stderr = run.stderr.trim();
    const detail = stderr ? `: ${stderr}` : "";

    if (run.cancelled) {
        return `${what} was stopped: the action's caller cancelled or its deadline passed`;
    }

    if (run.timedOut) {
        return `${what} gave no answer within ${Math.ceil(limitMs / 1000)} s and was stopped; the grant is unknown, not denied`;
    }

    if (run.signal) {
        return `${what} was ended by ${run.signal}${detail}`;
    }

    if (run.exit !== 0) {
        return `${what} failed with exit ${run.exit}${detail}`;
    }

    return null;
}

async function runLauncher(argv: string[], options: { timeoutMs: number; signal: AbortSignal }): Promise<LauncherRun> {
    options.signal.throwIfAborted();
    const deadline = AbortSignal.timeout(Math.max(1, options.timeoutMs));
    const proc = Bun.spawn([genesisAppLauncherPath(), ...argv], {
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.any([options.signal, deadline]),
    });
    const [exit, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const killed = proc.signalCode !== null;

    return {
        exit,
        stdout,
        stderr,
        signal: proc.signalCode,
        timedOut: killed && deadline.aborted,
        cancelled: killed && options.signal.aborted,
    };
}

async function status(kind: string, signal: AbortSignal): Promise<string> {
    refuseHostEffectInTest("permission probe", "Inject permission facts in tests.");
    const run = await runLauncher(["--permission-status", kind], { timeoutMs: PROBE_TIMEOUT_MS, signal });
    const failure = launcherFailure("Permission probe", run, PROBE_TIMEOUT_MS);

    if (failure) {
        throw new Error(failure);
    }

    if (!run.stdout.trim()) {
        throw new Error("Permission probe printed no status");
    }

    return run.stdout.trim();
}
export const permissions = defineArea({
    area: "permissions",
    summary: "Read a privacy grant or open its native request dialog",
    actions: {
        openTerminalRequest: defineAction({
            summary: "Open a terminal for a permission step the person can see",
            args: z.object({ argv: z.array(z.string()).min(1) }),
            result: z.object({ opened: z.literal(true) }),
            native: {
                needs: [Need.person.display],
                run: async (ctx): Promise<{ opened: true } | Pass> => {
                    const opened = await ctx.terminal.runVisibly(ctx.args, {
                        timeoutMs: ctx.timeoutMs,
                        signal: ctx.signal,
                    });
                    return opened.status === "ran"
                        ? opened.value
                        : ctx.pass(opened.skipped.map((skip) => skip.reason).join("; "));
                },
            },
        }),
        status: defineAction({
            summary: "Read the current grant in a fresh app process",
            args,
            result,
            native: {
                // Both start the launcher by its path, so routing switched off does not block them.
                needs: [Need.platform.darwin, Need.app.bundle],
                run: async (ctx) => ({ kind: ctx.args.kind, status: await status(ctx.args.kind, ctx.signal) }),
            },
        }),
        require: defineAction({
            summary: "Show the app's permission dialog, then read the grant",
            args: args.extend({ reason: z.string().optional() }),
            result,
            native: {
                needs: [Need.platform.darwin, Need.app.bundle, Need.person.display],
                run: async (ctx) => {
                    refuseHostEffectInTest("permission request", "Inject a permission requester in tests.");
                    const run = await runLauncher(
                        [
                            "--permission-dialog",
                            ctx.args.kind,
                            ...(ctx.args.reason ? ["--reason", ctx.args.reason] : []),
                        ],
                        { timeoutMs: ctx.timeoutMs, signal: ctx.signal }
                    );
                    const failure = launcherFailure("Permission dialog", run, ctx.timeoutMs);

                    if (failure) {
                        throw new Error(failure);
                    }

                    return { kind: ctx.args.kind, status: await status(ctx.args.kind, ctx.signal) };
                },
            },
        }),
    },
});
declare module "@genesiscz/utils/genesis-tools/actions/registry" {
    interface GenesisToolsAreas {
        permissions: typeof permissions;
    }
}
