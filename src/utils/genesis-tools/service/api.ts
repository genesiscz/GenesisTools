import { defineApi, type MethodDescriptor } from "@genesiscz/utils/api-descriptor";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import { requestViewSchema } from "@genesiscz/utils/genesis-tools/areas/person/journal";
import {
    noticeInputSchema,
    requestOutcomeSchema,
    requestSchema,
} from "@genesiscz/utils/genesis-tools/areas/person/request";
import { z } from "zod";

export const skippedWaySchema = z.object({
    way: z.string(),
    code: z.string(),
    reason: z.string(),
    fix: z.object({ command: z.string(), sentence: z.string() }).nullable(),
});
export function actionOutcomeSchema(result: z.ZodType): z.ZodType {
    return z.union([
        z.object({ status: z.literal("ran"), via: z.string(), value: result, skipped: z.array(skippedWaySchema) }),
        z.object({
            status: z.literal("unreachable"),
            skipped: z.array(skippedWaySchema),
            manual: z.string().nullable(),
        }),
    ]);
}
export const stateValueSchema = z.object({
    value: z.unknown(),
    at: z.string().datetime(),
    source: z.enum(["build", "app", "probe"]),
    build: z.string().optional(),
    stale: z.boolean().optional(),
});
export const explainSchema = z.object({
    id: z.string(),
    summary: z.string(),
    ways: z.array(
        z.object({
            way: z.string(),
            needsKnown: z.boolean(),
            needs: z.array(
                z.object({
                    need: z.string(),
                    ok: z.boolean(),
                    code: z.string().optional(),
                    reason: z.string().optional(),
                    fix: z.object({ command: z.string(), sentence: z.string() }).nullable().optional(),
                    from: z.enum(["state", "probe"]),
                })
            ),
        })
    ),
    first: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
});

const actionMethods: MethodDescriptor[] = Object.entries(AREAS).flatMap(([area, definition]) =>
    Object.entries(definition.actions).map(([name, action]) => ({
        name: `${area}.${name}`,
        params: action.args,
        result: actionOutcomeSchema(action.result),
        doc: action.summary,
        effect: "reversible" as const,
        reaches: ["user"] as const,
    }))
);
export const serviceMethods = [
    {
        name: "hello",
        params: z.object({
            methods: z.array(z.enum(["request.present"])).default([]),
            caller: z.enum(["person", "agent", "face"]).default("person"),
        }),
        result: z.object({ protocol: z.literal(1), methods: z.array(z.string()) }),
        doc: "Register the methods this face serves",
        effect: "read",
    },
    {
        name: "actions.explain",
        params: z.object({ id: z.string(), fresh: z.boolean().default(false), args: z.unknown().optional() }),
        result: explainSchema,
        doc: "Explain an action without running it",
        effect: "read",
    },
    {
        name: "config.get",
        params: z.object({ path: z.string() }),
        result: z.unknown(),
        doc: "Read resolved config",
        effect: "read",
    },
    {
        name: "config.set",
        params: z.object({ path: z.string(), value: z.unknown() }),
        result: z.object({ changed: z.literal(true) }),
        doc: "Store one validated config value",
        effect: "reversible",
    },
    {
        name: "config.unset",
        params: z.object({ path: z.string() }),
        result: z.object({ changed: z.literal(true) }),
        doc: "Remove a config override",
        effect: "reversible",
    },
    {
        name: "state.report",
        params: z.object({ area: z.string(), key: z.string(), value: stateValueSchema }),
        result: z.object({ reported: z.literal(true) }),
        doc: "Report a measured fact",
        effect: "reversible",
    },
    {
        name: "requests.post",
        params: z.object({
            input: noticeInputSchema,
            timeoutMs: z.number().int().min(1).max(600_000).default(120_000),
        }),
        result: requestViewSchema,
        doc: "Append a notice request",
        effect: "reversible",
    },
    {
        name: "requests.get",
        params: z.object({ id: z.string() }),
        result: requestViewSchema.nullable(),
        doc: "Read one request",
        effect: "read",
    },
    {
        name: "requests.list",
        params: z.object({ limit: z.number().int().min(1).max(1000).default(100) }),
        result: z.array(requestViewSchema),
        doc: "Read recent requests",
        effect: "read",
    },
    {
        name: "requests.present",
        params: z.object({ id: z.string(), takesFocus: z.boolean().optional() }),
        result: requestOutcomeSchema,
        doc: "Show a waiting request to the person and record their answer once",
        effect: "reversible",
        reaches: ["user"] as const,
    },
    {
        name: "requests.withdraw",
        params: z.object({ id: z.string() }),
        result: requestOutcomeSchema,
        doc: "Withdraw an unanswered request",
        effect: "reversible",
    },
] as const satisfies readonly MethodDescriptor[];
export const genesisToolsApi = defineApi({
    id: "genesis-tools",
    global: "gt",
    title: "GenesisTools actions",
    summary: "Actions, requests, config and state",
    methods: [...actionMethods, ...serviceMethods],
});
export const requestPresentApi = defineApi({
    id: "genesis-tools-face",
    global: "face",
    title: "Request face",
    summary: "The service calls a connected face",
    methods: [
        {
            name: "request.present",
            params: requestSchema,
            result: requestOutcomeSchema,
            doc: "Show a notice and return the person's answer",
            effect: "reversible",
        },
    ],
});
export const serviceEvents = {
    ...Object.fromEntries(
        Object.entries(AREAS).flatMap(([area, definition]) =>
            Object.entries("events" in definition ? (definition.events ?? {}) : {}).map(([name, schema]) => [
                `${area}.${name}`,
                z.object({ payload: schema, at: z.string().datetime() }),
            ])
        )
    ),
    "request.changed": requestViewSchema,
    "config.changed": z.object({ path: z.string(), value: z.unknown().optional() }),
    "state.changed": z.object({ area: z.string(), key: z.string(), value: stateValueSchema.nullable() }),
};
