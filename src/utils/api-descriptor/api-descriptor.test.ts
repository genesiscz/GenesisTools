import { describe, expect, test } from "bun:test";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { z } from "zod";
import { defineApi, defineMethod } from "./descriptor";
import { jsonSchemaOf, methodSignature, renderDocs, toMcpTools, typeText } from "./render";

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
        expect(typeText(jsonSchemaOf(z.object({ a: z.string(), b: z.number().optional() })))).toBe(
            "{ a: string; b?: number }"
        );
        expect(typeText(jsonSchemaOf(z.array(z.enum(["x", "y"]))))).toBe('Array<"x" | "y">');
        expect(typeText(jsonSchemaOf(z.record(z.string(), z.boolean())))).toBe("Record<string, boolean>");
        expect(typeText(jsonSchemaOf(z.custom<() => void>()))).toBe("unknown");
    });

    test("signatures and the full docs come from the descriptor", () => {
        expect(methodSignature("demo", api.methods[0])).toBe(
            'demo.start(options: { fps?: number; displays: "all" | number[] }) → Recording'
        );
        expect(methodSignature("demo", api.methods[1])).toBe(
            'demo.list() → Array<{ id: string; state: "recording" | "paused" }>'
        );
        expect(methodSignature("demo", api.methods[2])).toBe("demo.wipe(id: string) → unknown");
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

test("REPL validation preserves an AbortSignal without changing the descriptor schema", async () => {
    class SignalToolset extends ReplToolset {
        readonly api = defineApi({
            id: "fixture",
            global: "fixture",
            title: "Fixture",
            summary: "Fixture",
            methods: [
                defineMethod({
                    name: "call",
                    params: z.object({ word: z.string() }).strict(),
                    result: z.boolean(),
                    doc: "Fixture",
                    effect: "read",
                }),
            ],
        });
        async bootstrap() {
            return {
                fixture: {
                    call: (options: { word: string; signal?: AbortSignal }) => options.signal?.aborted === true,
                },
            };
        }
    }
    type Fixture = { fixture: { call(options: { word: string; signal?: AbortSignal }): boolean } };
    const toolset = new SignalToolset();
    const loaded = (await toolset.load({
        scratchDir: "/tmp",
        show: async () => undefined,
        write: () => undefined,
    })) as Fixture;
    const controller = new AbortController();
    controller.abort();
    expect(loaded.fixture.call({ word: "hello", signal: controller.signal })).toBe(true);
    expect(() => Reflect.apply(loaded.fixture.call, null, [{ word: 1, signal: controller.signal }])).toThrow();
    expect(jsonSchemaOf(toolset.api.methods[0]!.params).properties).not.toHaveProperty("signal");
});
