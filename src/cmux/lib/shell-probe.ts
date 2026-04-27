import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandSource } from "@app/cmux/lib/types";
import logger from "@app/logger";

/**
 * cmux exposes no PID/tty for surfaces, but it does set tab titles from OSC-7 cwd escapes.
 * Idle shells get titles like "…/Tresors/Projects/ReservineBack" — the leading "…" stands
 * for $HOME. TUIs (claude, vim) overwrite the title with their own text, so we only treat
 * a title as a cwd when it starts with "/" or "…/".
 */
export function cwdFromTitle(title: string | undefined | null): string | undefined {
    if (!title) {
        return undefined;
    }
    const trimmed = title.trim();
    // OSC-7 / OSC-1337 titles: "user@host:/abs/path" or "user@host:~/path"
    const userHostMatch = trimmed.match(/^[^\s@:]+@[^\s:]+:(.+)$/);
    if (userHostMatch) {
        return expandHome(userHostMatch[1]);
    }
    if (trimmed === "…" || trimmed === "~" || trimmed.startsWith("…/") || trimmed.startsWith("~/")) {
        return expandHome(trimmed);
    }
    if (trimmed.startsWith("/")) {
        return trimmed;
    }
    return undefined;
}

function expandHome(path: string): string {
    if (path.startsWith("…/") || path.startsWith("~/")) {
        return join(homedir(), path.slice(2));
    }
    if (path === "~" || path === "…") {
        return homedir();
    }
    return path;
}

let cachedHistoryHint: { value: string | undefined; source: CommandSource } | null = null;

/**
 * Best-effort "last shell command" hint sampled from the user's history file.
 * Globally scoped — the same hint is shared by every pane in v1. Users can edit the
 * resulting JSON to make individual panes accurate before restoring.
 */
export function lastHistoryHint(): { value: string | undefined; source: CommandSource } {
    if (cachedHistoryHint) {
        return cachedHistoryHint;
    }
    const candidates = [
        process.env.HISTFILE,
        process.env.ZDOTDIR ? join(process.env.ZDOTDIR, ".zsh_history") : undefined,
        join(homedir(), ".zsh_history"),
        join(homedir(), ".bash_history"),
    ].filter((p): p is string => Boolean(p));

    for (const path of candidates) {
        try {
            if (!existsSync(path)) {
                continue;
            }
            const raw = readFileSync(path, "utf8");
            const lines = raw
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
            if (lines.length === 0) {
                continue;
            }
            const last = lines[lines.length - 1];
            // zsh extended-history format: ": <epoch>:<elapsed>;<cmd>"
            const stripped = last.startsWith(":") ? last.replace(/^:[^;]*;/, "") : last;
            cachedHistoryHint = { value: stripped, source: "history" };
            logger.debug({ path }, "[shell-probe] history hint loaded");
            return cachedHistoryHint;
        } catch (error) {
            logger.debug({ error, path }, "[shell-probe] history read failed");
        }
    }

    cachedHistoryHint = { value: undefined, source: "none" };
    return cachedHistoryHint;
}
