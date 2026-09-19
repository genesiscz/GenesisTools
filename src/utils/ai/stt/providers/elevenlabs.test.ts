import { afterEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { openSocketSession } from "../socket-session";
import type { LiveTranscriptEvent } from "../types";
import {
    ELEVENLABS_PCM_SAMPLE_RATES,
    elevenLabsRealtimeUrl,
    elevenLabsSocketSpec,
    openElevenLabsStt,
    parseElevenLabsMessage,
} from "./elevenlabs";

const FIXTURE_KEY = "sk_fixture_scribe_key";

interface Recorded {
    headers: Record<string, string>;
    url: string;
    messages: string[];
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
    for (const server of servers) {
        server.stop(true);
    }

    servers.length = 0;
});

/** A local Scribe stand-in: records what the client sent, replays a scripted frame sequence. */
function replayServer(
    script: string[],
    options: { replyOn?: "open" | "first-message" } = {}
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
                recorded.messages.push(typeof message === "string" ? message : new TextDecoder().decode(message));

                if (replyOn === "first-message" && recorded.messages.length === 1) {
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

const SESSION_STARTED = SafeJSON.stringify({
    message_type: "session_started",
    session_id: "sess_fixture_1",
    config: { model_id: "scribe_v2_realtime", sample_rate: 16000, commit_strategy: "vad" },
});

describe("elevenLabsRealtimeUrl", () => {
    test("carries the model, the pcm format for the sample rate and the vad commit strategy", () => {
        const url = new URL(elevenLabsRealtimeUrl({ sampleRateHz: 16000 }));

        expect(url.protocol).toBe("wss:");
        expect(url.host).toBe("api.elevenlabs.io");
        expect(url.pathname).toBe("/v1/speech-to-text/realtime");
        expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
        expect(url.searchParams.get("audio_format")).toBe("pcm_16000");
        expect(url.searchParams.get("commit_strategy")).toBe("vad");
        expect(url.searchParams.get("language_code")).toBeNull();
    });

    test("a language and a model override reach the query string", () => {
        const url = new URL(
            elevenLabsRealtimeUrl({ sampleRateHz: 48000, model: "scribe_v2_experimental", languages: ["cs"] })
        );

        expect(url.searchParams.get("audio_format")).toBe("pcm_48000");
        expect(url.searchParams.get("model_id")).toBe("scribe_v2_experimental");
        expect(url.searchParams.get("language_code")).toBe("cs");
    });

    test("an unsupported sample rate fails with the list of the ones that work", () => {
        expect(() => elevenLabsRealtimeUrl({ sampleRateHz: 32000 })).toThrow(/32000 Hz/);
        expect(() => elevenLabsRealtimeUrl({ sampleRateHz: 32000 })).toThrow(/8000, 16000/);

        for (const rate of ELEVENLABS_PCM_SAMPLE_RATES) {
            expect(elevenLabsRealtimeUrl({ sampleRateHz: rate })).toContain(`pcm_${rate}`);
        }
    });
});

describe("parseElevenLabsMessage", () => {
    test("partial and committed transcripts become partial and final events", () => {
        expect(
            parseElevenLabsMessage(SafeJSON.stringify({ message_type: "partial_transcript", text: "open the" }), 7)
        ).toEqual({ kind: "partial", text: "open the", isFinal: false, startedAtMs: 7 });

        expect(
            parseElevenLabsMessage(
                SafeJSON.stringify({ message_type: "committed_transcript", text: "open the door" }),
                9
            )
        ).toEqual({ kind: "final", text: "open the door", isFinal: true, startedAtMs: 9 });
    });

    test("session_started, warnings and the enrichment frames report nothing", () => {
        expect(parseElevenLabsMessage(SESSION_STARTED, 1)).toBeNull();
        expect(parseElevenLabsMessage(SafeJSON.stringify({ message_type: "warning", warning: "slow" }), 1)).toBeNull();
        // The text here repeats a committed_transcript already delivered; emitting
        // it would double every final.
        expect(
            parseElevenLabsMessage(
                SafeJSON.stringify({ message_type: "committed_transcript_with_timestamps", text: "open the door" }),
                1
            )
        ).toBeNull();
        expect(
            parseElevenLabsMessage(SafeJSON.stringify({ message_type: "partial_transcript", text: "  " }), 1)
        ).toBeNull();
    });

    test("every documented failure type becomes an error event, not just the ones ending in _error", () => {
        const failures = [
            "error",
            "auth_error",
            "quota_exceeded",
            "transcriber_error",
            "input_error",
            "invalid_request",
            "commit_throttled",
            "unaccepted_terms",
            "rate_limited",
            "queue_overflow",
            "resource_exhausted",
            "session_time_limit_exceeded",
            "chunk_size_exceeded",
            "insufficient_audio_activity",
        ];

        for (const messageType of failures) {
            const event = parseElevenLabsMessage(
                SafeJSON.stringify({ message_type: messageType, error: "fixture detail" }),
                3
            );

            expect(event).toMatchObject({ kind: "error", isFinal: false, startedAtMs: 3 });
            expect(event?.error).toContain(messageType);
            expect(event?.error).toContain("fixture detail");
        }
    });
});

describe("the ElevenLabs live session", () => {
    test("streams base64 audio chunks and maps the replayed frames in order", async () => {
        const { url, recorded } = replayServer([
            SESSION_STARTED,
            SafeJSON.stringify({ message_type: "partial_transcript", text: "call" }),
            SafeJSON.stringify({ message_type: "committed_transcript", text: "call the vet" }),
        ]);

        const session = await openSocketSession({
            accountId: "acc_fixture",
            spec: elevenLabsSocketSpec({ apiKey: FIXTURE_KEY, sampleRateHz: 16000, url }),
        });

        session.write(new Uint8Array([1, 2, 3, 4]));
        const events = await collect(session.events(), 2);

        expect(events.map((event) => `${event.kind}:${event.text}`)).toEqual(["partial:call", "final:call the vet"]);
        await Bun.sleep(20);
        expect(recorded.headers["xi-api-key"]).toBe(FIXTURE_KEY);
        expect(SafeJSON.parse(recorded.messages[0] ?? "{}")).toEqual({
            message_type: "input_audio_chunk",
            audio_base_64: Buffer.from([1, 2, 3, 4]).toString("base64"),
            commit: false,
            sample_rate: 16000,
        });

        await session.close();
    });

    test("audio written before session_started is queued, then flushed once it arrives", async () => {
        const { url, recorded } = replayServer([
            SESSION_STARTED,
            SafeJSON.stringify({ message_type: "committed_transcript", text: "queued audio" }),
        ]);

        const session = await openSocketSession({
            accountId: "acc_fixture",
            spec: elevenLabsSocketSpec({ apiKey: FIXTURE_KEY, sampleRateHz: 16000, url }),
        });

        session.write(new Uint8Array([9, 9]));
        const events = await collect(session.events(), 1);

        expect(events[0]).toMatchObject({ kind: "final", text: "queued audio" });
        await Bun.sleep(20);
        // Exactly one frame: the queued one, sent after the ready message rather
        // than dropped and rather than sent twice.
        expect(recorded.messages).toHaveLength(1);
        expect(SafeJSON.parse(recorded.messages[0] ?? "{}").audio_base_64).toBe(Buffer.from([9, 9]).toString("base64"));

        await session.close();
    });

    test("end() sends the documented empty commit chunk", async () => {
        const { url, recorded } = replayServer([SESSION_STARTED]);

        const session = await openSocketSession({
            accountId: "acc_fixture",
            spec: elevenLabsSocketSpec({ apiKey: FIXTURE_KEY, sampleRateHz: 24000, url }),
        });

        await Bun.sleep(20);
        session.end();
        await Bun.sleep(20);

        const last = SafeJSON.parse(recorded.messages.at(-1) ?? "{}");
        expect(last).toEqual({
            message_type: "input_audio_chunk",
            audio_base_64: "",
            commit: true,
            sample_rate: 24000,
        });

        await session.close();
    });

    test("aborting the signal closes the socket and ends the event iterator", async () => {
        const { url } = replayServer([SESSION_STARTED]);
        const controller = new AbortController();

        const session = await openSocketSession({
            accountId: "acc_fixture",
            signal: controller.signal,
            spec: elevenLabsSocketSpec({ apiKey: FIXTURE_KEY, sampleRateHz: 16000, url }),
        });

        const drained = collect(session.events(), 1);
        controller.abort();

        expect(await drained).toEqual([]);
    });

    // The negative control for the key: the resolver above decides WHICH account
    // pays, and this proves an empty result never reaches the network at all.
    // Spying on the WebSocket constructor rather than on a symptom, because that
    // is the call that would leak an unauthenticated connection.
    test("an empty api key is refused before any WebSocket is constructed", () => {
        const original = globalThis.WebSocket;
        let constructed = 0;

        class ExplodingWebSocket {
            constructor() {
                constructed++;
                throw new Error("a WebSocket must not be constructed without a key");
            }
        }

        globalThis.WebSocket = ExplodingWebSocket as unknown as typeof WebSocket;

        try {
            expect(() => openElevenLabsStt({ apiKey: "", accountId: "acc_fixture", sampleRateHz: 16000 })).toThrow(
                /API key/
            );
            expect(constructed).toBe(0);
        } finally {
            globalThis.WebSocket = original;
        }
    });
});
