import { describe, expect, it } from "bun:test";
import { parseHar } from "@genesiscz/utils/hls/har";
import { SafeJSON } from "@genesiscz/utils/json";
import { recordingOutputName } from "../recording";
import { streamyard, webinarState } from "./streamyard";

const API = "https://oa-api.streamyard.com/api/public/webinars/abc123";

function harWith(answers: { status: string; extra?: Record<string, unknown>; method?: string }[]) {
    return parseHar({
        log: {
            pages: [{ id: "page_1", title: "https://example.com/event/3" }],
            entries: answers.map((answer, index) => ({
                startedDateTime: `2026-11-03T20:0${index}:00.000Z`,
                request: {
                    method: answer.method ?? "GET",
                    url: API,
                    headers: [
                        { name: ":authority", value: "oa-api.streamyard.com" },
                        { name: "authorization", value: "Bearer test-token" },
                        { name: "user-agent", value: "TestAgent/1.0" },
                        { name: "referer", value: "https://streamyard.com/" },
                    ],
                },
                response: {
                    status: 200,
                    content: {
                        mimeType: "application/json",
                        text: SafeJSON.stringify(
                            { id: "abc123", title: "Day 3", status: answer.status, ...answer.extra },
                            { strict: true }
                        ),
                    },
                },
            })),
        },
    });
}

describe("streamyard provider", () => {
    it("finds the webinar with the newest answer and the player's headers", () => {
        const events = streamyard.find(
            harWith([
                { status: "live", extra: { watchUrl: "https://cdn.example.com/live/x/master.m3u8" } },
                { status: "complete" },
            ])
        );

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            provider: "streamyard",
            id: "abc123",
            title: "Day 3",
            capturedStatus: "complete",
            page: "https://example.com/event/3",
        });
        expect(events[0].request.headers.authorization).toBe("Bearer test-token");
        expect(events[0].request.headers[":authority"]).toBeUndefined();
    });

    it("ignores a preflight", () => {
        expect(streamyard.find(harWith([{ status: "live", method: "OPTIONS" }]))).toEqual([]);
    });

    it("maps the answer to live, recorded, pending and unavailable", () => {
        const headers = { "user-agent": "TestAgent/1.0" };
        const base = { id: "abc123" };

        expect(webinarState({ ...base, status: "live", watchUrl: "https://cdn.example.com/m.m3u8" }, headers)).toEqual({
            kind: "live",
            playlistUrl: "https://cdn.example.com/m.m3u8",
            headers,
        });
        expect(
            webinarState({ ...base, status: "complete", vodUrl: "https://vods.example.com/v.mp4" }, headers)
        ).toEqual({ kind: "recorded", url: "https://vods.example.com/v.mp4", headers });
        expect(webinarState({ ...base, status: "complete" }, headers).kind).toBe("pending");
        expect(webinarState({ ...base, status: "scheduled" }, headers).kind).toBe("pending");
        expect(webinarState({ ...base, status: "complete", isVodEnabled: false }, headers).kind).toBe("unavailable");
        expect(webinarState({ ...base, status: "complete", isVodMediaDeleted: true }, headers).kind).toBe(
            "unavailable"
        );
    });

    it("names the recording after the page, the title and the event", () => {
        const [event] = streamyard.find(harWith([{ status: "complete" }]));

        expect(recordingOutputName(event)).toBe("example-com-event-3-Day-3-abc123.mp4");
    });
});
