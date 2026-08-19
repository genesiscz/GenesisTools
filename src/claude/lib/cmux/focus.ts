import { basename } from "node:path";
import type { CmuxLivePane, CmuxLiveSnapshot } from "@genesiscz/utils/cmux/lib/live-snapshot";

/** A UUID as it appears in a resume command, with or without the surrounding quotes. */
const SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * `--resume <id>` as a restored pane prints it, e.g.
 * `tools claude start -- --resume '8b6e69bf-0efc-4990-ba3e-b77262498421'`.
 * Quotes are optional because a hand-typed resume usually has none.
 */
const RESUME_ID_RE = /--resume[=\s]+['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/gi;

/**
 * Shortest prefix accepted as "this is a session id, not a word".
 *
 * A restored pane's screen holds the whole resume command, so a 3-character query
 * would match a hex fragment inside some unrelated hash and focus the wrong pane.
 * Eight is the short form printed everywhere else in this tool (`sessionId.slice(0, 8)`).
 */
const MIN_ID_PREFIX = 8;

export type FocusMatchKind =
    | "resume-command"
    | "resume-prefix"
    | "session-id"
    | "id-prefix"
    | "pane-title"
    | "workspace"
    | "cwd"
    | "screen";

export interface FindFocusOptions {
    /** Pane to leave out of the search, normally the one this process runs in. */
    excludePaneId?: string;
}

export interface FocusTarget {
    workspaceId: string;
    workspaceName: string;
    paneId: string;
    paneTitle: string;
    cwd?: string;
    /** Session ids found in this pane's text, newest occurrence last. Empty when none. */
    sessionIds: string[];
    /** Which signal matched, for the "focused X because Y" line and for --json. */
    matchedOn: FocusMatchKind;
    /** Higher wins. Ties break on the pane already being active, then on pane id. */
    score: number;
    active: boolean;
}

/** Every scrap of text a pane exposes: its own title plus each surface's title and screen. */
function paneHaystack(pane: CmuxLivePane): string {
    const parts = [pane.title, pane.preview ?? ""];

    for (const surface of pane.surfaces) {
        parts.push(surface.title, surface.preview ?? "", surface.url ?? "");
    }

    return parts.join("\n");
}

export function sessionIdsIn(text: string): string[] {
    const found = text.match(SESSION_ID_RE);

    if (!found) {
        return [];
    }

    return [...new Set(found.map((id) => id.toLowerCase()))];
}

/**
 * Session ids this pane is actually RESUMING, as opposed to merely displaying.
 *
 * The distinction is not academic. An agent pane that discussed a session id has that id
 * on screen as plain text, so matching bare ids alone reports two hits for one session and
 * turns every focus into a prompt. A resuming pane always shows `--resume <id>`, which the
 * mentioning pane does not, so that is the signal worth ranking first.
 */
export function resumedSessionIdsIn(text: string): string[] {
    const ids: string[] = [];

    for (const match of text.matchAll(RESUME_ID_RE)) {
        const id = match[1]?.toLowerCase();

        if (id) {
            ids.push(id);
        }
    }

    return [...new Set(ids)];
}

function scorePane({
    pane,
    query,
    workspaceName,
}: {
    pane: CmuxLivePane;
    query: string;
    workspaceName: string;
}): { kind: FocusMatchKind; score: number } | null {
    const haystack = paneHaystack(pane);
    const resumed = resumedSessionIdsIn(haystack);
    const ids = sessionIdsIn(haystack);
    const needle = query.toLowerCase();
    const longEnough = needle.length >= MIN_ID_PREFIX;

    // The pane is running this session, not talking about it. Nothing outranks that.
    if (resumed.includes(needle)) {
        return { kind: "resume-command", score: 100 };
    }

    if (longEnough && resumed.some((id) => id.startsWith(needle))) {
        return { kind: "resume-prefix", score: 95 };
    }

    // The id is on screen but not in a resume command: an agent pane that printed the id,
    // a log, a note. Real evidence, but weaker than the pane actually running it.
    if (ids.includes(needle)) {
        return { kind: "session-id", score: 70 };
    }

    if (longEnough && ids.some((id) => id.startsWith(needle))) {
        return { kind: "id-prefix", score: 65 };
    }

    if (pane.title.toLowerCase().includes(needle)) {
        return { kind: "pane-title", score: 60 };
    }

    if (workspaceName.toLowerCase().includes(needle)) {
        return { kind: "workspace", score: 50 };
    }

    const cwd = pane.cwd;

    if (cwd && (cwd.toLowerCase().includes(needle) || basename(cwd).toLowerCase() === needle)) {
        return { kind: "cwd", score: 40 };
    }

    // Last resort: the query is somewhere on the screen. Useful for "the pane where I
    // was editing pricing.ts", noisy enough that it never outranks an id.
    if (haystack.toLowerCase().includes(needle)) {
        return { kind: "screen", score: 20 };
    }

    return null;
}

/**
 * Panes matching `query`, best first.
 *
 * The query is matched against what a pane SHOWS, not against the session store, because
 * the question this answers is "which pane already has this session open" — a session with
 * no pane cannot be focused, and `restore` is the command for that case.
 */
export function findFocusTargets(
    snapshot: CmuxLiveSnapshot,
    query: string,
    opts: FindFocusOptions = {}
): FocusTarget[] {
    const trimmed = query.trim();

    if (!trimmed) {
        return [];
    }

    const names = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace.name]));
    const targets: FocusTarget[] = [];

    for (const pane of snapshot.panes) {
        // Skip the pane this command is running in. Typing the query puts it on that pane's
        // screen, so the weak "text on screen" rule would match the caller for EVERY query
        // — including a nonsense one, which then reports a confident hit instead of "no
        // match". Found by running `focus zzz-not-a-session` from a cmux pane: it focused
        // the calling pane. Focusing where you already are is a no-op anyway.
        if (opts.excludePaneId && pane.id === opts.excludePaneId) {
            continue;
        }

        const workspaceName = names.get(pane.workspaceId) ?? pane.workspaceId;
        const hit = scorePane({ pane, query: trimmed, workspaceName });

        if (!hit) {
            continue;
        }

        targets.push({
            workspaceId: pane.workspaceId,
            workspaceName,
            paneId: pane.id,
            paneTitle: pane.title,
            cwd: pane.cwd,
            sessionIds: sessionIdsIn(paneHaystack(pane)),
            matchedOn: hit.kind,
            score: hit.score,
            active: pane.active,
        });
    }

    return targets.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }

        if (a.active !== b.active) {
            return a.active ? -1 : 1;
        }

        return a.paneId.localeCompare(b.paneId);
    });
}

