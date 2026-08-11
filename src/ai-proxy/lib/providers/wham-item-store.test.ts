import { afterEach, describe, expect, it } from "bun:test";
import {
    createWhamItemHarvestTransform,
    rememberWhamOutputItem,
    resetWhamItemStore,
    resolveWhamItemReferences,
    whamItemStoreSize,
} from "@app/ai-proxy/lib/providers/wham-item-store";
import { SafeJSON } from "@genesiscz/utils/json";

afterEach(() => {
    resetWhamItemStore();
});

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
        rememberWhamOutputItem(CALL);

        const { input, unresolved } = resolveWhamItemReferences([
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
        const { input, unresolved, orphanedOutputs } = resolveWhamItemReferences([
            { role: "user", content: "question" },
            { type: "item_reference", id: "fc_unknown" },
            { type: "function_call_output", call_id: "call_orphan", output: "{}" },
        ]);

        expect(unresolved).toEqual(["fc_unknown"]);
        expect(orphanedOutputs).toEqual(["call_orphan"]);
        expect(input).toEqual([{ role: "user", content: "question" }]);
    });

    it("keeps a function_call_output whose call survives even when another reference is unknown", () => {
        rememberWhamOutputItem(CALL);

        const { input, unresolved } = resolveWhamItemReferences([
            { type: "item_reference", id: CALL.id },
            { type: "function_call_output", call_id: "call_abc123", output: "{}" },
            { type: "item_reference", id: "fc_unknown" },
        ]);

        expect(unresolved).toEqual(["fc_unknown"]);
        expect(input).toEqual([CALL, { type: "function_call_output", call_id: "call_abc123", output: "{}" }]);
    });

    it("passes through input with no references untouched", () => {
        const input = [{ role: "user", content: "hi" }];
        expect(resolveWhamItemReferences(input).input).toEqual(input);
    });
});

describe("createWhamItemHarvestTransform", () => {
    async function pump(chunks: string[]): Promise<string> {
        const transform = createWhamItemHarvestTransform();
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
        expect(resolveWhamItemReferences([{ type: "item_reference", id: CALL.id }]).input).toEqual([CALL]);
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
        rememberWhamOutputItem({ type: "message" });
        rememberWhamOutputItem(null);
        rememberWhamOutputItem("nope");

        expect(whamItemStoreSize()).toBe(0);
    });
});
