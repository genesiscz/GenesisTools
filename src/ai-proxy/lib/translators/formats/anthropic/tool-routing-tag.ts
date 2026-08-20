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

interface SchemaShape {
    tool: JsonRecord;
    name: string;
    required: string[];
    properties: string[];
}

function schemaShape(tool: unknown): SchemaShape | undefined {
    if (!isJsonRecord(tool) || typeof tool.name !== "string" || !isJsonRecord(tool.input_schema)) {
        return undefined;
    }

    const schema = tool.input_schema;

    return {
        tool,
        name: tool.name,
        required: Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : [],
        properties: isJsonRecord(schema.properties) ? Object.keys(schema.properties) : [],
    };
}

/**
 * Whether one argument object can legally belong to BOTH tools. An object with
 * key set K fits a tool when required ⊆ K ⊆ properties, so a shared object
 * exists exactly when `A.required ∪ B.required ⊆ A.properties ∩ B.properties`.
 * Two no-argument tools are the degenerate case (∅ ⊆ ∅); Glob and Grep are the
 * live one — both accept `{pattern, path}`, so `{"pattern":"*.ts"}` fits either.
 */
function confusable(a: SchemaShape, b: SchemaShape): boolean {
    const shared = new Set(a.properties.filter((key) => b.properties.includes(key)));

    return [...a.required, ...b.required].every((key) => shared.has(key));
}

/**
 * Grok's STREAMING /messages merges parallel tool calls into one block and
 * keeps only the first call's name (raw wire capture, 2026-08-21: one
 * `content_block_start` naming `run_command`, then four complete argument
 * objects as separate `input_json_delta` frames). The splitter recovers a name
 * by matching argument keys against the request's schemas, which only works
 * when exactly one tool fits — and fails for every pair of tools that can share
 * an argument object: two no-argument tools (`{}` fits both), or overlapping
 * schemas like Glob and Grep (`{"pattern":…}` fits both).
 *
 * So make exactly those calls distinguishable at the source: every tool in some
 * {@link confusable} pair gets one required property whose only legal value is
 * its own name. The model fills it, the merged stream carries it, the splitter
 * reads the name straight off the object, and {@link stripRoutingTag} removes
 * it before the client sees the call. Streaming is untouched, and tools no
 * other tool can imitate go up verbatim.
 *
 * With the tag in place every schema-conforming argument object is uniquely
 * attributable: an untagged tool's object fits no other tool (else the pair
 * would be confusable and both tagged), and a tagged tool's object names itself.
 * Mutates `body.tools` in place and returns the names it tagged.
 */
export function tagConfusableTools(body: JsonRecord): Set<string> {
    const tagged = new Set<string>();

    if (!Array.isArray(body.tools)) {
        return tagged;
    }

    const shapes = body.tools.map(schemaShape).filter((shape): shape is SchemaShape => shape !== undefined);

    for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
            if (confusable(shapes[i], shapes[j])) {
                tagged.add(shapes[i].name);
                tagged.add(shapes[j].name);
            }
        }
    }

    for (const shape of shapes) {
        if (!tagged.has(shape.name)) {
            continue;
        }

        const schema = shape.tool.input_schema as JsonRecord;
        const properties = isJsonRecord(schema.properties) ? { ...schema.properties } : {};

        properties[TOOL_ROUTING_TAG] = {
            type: "string",
            enum: [shape.name],
            description: `Routing tag required by this endpoint. Always exactly "${shape.name}".`,
        };
        shape.tool.input_schema = { ...schema, properties, required: [...shape.required, TOOL_ROUTING_TAG] };
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
