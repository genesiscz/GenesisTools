import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import type { Command } from "commander";

export type SelfTarget = { kind: "tmux"; pane: string } | { kind: "cmux"; workspaceId: string; surfaceId: string };

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

    if (prefer !== "tmux" && surfaceId && workspaceId) {
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

async function sendCmux(
    workspaceId: string,
    surfaceId: string,
    text: string,
    enter: boolean,
    enterDelayMs: number
): Promise<void> {
    const where = ["--workspace", workspaceId, "--surface", surfaceId];
    await runCmuxOk(["send", ...where, text]);

    if (!enter) {
        return;
    }

    await Bun.sleep(enterDelayMs);
    await runCmuxOk(["send-key", ...where, "enter"]);
}

export function registerSendSelfCommand(program: Command): void {
    program
        .command("send-self <text>")
        .description(
            "Type text into the terminal surface this process is running in, then press Enter. " +
                "To fire later, put the sleep in the calling shell: a long-lived bun process is killed at an agent turn boundary."
        )
        .option("--enter-delay <ms>", "Wait this long between the text and Enter", "500")
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
                    throw new Error(
                        "not running inside tmux or cmux (no TMUX_PANE, no CMUX_SURFACE_ID/CMUX_WORKSPACE_ID)"
                    );
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
