#!/usr/bin/env bun

// Claude Code, Codex and Grok run this plugin's SessionStart hooks. The harness is decided from
// the payload, never from the environment: a Codex worker spawned from a Claude session inherits
// every CLAUDE_CODE_* variable, so env would call it Claude.
//
// Grok 1.0.44's installed guide says SessionStart stdout is ignored. Rechecked 2026-09-29: the
// sentence is in that binary, and a 1.0.44 system prompt did not contain this reminder. Codex
// 0.155 still accepts additionalContext on SessionStart, and Claude does too, so the hook still
// prints it.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessOf, type SessionStartPayload } from "./harness";

const SafeJSON = JSON;

export { harnessOf };

export const CLAUDE_REMINDER =
    "Invoke the `genesis-tools:agents-talk` skill first when agents must talk to each other WHILE they work: a `gt:handoff-to` swarm, or an agent team whose lead may need to steer a teammate in the middle of its task (team mail to a busy teammate waits until its turn ends). Ordinary subagents that report back when finished need nothing from it. The Skill tool only accepts that full id — `gt:agents-talk` is not a valid skill name.";

export const CODEX_REMINDER =
    "Never invoke the `genesis-tools:agents-talk` / `agents-talk` skill: it needs a Monitor tool Codex does not have. For subagent communication use Codex's native collaboration tools (send_message for active peers, followup_task for idle ones).";

export const GROK_REMINDER =
    "When agents must talk to each other WHILE they work, read the `agents-talk` skill and follow its Grok section: wrap `tools agents login` in the `monitor` tool (`persistent: true`), which pushes each mail line into the chat, and pass `--session <id>` explicitly on every `tools agents` call, because a grok worker's environment may be stripped. An idle grok subagent is not woken by its mail; the parent resumes it with `spawn_subagent` `resume_from`.";

/** `agentsTalk.hint` in `~/.genesis-tools/agents/hooks.json`, set by `tools agents hooks config set`. */
export function hintEnabled(configPath = hooksConfigPath()): boolean {
    let text: string;

    try {
        text = readFileSync(configPath, "utf8");
    } catch {
        // No config file is the normal case: the shipped default is on.
        return true;
    }

    let stored: unknown;

    try {
        stored = parseLenientJson(text);
    } catch (error) {
        // An unreadable config keeps the shipped default, as the main hooks loader does.
        process.stderr.write(
            `agents-talk-hint: ${configPath} is not valid JSON (${String(error)}); the hint stays on\n`
        );
        return true;
    }

    const agentsTalk = (stored as { agentsTalk?: { hint?: unknown } } | null)?.agentsTalk;
    return agentsTalk?.hint !== false;
}

/**
 * JSON with the comments and trailing commas a hand-edited `hooks.json` may carry: the main loader reads it
 * with the lenient SafeJSON, and this standalone hook cannot import that.
 */
export function parseLenientJson(text: string): unknown {
    let out = "";
    let inString = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            out += char;

            if (char === "\\") {
                out += text[i + 1] ?? "";
                i++;
            } else if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
            out += char;
        } else if (char === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") {
                i++;
            }

            out += "\n";
        } else if (char === "/" && text[i + 1] === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end < 0 ? text.length : end + 1;
        } else {
            out += char;
        }
    }

    return SafeJSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function hooksConfigPath(): string {
    // Standalone hook script: no access to @genesiscz/utils/env, so process.env directly.
    return join(process.env.GENESIS_TOOLS_HOME || homedir(), ".genesis-tools", "agents", "hooks.json");
}

/** Codex has no Monitor, so it is told never to use the skill; Claude and Grok each get their own route. */
export function reminderFor(payload: SessionStartPayload): string {
    const harness = harnessOf(payload);

    if (harness === "codex") {
        return CODEX_REMINDER;
    }

    return harness === "grok" ? GROK_REMINDER : CLAUDE_REMINDER;
}

if (import.meta.main && hintEnabled()) {
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
