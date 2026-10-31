import { basename, dirname, join } from "node:path";
import type { NativeSessionReader } from "../types";

export const grokDialog: NativeSessionReader<"grok">["dialog"] = {
    eventLogPath(transcriptPath) {
        return basename(transcriptPath) === "updates.jsonl" ? join(dirname(transcriptPath), "events.jsonl") : null;
    },
    openPermission(records) {
        let pending: Array<{ tool: string; at: string }> = [];
        for (const record of records) {
            if (record.type === "turn_started" || record.type === "turn_ended") {
                pending = [];
                continue;
            }
            const tool = typeof record.tool_name === "string" ? record.tool_name : null;
            if (!tool) {
                continue;
            }
            if (record.type === "permission_requested") {
                pending.push({ tool, at: typeof record.ts === "string" ? record.ts : "" });
            } else if (record.type === "permission_resolved") {
                const index = pending.findIndex((request) => request.tool === tool);
                if (index >= 0) {
                    pending.splice(index, 1);
                }
            }
        }
        return pending.at(-1) ?? null;
    },
};
