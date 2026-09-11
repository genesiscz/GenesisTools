#!/usr/bin/env bun

// Both Claude Code and Codex run this plugin's SessionStart hooks (Codex installs Claude plugins
// verbatim), so the same file speaks to two harnesses that need opposite advice. The harness is
// decided from the payload, never from the environment: a Codex worker spawned from a Claude
// session inherits every CLAUDE_CODE_* variable, so env would call it Claude.

import { harnessOf, type SessionStartPayload } from "./harness";

// biome-ignore lint/style/noRestrictedGlobals: standalone hook script — cannot import @genesiscz/utils/json
const SafeJSON = JSON;

export { harnessOf };

export const CLAUDE_REMINDER =
    "Only when a `gt:handoff-to` run needs several agents to talk to each other WHILE they work: invoke the `genesis-tools:agents-talk` skill first, to pick the channel. Ordinary subagents that report back when finished need nothing from it. The Skill tool only accepts that full id — `gt:agents-talk` is not a valid skill name.";

export const CODEX_REMINDER =
    "Never invoke the `genesis-tools:agents-talk` / `agents-talk` skill: it needs a Monitor tool Codex does not have. For subagent communication use Codex's native collaboration tools (send_message for active peers, followup_task for idle ones).";

export const GROK_REMINDER =
    "Never invoke the `genesis-tools:agents-talk` / `agents-talk` skill: its protocol needs a PUSH subscription to be woken by, and Grok's `get_command_or_subagent_output` is a poll — you get what has accumulated when you ask. Grok does have subagents (`spawn_subagent`) and can read their output that way. To talk to another agent, use the `tools agents` CLI directly and pass `--session <id>` explicitly on every call: a grok worker's environment may be stripped, so auto-detection of the parent swarm cannot be relied on.";

/**
 * Grok used to receive the CLAUDE text, which tells it to invoke a skill that needs the
 * Monitor tool. Grok has no Monitor either, so that advice was as wrong there as it was on
 * Codex; the two just need different replacements, because their messaging tools differ.
 */
export function reminderFor(payload: SessionStartPayload): string {
    const harness = harnessOf(payload);

    if (harness === "codex") {
        return CODEX_REMINDER;
    }

    return harness === "grok" ? GROK_REMINDER : CLAUDE_REMINDER;
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
