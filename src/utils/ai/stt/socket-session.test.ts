import { afterEach, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { resamplePcm16 } from "./pcm";
import { openDeepgramStt, parseDeepgramMessage } from "./providers/deepgram";
import {
    openOpenAiRealtimeStt,
    parseRealtimeEvent,
    realtimeTranscriptionSessionUpdate,
} from "./providers/openai-realtime";
import { openXaiRealtimeStt, parseXaiSttEvent } from "./providers/xai-realtime";
import { openSocketSession } from "./socket-session";
import type { LiveTranscriptEvent } from "./types";

interface Recorded {
    headers: Record<string, string>;
    url: string;
    messages: Array<string | Uint8Array>;
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
    for (const server of servers) {
        server.stop(true);
    }

    servers.length = 0;
});

/** A local WebSocket that records what the client sent and replays scripted frames after `open`. */
function replayServer(
    script: string[],
    options: { replyOn?: "open" | "first-audio" } = {}
): {
    url: string;
    recorded: Recorded;
} {
    const recorded: Recorded = { headers: {}, url: "", messages: [] };
    const replyOn = options.replyOn ?? "open";
    const server = Bun.serve({
        port: 0,
        fetch(request, server) {
            recorded.url = request.url;
            for (const [key, value] of request.headers) {
                recorded.headers[key.toLowerCase()] = value;
            }

            if (server.upgrade(request)) {
                return undefined;
            }

            return new Response("expected websocket", { status: 400 });
        },
        websocket: {
            open(ws) {
                if (replyOn === "open") {
                    for (const frame of script) {
                        ws.send(frame);
                    }
                }
            },
            message(ws, message) {
                recorded.messages.push(typeof message === "string" ? message : new Uint8Array(message));
                if (replyOn === "first-audio" && recorded.messages.length === 1) {
                    for (const frame of script) {
                        ws.send(frame);
                    }
                }
            },
        },
    });
    servers.push(server);
    return { url: `ws://127.0.0.1:${server.port}`, recorded };
}

async function collect(events: AsyncIterable<LiveTranscriptEvent>, count: number): Promise<LiveTranscriptEvent[]> {
    const seen: LiveTranscriptEvent[] = [];
    for await (const event of events) {
        seen.push(event);
        if (seen.length >= count) {
            break;
        }
    }

    return seen;
}

test("deepgram parser maps Results, speech markers and errors", () => {
    const partial = parseDeepgramMessage(
        SafeJSON.stringify({
            type: "Results",
            is_final: false,
            channel: { alternatives: [{ transcript: "press sev", confidence: 0.7 }] },
        }),
        5
    );
    expect(partial).toMatchObject({ kind: "partial", text: "press sev", isFinal: false, confidence: 0.7 });
    const final = parseDeepgramMessage(
        SafeJSON.stringify({
            type: "Results",
            is_final: true,
            speech_final: true,
            channel: { alternatives: [{ transcript: "press seven" }] },
        }),
        9
    );
    expect(final).toMatchObject({ kind: "final", text: "press seven", isFinal: true });
    expect(parseDeepgramMessage(SafeJSON.stringify({ type: "SpeechStarted" }), 1)?.kind).toBe("speech_start");
    expect(parseDeepgramMessage(SafeJSON.stringify({ type: "UtteranceEnd" }), 1)?.kind).toBe("speech_end");
    expect(parseDeepgramMessage(SafeJSON.stringify({ type: "Metadata" }), 1)).toBeNull();
    expect(parseDeepgramMessage(SafeJSON.stringify({ type: "Error", description: "bad key" }), 1)).toMatchObject({
        kind: "error",
        error: "bad key",
    });
});

test("openai realtime parser and session update follow the transcription grammar", () => {
    const update = realtimeTranscriptionSessionUpdate({ model: "gpt-live-transcribe", sampleRateHz: 16000 });
    expect(update).toMatchObject({
        type: "session.update",
        session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 16000 } } } },
    });
    expect(
        parseRealtimeEvent(
            SafeJSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "pre" }),
            1
        )
    ).toMatchObject({ kind: "partial", text: "pre" });
    expect(
        parseRealtimeEvent(
            SafeJSON.stringify({
                type: "conversation.item.input_audio_transcription.completed",
                transcript: "press seven",
            }),
            1
        )
    ).toMatchObject({ kind: "final", text: "press seven", isFinal: true });
    expect(parseRealtimeEvent(SafeJSON.stringify({ type: "input_audio_buffer.speech_started" }), 1)?.kind).toBe(
        "speech_start"
    );
    expect(parseRealtimeEvent(SafeJSON.stringify({ type: "error", error: { message: "nope" } }), 1)).toMatchObject({
        kind: "error",
        error: "nope",
    });
});

test("xai parser maps transcript.partial finals and transcript.done", () => {
    expect(
        parseXaiSttEvent(SafeJSON.stringify({ type: "transcript.partial", text: "press", is_final: false }), 1)
    ).toMatchObject({ kind: "partial", text: "press" });
    expect(
        parseXaiSttEvent(SafeJSON.stringify({ type: "transcript.partial", text: "press seven", is_final: true }), 1)
    ).toMatchObject({ kind: "final", isFinal: true });
    expect(
        parseXaiSttEvent(SafeJSON.stringify({ type: "transcript.done", text: "press seven", duration: 2 }), 1)
    ).toMatchObject({
        kind: "final",
    });
    expect(parseXaiSttEvent(SafeJSON.stringify({ type: "transcript.created" }), 1)).toBeNull();
});

