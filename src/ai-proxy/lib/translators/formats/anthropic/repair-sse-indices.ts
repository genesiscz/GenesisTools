import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REPAIRED_TYPES = new Set(["content_block_start", "content_block_delta", "content_block_stop"]);

/** Enough of a tool schema to attribute an orphaned call by its argument keys. */
export interface ToolMatcher {
    name: string;
    required: string[];
    properties: string[];
}

export function toolMatchersFromBody(body: JsonRecord): ToolMatcher[] {
    if (!Array.isArray(body.tools)) {
        return [];
    }

    const matchers: ToolMatcher[] = [];

    for (const tool of body.tools) {
        if (!isJsonRecord(tool) || typeof tool.name !== "string") {
            continue;
        }

        const schema = isJsonRecord(tool.input_schema) ? tool.input_schema : {};
        matchers.push({
            name: tool.name,
            required: Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : [],
            properties: isJsonRecord(schema.properties) ? Object.keys(schema.properties) : [],
        });
    }

    return matchers;
}

/**
 * The wire carries no name for a merged second call, so it must be inferred
 * from the argument keys against the request's own tool schemas. Only a UNIQUE
 * match is trusted; anything else falls back to the original block's name and
 * fails loudly client-side rather than running the wrong tool.
 */
function matchToolName(argKeys: string[], tools: ToolMatcher[], fallback: string): string {
    const matches = tools.filter(
        (tool) =>
            tool.required.every((key) => argKeys.includes(key)) && argKeys.every((key) => tool.properties.includes(key))
    );

    return matches.length === 1 ? matches[0].name : fallback;
}

/**
 * String-aware JSON depth scanner. `complete` flips when the object closes at
 * depth 0; the split logic buffers everything after that as orphaned calls.
 */
interface JsonScanner {
    depth: number;
    inString: boolean;
    escaped: boolean;
    started: boolean;
    complete: boolean;
}

function createJsonScanner(): JsonScanner {
    return { depth: 0, inString: false, escaped: false, started: false, complete: false };
}

function scanChar(scanner: JsonScanner, char: string): void {
    if (scanner.inString) {
        if (scanner.escaped) {
            scanner.escaped = false;
        } else if (char === "\\") {
            scanner.escaped = true;
        } else if (char === '"') {
            scanner.inString = false;
        }

        return;
    }

    if (char === '"') {
        scanner.inString = true;
        scanner.started = true;
    } else if (char === "{" || char === "[") {
        scanner.depth += 1;
        scanner.started = true;
    } else if (char === "}" || char === "]") {
        scanner.depth -= 1;

        if (scanner.depth === 0 && scanner.started) {
            scanner.complete = true;
        }
    } else if (!/\s/.test(char)) {
        scanner.started = true;
    }
}

/** Per-tool_use-block split state: first object streams, the rest buffer. */
interface ToolBlockState {
    /** The ASSIGNED index of this block, so interleaved frames cannot feed it. */
    index: number;
    toolName: string;
    scanner: JsonScanner;
    /** Completed orphan JSON texts, in arrival order. */
    orphans: string[];
    /** The orphan currently accumulating (null until its `{` arrives). */
    orphanText: string | null;
    orphanScanner: JsonScanner;
    /** Set when trailing bytes were not a second object — stop interpreting. */
    disabled: boolean;
}

/**
 * Repairs Grok's native /v1/messages SSE, which deviates from the Anthropic
 * spec in two verified ways:
 *
 * 1. It reuses `index: 0` for every content block and omits `index` on
 *    `content_block_delta` frames. Anthropic SDKs place blocks by index, so the
 *    text block overwrites the thinking block client-side and an index-less
 *    delta has nowhere to land. Blocks are renumbered monotonically and every
 *    delta/stop is stamped with the current block's index.
 *
 * 2. It merges MULTIPLE tool calls into ONE tool_use block: a single
 *    content_block_start whose input_json_delta stream carries several complete
 *    JSON objects back to back (194 occurrences in one live session,
 *    2026-08-19). The first object streams through normally; the rest are
 *    buffered to completion and emitted as their own tool_use blocks when the
 *    real content_block_stop arrives, each named by matching its argument keys
 *    against the request's tool schemas — the wire does NOT carry the second
 *    call's name, and guessing "same tool" cross-wired Bash/Read/ToolSearch
 *    calls and sent a session into a 35-round retry loop.
 *
 * Both are identity rewrites for a stream that already follows the spec.
 * All other frames pass through verbatim.
 */
