import { z } from "zod";
import { decisionBatchUpdateSchema } from "./schema";
import type { DecisionRecord } from "./store";

/**
 * What an update answers by default: enough to confirm what was recorded. The whole row (prompt, options,
 * reasoning, refs, versions) is what the agent itself posted, so echoing it cost about 1,000 tokens per decision
 * and nobody read it. `include` asks for more fields, or `"all"` for the whole row and the events file.
 */
const DEFAULT_FIELDS = [
    "id",
    "number",
    "type",
    "state",
    "option",
    "answeredVia",
    "supersededBy",
    "commitRefs",
    "verdict",
    "revision",
] as const;

export const updateIncludeSchema = z
    .array(z.string().min(1))
    .optional()
    .describe(
        'More fields of each updated row in the reply, e.g. ["prompt", "comments"], or ["all"] for the whole row. ' +
            "By default the reply carries only id, number, type, state, option, answeredVia, supersededBy, " +
            "commitRefs, verdict, revision, and a note when the store changed the requested state."
    );

/** The MCP and CLI input: the store's batch plus `include`, which only shapes the reply. */
export const decisionBatchUpdateRequestSchema = decisionBatchUpdateSchema.extend({ include: updateIncludeSchema });

interface RequestedUpdate {
    id: string;
    state?: string;
}

/** Reads `include` and the requested states from the raw input without validating it: the store does that. */
function readRequest(input: unknown): { include: string[]; requested: RequestedUpdate[] } {
    const record = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const include =
        "include" in record && Array.isArray(record.include)
            ? record.include.filter((field): field is string => typeof field === "string")
            : [];
    const updates = "updates" in record && Array.isArray(record.updates) ? record.updates : [];
    const requested = updates.flatMap((update: unknown) => {
        if (!update || typeof update !== "object" || !("id" in update) || typeof update.id !== "string") {
            return [];
        }

        const state = "state" in update && typeof update.state === "string" ? update.state : undefined;
        return [{ id: update.id, state }];
    });
    return { include, requested };
}

export function updateResult(rows: DecisionRecord[], input: unknown, events: string): Record<string, unknown> {
    const { include, requested } = readRequest(input);

    if (include.includes("all")) {
        return { updated: rows, events };
    }

    const fields = new Set<string>([...DEFAULT_FIELDS, ...include]);
    const updated = rows.map((row) => {
        const entries = Object.entries(row).filter(([key, value]) => fields.has(key) && value !== undefined);
        const compact: Record<string, unknown> = Object.fromEntries(entries);
        const asked = requested.find((update) => update.id === row.id)?.state;

        // The store moved it elsewhere (an agent's answered becomes acknowledged) and said why in a comment.
        if (asked && asked !== row.state && row.comments?.length) {
            compact.note = row.comments.at(-1);
        }

        return compact;
    });
    return { updated };
}
