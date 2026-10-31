/** Codex's `currentModel`: every turn writes a `turn_context` row that names the turn's model. */
import { SafeJSON } from "@genesiscz/utils/json";
import { firstModelInHead, newestModelInTail, type RowModel } from "./session-model";

/** The first `turn_context` follows ~300 KB of instructions and world state. */
export const CODEX_MODEL_HEAD_BYTES = 640 * 1024;

/** The model one Codex rollout row names: a `turn_context` row's `payload.model`. Codex has no side chains. */
export function codexModelOfRow(row: string): RowModel | undefined {
    if (!row.includes('"turn_context"')) {
        return undefined;
    }

    let value: unknown;

    try {
        value = SafeJSON.parse(row, { strict: true });
    } catch {
        // The tail's first row is cut by the window, and a row being written is cut too: neither names a model.
        return undefined;
    }

    if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "turn_context") {
        return undefined;
    }

    const payload = "payload" in value ? value.payload : undefined;
    const model = typeof payload === "object" && payload !== null && "model" in payload ? payload.model : undefined;
    return typeof model === "string" && model ? { model, sidechain: false } : undefined;
}

/**
 * The model a Codex session runs now: the newest `turn_context` in the tail, else (one long turn whose output pushed
 * its `turn_context` out of the tail) the first one in the head.
 */
export function codexCurrentModel(transcriptPath: string): string | null {
    return (
        newestModelInTail(transcriptPath, codexModelOfRow) ??
        firstModelInHead(transcriptPath, codexModelOfRow, CODEX_MODEL_HEAD_BYTES)
    );
}
