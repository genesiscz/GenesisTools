/**
 * Who a handoff is FOR, and what it is called.
 *
 * Recipient identity is deliberately separate from author identity. `postedBy`
 * and `postedByContext.agent` say which harness WROTE the handoff; `target.agent`
 * says which harness should WORK it. Reading one for the other would make every
 * codex task look addressed to the claude session that filed it.
 *
 * Nothing here blocks: a mismatch produces a warning line and the caller decides.
 * User-authorized cross-target work stays possible on purpose — the agent is told
 * to stop, not prevented from continuing when its user says to.
 */

import { targetMatchesSession } from "./fold";
import type { HandoffEventBy, HandoffTarget } from "./types";

/** Documented recipient harness names — the values `target.agent` compares against. */
export const HANDOFF_AGENTS = ["claude", "codex", "grok", "copilot"] as const;

export type HandoffAgent = (typeof HANDOFF_AGENTS)[number];

export const HANDOFF_AGENTS_LIST = HANDOFF_AGENTS.join(", ");

/**
 * Spelling → canonical harness. The runtime context calls the Claude host
 * "claude-code" (AgentRuntimeContext.agent) while posters write "claude", so the
 * two must land on the same value or every claude session would read as a
 * mismatch against every claude-targeted handoff.
 */
const AGENT_ALIASES: Record<string, HandoffAgent> = {
    claude: "claude",
    "claude-code": "claude",
    claude_code: "claude",
    claudecode: "claude",
    "claude-cli": "claude",
    codex: "codex",
    "codex-cli": "codex",
    grok: "grok",
    "grok-cli": "grok",
    copilot: "copilot",
    "github-copilot": "copilot",
};

/** Canonical harness name, or null when the value names no documented harness. */
export function canonicalAgent(raw: string | null | undefined): HandoffAgent | null {
    if (typeof raw !== "string") {
        return null;
    }

    const key = raw.trim().toLowerCase();

    // Own-property check: "constructor" or "__proto__" must not read as a harness.
    return Object.hasOwn(AGENT_ALIASES, key) ? AGENT_ALIASES[key] : null;
}

export function isKnownAgent(raw: string | null | undefined): boolean {
    return canonicalAgent(raw) !== null;
}

/**
 * Stored form of a supplied recipient harness: the canonical name when the value
 * is documented, the trimmed lowercase form otherwise. An undocumented name is
 * kept rather than rejected so a harness added later survives a round trip; it
 * simply can never prove a mismatch (see recipientCheck).
 */
export function normalizeAgentInput(raw: unknown): string | undefined {
    if (typeof raw !== "string") {
        return undefined;
    }

    const trimmed = raw.trim().toLowerCase();

    if (trimmed.length === 0) {
        return undefined;
    }

    return canonicalAgent(trimmed) ?? trimmed;
}

/**
 * The one place a caller-supplied target is cleaned up: trimmed session fields
 * plus a normalized recipient harness. Both the post door and the modify_handoff
 * door go through it, so `{ agent: "Claude-Code" }` cannot be stored one way
 * here and another way there.
 */
export function normalizeTargetInput(raw: unknown): HandoffTarget | undefined {
    if (raw === null || typeof raw !== "object") {
        return undefined;
    }

    const input = raw as { sessionId?: unknown; sessionName?: unknown; agent?: unknown };
    const target: HandoffTarget = {};

    if (typeof input.sessionId === "string" && input.sessionId.trim().length > 0) {
        target.sessionId = input.sessionId.trim();
    }

    if (typeof input.sessionName === "string" && input.sessionName.trim().length > 0) {
        target.sessionName = input.sessionName.trim();
    }

    const agent = normalizeAgentInput(input.agent);

    if (agent !== undefined) {
        target.agent = agent;
    }

    return Object.keys(target).length > 0 ? target : undefined;
}

export const MAX_HANDOFF_NAME_LENGTH = 60;

/**
 * A handoff name is a slug: lowercase, alphanumeric, hyphen-separated. Slugging
 * is what keeps a name from ever colliding with an id — `_` is not alphanumeric,
 * so no slug can start with the `h_` prefix `normalizeHandoffId` produces.
 */
export function normalizeHandoffName(raw: unknown): string | undefined {
    if (typeof raw !== "string") {
        return undefined;
    }

    const slug = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    if (slug.length === 0) {
        return undefined;
    }

    return slug.slice(0, MAX_HANDOFF_NAME_LENGTH).replace(/-+$/g, "");
}

/**
 * The name a new handoff gets: the supplied one, else derived from the title.
 * Derivation happens HERE and not in the fold, so the final name is written into
 * the post event. The fold stays a pure copy, and a later title edit never
 * silently renames a handoff other agents were told to look up by name.
 */
export function handoffNameFor({ name, title }: { name?: unknown; title: string }): string | undefined {
    return normalizeHandoffName(name) ?? normalizeHandoffName(title);
}

/** What the recipient check concluded for one dimension of the target. */
export type RecipientStatus = "not-targeted" | "match" | "mismatch" | "unverifiable";

export interface RecipientCheck {
    agent: RecipientStatus;
    session: RecipientStatus;
    /** Human-readable lines for the caller. Empty when nothing is worth saying. */
    warnings: string[];
}

