#!/usr/bin/env bun
// Claude Code's `subagentStatusLine` command: the agents panel rows with each subagent's model beside its type
// (`mods.agentRow`). The engine runs it every 5 s while a subagent is listed, with the subagents as JSON on stdin,
// and draws each `{"id","content"}` line printed here as that row. The look is the mods plugin's
// (`plugins/genesis-tools-mods/hooks/agent-row.ts`); no line leaves the engine's own row.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { agentRows, finishedAt, rowInput } from "../../../plugins/genesis-tools-mods/hooks/agent-row";
import { loadHooksConfig } from "../lib/hooks/config";
import { hookDiag } from "../lib/hooks/log";
import { writeJsonFile } from "../lib/hooks/write-json";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();

if (!config.mods.agentRow.enabled) {
    process.exit(0);
}

let payload: unknown;

try {
    payload = SafeJSON.parse(await Bun.stdin.text(), { strict: true });
} catch (err) {
    hookDiag("subagentStatusLine got no JSON", { err });
    process.exit(0);
}

const input = rowInput(payload);

if (!input) {
    process.exit(0);
}

const now = Date.now();
// When each finished agent was first seen finished, since the payload has no end time. Only a session's own rows
// read it, and it matters only while the panel lists the agent, so it lives in the temporary folder.
const endsPath = input.sessionId?.match(/^[\w-]+$/)
    ? join(tmpdir(), "genesis-tools-agent-row", `${input.sessionId}.json`)
    : undefined;
let held: Record<string, number> = {};

if (endsPath && existsSync(endsPath)) {
    try {
        const stored: unknown = SafeJSON.parse(readFileSync(endsPath, "utf8"), { strict: true });

        if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
            held = Object.fromEntries(
                Object.entries(stored).filter((entry): entry is [string, number] => typeof entry[1] === "number")
            );
        }
    } catch (err) {
        hookDiag("Could not read the agent row end times", { err, path: endsPath });
    }
}

const ends = finishedAt(input, held, now);

if (endsPath && SafeJSON.stringify(ends) !== SafeJSON.stringify(held)) {
    try {
        mkdirSync(join(tmpdir(), "genesis-tools-agent-row"), { recursive: true });
        writeJsonFile(endsPath, ends);
    } catch (err) {
        hookDiag("Could not keep the agent row end times", { err, path: endsPath });
    }
}

const rows = agentRows(input, {
    format: config.mods.agentRow.format,
    effort: config.mods.agentRow.effort,
    now,
    ends,
    width: Bun.stringWidth,
});

process.stdout.write(rows.map((row) => `${SafeJSON.stringify(row)}\n`).join(""));
