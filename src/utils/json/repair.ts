/**
 * Best-effort repair of broken (typically LLM-emitted) JSON.
 *
 * Wraps `jsonrepair` (josdejong, ISC) — chosen per the research note
 * GenesisBrain/Dev/Json/JsonRepair.research.md (2026-07-24): broadest fix
 * coverage (quotes, commas, brackets, truncation, markdown fences, NDJSON) and
 * the de-facto standard wrapper in LLM tooling. Returns the repaired value
 * only — no fix metadata by design.
 */

import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { jsonrepair } from "jsonrepair";

export interface RepairResult {
    value?: unknown;
    /** Set when even repair could not produce parseable JSON. */
    error?: string;
    /** True when the text only parsed after repair (false = parsed strictly). */
    repaired: boolean;
}

/**
 * Payloads are logged so a repair can be reconstructed after the fact, but a model
 * reply can be tens of KB — enough to bloat the day-stamped log and to carry more
 * of the prompt's content than a debug line needs. The head is where the breakage
 * that matters is, so keep that and mark the cut.
 */
const MAX_LOGGED_PAYLOAD_CHARS = 4_000;

function trimForLog(payload: string): string {
    return payload.length > MAX_LOGGED_PAYLOAD_CHARS
        ? `${payload.slice(0, MAX_LOGGED_PAYLOAD_CHARS)}… [${payload.length} chars total]`
        : payload;
}

/** Strip markdown code fences and leading/trailing prose around the outermost JSON value. */
export function stripToJson(text: string): string {
    let raw = (text ?? "").trim();
    if (raw.startsWith("```")) {
        raw = raw
            .replace(/^```[a-zA-Z]*\n?/, "")
            .replace(/```\s*$/, "")
            .trim();
    }

    const starts = [raw.indexOf("{"), raw.indexOf("[")].filter((i) => i !== -1);
    if (!starts.length) {
        return raw;
    }

    const start = Math.min(...starts);
    const close = raw[start] === "{" ? "}" : "]";
    const end = raw.lastIndexOf(close);
    return end > start ? raw.slice(start, end + 1) : raw.slice(start);
}

/** Parse strictly; on failure strip fences/prose and run jsonrepair. */
export function repairJson(text: string): RepairResult {
    if (!/[{[]/.test(text ?? "")) {
        return { error: "no JSON object/array found in reply", repaired: false };
    }

    const cleaned = stripToJson(text);

    try {
        return { value: SafeJSON.parse(cleaned, { strict: true }), repaired: false };
    } catch {
        // fall through to repair
    }

    try {
        const repaired = jsonrepair(cleaned);
        const value = SafeJSON.parse(repaired, { strict: true });
        logger.debug(
            { before: trimForLog(text), after: trimForLog(repaired) },
            "jsonrepair recovered a broken payload"
        );
        return { value, repaired: true };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.debug({ before: trimForLog(text), error }, "jsonrepair could not recover payload");
        return { error, repaired: true };
    }
}
