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