/**
 * True when the top match is the only one worth focusing without asking.
 *
 * One pane RESUMING the session wins even when other panes merely print its id. Anything
 * else needs the top score to stand alone.
 */
export function isUnambiguous(targets: FocusTarget[]): boolean {
    if (targets.length === 0) {
        return false;
    }

    if (targets.length === 1) {
        return true;
    }

    const [first, second] = targets;

    // A resume match is the pane RUNNING the session. One of those beats any number of
    // panes that merely printed the id, which is the common case when an agent pane has
    // been discussing session ids.
    if (isResumeMatch(first)) {
        return !isResumeMatch(second);
    }

    return first.score > second.score;
}

/** True when the pane is running the session, not just showing its id. */
export function isResumeMatch(target: FocusTarget): boolean {
    return target.matchedOn === "resume-command" || target.matchedOn === "resume-prefix";
}

export function describeMatch(target: FocusTarget): string {
    switch (target.matchedOn) {
        case "resume-command":
            return "resuming this session";
        case "resume-prefix":
            return "resuming this session (id prefix)";
        case "session-id":
            return "session id on screen";
        case "id-prefix":
            return "session id prefix on screen";
        case "pane-title":
            return "pane title";
        case "workspace":
            return "workspace name";
        case "cwd":
            return "working directory";
        case "screen":
            return "text on screen";
    }
}
