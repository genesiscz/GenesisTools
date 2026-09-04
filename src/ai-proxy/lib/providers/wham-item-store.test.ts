import { afterEach, describe, expect, it } from "bun:test";
import {
    createWhamItemHarvestTransform,
    harvestResponsesOutput,
    inlineResponsesItemReferences,
    inlineResponsesItemReferencesInBodyText,
    rememberWhamOutputItem,
    resetWhamItemStore,
    resolveWhamItemReferences,
    whamItemScope,
    whamItemStoreSize,
} from "@app/ai-proxy/lib/providers/wham-item-store";
import { SafeJSON } from "@genesiscz/utils/json";

afterEach(() => {
    resetWhamItemStore();
});

/** One client's store partition. Fixture keys, never a real proxy key. */
const A = whamItemScope(new Request("http://proxy.local/v1/responses", { headers: { Authorization: "Bearer key-a" } }));
const B = whamItemScope(new Request("http://proxy.local/v1/responses", { headers: { Authorization: "Bearer key-b" } }));

const CALL = {
    id: "fc_0ba86f528823c54f016a7b404cdaf48191824f4b8eea22c2ce",
    type: "function_call",
    status: "completed",
    call_id: "call_abc123",
    name: "query_sentry",
    arguments: '{"q":"errors"}',
};

describe("resolveWhamItemReferences", () => {
    it("inlines a remembered item in place of its reference (the sentry-mcp turn-2 shape)", () => {
        rememberWhamOutputItem(A, CALL);

        const { input, unresolved } = resolveWhamItemReferences(A, [
            { role: "system", content: "sys" },
            { role: "user", content: "question" },
            { type: "item_reference", id: CALL.id },
            { type: "function_call_output", call_id: "call_abc123", output: "{}" },
        ]);

        expect(unresolved).toEqual([]);
        expect(input[2]).toEqual(CALL);
        expect(input).toHaveLength(4);
    });

    it("drops an unknown reference AND its orphaned function_call_output", () => {
        const { input, unresolved, orphanedOutputs } = resolveWhamItemReferences(A, [
            { role: "user", content: "question" },
            { type: "item_reference", id: "fc_unknown" },
            { type: "function_call_output", call_id: "call_orphan", output: "{}" },
        ]);

        expect(unresolved).toEqual(["fc_unknown"]);
        expect(orphanedOutputs).toEqual(["call_orphan"]);
        expect(input).toEqual([{ role: "user", content: "question" }]);
    });

    it("keeps a function_call_output whose call survives even when another reference is unknown", () => {
        rememberWhamOutputItem(A, CALL);

        const { input, unresolved } = resolveWhamItemReferences(A, [
            { type: "item_reference", id: CALL.id },
            { type: "function_call_output", call_id: "call_abc123", output: "{}" },
            { type: "item_reference", id: "fc_unknown" },
        ]);

        expect(unresolved).toEqual(["fc_unknown"]);
        expect(input).toEqual([CALL, { type: "function_call_output", call_id: "call_abc123", output: "{}" }]);
    });

    it("passes through input with no references untouched", () => {
        const input = [{ role: "user", content: "hi" }];
        expect(resolveWhamItemReferences(A, input).input).toEqual(input);
    });
});

describe("createWhamItemHarvestTransform", () => {
    async function pump(chunks: string[]): Promise<string> {
        const transform = createWhamItemHarvestTransform(A);
        const writer = transform.writable.getWriter();
        const encoder = new TextEncoder();
        const readDone = new Response(transform.readable).text();

        for (const chunk of chunks) {
            await writer.write(encoder.encode(chunk));
        }

        await writer.close();
        return readDone;
    }

    it("passes bytes through unchanged and harvests output_item.done items", async () => {
        const sse =
            `data: {"type":"response.output_item.done","item":${SafeJSON.stringify(CALL)}}\n\n` +
            `data: {"type":"response.completed","response":{}}\n\n` +
            "data: [DONE]\n\n";

        const out = await pump([sse]);

        expect(out).toBe(sse);
        expect(whamItemStoreSize()).toBe(1);
        expect(resolveWhamItemReferences(A, [{ type: "item_reference", id: CALL.id }]).input).toEqual([CALL]);
    });

    it("handles an event split across chunk boundaries", async () => {
        const line = `data: {"type":"response.output_item.done","item":${SafeJSON.stringify(CALL)}}\n\n`;
        const mid = Math.floor(line.length / 2);

        const out = await pump([line.slice(0, mid), line.slice(mid)]);

        expect(out).toBe(line);
        expect(whamItemStoreSize()).toBe(1);
    });

    it("ignores malformed data lines without breaking the stream", async () => {
        const sse = "data: {broken json response.output_item.done\n\ndata: [DONE]\n\n";
        const out = await pump([sse]);

        expect(out).toBe(sse);
        expect(whamItemStoreSize()).toBe(0);
    });
});

describe("rememberWhamOutputItem", () => {
    it("ignores items without a string id", () => {
        rememberWhamOutputItem(A, { type: "message" });
        rememberWhamOutputItem(A, null);
        rememberWhamOutputItem(A, "nope");

        expect(whamItemStoreSize()).toBe(0);
    });
});

