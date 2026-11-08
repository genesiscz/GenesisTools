import { describe, expect, test } from "bun:test";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { JSON_RPC_ERRORS } from "@genesiscz/utils/rpc/errors";
import { z } from "zod";
import { defineApi, defineMethod, effectLabel } from "./descriptor";
import { assertReach, runInMethodScope, UndeclaredReachError } from "./reach";
import { jsonSchemaOf, methodSignature, renderDocs, toMcpTools, typeText } from "./render";
import { callArguments, handleHandlers, toRpcTable } from "./rpc";

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

    test("a schema with a title is written as that name, so a docs note can define it once", () => {
        const seconds = z.number().nonnegative().meta({ title: "SourceTime" });
        expect(typeText(jsonSchemaOf(z.object({ at: seconds, to: seconds.optional(), n: z.number() })))).toBe(
            "{ at: SourceTime; to?: SourceTime; n: number }"
        );
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

describe("toRpcTable", () => {
    const calls: unknown[] = [];
    const table = toRpcTable(
        api,
        {
            start: (params) => ({ started: params.displays }),
            list: () => [],
            wipe: (params, context: { who: string }) => {
                calls.push([params.id, context.who]);
                return null;
            },
        },
        { prefix: "demo." }
    );

    test("a call is validated by its method's schema and reaches its handler with the context", async () => {
        expect(table.methods).toEqual(["demo.start", "demo.list", "demo.wipe"]);
        expect(await table.call("demo.start", { displays: "all" }, { who: "test" })).toEqual({ started: "all" });
        await table.call("demo.wipe", { id: "r1" }, { who: "cli" });
        expect(calls).toEqual([["r1", "cli"]]);
    });

    test("bad params answer invalidParams with the schema's words, an unknown name methodNotFound", async () => {
        await expect(table.call("demo.start", { displays: 3 }, { who: "test" })).rejects.toMatchObject({
            code: JSON_RPC_ERRORS.invalidParams,
            message: expect.stringContaining("demo.start: displays:"),
        });
        await expect(table.call("demo.stop", {}, { who: "test" })).rejects.toMatchObject({
            code: JSON_RPC_ERRORS.methodNotFound,
        });
    });

    test("handlers are one per method name, and a handle's methods are called the REPL's way", async () => {
        // @ts-expect-error `wipe` has no handler: the descriptor's literal names make the record exhaustive.
        toRpcTable(api, { start: () => null, list: () => null });

        const recording = {
            stop: (options: { wait: boolean }) => ({ recordingId: options.wait ? "waited" : "now" }),
        };
        const handle = { methods: api.handles[0].methods };
        const handles = toRpcTable(
            handle,
            handleHandlers(handle, () => recording),
            { prefix: "recording." }
        );
        expect(await handles.call("recording.stop", {}, undefined)).toEqual({ recordingId: "waited" });
        expect(callArguments(api.methods[2], { id: "r2" })).toEqual(["r2"]);
    });
});

/**
 * NR1 (deep test 2026-11-06): movie.find(), declared read, started a paid transcription and a vault-key dialog. The
 * declaration is now enforced: a described call that reaches the user or spends money without saying so throws
 * before the paid line runs.
 */
describe("declared reaches", () => {
    class ReachToolset extends ReplToolset {
        readonly spent: string[] = [];
        readonly api = defineApi({
            id: "fixture",
            global: "fixture",
            title: "Fixture",
            summary: "Fixture",
            methods: [
                defineMethod({
                    name: "peek",
                    params: z.object({}),
                    result: z.unknown(),
                    doc: "Fixture",
                    effect: "read",
                }),
                defineMethod({
                    name: "transcribe",
                    params: z.object({}),
                    result: z.unknown(),
                    doc: "Fixture",
                    effect: "reversible",
                    reaches: ["paid", "user"],
                }),
            ],
        });

        async bootstrap() {
            // A paid primitive that records when it runs, guarded the way the movies toolset guards tools transcribe.
            const pay = async () => {
                await Bun.sleep(1);
                assertReach("paid", "start a transcription");
                this.spent.push("transcription");
                return "paid";
            };
            return { fixture: { peek: async () => pay(), transcribe: async () => pay() } };
        }
    }
    type Fixture = { fixture: { peek(): Promise<unknown>; transcribe(): Promise<unknown> } };
    const ctx = { scratchDir: "/tmp", show: async () => undefined, write: () => undefined };

    test("a read method that reaches a paid line is refused before the line runs, naming the method", async () => {
        const toolset = new ReachToolset();
        const loaded = (await toolset.load(ctx)) as Fixture;
        const refused = loaded.fixture.peek();
        await expect(refused).rejects.toBeInstanceOf(UndeclaredReachError);
        await expect(refused).rejects.toThrow("fixture.peek is declared [read], so it may not start a transcription");
        expect(toolset.spent).toEqual([]);
    });

    test("the method that declares the reach still reaches it, and a call outside every described method does too", async () => {
        const toolset = new ReachToolset();
        const loaded = (await toolset.load(ctx)) as Fixture;
        expect(await loaded.fixture.transcribe()).toBe("paid");
        expect(toolset.spent).toEqual(["transcription"]);
        expect(() => assertReach("user", "open a dialog")).not.toThrow();
    });

    test("a read method may not declare a reach, and help prints the reaches beside the effect", () => {
        expect(() =>
            defineMethod({
                name: "lie",
                params: z.object({}),
                result: z.unknown(),
                doc: "Fixture",
                effect: "read",
                reaches: ["paid"],
            })
        ).toThrow("a read method reaches no one");
        expect(effectLabel({ effect: "reversible", reaches: ["paid", "user"] })).toBe("reversible · paid · user");
        expect(() =>
            runInMethodScope({ name: "x.y", method: { effect: "reversible", reaches: ["paid"] } }, () =>
                assertReach("user", "post to the inbox")
            )
        ).toThrow("x.y is declared [reversible · paid], so it may not post to the inbox (that reaches: user)");
    });
});
