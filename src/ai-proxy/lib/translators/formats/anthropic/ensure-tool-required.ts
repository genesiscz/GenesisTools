type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Grok's native /v1/messages validator is stricter than Anthropic's: a tool
 * whose `input_schema` omits `required` is rejected with
 * `/required: null is not of type "array"`, while Anthropic permits the
 * omission. Claude Code ships 4 such tools out of 13, so an Anthropic
 * passthrough to Grok must add the empty array. Pure — returns a clone when it
 * changes anything, so the caller's body is never mutated.
 */
export function ensureToolRequiredArrays(body: JsonRecord): JsonRecord {
    if (!Array.isArray(body.tools)) {
        return body;
    }

    const needsFix = body.tools.some((tool) => {
        if (!isJsonRecord(tool)) {
            return false;
        }

        const schema = tool.input_schema;
        return isJsonRecord(schema) && !("required" in schema);
    });

    if (!needsFix) {
        return body;
    }

    const next = structuredClone(body);

    for (const tool of next.tools as unknown[]) {
        if (!isJsonRecord(tool)) {
            continue;
        }

        const schema = tool.input_schema;

        if (isJsonRecord(schema) && !("required" in schema)) {
            schema.required = [];
        }
    }

    return next;
}
