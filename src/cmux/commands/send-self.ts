import { readCmuxTerminal } from "@genesiscz/utils/cmux/caller-enricher";
import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { readTmuxTerminal } from "@genesiscz/utils/tmux/caller-enricher";
import { tmuxSendKeys } from "@genesiscz/utils/tmux/send-keys";
import type { Command } from "commander";

export type SelfTarget = { kind: "tmux"; pane: string } | { kind: "cmux"; workspaceId?: string; surfaceId: string };

export function resolveSelfTarget(
    environment: NodeJS.ProcessEnv,
    prefer: "auto" | "tmux" | "cmux" = "auto"
): SelfTarget | null {
    // A blank pane or surface (an unset variable a shell expanded) names nothing, so it cannot beat a real one.
    const pane = readTmuxTerminal(environment)?.pane;
    const cmux = readCmuxTerminal(environment);

    if (prefer !== "cmux" && pane) {
        return { kind: "tmux", pane };
    }

    // The surface alone is enough: a UUID names one surface across the whole
    // tree, and CMUX_WORKSPACE_ID goes stale the moment the surface is moved.
    if (prefer !== "tmux" && cmux) {
        return { kind: "cmux", workspaceId: cmux.workspaceId ?? undefined, surfaceId: cmux.surfaceId };
    }

    return null;
}

async function sendTmux(pane: string, text: string, enter: boolean, enterDelayMs: number): Promise<void> {
    const typed = await tmuxSendKeys(pane, ["-l", "--", text]);

    if (!typed.ok) {
        throw new Error(typed.detail);
    }

    if (!enter) {
        return;
    }

    await Bun.sleep(enterDelayMs);
    const entered = await tmuxSendKeys(pane, ["Enter"]);

    if (!entered.ok) {
        throw new Error(entered.detail);
    }
}

/**
 * One `cmux paste --submit`: the text and its submit go out in a single call, so no gap is left between them.
 * Observed 2026-09-10 17:39: a detached `send-self '/compact'` typed with `send` and then `send-key enter` logged
 * its `send` and never its Enter; the text sat unsubmitted in the prompt and the compaction never ran. The paste
 * also keeps a multi-line text as one message, and runs a slash command (a pasted `/compact` compacted a scratch
 * session on 2026-10-30, Claude Code 2.1.312).
 */
async function sendCmux(
    workspaceId: string | undefined,
    surfaceId: string,
    text: string,
    enter: boolean
): Promise<void> {
    const where = surfaceTargetArgs(surfaceId, workspaceId);
    // Never log `text` itself. This types arbitrary content into a terminal — a prompt,
    // a pasted command, a token being echoed into a login flow — and logger always
    // writes the day-stamped plaintext file, at every level. The length plus the enter
    // flag is what the triage actually needs. A bare slash command is named in full
    // because it cannot be a credential and it is the case being debugged.
    const command = /^\/[a-z][a-z-]{0,31}$/.test(text) ? text : undefined;
    logger.info(
        { pid: process.pid, surfaceId, textLength: text.length, command, enter },
        "[cmux send-self] pasting text"
    );
    await runCmuxOk(["paste", ...where, ...(enter ? ["--submit"] : []), "--", text]);
    logger.info({ pid: process.pid, surfaceId, enter }, "[cmux send-self] pasted");
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
            "tmux only: wait this long between the text and Enter (cmux pastes and submits in one call)",
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
                    throw new Error("not running inside tmux or cmux (no tmux pane, no cmux surface)");
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
                    await sendCmux(target.workspaceId, target.surfaceId, text, opts.enter);
                }

                out.println(`sent to ${target.kind}`);
            }
        );
}
