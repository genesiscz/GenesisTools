import { describe, expect, test } from "bun:test";
import type { LiveChannel } from "@app/dev-dashboard/lib/live/types";
import { channelsFromKey, liveChannelsKey } from "./useLive";

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

describe("channelsFromKey", () => {
    test("round-trips a subscription", () => {
        expect(channelsFromKey(liveChannelsKey(["ai-usage", "ports"]))).toEqual(["ai-usage", "ports"]);
    });

    test("an empty key means no channels, not one empty channel", () => {
        expect(channelsFromKey(liveChannelsKey([]))).toEqual([]);
    });
});
