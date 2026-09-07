#!/usr/bin/env bun

// biome-ignore lint/style/noRestrictedGlobals: standalone hook script — cannot import @genesiscz/utils/json
const SafeJSON = JSON;

const reminder =
    "Before spawning subagents that need to communicate with each other or with you, invoke the `genesis-tools:agents-talk` skill (the channel-selection and cross-agent messaging protocol: working Codex peers use native messages without inbox waits; a shared bus uses `tools agents`). The Skill tool only accepts that full id — `gt:agents-talk` is not a valid skill name.";

const payload = {
    hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: reminder,
    },
};

process.stdout.write(`${SafeJSON.stringify(payload)}\n`);
