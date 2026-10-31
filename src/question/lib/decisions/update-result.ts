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

/**
 * `include` and the requested states, read without validating: the store validates the batch. A field or an item of
 * the wrong shape is skipped alone, so an odd `include` never costs the reply its notes.
 */
const requestReadSchema = z
    .object({
        include: z.array(z.string().nullable().catch(null)).catch([]),
        updates: z
            .array(
                z
                    .object({ id: z.string(), state: z.string().optional().catch(undefined) })
                    .nullable()
                    .catch(null)
            )
            .catch([]),
    })
    .catch({ include: [], updates: [] });

function readRequest(input: unknown): { include: string[]; requested: { id: string; state?: string }[] } {
    const { include, updates } = requestReadSchema.parse(input);
    return {
        include: include.filter((field) => field !== null),
        requested: updates.filter((update) => update !== null),
    };
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
        // A batch may name one id twice; the stored row is the result of the last one.
        const asked = requested.findLast((update) => update.id === row.id)?.state;

        // The store moved it elsewhere (an agent's answered becomes acknowledged) and said why in a comment.
        if (asked && asked !== row.state && row.comments?.length) {
            compact.note = row.comments.at(-1);
        }

        return compact;
    });
    return { updated };
}
