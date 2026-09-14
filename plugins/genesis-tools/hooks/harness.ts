/**
 * Which coding agent is running this hook, decided from the SessionStart payload.
 *
 * Claude Code, Codex and Grok all install Claude plugins verbatim and run these hooks, so one
 * file speaks to three harnesses. 🛑 The harness is decided from the PAYLOAD, never from the
 * environment: a Codex worker spawned from a Claude session inherits every `CLAUDE_CODE_*` and
 * `TOOLS_CLAUDE_*` variable, so env would call it Claude and attribute its work to a Claude
 * account. That exact mis-attribution is in the pin journal 9 times over.
 *
 * Shared by `agents-talk-hint.ts` and `record-session-account.ts`, which is why it is its own
 * file: a hook script cannot import `@genesiscz/utils`, but it can import a sibling.
 */

export type Harness = "claude" | "codex" | "grok";

export interface SessionStartPayload {
    transcript_path?: string;
}

/**
 * Codex writes `~/.codex-<name>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; Grok writes
 * under a `~/.grok` home's `sessions/`; Claude writes `~/.claude/projects/<slug>/<uuid>.jsonl`. The
 * rollout name is the decisive Codex signal; the home directory carries the rest.
 *
 * Claude is the fallback because this journal has only ever held Claude sessions, so an
 * unrecognised payload keeps today's meaning rather than inventing a new one.
 */
export function harnessOf(payload: SessionStartPayload): Harness {
    const transcript = payload.transcript_path ?? "";

    if (/\/rollout-[^/]*\.jsonl$/.test(transcript) || /\/\.codex[^/]*\//.test(transcript)) {
        return "codex";
    }

    if (/\/\.grok[^/]*\//.test(transcript)) {
        return "grok";
    }

    return "claude";
}

/**
 * The variable `tools <agent> run` exports into the launched agent's environment. A hook is a
 * child of that process, so it can read it back. Mirrors `accountEnvVar()` in
 * `@genesiscz/utils/ai/account-env`, which a standalone hook cannot import.
 */
export function accountEnvVarFor(harness: Harness): string {
    return `TOOLS_${harness.toUpperCase()}_ACCOUNT`;
}
