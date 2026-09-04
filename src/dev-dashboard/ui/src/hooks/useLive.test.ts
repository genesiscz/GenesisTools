import { describe, expect, test } from "bun:test";
import type { LiveChannel } from "@app/dev-dashboard/lib/live/types";
import { AI_USAGE_KEYS, channelsFromKey, liveChannelsKey } from "./useLive";

/**
 * The reconnect storm (sweep 2026-09-04) was an effect that depended on the
 * `channels` ARRAY. Every caller passes a fresh literal, so the dependency
 * changed on every render and the EventSource was rebuilt about eight times a
 * second. The effect now depends on this key, so these tests pin the two
 * properties that make that safe: equal content gives an equal key regardless
 * of identity or order, and the key still round-trips to the URL channels.
 */
describe("liveChannelsKey", () => {
    test("two distinct arrays with the same channels give the same key", () => {
        expect(liveChannelsKey(["ai-usage"])).toBe(liveChannelsKey(["ai-usage"]));
    });

    test("order does not change the key", () => {
        const a: LiveChannel[] = ["ai-usage", "ports"];
        const b: LiveChannel[] = ["ports", "ai-usage"];

        expect(liveChannelsKey(a)).toBe(liveChannelsKey(b));
    });

    test("a different channel set gives a different key", () => {
        expect(liveChannelsKey(["ai-usage"])).not.toBe(liveChannelsKey(["ai-usage", "pulse"]));
    });

    test("sorting the input does not mutate the caller's array", () => {
        const channels: LiveChannel[] = ["ports", "ai-usage"];
        liveChannelsKey(channels);

        expect(channels).toEqual(["ports", "ai-usage"]);
    });
});

/** React Query matches a query key by prefix, which is the whole point here. */
function invalidatedBy(prefix: readonly string[], key: readonly unknown[]): boolean {
    return prefix.every((part, i) => key[i] === part);
}

function invalidatedByPoll(key: readonly unknown[]): boolean {
    return AI_USAGE_KEYS.some((prefix) => invalidatedBy(prefix, key));
}

describe("AI_USAGE_KEYS", () => {
    test("a poll refreshes the limit windows, the account list and the poller", () => {
        expect(invalidatedByPoll(["ai", "usage", "openai-sub", ""])).toBe(true);
        expect(invalidatedByPoll(["ai", "usage", "series", "from", "to"])).toBe(true);
        expect(invalidatedByPoll(["ai", "accounts"])).toBe(true);
        expect(invalidatedByPoll(["ai", "daemon"])).toBe(true);
    });

    test("a poll does NOT refresh recorded spend, which costs a transcript scan", () => {
        expect(invalidatedByPoll(["ai", "spend", "totals", "from", "to"])).toBe(false);
        expect(invalidatedByPoll(["ai", "spend", "series", "from", "to"])).toBe(false);
    });

    test("no prefix is the bare `ai`, which would match everything again", () => {
        expect(AI_USAGE_KEYS.every((prefix) => prefix.length > 1)).toBe(true);
    });
});

describe("channelsFromKey", () => {
    test("round-trips a subscription", () => {
        expect(channelsFromKey(liveChannelsKey(["ai-usage", "ports"]))).toEqual(["ai-usage", "ports"]);
    });

    test("an empty key means no channels, not one empty channel", () => {
        expect(channelsFromKey(liveChannelsKey([]))).toEqual([]);
    });
});
