import { tmuxSessionNameFromTopic } from "@app/dev-dashboard/lib/tmux/claude-pane-title";
import { listTtyd, renameTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import {
    attachTmuxSession,
    createTmuxSessionRunning,
    currentTmuxSessionName,
    renameTmuxSession,
    sessionExists,
} from "@genesiscz/utils/tmux/sessions";

/**
 * Name to rename the *current* tmux session to. If we already have `desired`,
 * keep it. Otherwise pick a free name so rename-session does not throw.
 */
export async function renameTargetForCurrentSession(currentName: string, desiredName: string): Promise<string> {
    if (!desiredName || desiredName === currentName) {
        return currentName;
    }

    return uniqueTmuxSessionName(desiredName);
}

export async function uniqueTmuxSessionName(desired: string): Promise<string> {
    const base = tmuxSessionNameFromTopic(desired) || "claude";
    if (!(await sessionExists(base))) {
        return base;
    }

    for (let i = 2; i < 50; i++) {
        const candidate = `${base}-${i}`;
        if (!(await sessionExists(candidate))) {
            return candidate;
        }
    }

    return `${base}-${Date.now()}`;
}

/**
 * Rename the tmux session and, if a ttyd tab is bound to it, the ttyd display
 * name too (dev-dashboard Session Hub). Prefer renameTtyd when a binding
 * exists — it retargets the ttyd attach argv in the same step.
 */
export async function renameTmuxAndBoundTtyd(fromName: string, toName: string): Promise<string> {
    const trimmed = tmuxSessionNameFromTopic(toName) || toName.trim();
    if (!trimmed || trimmed === fromName) {
        return fromName;
    }

    const ttydSessions = await listTtyd();
    const bound = ttydSessions.find((session) => session.tmuxSessionName === fromName);
    if (bound) {
        await renameTtyd(bound.id, trimmed);
        return trimmed;
    }

    await renameTmuxSession(fromName, trimmed);
    return trimmed;
}

export async function launchCommandInTmux(opts: {
    sessionName: string;
    cwd: string;
    argv: string[];
    env: Record<string, string | undefined>;
    attach: boolean;
}): Promise<{ name: string; exitCode: number }> {
    const name = await uniqueTmuxSessionName(opts.sessionName);
    await createTmuxSessionRunning(name, opts.cwd, opts.argv, opts.env);

    const tmuxBin = resolveTmuxBin();
    const insideTmux = Boolean(env.get("TMUX"));
    if (!opts.attach) {
        logger.info({ name }, "[tmux-launch] created detached session");
        return { name, exitCode: 0 };
    }

    if (insideTmux) {
        const result = Bun.spawnSync([tmuxBin, "switch-client", "-t", name], {
            stdio: ["inherit", "inherit", "inherit"],
        });
        return { name, exitCode: result.exitCode ?? 1 };
    }

    attachTmuxSession(name);
    return { name, exitCode: 0 };
}

export function tmuxNameFromResumeTitle(title: string | undefined, fallback: string): string {
    if (title?.trim()) {
        return tmuxSessionNameFromTopic(title.trim()) || fallback;
    }

    return fallback;
}

export { currentTmuxSessionName };
