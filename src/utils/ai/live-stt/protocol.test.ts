import { describe, expect, test } from "bun:test";
import { nextFallback, recordReconnect, shouldReconnect } from "./health";
import { parseDeepgramMessage } from "./parse-deepgram";
import { parseRealtimeEvent } from "./parse-realtime";
import { isStopUtterance } from "./stop-phrases";
import { pcmRms, silenceTimedOut } from "./vad";
import { canDispatchWake } from "./wake-jev";

describe("Deepgram / realtime parsers", () => {
    test("maps Deepgram interim and final results", () => {
        const partial = parseDeepgramMessage(
            `{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"hey gene"}]}}`,
            1
        );
        const final = parseDeepgramMessage(
            `{"type":"Results","is_final":true,"speech_final":true,"channel":{"alternatives":[{"transcript":"hey genesis"}]}}`,
            2
        );
        expect(partial).toMatchObject({ type: "partial", text: "hey gene", provider: "deepgram" });
        expect(final).toMatchObject({ type: "final", text: "hey genesis" });
    });

    test("maps Grok/GPT realtime transcription events", () => {
        const partial = parseRealtimeEvent(
            `{"type":"conversation.item.input_audio_transcription.delta","delta":"go ba"}`,
            "grok-live",
            1
        );
        const completed = parseRealtimeEvent(
            `{"type":"conversation.item.input_audio_transcription.completed","transcript":"go back"}`,
            "gpt-realtime",
            2
        );
        expect(partial).toMatchObject({ type: "partial", text: "go ba", provider: "grok-live" });
        expect(completed).toMatchObject({ type: "final", text: "go back", provider: "gpt-realtime" });
    });
});

describe("health and VAD", () => {
    test("reconnects only while audio is flowing and the heartbeat elapsed", () => {
        expect(shouldReconnect({ lastEventMs: 0, audioFlowing: true, now: 8000 })).toBe(true);
        expect(shouldReconnect({ lastEventMs: 0, audioFlowing: false, now: 8000 })).toBe(false);
        expect(shouldReconnect({ lastEventMs: 7000, audioFlowing: true, now: 8000 })).toBe(false);
        expect(nextFallback("deepgram", "grok-live")).toBe("grok-live");
        expect(nextFallback("deepgram")).toBeNull();
        const state = { attempts: 0 };
        expect(recordReconnect(state).retry).toBe(true);
        expect(recordReconnect(state).retry).toBe(false);
    });

    test("stop phrases and silence endpoint", () => {
        expect(isStopUtterance("Never mind.")).toBe(true);
        expect(isStopUtterance("open atlas")).toBe(false);
        const quiet = new Uint8Array(8);
        expect(pcmRms(quiet)).toBe(0);
        expect(silenceTimedOut({ lastLoudMs: 0, now: 400, rms: 0.001 })).toBe(true);
        expect(silenceTimedOut({ lastLoudMs: 0, now: 100, rms: 0.001 })).toBe(false);
    });

    test("jev wake dispatch gates", () => {
        expect(
            canDispatchWake({
                woke: true,
                complete: true,
                destructive: true,
                remainder: "push",
                probabilities: { woke: 0.9, complete: 0.8, destructive: 0.8 },
            })
        ).toBe(false);
        expect(
            canDispatchWake(
                {
                    woke: true,
                    complete: true,
                    destructive: true,
                    remainder: "push",
                    probabilities: {},
                },
                true
            )
        ).toBe(true);
        expect(
            canDispatchWake({
                woke: true,
                complete: false,
                destructive: false,
                remainder: "open",
                probabilities: {},
            })
        ).toBe(false);
    });
});
