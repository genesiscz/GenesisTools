import { focusRunningSession, runningTarget } from "@app/claude/commands/cmux/focus";
import { CLAUDE_WHO_SOURCE } from "@app/claude/lib/active-sessions";
import { openSessionAt, sessionLaunch } from "@app/claude/lib/cmux/open-session";
import {
    type CodeModeForkOptions,
    type CodeModeForkOutcome,
    type CodeModeForkPlan,
    DEFAULT_BACKUP_SUFFIX,
    forkSessionIntoCodeMode,
    stopClaudeProcesses,
    waitUntilSessionCloses,
} from "@app/claude/lib/code-mode-fork";
import { listRunningCmuxSessions, type RunningCmuxSession } from "@genesiscz/utils/ai/active-sessions";
import { isInteractive } from "@genesiscz/utils/cli";
import type { OpenSessionTarget } from "@genesiscz/utils/cmux/open-command";
import { fetchCmuxTree } from "@genesiscz/utils/cmux/tree";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import pc from "picocolors";

interface ForkFlags {
    title?: string;
    backupSuffix: string;
    dryRun?: boolean;
    json?: boolean;
}

type ResumeChoice = "codemode" | "backup" | "none";
type BusyChoice = "restart" | "focus" | "kill" | "cancel";

/** How long a focused session may stay open before the command gives up waiting for it to close. */
const CLOSE_WAIT_MS = 15 * 60_000;

/** Resumes a session here, under the account and model it ran on, and exits with Claude Code's exit code. */
async function resumeHere(sessionId: string): Promise<never> {
    const { command } = await sessionLaunch(sessionId);
    out.log.info(pc.dim(command));
    const proc = Bun.spawn({
        cmd: [env.paths.getShell("/bin/sh"), "-ic", command],
        stdio: ["inherit", "inherit", "inherit"],
    });
    process.exit(await proc.exited);
}

/** In a terminal, offers to resume one of the two sessions; elsewhere, prints the command for the Code Mode one. */
async function offerResume(plan: CodeModeForkPlan): Promise<void> {
    const { command } = await sessionLaunch(plan.sessionId);

    if (!isInteractive()) {
        out.println("");
        out.println(`Resume it with Code Mode on: ${pc.cyan(command)}`);
        return;
    }

    const choice = await p.select<ResumeChoice>({
        message: "Resume which session?",
        options: [
            { value: "codemode", label: `"${plan.title}" in Code Mode`, hint: plan.sessionId.slice(0, 8) },
            {
                value: "backup",
                label: `"${plan.backupTitle}" without Code Mode`,
                hint: `the copy, ${plan.backupId.slice(0, 8)}`,
            },
            { value: "none", label: "Neither", hint: "print the command" },
        ],
        cancel: "back",
    });

    if (p.isCancel(choice) || choice === "none") {
        out.println(`Resume it with Code Mode on: ${pc.cyan(command)}`);
        return;
    }

    await resumeHere(choice === "codemode" ? plan.sessionId : plan.backupId);
}

/** Where the session's cmux tab was: its surface first, then its pane, then its workspace. */
async function placesOf(running: RunningCmuxSession): Promise<OpenSessionTarget[]> {
    const tree = await fetchCmuxTree();
    const target = tree.available ? runningTarget(tree, running) : null;

    if (!target) {
        return [];
    }

    const places: OpenSessionTarget[] = [];

    if (target.surfaceId) {
        places.push({ kind: "surface", workspaceId: target.workspaceId, surfaceId: target.surfaceId });
    }

    places.push({ kind: "pane", workspaceId: target.workspaceId, paneId: target.paneId });
    places.push({ kind: "workspace", workspaceId: target.workspaceId });
    return places;
}

/** The surface still exists after its Claude Code process ended (a shell is left in it), so the resume can reuse it. */
async function stillThere(place: OpenSessionTarget): Promise<boolean> {
    if (place.kind !== "surface") {
        return true;
    }

    const tree = await fetchCmuxTree();
    return tree.windows.some((window) =>
        window.workspaces.some((workspace) =>
            workspace.panes.some((pane) => pane.surfaces.some((surface) => surface.id === place.surfaceId))
        )
    );
}

async function reopenAt(sessionId: string, places: readonly OpenSessionTarget[]): Promise<boolean> {
    for (const place of places) {
        if (!(await stillThere(place))) {
            continue;
        }

        try {
            const opened = await openSessionAt(sessionId, place, { enter: true });
            out.log.success(`Resumed ${sessionId.slice(0, 8)} in Code Mode in its ${place.kind} (${opened.surfaceId})`);
            return true;
        } catch (error) {
            out.log.warn(`Could not resume it in its ${place.kind}: ${error instanceof Error ? error.message : error}`);
        }
    }

    return false;
}

