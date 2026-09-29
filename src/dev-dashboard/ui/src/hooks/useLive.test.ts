import { describe, expect, test } from "bun:test";
import type { LiveChannel } from "@app/dev-dashboard/lib/live/types";
import { SafeJSON } from "@genesiscz/utils/json";
import type { QueryClient } from "@tanstack/react-query";
import {
    AI_USAGE_KEYS,
    channelsFromKey,
    type LiveConnectionDeps,
    liveChannelsKey,
    openLiveConnection,
} from "./useLive";

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

/** Stands in for the browser `EventSource`: no network, just `onmessage`/`onerror`/`close`. */
class FakeEventSource {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    readonly url: string;

    constructor(url: string | URL) {
        this.url = String(url);
    }

    close(): void {
        this.closed = true;
    }

    hello(connId: string): void {
        this.onmessage?.({
            data: SafeJSON.stringify({ channel: "system", type: "hello", payload: { connId } }),
        } as MessageEvent);
    }
}

function fakeDeps(
    created: FakeEventSource[]
): LiveConnectionDeps & { connId: () => string | null; lastError: () => string | null } {
    let connId: string | null = null;
    let lastError: string | null = null;
    const connIdRef = { current: null as string | null };

    return {
        qc: { setQueryData: () => {}, invalidateQueries: async () => {} } as unknown as QueryClient,
        connIdRef,
        setConnId: (id) => {
            connId = id;
        },
        setLastError: (message) => {
            lastError = message;
        },
        connId: () => connId,
        lastError: () => lastError,
        EventSourceCtor: class extends FakeEventSource {
            constructor(url: string | URL) {
                super(url);
                created.push(this);
            }
        } as unknown as typeof EventSource,
    };
}

/**
 * Pins the idle-cost behavior a hidden tab must not defeat: the tab-visibility test the review
 * asked for, run against `openLiveConnection` instead of a rendered hook, since this package has
 * no DOM/hook renderer to mount `useLive` itself in (the `liveChannelsKey` tests above cover the
 * rest of this file the same way, against a pure helper rather than a render).
 */
describe("openLiveConnection", () => {
    test("hiding the tab closes the sole EventSource and clears the connection id", () => {
        const created: FakeEventSource[] = [];
        const deps = fakeDeps(created);

        const cleanup = openLiveConnection("ports", true, deps);
        created[0]?.hello("conn-1");
        expect(deps.connId()).toBe("conn-1");
        expect(deps.connIdRef.current).toBe("conn-1");

        cleanup?.();
        expect(created[0]?.closed).toBe(true);
        expect(deps.connId()).toBeNull();
        expect(deps.connIdRef.current).toBeNull();
    });

    test("a hidden tab opens no connection at all", () => {
        const created: FakeEventSource[] = [];
        const cleanup = openLiveConnection("ports", false, fakeDeps(created));

        expect(cleanup).toBeUndefined();
        expect(created).toHaveLength(0);
    });

    test("becoming visible again opens a fresh EventSource, not the closed one", () => {
        const created: FakeEventSource[] = [];
        const deps = fakeDeps(created);

        const first = openLiveConnection("ports", true, deps);
        first?.();
        openLiveConnection("ports", true, deps);

        expect(created).toHaveLength(2);
        expect(created[0]?.closed).toBe(true);
        expect(created[1]?.closed).toBe(false);
    });

    test("after a reconnect the connection id is stale until a fresh hello arrives", () => {
        const created: FakeEventSource[] = [];
        const deps = fakeDeps(created);

        const first = openLiveConnection("ports", true, deps);
        created[0]?.hello("conn-1");
        first?.();

        openLiveConnection("ports", true, deps);
        // The cleanup already cleared connIdRef; a caller (setChannels) reading it right after
        // reconnect and before the next `hello` correctly sees "not connected yet", not the stale id.
        expect(deps.connIdRef.current).toBeNull();

        created[1]?.hello("conn-2");
        expect(deps.connIdRef.current).toBe("conn-2");
    });

    test("no channel subscribed opens no connection either", () => {
        const created: FakeEventSource[] = [];
        const cleanup = openLiveConnection("", true, fakeDeps(created));

        expect(cleanup).toBeUndefined();
        expect(created).toHaveLength(0);
    });
});
