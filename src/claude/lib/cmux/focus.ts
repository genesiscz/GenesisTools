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
 * The ` · 8b6e69bf` marker `paneTitle()` puts at the end of every restored tab title.
 *
 * Anchored at the end because that function truncates a long name and never the id, so the
 * marker is always the last thing in the title.
 */
export const TITLE_SHORT_ID_RE = /·\s*([0-9a-f]{8})\s*$/i;

/**
 * Shortest prefix accepted as "this is a session id, not a word".
 *
 * A restored pane's screen holds the whole resume command, so a 3-character query
 * would match a hex fragment inside some unrelated hash and focus the wrong pane.
 * Eight is the short form printed everywhere else in this tool (`sessionId.slice(0, 8)`).
 */
const MIN_ID_PREFIX = 8;
const MIN_ALIAS_LENGTH = 8;

export interface SessionFocusRecord {
    sessionId: string | null;
    customTitle: string | null;
    summary: string | null;
    firstPrompt: string | null;
}

/** Basenames of html/md/txt/pdf paths cited in a prompt, without the extension. */
function fileStemsIn(prompt: string): string[] {
    const stems: string[] = [];

    for (const match of prompt.matchAll(/\/([^/\s"'<>]+)\.(html?|md|txt|pdf)\b/gi)) {
        const stem = match[1];

        if (stem && stem.length >= MIN_ALIAS_LENGTH) {
            stems.push(stem);
        }
    }

    return stems;
}

/**
 * Title needles for a session-id query: `/rename` first, else a file the prompt cited.
 *
 * Untitled sessions still show a topic tab (Claude OSC or a file-stem name). The id
 * is not in that title, so focus has to look the topic up from the session record.
 */
export function matchingSession(query: string, sessions: SessionFocusRecord[]): SessionFocusRecord | null {
    const needle = query.trim().toLowerCase();
    return (
        sessions.find((session) => {
            const id = (session.sessionId ?? "").toLowerCase();
            return id === needle || (needle.length >= MIN_ID_PREFIX && id.startsWith(needle));
        }) ?? null
    );
}

export function aliasesForSession(query: string, sessions: SessionFocusRecord[]): string[] {
    const record = matchingSession(query, sessions);

    if (!record) {
        return [];
    }

    const aliases: string[] = [];
    const push = (raw: string | null | undefined) => {
        const text = raw?.replace(/\s+/g, " ").trim();

        if (text && text.length >= MIN_ALIAS_LENGTH) {
            aliases.push(text);
        }
    };

    push(record.customTitle);
    push(record.summary);

    if (!record.customTitle && record.firstPrompt) {
        for (const stem of fileStemsIn(record.firstPrompt)) {
            push(stem);
            push(stem.replace(/[-_]+/g, " "));
        }
    }

    return [...new Set(aliases)];
}

export type FocusMatchKind =
    | "recorded"
    | "resume-command"
    | "resume-prefix"
    | "title-id"
    | "session-name"
    | "session-id"
    | "id-prefix"
    | "pane-title"
    | "workspace"
    | "cwd"
    | "screen";

export interface FindFocusOptions {
    /** Pane to leave out of the search, normally the one this process runs in. */
    excludePaneId?: string;
    /**
     * Surface (tab) to leave out, normally the one this process runs in.
     *
     * Preferred over `excludePaneId`: a cmux pane holds many tabs, so skipping the whole
     * pane hides every SIBLING tab in it. That is not hypothetical — on 2026-08-26 a focus
     * for a session sitting one tab away from the caller skipped its own pane, then focused
     * a different pane whose tab had a near-identical name, and reported success. Excluding
     * only the caller's own surface keeps the original protection (the query is echoed on
     * THAT tab's screen, nowhere else) without blinding the search to the rest of the pane.
     */
    excludeSurfaceId?: string;
    /**
     * Extra title needles from the session record (custom title, prompt file stem).
     * Used when the tab was named from the topic and never got ` · 8b6e69bf`.
     */
    aliases?: string[];
    /** Full session UUID looked up from the query. Stamped onto a session-name match. */
    resolvedSessionId?: string;
}

export interface FocusTarget {
    workspaceId: string;
    workspaceName: string;
    paneId: string;
    paneTitle: string;
    cwd?: string;
    /** Owning cmux window, when the live snapshot already knew it. */
    windowRef?: string;
    /**
     * The surface (tab) the match came from, when it was not the pane's own visible text.
     *
     * Focusing the pane alone leaves whatever tab was already selected on top, so a caller
     * has to focus this surface too or it reports success while the match stays hidden.
     */
    surfaceId?: string;
    /** Session ids this pane shows, the one it is RESUMING first. Empty when none. */
    sessionIds: string[];
    /** Which signal matched, for the "focused X because Y" line and for --json. */
    matchedOn: FocusMatchKind;
    /** Higher wins. Ties break on the pane already being active, then on pane id. */
    score: number;
    active: boolean;
}

/** One block of text to match against, and the surface it came from when it came from one. */
interface PaneScope {
    surfaceId?: string;
    title: string;
    screen: string;
}

/**
 * The pane's own text first, then its surfaces with the visible one ahead of the rest.
 *
 * Scoring per scope rather than over one merged blob is what lets a match name the tab it
 * came from. Selected-first settles ties in favour of the tab the user already sees, so a
 * focus never switches tabs unless a background one is a strictly better match.
 */
function paneScopes(pane: CmuxLivePane, excludeSurfaceId?: string): PaneScope[] {
    const surfaces = [...pane.surfaces]
        .filter((surface) => surface.id !== excludeSurfaceId)
        .sort((a, b) => Number(b.selected) - Number(a.selected));

    // The pane's own preview mirrors whatever tab is selected, so when that tab is the
    // caller's it carries the echoed query and would match everything. Drop it with the tab.
    const ownScope: PaneScope[] =
        excludeSurfaceId && pane.surfaces.some((surface) => surface.id === excludeSurfaceId && surface.selected)
            ? []
            : [{ title: pane.title, screen: pane.preview ?? "" }];

    return [
        ...ownScope,
        ...surfaces.map((surface) => ({
            surfaceId: surface.id,
            title: surface.title,
            screen: [surface.preview ?? "", surface.url ?? ""].join("\n"),
        })),
    ];
}

function scopeText(scope: PaneScope): string {
    return `${scope.title}\n${scope.screen}`;
}

/** Every scrap of text a pane exposes, for the full session-id inventory. */
function paneText(pane: CmuxLivePane, excludeSurfaceId?: string): string {
    return paneScopes(pane, excludeSurfaceId).map(scopeText).join("\n");
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

/**
 * Session ids this pane shows, the one it is resuming first.
 *
 * Callers render `sessionIds[0]` as "the session in this pane", so the session that was
 * matched has to come first. Neither screen order nor scope order gets there on its own: a
 * pane can print another session's id above its own resume command, and a pane whose visible
 * tab resumes one session can have the MATCHED session on a background tab. In both cases the
 * status line, the picker hint and the table would name a session the user did not ask about.
 *
 * `matched` is the text of the scope that actually matched; `rest` is the remainder of the
 * pane, kept so the field is still a full inventory of what the pane shows.
 */
function sessionIdsForMatch(kind: FocusMatchKind, ids: string[], resolved?: string): string[] {
    if (!resolved || kind !== "session-name") {
        return ids;
    }

    return [...new Set([resolved.toLowerCase(), ...ids])];
}

export function paneSessionIds(matched: string, rest = ""): string[] {
    return [
        ...new Set([
            ...resumedSessionIdsIn(matched),
            ...sessionIdsIn(matched),
            ...resumedSessionIdsIn(rest),
            ...sessionIdsIn(rest),
        ]),
    ];
}

interface PaneMatch {
    kind: FocusMatchKind;
    score: number;
    surfaceId?: string;
    /** Text of the scope that matched, so the caller can order session ids by it. */
    matchedText: string;
}

function scoreScope(scope: PaneScope, needle: string): { kind: FocusMatchKind; score: number } | null {
    const haystack = scopeText(scope);
    const longEnough = needle.length >= MIN_ID_PREFIX;
    const resumed = resumedSessionIdsIn(haystack);

    // The pane is running this session, not talking about it. Nothing outranks that.
    if (resumed.includes(needle)) {
        return { kind: "resume-command", score: 100 };
    }

    if (longEnough && resumed.some((id) => id.startsWith(needle))) {
        return { kind: "resume-prefix", score: 95 };
    }

    // `restore` stamps the short id into the tab title, and the title outlives the resume
    // command: cmux only exposes the visible viewport, so an active Claude TUI scrolls that
    // command away within seconds and a full-id query would then find nothing. The title is
    // the one durable marker for a long-running session, so it ranks just under seeing the
    // command itself.
    const titleId = scope.title.match(TITLE_SHORT_ID_RE)?.[1]?.toLowerCase();

    if (longEnough && titleId && needle.startsWith(titleId)) {
        return { kind: "title-id", score: 90 };
    }

    const ids = sessionIdsIn(haystack);

    // The id is on screen but not in a resume command: an agent pane that printed the id,
    // a log, a note. Real evidence, but weaker than the pane actually running it.
    if (ids.includes(needle)) {
        return { kind: "session-id", score: 70 };
    }

    if (longEnough && ids.some((id) => id.startsWith(needle))) {
        return { kind: "id-prefix", score: 65 };
    }

    if (scope.title.toLowerCase().includes(needle)) {
        return { kind: "pane-title", score: 60 };
    }

    // Last resort: the query is somewhere on the screen. Useful for "the pane where I
    // was editing pricing.ts", noisy enough that it never outranks an id.
    if (haystack.toLowerCase().includes(needle)) {
        return { kind: "screen", score: 20 };
    }

    return null;
}

function scoreAliasOnTitle(scope: PaneScope, alias: string): { kind: FocusMatchKind; score: number } | null {
    const needle = alias.trim().toLowerCase();

    if (needle.length < MIN_ALIAS_LENGTH) {
        return null;
    }

    if (scope.title.toLowerCase().includes(needle)) {
        return { kind: "session-name", score: 88 };
    }

    return null;
}

function scorePane({
    pane,
    query,
    workspaceName,
    aliases = [],
    excludeSurfaceId,
}: {
    pane: CmuxLivePane;
    query: string;
    workspaceName: string;
    aliases?: string[];
    excludeSurfaceId?: string;
}): PaneMatch | null {
    const scopes = paneScopes(pane, excludeSurfaceId);

    if (scopes.length === 0) {
        return null;
    }

    const needle = query.toLowerCase();
    let best: PaneMatch | null = null;

    for (const scope of scopes) {
        const hit = scoreScope(scope, needle);

        if (hit && (!best || hit.score > best.score)) {
            best = { ...hit, surfaceId: scope.surfaceId, matchedText: scopeText(scope) };
        }

        for (const alias of aliases) {
            const aliasHit = scoreAliasOnTitle(scope, alias);

            if (aliasHit && (!best || aliasHit.score > best.score)) {
                best = { ...aliasHit, surfaceId: scope.surfaceId, matchedText: scopeText(scope) };
            }
        }
    }

    // Pane-level signals. Compared by score rather than checked in sequence, so their
    // precedence against the per-scope kinds does not depend on evaluation order. These
    // match the pane as a whole, so its own text is the scope session ids get ordered by.
    if (workspaceName.toLowerCase().includes(needle) && (!best || best.score < 50)) {
        best = { kind: "workspace", score: 50, matchedText: scopeText(scopes[0]) };
    }

    const cwd = pane.cwd;
    const cwdMatches = cwd && (cwd.toLowerCase().includes(needle) || basename(cwd).toLowerCase() === needle);

    if (cwdMatches && (!best || best.score < 40)) {
        best = { kind: "cwd", score: 40, matchedText: scopeText(scopes[0]) };
    }

    return best;
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
        const hit = scorePane({
            pane,
            query: trimmed,
            workspaceName,
            aliases: opts.aliases,
            excludeSurfaceId: opts.excludeSurfaceId,
        });

        if (!hit) {
            continue;
        }

        targets.push({
            workspaceId: pane.workspaceId,
            workspaceName,
            paneId: pane.id,
            paneTitle: pane.title,
            cwd: pane.cwd,
            windowRef: pane.windowRef,
            surfaceId: hit.surfaceId,
            sessionIds: sessionIdsForMatch(
                hit.kind,
                paneSessionIds(hit.matchedText, paneText(pane, opts.excludeSurfaceId)),
                opts.resolvedSessionId
            ),
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
 * One pane that HOLDS the session wins even when other panes merely print its id. Anything
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

    // One pane demonstrably running the session beats any number of panes that merely
    // printed the id, which is the common case when an agent pane has been discussing
    // session ids.
    if (ownsSession(first)) {
        return !ownsSession(second);
    }

    return first.score > second.score;
}

/**
 * True when the pane demonstrably holds the session rather than mentioning its id.
 *
 * Either the resume command is still on screen, or `restore` stamped the id into the tab
 * title. Both are written by this tool; a bare id in some text is not.
 */
function ownsSession(target: FocusTarget): boolean {
    return (
        target.matchedOn === "resume-command" ||
        target.matchedOn === "resume-prefix" ||
        target.matchedOn === "title-id" ||
        target.matchedOn === "session-name"
    );
}

export function describeMatch(target: FocusTarget): string {
    switch (target.matchedOn) {
        case "recorded":
            return "recorded by the session hook";
        case "resume-command":
            return "resuming this session";
        case "resume-prefix":
            return "resuming this session (id prefix)";
        case "title-id":
            return "session id in the tab title";
        case "session-name":
            return "session name in the tab title";
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