export function repairAnthropicSseIndices(
    upstream: ReadableStream<Uint8Array>,
    options?: { tools?: ToolMatcher[] }
): ReadableStream<Uint8Array> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const tools = options?.tools ?? [];
    let buffer = "";
    let nextIndex = 0;
    let currentIndex = 0;
    let toolBlock: ToolBlockState | null = null;
    // Upstream index → assigned index, for blocks that are still open. Grok
    // reuses index 0 for consecutive blocks (the map entry is replaced after
    // each stop), while a spec-compliant stream keeps distinct indices — so an
    // interleaved delta that names its block resolves to the RIGHT assigned
    // index instead of being stamped with the last-started block's.
    const openBlocks = new Map<number, number>();

    /** The assigned index for a frame: its own mapped index when it names one, else the last-started block. */
    function resolveIndex(event: JsonRecord): number {
        if (typeof event.index === "number") {
            const assigned = openBlocks.get(event.index);

            if (assigned !== undefined) {
                return assigned;
            }
        }

        return currentIndex;
    }

    function frameText(type: string, data: JsonRecord): string {
        return `event: ${type}\ndata: ${SafeJSON.stringify({ type, ...data })}`;
    }

    /** Route one input_json_delta payload; orphan bytes buffer, they do not stream. */
    function consumeToolJson(block: ToolBlockState, partialJson: string): string {
        let pending = "";

        for (const char of partialJson) {
            if (block.disabled) {
                pending += char;
                continue;
            }

            if (!block.scanner.complete) {
                pending += char;
                scanChar(block.scanner, char);
                continue;
            }

            // First object is complete — everything from here is overflow.
            if (block.orphanText === null) {
                if (/\s/.test(char)) {
                    continue;
                }

                if (char !== "{") {
                    // Not a second call: give up on splitting and hand ALL held
                    // bytes back verbatim — including orphans already buffered —
                    // so the ONE call fails loudly instead of pairing a guessed
                    // split with a corrupted first call.
                    block.disabled = true;
                    pending += [...block.orphans, char].join("");
                    block.orphans = [];
                    continue;
                }

                block.orphanText = "";
                block.orphanScanner = createJsonScanner();
            }

            block.orphanText += char;
            scanChar(block.orphanScanner, char);

            if (block.orphanScanner.complete) {
                block.orphans.push(block.orphanText);
                block.orphanText = null;
            }
        }

        return `data: ${SafeJSON.stringify({
            type: "content_block_delta",
            index: block.index,
            delta: { type: "input_json_delta", partial_json: pending },
        })}`;
    }

    /** The real stop closes the original block, then the orphans become blocks. */
    function emitStopAndOrphans(block: ToolBlockState): string {
        const frames = [frameText("content_block_stop", { index: block.index })];
        const leftovers = block.orphanText !== null ? [...block.orphans, block.orphanText] : block.orphans;

        for (const orphan of leftovers) {
            currentIndex = nextIndex;
            nextIndex += 1;

            let name = block.toolName;
            try {
                const parsed = SafeJSON.parse(orphan, { strict: true });

                if (isJsonRecord(parsed)) {
                    name = matchToolName(Object.keys(parsed), tools, block.toolName);
                }
            } catch (err) {
                logger.debug({ err }, "ai-proxy: merged-call orphan did not parse; keeping the original tool name");
            }

            // An orphan with NO arguments is a no-arg call whose name the wire
            // destroyed. If the fallback tool requires arguments, the name we
            // are about to emit is certainly wrong and the client will reject
            // it — say so here, or the InputValidationError reads as a bug in
            // the tool being blamed.
            const noArgs = orphan.trim() === "{}";
            const fallbackNeedsArgs = tools.some((t) => t.name === name && t.required.length > 0);

            if (noArgs && fallbackNeedsArgs) {
                logger.warn(
                    {
                        blamed: name,
                        candidates: tools.filter((t) => t.required.length === 0).map((t) => t.name),
                        index: currentIndex,
                    },
                    "ai-proxy: grok destroyed the name of a no-arg tool call; no unique match, so it goes out under a tool that requires arguments and the client will reject it"
                );
            } else {
                logger.warn(
                    { from: block.toolName, to: name, index: currentIndex },
                    "ai-proxy: grok merged an extra tool call into one block — emitted as its own tool_use"
                );
            }

            frames.push(
                frameText("content_block_start", {
                    index: currentIndex,
                    content_block: {
                        type: "tool_use",
                        id: `toolu_split_${crypto.randomUUID()}`,
                        name,
                        input: {},
                    },
                }),
                frameText("content_block_delta", {
                    index: currentIndex,
                    delta: { type: "input_json_delta", partial_json: orphan },
                }),
                frameText("content_block_stop", { index: currentIndex })
            );
        }

        return frames.join("\n\n");
    }

    function repairLine(line: string): string {
        const trimmed = line.trimStart();

        if (!trimmed.startsWith("data:")) {
            return line;
        }

        const payload = trimmed.slice("data:".length).trim();

        if (payload.length === 0 || payload === "[DONE]") {
            return line;
        }

        try {
            const event = SafeJSON.parse(payload, { strict: true });

            if (!isJsonRecord(event) || typeof event.type !== "string" || !REPAIRED_TYPES.has(event.type)) {
                return line;
            }

            if (event.type === "content_block_start") {
                currentIndex = nextIndex;
                nextIndex += 1;

                if (typeof event.index === "number") {
                    openBlocks.set(event.index, currentIndex);
                }

                const block = isJsonRecord(event.content_block) ? event.content_block : undefined;
                toolBlock =
                    block?.type === "tool_use"
                        ? {
                              index: currentIndex,
                              toolName: typeof block.name === "string" ? block.name : "unknown",
                              scanner: createJsonScanner(),
                              orphans: [],
                              orphanText: null,
                              orphanScanner: createJsonScanner(),
                              disabled: false,
                          }
                        : null;

                event.index = currentIndex;
                return `data: ${SafeJSON.stringify(event)}`;
            }

            const resolved = resolveIndex(event);

            if (event.type === "content_block_stop") {
                if (typeof event.index === "number") {
                    openBlocks.delete(event.index);
                }

                if (toolBlock && resolved === toolBlock.index) {
                    const block = toolBlock;
                    toolBlock = null;

                    if (block.orphans.length > 0 || block.orphanText !== null) {
                        // The original data line is replaced wholesale; the stop's
                        // own event: line already passed through above it.
                        return emitStopAndOrphans(block).replace(/^event: content_block_stop\n/, "");
                    }
                }
            }

            if (
                event.type === "content_block_delta" &&
                toolBlock &&
                resolved === toolBlock.index &&
                isJsonRecord(event.delta) &&
                event.delta.type === "input_json_delta" &&
                typeof event.delta.partial_json === "string"
            ) {
                return consumeToolJson(toolBlock, event.delta.partial_json);
            }

            event.index = resolved;
            return `data: ${SafeJSON.stringify(event)}`;
        } catch (err) {
            logger.debug({ err, payload }, "ai-proxy: SSE index repair could not parse frame, passing through");
            return line;
        }
    }

    return new ReadableStream<Uint8Array>({
        // A pull that resolves without enqueuing anything is not re-polled, so a
        // chunk that carries no complete line must loop for the next read.
        async pull(controller) {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    // Flush held multibyte bytes AND the final unterminated frame —
                    // both were dropped by earlier stream code in this repo and
                    // truncated replies mid-word.
                    buffer += decoder.decode();

                    const parts: string[] = [];

                    if (buffer.length > 0) {
                        parts.push(repairLine(buffer));
                    }

                    // A stream that ends without content_block_stop still owes the
                    // client any merged calls sitting in the buffer — dropping them
                    // here would destroy bytes the client received before this
                    // transformer existed.
                    if (toolBlock && (toolBlock.orphans.length > 0 || toolBlock.orphanText !== null)) {
                        const block = toolBlock;
                        toolBlock = null;
                        parts.push(emitStopAndOrphans(block));
                    }

                    if (parts.length > 0) {
                        // Terminate the final frame: without the blank line a
                        // conformant SSE parser never dispatches it.
                        controller.enqueue(encoder.encode(`${parts.join("\n\n")}\n\n`));
                    }

                    controller.close();
                    return;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                if (lines.length > 0) {
                    const repaired = lines.map((line) => repairLine(line)).join("\n");
                    controller.enqueue(encoder.encode(`${repaired}\n`));
                    return;
                }
            }
        },
        cancel(reason) {
            reader.cancel(reason).catch((err) => {
                logger.debug({ err }, "ai-proxy: SSE index repair cancel failed");
            });
        },
    });
}
