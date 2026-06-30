#!/usr/bin/env bun

import { SafeJSON } from "@app/utils/json";

const reminder =
    "Before spawning subagents that need to communicate with each other or with you, invoke `/gt:agents-talk` (the cross-agent messaging protocol via `tools agents`).";

const payload = {
    hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: reminder,
    },
};

process.stdout.write(`${SafeJSON.stringify(payload, { strict: true })}\n`);
