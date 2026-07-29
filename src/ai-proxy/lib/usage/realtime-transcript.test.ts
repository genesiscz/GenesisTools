import { beforeEach, describe, expect, it, mock } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";

// The transcript store writes into ~/.genesis-tools/ai-proxy, so it is replaced
// with a collector: these tests are about what the writer decides to keep.

const appended: string[] = [];

mock.module("@app/ai-proxy/lib/usage/transcripts", () => ({
    transcriptsEnabled: () => true,
    transcriptFile: (day: string, session?: string) => `${day}/${session ?? "_untagged"}.jsonl`,
    appendTranscriptLines: (_file: string, _day: string, lines: string[]) => {
        appended.push(...lines);
    },
}));

import { MAX_RETAINED_EVENTS, RealtimeTranscript } from "@app/ai-proxy/lib/usage/realtime-transcript";

function newTranscript(): RealtimeTranscript {
    return new RealtimeTranscript({
        ts: "2026-07-29T04:00:00.000Z",
        account: "acct",
        provider: "openai",
        proxyModel: "openai/gpt-realtime",
        upstreamModel: "gpt-realtime",
        client: "cli",
    });
}

function closingSummary() {
    return {
        elapsedMs: 1_000,
        closeCode: 1000,
        clientFrames: 1,
        clientBytes: 10,
        upstreamFrames: 1,
        upstreamBytes: 10,
    };
}

interface Entry {
    eventType?: string;
    realtime?: { retainedEvents?: number; cappedEvents?: number };
}

function entries(): Entry[] {
    return appended.map((line) => SafeJSON.parse(line, { strict: true }) as Entry);
}

beforeEach(() => {
    appended.length = 0;
});

describe("RealtimeTranscript", () => {
    it("counts stream fragments instead of storing them", () => {
        const transcript = newTranscript();

        transcript.recordFrame("upstream", SafeJSON.stringify({ type: "response.audio.delta", delta: "AAAA" }));
        transcript.recordFrame("client", SafeJSON.stringify({ type: "session.update", session: {} }));
        transcript.finish(closingSummary());

        const recorded = entries();
        expect(recorded.filter((entry) => entry.eventType === "response.audio.delta")).toHaveLength(0);
        expect(recorded.filter((entry) => entry.eventType === "session.update")).toHaveLength(1);
    });

    it("stops retaining events at the ceiling and counts the rest in the summary", () => {
        const transcript = newTranscript();
        const overshoot = 100;

        for (let index = 0; index < MAX_RETAINED_EVENTS + overshoot; index += 1) {
            transcript.recordFrame("client", SafeJSON.stringify({ type: "conversation.item.create", index }));
        }

        transcript.finish(closingSummary());

        const recorded = entries();
        expect(recorded.filter((entry) => entry.eventType === "conversation.item.create")).toHaveLength(
            MAX_RETAINED_EVENTS
        );

        const summary = recorded[recorded.length - 1];
        expect(summary?.realtime?.retainedEvents).toBe(MAX_RETAINED_EVENTS);
        expect(summary?.realtime?.cappedEvents).toBe(overshoot);
    });
});