const ANOTHER_HARNESS = "This task is for another harness — do not work on it unless your user explicitly asks you to.";

const ANOTHER_SESSION = "This task is for another session — do not work on it unless your user explicitly asks you to.";

function checkAgent(target: HandoffTarget | undefined, by: HandoffEventBy, warnings: string[]): RecipientStatus {
    const wanted = target?.agent;

    if (wanted === undefined || wanted.trim().length === 0) {
        return "not-targeted";
    }

    const wantedCanonical = canonicalAgent(wanted);

    if (wantedCanonical === null) {
        warnings.push(
            `⚠️ Recipient unverifiable: this handoff targets harness "${wanted}", which is not a documented harness (${HANDOFF_AGENTS_LIST}). No match or mismatch can be proven — ask your user who it is for.`
        );
        return "unverifiable";
    }

    const mine = canonicalAgent(by.agent);

    if (mine === null) {
        warnings.push(
            `⚠️ Recipient unverifiable: this handoff targets harness "${wantedCanonical}", but this session's own harness was not detected (agent "${by.agent}"). Treat it as addressed elsewhere until your user confirms.`
        );
        return "unverifiable";
    }

    if (mine === wantedCanonical) {
        return "match";
    }

    warnings.push(
        `⚠️ Recipient mismatch: this handoff targets harness "${wantedCanonical}", this session runs "${mine}". ${ANOTHER_HARNESS}`
    );
    return "mismatch";
}

function checkSession(target: HandoffTarget | undefined, by: HandoffEventBy, warnings: string[]): RecipientStatus {
    const wantedId = target?.sessionId;

    if (wantedId !== undefined && wantedId.trim().length > 0) {
        if (by.sessionId == null) {
            warnings.push(
                `⚠️ Recipient unverifiable: this handoff targets sessionId "${wantedId}", but this session has no sessionId, so the match cannot be checked. Treat it as addressed elsewhere until your user confirms.`
            );
            return "unverifiable";
        }

        if (targetMatchesSession(wantedId, by.sessionId)) {
            return "match";
        }

        warnings.push(
            `⚠️ Recipient mismatch: this handoff targets sessionId "${wantedId}", this session is "${by.sessionId}". ${ANOTHER_SESSION}`
        );
        return "mismatch";
    }

    const wantedName = target?.sessionName;

    if (wantedName === undefined || wantedName.trim().length === 0) {
        return "not-targeted";
    }

    if (by.sessionTitle != null && by.sessionTitle === wantedName) {
        return "match";
    }

    // Session names are not unique, so a difference never proves the handoff is
    // for someone else. Say so rather than raising a mismatch nobody can act on.
    warnings.push(
        `⚠️ Recipient unverifiable: this handoff targets sessionName "${wantedName}", which is not this session's name (${by.sessionTitle == null ? "unnamed" : `"${by.sessionTitle}"`}). Session names are not unique, so this is a hint, not proof.`
    );
    return "unverifiable";
}

/**
 * Compare a handoff's intended recipient against the calling session.
 *
 * A missing caller identity is reported as unverifiable, never as a mismatch:
 * "I could not check" and "this is not for you" are different claims, and only
 * one of them is true when the harness could not be detected.
 */
export function recipientCheck({ target, by }: { target?: HandoffTarget; by: HandoffEventBy }): RecipientCheck {
    const warnings: string[] = [];
    const agent = checkAgent(target, by, warnings);
    const session = checkSession(target, by, warnings);

    if (agent === "mismatch" || session === "mismatch") {
        warnings.push(
            "If your user explicitly asks you to take it anyway, claim it explicitly (handoff_get with claim: true) and say in a comment why you are working someone else's handoff."
        );
    }

    return { agent, session, warnings };
}

/**
 * `handoff_list { agent }` — matches the INTENDED RECIPIENT harness only, never
 * the posting harness. Documented spellings are compared canonically, so
 * `agent: "claude-code"` finds handoffs stored as `claude`.
 */
export function agentFilterMatches(target: HandoffTarget | undefined, query: string): boolean {
    const stored = target?.agent;

    if (stored === undefined) {
        return false;
    }

    const wanted = canonicalAgent(query);
    const have = canonicalAgent(stored);

    if (wanted !== null || have !== null) {
        return wanted !== null && have !== null && wanted === have;
    }

    return stored.trim().toLowerCase() === query.trim().toLowerCase();
}

/**
 * `handoff_list { session }` — matches the intended recipient session: the
 * target sessionId exactly or by leading-segment abbreviation in EITHER
 * direction (a stored `cd4e9457` and a queried full id name the same session),
 * or the target sessionName case-insensitively.
 */
export function sessionFilterMatches(target: HandoffTarget | undefined, query: string): boolean {
    const wanted = query.trim();

    if (wanted.length === 0 || target === undefined) {
        return false;
    }

    const storedId = target.sessionId;

    if (storedId !== undefined) {
        if (storedId === wanted || targetMatchesSession(storedId, wanted) || targetMatchesSession(wanted, storedId)) {
            return true;
        }
    }

    const storedName = target.sessionName;
    return storedName !== undefined && storedName.trim().toLowerCase() === wanted.toLowerCase();
}
