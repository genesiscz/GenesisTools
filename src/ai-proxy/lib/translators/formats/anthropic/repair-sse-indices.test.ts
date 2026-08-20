import { describe, expect, it } from "bun:test";
import { repairAnthropicSseIndices } from "@app/ai-proxy/lib/translators/formats/anthropic/repair-sse-indices";
import { TOOL_ROUTING_TAG } from "@app/ai-proxy/lib/translators/formats/anthropic/tool-routing-tag";
import { SafeJSON } from "@genesiscz/utils/json";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();

    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }

            controller.close();
        },
    });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    return await new Response(stream).text();
}

describe("repairAnthropicSseIndices", () => {
    it("renumbers grok's duplicate block indices and stamps deltas", async () => {
        // Verbatim shape observed live from grok's /v1/messages: both blocks at
        // index 0, deltas with no index at all.
        const input = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"4"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input)));
        const frames = out
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => SafeJSON.parse(line.slice("data: ".length), { strict: true }) as Record<string, unknown>);

        expect(frames.map((frame) => [frame.type, frame.index])).toEqual([
            ["content_block_start", 0],
            ["content_block_delta", 0],
            ["content_block_stop", 0],
            ["content_block_start", 1],
            ["content_block_delta", 1],
            ["content_block_stop", 1],
        ]);
    });

    it("passes non-block frames and event lines through verbatim", async () => {
        const input = [
            "event: message_start\n",
            'data: {"type":"message_start","message":{"id":"m1"}}\n\n',
            ": keepalive\n",
            "data: [DONE]\n\n",
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input)));

        expect(out).toContain('data: {"type":"message_start","message":{"id":"m1"}}');
        expect(out).toContain(": keepalive");
        expect(out).toContain("data: [DONE]");
    });

    it("does not lose a final frame that ends without a trailing newline", async () => {
        const input = ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"tail"}}'];

        const out = await collect(repairAnthropicSseIndices(sseStream(input)));

        expect(out).toContain('"text":"tail"');
        expect(out).toContain('"index":0');
        // Terminated: an unterminated final frame is never dispatched by a
        // conformant SSE parser.
        expect(out.endsWith("\n\n")).toBe(true);
    });

    it("preserves the indices of a spec-compliant interleaved stream", async () => {
        // Two blocks open at once, deltas alternating — the shape the Anthropic
        // spec allows. The repairer must be an identity rewrite here, not stamp
        // every delta with the last-started block's index.
        const input = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t0","name":"Bash","input":{}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}\n\n',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input)));
        const frames = out
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => SafeJSON.parse(line.slice("data: ".length), { strict: true }) as Record<string, unknown>);

        expect(frames.map((frame) => [frame.type, frame.index])).toEqual([
            ["content_block_start", 0],
            ["content_block_start", 1],
            ["content_block_delta", 0],
            ["content_block_delta", 1],
            ["content_block_stop", 0],
            ["content_block_stop", 1],
        ]);
    });

    it("emits buffered merged calls when the stream ends without content_block_stop", async () => {
        const input = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"a\\"}{\\"command\\":\\"b\\"}"}}\n\n',
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input)));

        // The second call's bytes must reach the client, not die in the buffer.
        expect(out).toContain('{\\"command\\":\\"b\\"}');
        expect(out).toContain('"type":"content_block_start","index":1');
        expect(out.endsWith("\n\n")).toBe(true);
    });

    it("hands ALL held bytes back when the overflow is not a second call", async () => {
        const input = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1} {\\"b\\":2} zz"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input)));
        const frames = out
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => SafeJSON.parse(line.slice("data: ".length), { strict: true }) as Record<string, unknown>);

        // One block only — no guessed split next to a corrupted first call.
        expect(frames.filter((frame) => frame.type === "content_block_start")).toHaveLength(1);

        const streamed = frames
            .filter((frame) => frame.type === "content_block_delta")
            .map((frame) => (frame.delta as Record<string, unknown>).partial_json)
            .join("");

        // Everything the upstream sent (minus insignificant gap whitespace)
        // reaches the client on the ONE block, so it fails loudly client-side.
        expect(streamed).toBe('{"a":1}{"b":2}zz');
    });

    it("splits two tool calls grok merged into one block (separate deltas — the observed shape)", async () => {
        // Verbatim wire shape from callId 7a802f21: ONE tool_use start, two
        // complete JSON objects as consecutive input_json_delta frames, one
        // stop. Claude Code failed the call with InputValidationError.
        const input = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls -la\\"}"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"echo hi\\"}"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input)));
        const frames = out
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => SafeJSON.parse(line.slice("data: ".length), { strict: true }) as Record<string, unknown>);

        const inputs = new Map<number, string>();

        for (const frame of frames) {
            if (frame.type === "content_block_delta") {
                const delta = frame.delta as Record<string, unknown>;
                const index = frame.index as number;
                inputs.set(index, (inputs.get(index) ?? "") + String(delta.partial_json ?? ""));
            }
        }

        expect(inputs.get(0)).toBe('{"command":"ls -la"}');
        expect(inputs.get(1)).toBe('{"command":"echo hi"}');

        const starts = frames.filter((frame) => frame.type === "content_block_start");
        expect(starts).toHaveLength(2);
        expect((starts[1].content_block as Record<string, unknown>).name).toBe("Bash");

        const stops = frames.filter((frame) => frame.type === "content_block_stop");
        expect(stops.map((frame) => frame.index)).toEqual([0, 1]);
    });

    it("names an orphaned call by matching its keys against the request's tool schemas", async () => {
        // Grok merged a Bash call and a Read call into ONE block. The wire has
        // no second name; guessing "same tool" cross-wired sessions into retry
        // loops (194 splits, 19 InputValidationErrors in session 8dfb08ea).
        const tools = [
            { name: "Bash", required: ["command"], properties: ["command", "description"] },
            { name: "Read", required: ["file_path"], properties: ["file_path", "limit"] },
        ];
        const input = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/tmp/x\\"}"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input), { tools }));
        const frames = out
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => SafeJSON.parse(line.slice("data: ".length), { strict: true }) as Record<string, unknown>);

        const starts = frames.filter((frame) => frame.type === "content_block_start");
        expect(starts.map((frame) => (frame.content_block as Record<string, unknown>).name)).toEqual(["Bash", "Read"]);

        // Order: the orphan block appears only AFTER the original block's stop.
        const order = frames
            .filter((frame) => frame.type !== "content_block_delta")
            .map((frame) => `${frame.type}[${frame.index}]`);
        expect(order).toEqual([
            "content_block_start[0]",
            "content_block_stop[0]",
            "content_block_start[1]",
            "content_block_stop[1]",
        ]);
    });

    it("splits two tool calls merged into a single delta", async () => {
        const input = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"p\\":\\"a\\"} {\\"p\\":\\"b\\"}"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input)));

        expect(out).toContain('"partial_json":"{\\"p\\":\\"a\\"}"');
        expect(out).toContain('"partial_json":"{\\"p\\":\\"b\\"}"');
        expect(out.match(/"type":"content_block_start"/g)).toHaveLength(2);
    });

    it("does not split on braces inside strings", async () => {
        const payload = '{"command":"echo \'}{\' and \\\\\\" done"}';
        const input = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
            `data: ${SafeJSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: payload } })}\n\n`,
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input)));

        expect(out.match(/"type":"content_block_start"/g)).toHaveLength(1);
        expect(out).toContain("}{");
    });

    it("survives a frame split across chunk boundaries", async () => {
        const frame = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
        const out = await collect(repairAnthropicSseIndices(sseStream([frame.slice(0, 30), frame.slice(30)])));

        expect(out).toContain('"type":"content_block_start"');
        expect(out).toContain('"index":0');
    });

    it("swaps arguments back when grok puts another call's args under the declared name", async () => {
        // Observed live 2026-08-20: a merged block declaring `Edit` carried
        // {query, count} first, so Edit was rejected for a missing file_path it
        // was never given and the search call never ran at all.
        const tools = [
            {
                name: "Edit",
                required: ["file_path", "old_string"],
                properties: ["file_path", "old_string", "new_string"],
            },
            { name: "brave_web_search", required: ["query"], properties: ["query", "count"] },
        ];
        const input = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Edit","input":{}}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"grok bugs\\",\\"count\\":3}"}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/tmp/a\\",\\"old_string\\":\\"x\\"}"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ];

        const out = await collect(repairAnthropicSseIndices(sseStream(input), { tools }));
        const frames = out
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => SafeJSON.parse(line.slice("data: ".length), { strict: true }) as Record<string, unknown>);

        const calls = new Map<number, { name?: string; args: string }>();
        for (const frame of frames) {
            const index = frame.index as number;
            if (frame.type === "content_block_start") {
                calls.set(index, { name: (frame.content_block as Record<string, unknown>).name as string, args: "" });
            } else if (frame.type === "content_block_delta") {
                const delta = frame.delta as Record<string, unknown>;
                if (delta.type === "input_json_delta") {
                    const call = calls.get(index);
                    if (call) {
                        call.args += delta.partial_json as string;
                    }
                }
            }
        }

        // Edit keeps its name and now receives the Edit arguments; the search
        // arguments go out under the tool they uniquely match.
        expect(calls.get(0)?.name).toBe("Edit");
        expect(SafeJSON.parse(calls.get(0)?.args ?? "", { strict: true })).toEqual({
            file_path: "/tmp/a",
            old_string: "x",
        });
        expect(calls.get(1)?.name).toBe("brave_web_search");
        expect(SafeJSON.parse(calls.get(1)?.args ?? "", { strict: true })).toEqual({ query: "grok bugs", count: 3 });
    });

    describe("no-argument calls in a merged block", () => {
        const tools = [
            { name: "run_command", required: ["command"], properties: ["command"] },
            { name: "list_agents", required: [TOOL_ROUTING_TAG], properties: [TOOL_ROUTING_TAG] },
            { name: "list_tasks", required: [TOOL_ROUTING_TAG], properties: [TOOL_ROUTING_TAG] },
            { name: "read_file", required: ["path"], properties: ["path"] },
        ];

        /** Verbatim shape captured from grok's wire on 2026-08-21: ONE start frame, N complete objects. */
        function mergedStream(argObjects: string[]): ReadableStream<Uint8Array> {
            return sseStream([
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-abc-0","name":"run_command","input":{}}}\n\n',
                ...argObjects.map(
                    (args) =>
                        `data: ${SafeJSON.stringify({
                            type: "content_block_delta",
                            delta: { type: "input_json_delta", partial_json: args },
                        })}\n\n`
                ),
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            ]);
        }

        async function toolCalls(
            stream: ReadableStream<Uint8Array>,
            taggedTools?: Set<string>
        ): Promise<{ name: string; args: string }[]> {
            const out = await collect(repairAnthropicSseIndices(stream, { tools, taggedTools }));
            const calls = new Map<number, { name: string; args: string }>();

            for (const line of out.split("\n")) {
                if (!line.startsWith("data: ")) {
                    continue;
                }

                const frame = SafeJSON.parse(line.slice("data: ".length), { strict: true }) as Record<string, unknown>;
                const index = frame.index as number;
                const block = frame.content_block as Record<string, unknown> | undefined;

                if (frame.type === "content_block_start" && block?.type === "tool_use") {
                    calls.set(index, { name: String(block.name), args: "" });
                }

                const delta = frame.delta as Record<string, unknown> | undefined;

                if (frame.type === "content_block_delta" && delta?.type === "input_json_delta") {
                    const call = calls.get(index);

                    if (call) {
                        call.args += String(delta.partial_json);
                    }
                }
            }

            return [...calls.values()];
        }

        const tagged = [
            '{"command":"date"}',
            `{"${TOOL_ROUTING_TAG}":"list_agents"}`,
            `{"${TOOL_ROUTING_TAG}":"list_tasks"}`,
            '{"path":"/etc/hosts"}',
        ];

        it("names every merged no-arg call from its routing tag and strips the tag", async () => {
            const calls = await toolCalls(mergedStream(tagged), new Set(["list_agents", "list_tasks"]));

            expect(calls.map((c) => c.name)).toEqual(["run_command", "list_agents", "list_tasks", "read_file"]);
            // The tag is the proxy's own addition; the client asked for an
            // empty-object schema and must get exactly that.
            expect(calls.map((c) => c.args)).toEqual(['{"command":"date"}', "{}", "{}", '{"path":"/etc/hosts"}']);
        });

        it("negative control: the same stream is unresolvable without the tag", async () => {
            // Two no-arg tools produce byte-identical `{}` objects, so key
            // matching has nothing to separate them and both inherit the
            // block's name. This is the defect the tag exists to remove.
            const untagged = ['{"command":"date"}', "{}", "{}", '{"path":"/etc/hosts"}'];
            const calls = await toolCalls(mergedStream(untagged));

            expect(calls.map((c) => c.name)).toEqual(["run_command", "run_command", "run_command", "read_file"]);
        });

        it("ignores a tag naming a tool this request never tagged", async () => {
            // An empty tagged set means the proxy injected nothing, so a
            // property that merely looks like the tag must not route a call.
            const calls = await toolCalls(mergedStream(tagged), new Set());

            expect(calls.map((c) => c.name)).toEqual(["run_command", "run_command", "run_command", "read_file"]);
        });
    });
});