/**
 * The session is open in Claude Code. In a terminal: stop it, fork, and resume it in the same cmux tab (the default),
 * focus its tab and fork once it closes, or stop it and fork. Returns the new outcome, or null when cancelled.
 */
async function resolveBusy(
    busy: Extract<CodeModeForkOutcome, { kind: "busy" }>,
    options: CodeModeForkOptions
): Promise<{ outcome: CodeModeForkOutcome; reopened: boolean } | null> {
    const running = (await listRunningCmuxSessions(CLAUDE_WHO_SOURCE)).find((s) => s.sessionId === busy.sessionId);
    const where = running ? `pid ${busy.holders.join(", ")}, cmux ${running.surfaceRef ?? running.surfaceId}` : "";
    out.log.warn(`Session ${busy.sessionId.slice(0, 8)} is open in Claude Code (pid ${busy.holders.join(", ")}).`);

    const choices: Array<{ value: BusyChoice; label: string; hint?: string }> = [];

    if (running) {
        choices.push(
            { value: "restart", label: "Kill it, move it into Code Mode, and resume it in the same tab", hint: where },
            { value: "focus", label: "Focus its tab so I can close it; fork when it closes" }
        );
    }

    choices.push(
        {
            value: "kill",
            label: "Just kill it, then fork",
            hint: running ? undefined : `pid ${busy.holders.join(", ")}`,
        },
        { value: "cancel", label: "Cancel" }
    );

    const choice = await p.select<BusyChoice>({ message: "What now?", options: choices, cancel: "back" });

    if (p.isCancel(choice) || choice === "cancel") {
        return null;
    }

    if (choice === "focus" && running) {
        if (!(await focusRunningSession(running))) {
            return null;
        }

        out.log.info("Waiting for you to close it. Ctrl-C stops waiting.");

        if (!(await waitUntilSessionCloses(busy.sessionId, CLOSE_WAIT_MS))) {
            out.log.error("It is still open after 15 minutes. Nothing was written.");
            return null;
        }

        return { outcome: await forkSessionIntoCodeMode(options), reopened: false };
    }

    const places = choice === "restart" && running ? await placesOf(running) : [];
    const left = await stopClaudeProcesses(busy.holders);

    if (left.length > 0) {
        out.log.error(`Claude Code still runs after SIGKILL (pid ${left.join(", ")}). Nothing was written.`);
        return null;
    }

    const outcome = await forkSessionIntoCodeMode(options);

    if (outcome.kind !== "forked" || choice !== "restart") {
        return { outcome, reopened: false };
    }

    return { outcome, reopened: await reopenAt(outcome.plan.sessionId, places) };
}

/** Claude Code pins a session's mode at its start, so an ordinary session resumes without Code Mode even when it is on. */
export function registerForkWithCodeModeCommand(program: Command): void {
    program
        .command("fork-with-codemode <session>")
        .alias("fork-with-codemod")
        .description(
            "Move a session into Code Mode: it keeps its id, and a copy under a new id keeps the conversation without Code Mode"
        )
        .option("--title <title>", "New title of the Code Mode session (default: its own title)")
        .option("--backup-suffix <suffix>", "Added to the title of the copy without Code Mode", DEFAULT_BACKUP_SUFFIX)
        .option("--dry-run", "Print the plan and write nothing")
        .option("--json", "Print the outcome as JSON")
        .action(async (session: string, flags: ForkFlags) => {
            const options: CodeModeForkOptions = {
                session,
                title: flags.title,
                backupSuffix: flags.backupSuffix,
                dryRun: flags.dryRun,
            };
            let outcome = await forkSessionIntoCodeMode(options);
            let reopened = false;

            if (outcome.kind === "busy" && !flags.json && !flags.dryRun && isInteractive()) {
                const resolved = await resolveBusy(outcome, options);

                if (!resolved) {
                    out.log.info("Nothing was written.");
                    process.exitCode = 1;
                    return;
                }

                ({ outcome, reopened } = resolved);
            }

            if (outcome.kind === "refused" || outcome.kind === "busy") {
                process.exitCode = 1;
            }

            if (flags.json) {
                out.result(outcome);
                return;
            }

            if (outcome.kind === "refused" || outcome.kind === "busy") {
                out.log.error(outcome.reason);
                return;
            }

            const { plan } = outcome;
            const planned = outcome.kind === "planned";
            out.println(
                `${pc.bold("codemode")}  ${plan.sessionId}  "${plan.title}"  (${planned ? "would get" : "got"} the Code Mode marker)`
            );
            out.println(
                `${pc.bold("backup  ")}  ${plan.backupId}  "${plan.backupTitle}"  (${planned ? "would write" : "wrote"} ${plan.backupPath})`
            );

            if (outcome.kind === "forked" && !reopened) {
                await offerResume(plan);
            }
        });
}
