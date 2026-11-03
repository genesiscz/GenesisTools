import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineApi, defineMethod } from "./descriptor";
import { jsonSchemaOf, methodSignature, renderDocs, renderOneLine, toMcpTools, typeText } from "./render";

const api = defineApi({
    id: "demo",
    global: "demo",
    title: "Demo",
    summary: "A demonstration surface.",
    methods: [
        defineMethod({
            name: "start",
            params: z.object({
                fps: z.number().optional(),
                displays: z.union([z.literal("all"), z.array(z.number())]),
            }),
            result: z.unknown(),
            resultName: "Recording",
            doc: "Starts a recording.",
            effect: "reversible",
        }),
        defineMethod({
            name: "list",
            params: z.object({}),
            result: z.array(z.object({ id: z.string(), state: z.enum(["recording", "paused"]) })),
            doc: "Lists the running recordings.",
            effect: "read",
        }),
        defineMethod({
            name: "wipe",
            params: z.object({ id: z.string() }),
            result: z.void(),
            doc: "Deletes a recording.",
            effect: "destructive",
            positional: ["id"],
        }),
    ],
    handles: [
        {
            name: "Recording",
            summary: "A running recording.",
            methods: [
                defineMethod({
                    name: "stop",
                    params: z.object({ wait: z.boolean().default(true) }),
                    result: z.object({ recordingId: z.string() }),
                    doc: "Stops and waits for post-processing.",
                    effect: "reversible",
                }),
            ],
        },
    ],
    notes: ["Times are seconds."],
});

describe("api descriptors", () => {
    test("a schema is spelled as compact TypeScript", () => {
        expect(typeText(jsonSchemaOf(z.object({ a: z.string(), b: z.number().optional() })) as never)).toBe(
            "{ a: string; b?: number }"
        );
        expect(typeText(jsonSchemaOf(z.array(z.enum(["x", "y"]))) as never)).toBe('Array<"x" | "y">');
        expect(typeText(jsonSchemaOf(z.record(z.string(), z.boolean())) as never)).toBe("Record<string, boolean>");
        expect(typeText(jsonSchemaOf(z.custom<() => void>()) as never)).toBe("unknown");
    });

    test("signatures, the one-line summary and the full docs come from the descriptor", () => {
        expect(methodSignature("demo", api.methods[0])).toBe(
            'demo.start(options: { fps?: number; displays: "all" | number[] }) → Recording'
        );
        expect(methodSignature("demo", api.methods[1])).toBe(
            'demo.list() → Array<{ id: string; state: "recording" | "paused" }>'
        );
        expect(methodSignature("demo", api.methods[2])).toBe("demo.wipe(id: string) → unknown");
        expect(renderOneLine(api)).toBe(
            "demo: A demonstration surface. demo.start({fps, displays}), demo.list(), demo.wipe(id)"
        );
        const docs = renderDocs(api);
        expect(docs).toContain(
            '- demo.start(options: { fps?: number; displays: "all" | number[] }) → Recording [reversible]'
        );
        expect(docs).toContain("  Starts a recording.");
        expect(docs).toContain("Recording: A running recording.");
        expect(docs).toContain("- recording.stop(options?: { wait?: boolean }) → { recordingId: string } [reversible]");
        expect(docs).toContain("Note: Times are seconds.");
    });

    test("MCP tools carry the input schema and the effect as annotations", () => {
        const tools = toMcpTools(api);
        expect(tools.map((tool) => tool.name)).toEqual(["start", "list", "wipe"]);
        expect(tools[0].inputSchema).toMatchObject({ type: "object", required: ["displays"] });
        expect(tools.map((tool) => tool.annotations)).toEqual([
            { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
            { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        ]);
    });

    test("a duplicate method name is refused", () => {
        expect(() => defineApi({ ...api, methods: [api.methods[0], api.methods[0]] })).toThrow("twice");
    });
});