const REASONING = {
    id: "rs_69c5c2d7-1104-95fd-ba05-cb5b4fff66ab",
    type: "reasoning",
    summary: [],
    encrypted_content: "opaque",
};

describe("inlineResponsesItemReferences", () => {
    it("replaces every reference with the remembered item and keeps the rest in order (the xAI turn-2 shape)", () => {
        rememberWhamOutputItem(A, REASONING);
        rememberWhamOutputItem(A, CALL);

        const body = inlineResponsesItemReferences<Record<string, unknown>>(A, {
            model: "grok-4.6",
            input: [
                { role: "user", content: "question" },
                { type: "item_reference", id: REASONING.id },
                { type: "item_reference", id: CALL.id },
                { type: "function_call_output", call_id: CALL.call_id, output: "{}" },
            ],
        });

        const expected: unknown[] = [
            { role: "user", content: "question" },
            REASONING,
            CALL,
            { type: "function_call_output", call_id: CALL.call_id, output: "{}" },
        ];
        expect(body.model).toBe("grok-4.6");
        expect(body.input).toEqual(expected);
    });

    it("leaves a body without an input array untouched", () => {
        const body = { model: "grok-4.6", messages: [{ role: "user", content: "hi" }] };

        expect(inlineResponsesItemReferences(A, body)).toBe(body);
    });

    it("works on body text and returns non-JSON text verbatim", () => {
        rememberWhamOutputItem(A, CALL);

        const text = SafeJSON.stringify({ input: [{ type: "item_reference", id: CALL.id }] });
        const parsed = SafeJSON.parse(inlineResponsesItemReferencesInBodyText(A, text), { strict: true }) as {
            input: unknown[];
        };
        expect(parsed.input).toEqual([CALL]);

        expect(inlineResponsesItemReferencesInBodyText(A, "not json")).toBe("not json");
    });
});

describe("harvestResponsesOutput", () => {
    it("remembers every output item of a JSON envelope and returns the text verbatim", async () => {
        const envelope = SafeJSON.stringify({ id: "resp_1", object: "response", output: [REASONING, CALL] });
        const body = await harvestResponsesOutput(
            A,
            new Response(envelope, { status: 200, headers: { "content-type": "application/json" } })
        );

        expect(body).toBe(envelope);
        expect(whamItemStoreSize()).toBe(2);
        expect(resolveWhamItemReferences(A, [{ type: "item_reference", id: REASONING.id }]).input).toEqual([REASONING]);
    });

    it("harvests an SSE stream without altering its bytes", async () => {
        const sse = `data: {"type":"response.output_item.done","item":${SafeJSON.stringify(CALL)}}\n\ndata: [DONE]\n\n`;
        const body = await harvestResponsesOutput(
            A,
            new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
        );

        expect(body).toBeInstanceOf(ReadableStream);
        expect(await new Response(body).text()).toBe(sse);
        expect(whamItemStoreSize()).toBe(1);
    });

    it("passes an error reply through untouched and remembers nothing", async () => {
        const upstream = new Response(SafeJSON.stringify({ output: [CALL] }), { status: 422 });
        const body = await harvestResponsesOutput(A, upstream);

        expect(await new Response(body).text()).toContain(CALL.id);
        expect(whamItemStoreSize()).toBe(0);
    });
});

describe("per-client scoping", () => {
    it("one client cannot resolve another client's item by id", () => {
        // The proxy fronts several separately billed clients. Looked up by id
        // alone, client B got A's tool name and full arguments inlined into its
        // own upstream request just by sending an id it had seen or guessed.
        rememberWhamOutputItem(A, CALL);

        const mine = resolveWhamItemReferences(A, [{ type: "item_reference", id: CALL.id }]);
        const theirs = resolveWhamItemReferences(B, [{ type: "item_reference", id: CALL.id }]);

        expect(mine.input).toEqual([CALL]);
        expect(theirs.input).toEqual([]);
        expect(theirs.unresolved).toEqual([CALL.id]);
    });

    it("the same id stored by two clients keeps two separate records", () => {
        rememberWhamOutputItem(A, CALL);
        rememberWhamOutputItem(B, { ...CALL, name: "b_tool", arguments: '{"q":"b"}' });

        expect(whamItemStoreSize()).toBe(2);
        expect(resolveWhamItemReferences(A, [{ type: "item_reference", id: CALL.id }]).input).toEqual([CALL]);
        expect(
            (resolveWhamItemReferences(B, [{ type: "item_reference", id: CALL.id }]).input[0] as { name: string }).name
        ).toBe("b_tool");
    });

    it("a request with no Authorization gets its own partition, not everyone's", () => {
        const anonymous = whamItemScope(new Request("http://proxy.local/v1/responses"));

        rememberWhamOutputItem(A, CALL);

        expect(anonymous).not.toBe(A);
        expect(resolveWhamItemReferences(anonymous, [{ type: "item_reference", id: CALL.id }]).input).toEqual([]);
    });

    it("the scope never carries the presented key", () => {
        expect(A).not.toContain("key-a");
        expect(A).toMatch(/^[0-9a-f]{32}$/);
        expect(A).not.toBe(B);
    });
});
