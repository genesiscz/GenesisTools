import type { ReplayCatalogSession } from "@app/cmux/lib/replay-catalog";
import type { ResumeEvidence } from "@app/cmux/lib/types";
import type { AgentKind } from "@genesiscz/utils/agent-sessions/types";

/**
 * Which session a tab title names: the agent its title implies, then an exact title in the tab's folder, a title
 * that starts with the tab title, and last the first prompt's words (weak evidence, never typed).
 */
const SPINNER_PREFIX = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳⠐●○◐◑◒◓]\s*/u;

export function inferLauncherFromTitle(title: string): AgentKind | undefined {
    if (/\s-\s+grok\b/i.test(title) || /\bgrok\s*$/i.test(title.trim())) {
        return "grok";
    }

    if (/\s-\s+codex\b/i.test(title) || /\bcodex\s*$/i.test(title.trim())) {
        return "codex";
    }

    if (/^[✳⠐◐◑◒◓]/.test(title.trim())) {
        return "claude";
    }

    return undefined;
}

function stripGrokSuffix(title: string): string {
    return title.replace(/\s+-\s+grok(?:\s+·\s+[0-9a-f]{7,8})?\s*$/i, "").trim();
}

function stripCodexSuffix(title: string): string {
    return title.replace(/\s+-\s+codex(?:\s+·\s+[0-9a-f]{7,8})?\s*$/i, "").trim();
}

function stripClaudeGlyph(title: string): string {
    return title
        .replace(SPINNER_PREFIX, "")
        .replace(/\s+·\s+[0-9a-f]{7,8}\s*$/i, "")
        .trim();
}

function stripEllipsis(value: string): string {
    return value.replace(/(\u2026|\.{2,}|…)+$/u, "").trim();
}

/** Keys to try against a generated session title, most specific first. */
export function titleMatchKeys(title: string, kind: AgentKind): string[] {
    const base =
        kind === "grok" ? stripGrokSuffix(title) : kind === "codex" ? stripCodexSuffix(title) : stripClaudeGlyph(title);
    const stripped = stripEllipsis(base.replace(SPINNER_PREFIX, "").trim());
    const parts = stripped
        .split(/\s+-\s+/)
        .map((part) => stripEllipsis(part).toLowerCase())
        .filter((part) => part.length >= 4);
    const full = stripped.toLowerCase();
    const keys = [...parts].reverse();

    if (full.length >= 4) {
        keys.push(full);
    }

    return [...new Set(keys)];
}

/** Strongest evidence: the tab title IS the session's title. */
export function titleEqualsKey(session: ReplayCatalogSession, key: string): boolean {
    return Boolean(key) && session.title.trim().toLowerCase() === key;
}

/**
 * Strong evidence: the tab shows the session's title truncated. It is its own tier below the exact
 * title, because sibling sessions are often named by extending one name (`pr-7210-logs`,
 * `pr-7210-logs-scripts`), and counting those prefix hits beside the exact one made the match
 * ambiguous and resolved nothing.
 */
export function titleStartsWithKey(session: ReplayCatalogSession, key: string): boolean {
    return key.length >= 12 && session.title.trim().toLowerCase().startsWith(key);
}

/** Weak evidence: the tab title reads like the opening words of the first prompt. */
export function promptMatchesKey(session: ReplayCatalogSession, key: string): boolean {
    const prompt = session.prompt?.toLowerCase() ?? "";

    if (!key || !prompt) {
        return false;
    }

    const words = key.split(/\s+/).filter((word) => word.length >= 4);
    if (words.length < 2) {
        return false;
    }

    return prompt.includes(words.slice(0, 2).join(" "));
}

function pickUnique(hits: ReplayCatalogSession[]): ReplayCatalogSession | undefined {
    if (hits.length === 1) {
        return hits[0];
    }

    if (hits.length === 0) {
        return undefined;
    }

    const ids = new Set(hits.map((hit) => hit.sessionId));
    if (ids.size === 1) {
        return hits[0];
    }

    return undefined;
}

/**
 * Title evidence outranks prompt evidence, and the pane's own directory
 * outranks both.
 *
 * Title and prompt used to share one candidate pool, so three sessions whose
 * FIRST PROMPT happened to contain "native oauth" out-voted the one session
 * whose title was exactly the tab's, and `pickUnique` reported "ambiguous" for a
 * session it had already found. Tiering answers from the exact title and never
 * reaches the prompt guess.
 *
 * The cwd fallback stays OUTSIDE that tier loop on purpose. Running it per tier
 * put "a title match in any directory" above "a prompt match in this pane's own
 * directory", and the restored pane then resumed a conversation from another
 * project.
 *
 * `launcherKnown` says the pane's own launch command already names this agent. A
 * tab cmux restored after a restart shows its saved title without the agent's
 * glyph (`nabidky-2.0`, not `✳ nabidky-2.0`), so demanding the glyph refused the
 * exact-title session for every idle tab. Then only a title that names ANOTHER
 * agent disqualifies the match.
 */
export function matchAgentSession(
    kind: AgentKind,
    title: string,
    cwd: string | undefined,
    sessions: ReplayCatalogSession[],
    options: { launcherKnown?: boolean } = {}
): { session: ReplayCatalogSession; evidence: Exclude<ResumeEvidence, "journal">; why: string } | undefined {
    const titleKind = inferLauncherFromTitle(title);

    if (options.launcherKnown ? titleKind !== undefined && titleKind !== kind : titleKind !== kind) {
        return undefined;
    }

    const keys = titleMatchKeys(title, kind);
    const pool = sessions.filter((session) => session.kind === kind);
    const inCwd = cwd ? pool.filter((session) => session.cwd === cwd) : pool;

    // `why` names the evidence for the drift line. Only a title match in the tab's own directory counts
    // as "title"; first-prompt words, or any match in another directory, are "weak".
    const tiers = [
        { matches: titleEqualsKey, why: "tab title" },
        { matches: titleStartsWithKey, why: "tab title" },
        { matches: promptMatchesKey, why: "first-prompt words of session" },
    ];

    for (const { matches, why } of tiers) {
        for (const key of keys) {
            const local = pickUnique(inCwd.filter((session) => matches(session, key)));
            if (local) {
                return { session: local, evidence: why === "tab title" ? "title" : "weak", why };
            }
        }
    }

    if (!cwd) {
        return undefined;
    }

    for (const { matches, why } of tiers) {
        for (const key of keys) {
            const global = pickUnique(pool.filter((session) => matches(session, key)));
            if (global) {
                return { session: global, evidence: "weak", why: `${why} in another directory (${global.cwd})` };
            }
        }
    }

    return undefined;
}
