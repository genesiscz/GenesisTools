import type { ChangeEvent } from "@app/agents/lib/changes/log";
import { asResult } from "@genesiscz/utils/cli/result";
import { parseArgv, stringFlag } from "../argv";
import { type CallDoor, failed, ok } from "./types";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `tools agents changes <session> --tools <ids> --json`: the hub asks it for each finished tool row of the session it
 * shows. As a process every ask read the whole session (223 MB main + 366 MB of sub-agents, ~1.5 s CPU and ~1 GB,
 * 2026-10-08); here the transcript folds (`readClaudeTranscriptFolded`) read only what the files gained.
 *
 * Read-only, like every door: `--store-blobs` (which writes the object store) runs as a process. The answer carries
 * each file's diff all the same; the hub stores a call's blobs only when "more context" needs them.
 * Only a full session id: a prefix is completed from the history index with a note on stderr, which the process does.
 */
export const agentsToolChangesDoor: CallDoor<{ session: string; toolIds: string[] }> = {
    kind: "call",
    name: "agents changes --tools --json",
    command: ["agents", "changes"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["agents", "changes"],
            positionals: 1,
            flags: { "--tools": "value", "--json": "bool" },
        });
        const session = parsed?.positionals[0];
        const tools = parsed ? stringFlag(parsed, "--tools") : undefined;
        if (!parsed || parsed.flags.get("--json") !== true || !session || !SESSION_ID.test(session) || !tools) {
            return null;
        }

        const toolIds = [...new Set(tools.split(",").map((id) => id.trim()))].filter(Boolean);
        if (toolIds.length === 0) {
            return null;
        }

        return { session, toolIds };
    },
    async run({ session, toolIds }, { signal }) {
        try {
            signal.throwIfAborted();
            const { readJsonlRows } = await import("@genesiscz/utils/jsonl");
            const { sessionChangesPath } = await import("@app/agents/lib/changes/log");
            const { toolChangesJson } = await import("@app/agents/lib/changes/tool-changes");
            const file = sessionChangesPath(session);
            const read = readJsonlRows<ChangeEvent>(file);
            const warning = read.skipped > 0 ? `Skipped ${read.skipped} unreadable line(s) in ${file}\n` : "";
            const outcome = await toolChangesJson({ session, toolIds, file, rows: read.rows, storeBlobs: false });
            if ("error" in outcome) {
                return { stdout: "", stderr: `${warning}${outcome.error}\n`, exit: 1 };
            }

            return { ...ok(asResult(outcome.result)), stderr: warning };
        } catch (error) {
            return failed(error);
        }
    },
};

/**
 * `tools agents changes <session> --last-turns <n> --json [--store-blobs]`: the Changes pane's ask, repeated on
 * every refresh of a live session. As a process each ask parsed the whole transcript again (309 MB for one
 * session: 2.4 to 7.8 s, 3 s of CPU and 650 MB, every 40 s on 2026-10-30); here the fold reads only what the
 * files gained. `--store-blobs` is honoured: the pane reads the before-states from the object store by oid, and a
 * loose object is content-addressed, so the write is idempotent and a process writing the same oid is no conflict.
 */
export const agentsTurnChangesDoor: CallDoor<{ session: string; lastTurns: number; storeBlobs: boolean }> = {
    kind: "call",
    name: "agents changes --last-turns --json",
    command: ["agents", "changes"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["agents", "changes"],
            positionals: 1,
            flags: { "--last-turns": "value", "--json": "bool", "--store-blobs": "bool" },
        });
        const session = parsed?.positionals[0];
        const lastTurns = parsed ? Number(stringFlag(parsed, "--last-turns")) : Number.NaN;
        if (
            !parsed ||
            parsed.flags.get("--json") !== true ||
            !session ||
            !SESSION_ID.test(session) ||
            !Number.isInteger(lastTurns) ||
            lastTurns < 1
        ) {
            return null;
        }

        return { session, lastTurns, storeBlobs: parsed.flags.get("--store-blobs") === true };
    },
    async run({ session, lastTurns, storeBlobs }, { signal }) {
        try {
            signal.throwIfAborted();
            const { readJsonlRows } = await import("@genesiscz/utils/jsonl");
            const { sessionChangesPath } = await import("@app/agents/lib/changes/log");
            const { sessionTurnChanges, turnChangesJson } = await import("@app/agents/lib/changes/tool-changes");
            const file = sessionChangesPath(session);
            const read = readJsonlRows<ChangeEvent>(file);
            const warning = read.skipped > 0 ? `Skipped ${read.skipped} unreadable line(s) in ${file}\n` : "";
            const options = { json: true, lastTurns: String(lastTurns), storeBlobs };
            const result = await sessionTurnChanges({ session, file, rows: read.rows, options, count: lastTurns });
            if ("error" in result) {
                return { stdout: "", stderr: `${warning}${result.error}\n`, exit: 1 };
            }

            return { ...ok(asResult(turnChangesJson(session, file, options, result))), stderr: warning };
        } catch (error) {
            return failed(error);
        }
    },
};
