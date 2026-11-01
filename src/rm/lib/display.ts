import { homedir, tmpdir } from "node:os";
import type { RmCaller } from "@genesiscz/utils/rm";

/**
 * Who deletes an aside copy outside `tools rm`, as the listing and `approve` say it: the copy waits in /tmp, where
 * macOS tmp_cleaner removes files untouched for 3 days (the keepalive refreshes them, but only from its first run).
 */
export const LOST_COPY_CAUSE = "deleted outside tools rm, by macOS tmp_cleaner or a person";

export interface ShortPathContext {
    home: string;
    /** The real $TMPDIR without its trailing slash, e.g. /var/folders/ab/cd/T. */
    tmpdir: string;
    /** The asking session's full id, so its own scratch reads <scratch>. */
    sessionId: string | null;
}

/** /tmp/<agent dir>/<project>/<full session id>: the scratch folder an agent session owns. */
const SCRATCH = /^\/tmp\/(cc|codex|grok|copilot)\/([^/]+)\/([0-9a-f]{8})[0-9a-f-]{28}(?=\/|$)/;

export function displayContext(caller: RmCaller | null): ShortPathContext {
    return { home: homedir(), tmpdir: tmpdir().replace(/\/+$/, ""), sessionId: caller?.sessionId ?? null };
}

/**
 * A path as a list row shows it: ~ for home, /tmp for /private/tmp, $TMPDIR for the per-user temp folder,
 * <scratch> for the asker's own scratch, <project>/<session8> for another session's, cut in the middle.
 */
export function shortRmPath(path: string, ctx: ShortPathContext, max = 48): string {
    let p = path.startsWith("/private/tmp/") || path === "/private/tmp" ? path.slice("/private".length) : path;
    const tmp = ctx.tmpdir.replace(/^\/private/, "");

    if (tmp && (p === tmp || p.startsWith(`${tmp}/`))) {
        p = `$TMPDIR${p.slice(tmp.length)}`;
    } else if (tmp && p.startsWith(`/private${tmp}`)) {
        p = `$TMPDIR${p.slice(`/private${tmp}`.length)}`;
    }

    const scratch = SCRATCH.exec(p);

    if (scratch) {
        const own = ctx.sessionId !== null && p.slice(0, scratch[0].length).endsWith(ctx.sessionId);
        p = `${own ? "<scratch>" : `${scratch[2]}/${scratch[3]}`}${p.slice(scratch[0].length)}`;
    } else if (p === ctx.home || p.startsWith(`${ctx.home}/`)) {
        p = `~${p.slice(ctx.home.length)}`;
    }

    return middleCut(p, max);
}

/** Cuts the middle and keeps the last segment whole when it fits: "~/Projects/a-long-client-folder-n…/.smoke.tmp.ts". */
export function middleCut(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }

    const slash = text.lastIndexOf("/");
    const base = slash >= 0 ? text.slice(slash) : text;

    if (base.length + 2 > max) {
        return `…${text.slice(-(max - 1))}`;
    }

    return `${text.slice(0, max - base.length - 1)}…${base}`;
}

export type AgeLevel = "fresh" | "day" | "old";

/** "11m", "22h", "5d", and how loud to show it: a day old is yellow, three days red. */
export function formatAgeCell(createdAt: string, now: Date): { text: string; level: AgeLevel } {
    const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(createdAt)) / 60_000));
    const text =
        minutes < 60
            ? `${minutes}m`
            : minutes < 48 * 60
              ? `${Math.floor(minutes / 60)}h`
              : `${Math.floor(minutes / 1440)}d`;
    const level: AgeLevel = minutes >= 3 * 1440 ? "old" : minutes >= 1440 ? "day" : "fresh";
    return { text, level };
}
