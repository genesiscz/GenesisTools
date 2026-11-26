/**
 * The `work_*` MCP tools use one method table. Reads have their own tool each; every other write
 * goes through `work_write { method, params }`, so the tool list stays short.
 */
import { jsonSchemaOf } from "@genesiscz/utils/api-descriptor";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ToolEntry } from "@genesiscz/utils/mcp/tool-entry";
import type { LoadedToolGroup } from "@genesiscz/utils/mcp/tool-group";
import type { Door, Formatter } from "@genesiscz/utils/output/formatter";
import { replyToToolAnswer } from "@genesiscz/utils/output/mcp";
import { type WorkMethodName, workMethods } from "@genesiscz/utils/work/api";
import { callOptionsOf, withoutCallOptions, workCallEnvelope } from "@genesiscz/utils/work/door";
import { workFormatters } from "@genesiscz/utils/work/formatters";
import type { CallOptions } from "@genesiscz/utils/work/handlers";
import { callWorkHere } from "../doors/service";

const OWN_TOOLS = (Object.keys(workMethods) as WorkMethodName[]).filter(
    (name) => workMethods[name].effect === "read" || name === "spot" || name === "reopen"
);
const WRITE_METHODS = (Object.keys(workMethods) as WorkMethodName[]).filter(
    (name) => workMethods[name].effect !== "read" && !(OWN_TOOLS as readonly string[]).includes(name)
);

const ENVELOPE = jsonSchemaOf(workCallEnvelope).properties ?? {};

/** An MCP next action is the tool call that runs it. */
const mcpDoor: Door = {
    commandOf(call) {
        const own = (OWN_TOOLS as readonly string[]).includes(call.method);
        return own
            ? `work_${call.method} ${SafeJSON.stringify(call.params)}`
            : `work_write ${SafeJSON.stringify({ method: call.method, params: call.params })}`;
    },
};

async function answer(
    method: WorkMethodName,
    params: unknown,
    call: CallOptions,
    view: { section?: string; explain?: boolean }
) {
    const reply = await callWorkHere(method, params, call);
    // The door answers unknown data, so the formatter of this method is widened to match.
    const formatter = workFormatters(view)[method] as Formatter<unknown>;
    return replyToToolAnswer(reply, formatter, mcpDoor);
}

function schemaWith(method: WorkMethodName, envelope: boolean): Record<string, unknown> {
    const schema = jsonSchemaOf(workMethods[method].params);
    return envelope ? { ...schema, properties: { ...(schema.properties ?? {}), ...ENVELOPE } } : { ...schema };
}

const READ_ANNOTATIONS: ToolEntry["annotations"] = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE_ANNOTATIONS: ToolEntry["annotations"] = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
};

function ownTool(method: (typeof OWN_TOOLS)[number]): ToolEntry {
    const read = workMethods[method].effect === "read";
    return {
        description: workMethods[method].doc,
        inputSchema: schemaWith(method, !read),
        annotations: read ? READ_ANNOTATIONS : WRITE_ANNOTATIONS,
        handler: async (args) =>
            answer(method, withoutCallOptions(args), callOptionsOf(args), {
                ...(typeof args.section === "string" ? { section: args.section } : {}),
            }),
    };
}

export function toolGroup(): LoadedToolGroup {
    const entries: Record<string, ToolEntry> = {};

    for (const method of OWN_TOOLS) {
        entries[`work_${method}`] = ownTool(method);
    }

    entries.work_write = {
        description: `Every other write of the work store: ${WRITE_METHODS.join(", ")}. params are the method's own (work_list's schema style); a ref is w_…, h_… or <handoff>:<slot>.`,
        inputSchema: {
            type: "object",
            properties: {
                method: { type: "string", enum: WRITE_METHODS },
                params: { type: "object", additionalProperties: true },
                ...ENVELOPE,
            },
            required: ["method", "params"],
        },
        annotations: WRITE_ANNOTATIONS,
        handler: async (args) => {
            const method = String(args.method);
            const target = (WRITE_METHODS as readonly string[]).includes(method) ? (method as WorkMethodName) : null;

            if (target === null) {
                return `work_write: no write method ${method}. Methods: ${WRITE_METHODS.join(", ")}.`;
            }

            return answer(target, args.params ?? {}, callOptionsOf(args), {});
        },
    };

    return { entries };
}
