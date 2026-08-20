import { SafeJSON } from "@genesiscz/utils/json";

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The property injected into otherwise-empty tool schemas. Namespaced so it
 * cannot collide with a real parameter, and only ever trusted when its value
 * names a tool this module actually tagged.
 */
export const TOOL_ROUTING_TAG = "__tool_route";

/**
 * A tool that can legally be called with `{}` — no required parameters. Two of
 * them in one request produce byte-identical argument objects, which is the one
 * case the merged-stream splitter cannot resolve.
 */
function callableWithEmptyArgs(tool: JsonRecord): boolean {
    if (typeof tool.name !== "string" || !isJsonRecord(tool.input_schema)) {
        return false;
    }

    const required = tool.input_schema.required;

    return !Array.isArray(required) || required.length === 0;
}

/**
 * Grok's STREAMING /messages merges parallel tool calls into one block and
 * keeps only the first call's name (raw wire capture, 2026-08-21: one
 * `content_block_start` naming `run_command`, then four complete argument
 * objects as separate `input_json_delta` frames). The splitter recovers a name
 * by matching argument keys against the request's schemas, which works for
 * every call that carries arguments and fails for `{}` — it matches every
 * no-argument tool equally.
 *
 * So make those calls distinguishable at the source: give each no-argument tool
 * one required property whose only legal value is its own name. The model fills
 * it, the merged stream carries it, the splitter reads the name straight off
 * the object, and {@link stripRoutingTag} removes it before the client sees the
 * call. Streaming is untouched.
 *
 * Applied only when two or more such tools are offered — one is already
 * unambiguous — and only to those tools, so every other schema goes up verbatim.
 * Mutates `body.tools` in place and returns the names it tagged.
 */
export function tagAmbiguousNoArgTools(body: JsonRecord): Set<string> {
    const tagged = new Set<string>();

    if (!Array.isArray(body.tools)) {
        return tagged;
    }

    const candidates = body.tools.filter(
        (tool): tool is JsonRecord => isJsonRecord(tool) && callableWithEmptyArgs(tool)
    );

    if (candidates.length < 2) {
        return tagged;
    }

    for (const tool of candidates) {
        const name = tool.name as string;
        const schema = tool.input_schema as JsonRecord;
        const properties = isJsonRecord(schema.properties) ? { ...schema.properties } : {};
        const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : [];

        properties[TOOL_ROUTING_TAG] = {
            type: "string",
            enum: [name],
            description: `Routing tag required by this endpoint. Always exactly "${name}".`,
        };
        tool.input_schema = { ...schema, properties, required: [...required, TOOL_ROUTING_TAG] };
        tagged.add(name);
    }

    return tagged;
}

/**
 * The tool named by an argument object's routing tag, when it names one this
 * request actually tagged. Anything else returns undefined so a coincidental
 * property of the same name can never redirect a call.
 */
export function routedToolName(args: JsonRecord, tagged: Set<string>): string | undefined {
    const value = args[TOOL_ROUTING_TAG];

    return typeof value === "string" && tagged.has(value) ? value : undefined;
}

/**
 * Remove the routing tag from a serialized argument object. The client asked
 * for its own schema and must never see the property this proxy added. Text
 * that does not parse is returned untouched, so a malformed call still fails
 * loudly on its own terms instead of being rewritten.
 */
export function stripRoutingTag(argsText: string): string {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(argsText, { strict: true });
    } catch {
        return argsText;
    }

    if (!isJsonRecord(parsed) || !(TOOL_ROUTING_TAG in parsed)) {
        return argsText;
    }

    delete parsed[TOOL_ROUTING_TAG];
    return SafeJSON.stringify(parsed);
}
