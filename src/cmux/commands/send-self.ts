import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import type { Command } from "commander";

export type SelfTarget = { kind: "tmux"; pane: string } | { kind: "cmux"; workspaceId?: string; surfaceId: string };

export function resolveSelfTarget(
    environment: NodeJS.ProcessEnv,
    prefer: "auto" | "tmux" | "cmux" = "auto"
): SelfTarget | null {
    const pane = environment.TMUX_PANE;
    const surfaceId = environment.CMUX_SURFACE_ID;
    const workspaceId = environment.CMUX_WORKSPACE_ID;

    if (prefer !== "cmux" && pane) {
        return { kind: "tmux", pane };
    }

    // The surface alone is enough: a UUID names one surface across the whole
    // tree, and CMUX_WORKSPACE_ID goes stale the moment the surface is moved.
    if (prefer !== "tmux" && surfaceId) {
        return { kind: "cmux", workspaceId, surfaceId };
    }

    return null;
}

/** One `tmux send-keys`, off the event loop, with stderr captured for the failure message. */
async function runTmuxSendKeys(argv: string[], label: string): Promise<void> {
    const proc = Bun.spawn(argv, { stdio: ["ignore", "ignore", "pipe"] });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    if (exitCode !== 0) {
        throw new Error(`${label} failed: ${stderr.trim() || `exit ${exitCode}`}`);
    }
}

async function sendTmux(pane: string, text: string, enter: boolean, enterDelayMs: number): Promise<void> {
    const tmux = resolveTmuxBin();
    await runTmuxSendKeys([tmux, "send-keys", "-t", pane, "-l", "--", text], "tmux send-keys");

    if (!enter) {
        return;
    }

    await Bun.sleep(enterDelayMs);
    await runTmuxSendKeys([tmux, "send-keys", "-t", pane, "Enter"], "tmux send-keys Enter");
}

/**
 * If this process is told to die between the text and the Enter, the Enter still goes out.
 * Observed 2026-09-10 17:39: a detached `send-self '/compact'` logged its `send` and never
 * its `send-key enter`; the text sat unsubmitted in the prompt and the compaction never
 * ran. Who sent the signal is unknown (the day log has no trace), so the handler records
 * the signal and finishes the job synchronously on the way out.
 */
function enterOnSignal(where: readonly string[]): () => void {
    const signals = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
    const handler = (signal: string) => {
        logger.warn(
            { pid: process.pid, signal },
            "[cmux send-self] signalled between text and Enter; sending Enter now"
        );
        Bun.spawnSync(["cmux", "send-key", ...where, "enter"], { stdio: ["ignore", "ignore", "ignore"] });
        process.exit(1);
    };

    for (const signal of signals) {
        process.on(signal, handler);
    }

    return () => {
        for (const signal of signals) {
            process.off(signal, handler);
        }
    };
}

async function sendCmux(
    workspaceId: string | undefined,
    surfaceId: string,
    text: string,
    enter: boolean,
    enterDelayMs: number
): Promise<void> {
    const where = surfaceTargetArgs(surfaceId, workspaceId);
    logger.info({ pid: process.pid, surfaceId, text, enter, enterDelayMs }, "[cmux send-self] sending text");
    await runCmuxOk(["send", ...where, text]);

    if (!enter) {
        return;
    }

    const release = enterOnSignal(where);

    try {
        if (enterDelayMs > 0) {
            await Bun.sleep(enterDelayMs);
        }

        await runCmuxOk(["send-key", ...where, "enter"]);
        logger.info({ pid: process.pid, surfaceId }, "[cmux send-self] Enter sent");
    } finally {
        release();
    }
}

export function registerSendSelfCommand(program: Command): void {
    program
        .command("send-self <text>")
        .description(
            "Type text into the terminal surface this process is running in, then press Enter. " +
                "To fire later, put the sleep in the calling shell: a long-lived bun process is killed at an agent turn boundary."
        )
        .option(
            "--enter-delay <ms>",
            "Wait this long between the text and Enter (0: back-to-back, which cmux and tmux both accept)",
            "0"
        )
        .option("--no-enter", "Send the text only, leave it unsubmitted at the prompt")
        .option("--target <auto|tmux|cmux>", "Force a transport instead of auto-detecting", "auto")
        .option("--dry-run", "Print the resolved target and exit without sending")
        .action(
            async (text: string, opts: { enterDelay: string; enter: boolean; target: string; dryRun?: boolean }) => {
                const prefer = opts.target as "auto" | "tmux" | "cmux";

                if (prefer !== "auto" && prefer !== "tmux" && prefer !== "cmux") {
                    throw new Error(`--target must be auto, tmux or cmux (got ${opts.target})`);
                }

                const target = resolveSelfTarget(env.getProcessEnv(), prefer);

                if (!target) {
                    throw new Error("not running inside tmux or cmux (no TMUX_PANE, no CMUX_SURFACE_ID)");
                }

                const enterDelayMs = Number(opts.enterDelay);

                if (!Number.isFinite(enterDelayMs) || enterDelayMs < 0) {
                    throw new Error(`--enter-delay must be a non-negative number (got ${opts.enterDelay})`);
                }

                if (opts.dryRun) {
                    out.println(SafeJSON.stringify({ target, text, enter: opts.enter, enterDelayMs }));
                    return;
                }

                if (target.kind === "tmux") {
                    await sendTmux(target.pane, text, opts.enter, enterDelayMs);
                } else {
                    await sendCmux(target.workspaceId, target.surfaceId, text, opts.enter, enterDelayMs);
                }

                out.println(`sent to ${target.kind}`);
            }
        );
}
