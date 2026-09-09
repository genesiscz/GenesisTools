#!/usr/bin/env bun

// Both Claude Code and Codex run this plugin's SessionStart hooks (Codex installs Claude plugins
// verbatim), so the same file speaks to two harnesses that need opposite advice. The harness is
// decided from the payload, never from the environment: a Codex worker spawned from a Claude
// session inherits every CLAUDE_CODE_* variable, so env would call it Claude.

// biome-ignore lint/style/noRestrictedGlobals: standalone hook script — cannot import @genesiscz/utils/json
const SafeJSON = JSON;

interface SessionStartPayload {
    transcript_path?: string;
}

/**
 * Codex writes its transcript as `~/.codex-<name>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`;
 * Claude writes `~/.claude/projects/<slug>/<uuid>.jsonl`. The rollout name is the decisive signal.
 */
export function harnessOf(payload: SessionStartPayload): "codex" | "claude" {
    const transcript = payload.transcript_path ?? "";
    return /\/rollout-[^/]*\.jsonl$/.test(transcript) || /\/\.codex[^/]*\//.test(transcript) ? "codex" : "claude";
}

export const CLAUDE_REMINDER =
    "Only when a `gt:handoff-to` run needs several agents to talk to each other WHILE they work: invoke the `genesis-tools:agents-talk` skill first, to pick the channel. Ordinary subagents that report back when finished need nothing from it. The Skill tool only accepts that full id — `gt:agents-talk` is not a valid skill name.";

export const CODEX_REMINDER =
    "Never invoke the `genesis-tools:agents-talk` / `agents-talk` skill: it needs a Monitor tool Codex does not have. For subagent communication use Codex's native collaboration tools (send_message for active peers, followup_task for idle ones).";

export function reminderFor(payload: SessionStartPayload): string {
    return harnessOf(payload) === "codex" ? CODEX_REMINDER : CLAUDE_REMINDER;
}

if (import.meta.main) {
    let payload: SessionStartPayload = {};

    try {
        payload = SafeJSON.parse(await Bun.stdin.text()) as SessionStartPayload;
    } catch (err) {
        // An unreadable payload is a harness we do not know; the Claude text is the safe default.
        process.stderr.write(`agents-talk-hint: payload not parsed, assuming Claude: ${String(err)}\n`);
    }

    const output = {
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: reminderFor(payload),
        },
    };

    process.stdout.write(`${SafeJSON.stringify(output)}\n`);
}