test("socket session sends the hello, streams frames, maps events and finishes", async () => {
    const { url, recorded } = replayServer([
        SafeJSON.stringify({
            type: "Results",
            is_final: false,
            channel: { alternatives: [{ transcript: "press" }] },
        }),
        SafeJSON.stringify({
            type: "Results",
            is_final: true,
            channel: { alternatives: [{ transcript: "press seven" }] },
        }),
    ]);
    const session = await openSocketSession({
        accountId: "acc_test",
        spec: {
            provider: "deepgram",
            url,
            headers: { Authorization: "Token test-key" },
            hello: () => ["hello"],
            frame: (pcm) => [pcm],
            finish: () => ["bye"],
            parse: parseDeepgramMessage,
        },
    });
    session.write(new Uint8Array([1, 2, 3, 4]));
    session.end();
    const events = await collect(session.events(), 2);
    expect(events.map((event) => `${event.kind}:${event.text}`)).toEqual(["partial:press", "final:press seven"]);
    await Bun.sleep(20);
    expect(recorded.headers.authorization).toBe("Token test-key");
    expect(recorded.messages[0]).toBe("hello");
    expect(recorded.messages[1]).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(recorded.messages[2]).toBe("bye");
    await session.close();
});

test("frames written before the provider is ready are queued and flushed on the ready message", async () => {
    const { url, recorded } = replayServer([
        SafeJSON.stringify({ type: "transcript.created" }),
        SafeJSON.stringify({ type: "transcript.partial", text: "queued", is_final: true }),
    ]);
    const session = await openSocketSession({
        accountId: "acc_test",
        spec: {
            provider: "xai",
            url,
            headers: {},
            frame: (pcm) => [pcm],
            parse: parseXaiSttEvent,
            readyWhen: (raw) => raw.includes("transcript.created"),
        },
    });
    session.write(new Uint8Array([9, 9]));
    const events = await collect(session.events(), 1);
    expect(events[0]).toMatchObject({ kind: "final", text: "queued" });
    await Bun.sleep(20);
    expect(recorded.messages).toEqual([new Uint8Array([9, 9])]);
    await session.close();
});

test("abort closes the socket and ends the event iterator", async () => {
    const { url } = replayServer([]);
    const controller = new AbortController();
    const session = await openSocketSession({
        accountId: "acc_test",
        signal: controller.signal,
        spec: { provider: "openai", url, headers: {}, frame: (pcm) => [pcm], parse: parseRealtimeEvent },
    });
    const drained = collect(session.events(), 1);
    controller.abort();
    const events = await drained;
    expect(events).toEqual([]);
});

test("provider openers refuse an empty key before any socket is opened", () => {
    const originalWebSocket = globalThis.WebSocket;
    let constructed = 0;
    globalThis.WebSocket = class {
        constructor() {
            constructed++;
            throw new Error("must not construct");
        }
    } as unknown as typeof WebSocket;
    try {
        const options = { apiKey: "", accountId: "acc_test", sampleRateHz: 16000 };
        expect(() => openDeepgramStt(options)).toThrow(/API key/);
        expect(() => openOpenAiRealtimeStt(options)).toThrow(/API key/);
        expect(() => openXaiRealtimeStt(options)).toThrow(/API key/);
        expect(constructed).toBe(0);
    } finally {
        globalThis.WebSocket = originalWebSocket;
    }
});

test("resamplePcm16 scales the frame length and keeps a constant signal constant", () => {
    const input = new Int16Array(160).fill(1000);
    const output = resamplePcm16(new Uint8Array(input.buffer), 16000, 24000);
    const samples = new Int16Array(output.buffer, output.byteOffset, output.byteLength / 2);
    expect(samples.length).toBe(240);
    expect(samples.every((sample) => sample === 1000)).toBe(true);
    expect(resamplePcm16(new Uint8Array(input.buffer), 16000, 16000)).toHaveLength(320);
});

test("language lists map to each provider's own grammar", async () => {
    const { deepgramListenUrl } = await import("./providers/deepgram");
    const { xaiSttUrl } = await import("./providers/xai-realtime");
    const { parseLanguages } = await import("./types");
    expect(parseLanguages("cs, en,CS")).toEqual(["cs", "en"]);
    expect(parseLanguages("")).toBeUndefined();
    expect(() => parseLanguages("czech")).toThrow(/ISO 639/);
    expect(new URL(deepgramListenUrl({ sampleRateHz: 16000, languages: ["cs"] })).searchParams.get("language")).toBe(
        "cs"
    );
    expect(
        new URL(deepgramListenUrl({ sampleRateHz: 16000, languages: ["en", "de"] })).searchParams.get("language")
    ).toBe("multi");
    expect(
        new URL(deepgramListenUrl({ sampleRateHz: 16000, languages: ["cs", "en"] })).searchParams.get("language")
    ).toBe("cs");
    expect(new URL(deepgramListenUrl({ sampleRateHz: 16000 })).searchParams.get("language")).toBeNull();
    expect(new URL(xaiSttUrl({ sampleRateHz: 16000, languages: ["cs", "en"] })).searchParams.get("language")).toBe(
        "cs"
    );
    const update = realtimeTranscriptionSessionUpdate({
        model: "gpt-live-transcribe",
        sampleRateHz: 24000,
        languages: ["cs", "en"],
    });
    expect(update).toMatchObject({ session: { audio: { input: { transcription: { languages: ["cs", "en"] } } } } });
});
