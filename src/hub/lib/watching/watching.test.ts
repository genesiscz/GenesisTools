import { describe, expect, it } from "bun:test";
import type { WatchRowDto, WatchSourceId } from "@app/dev-dashboard/contract/watching";
import { muteWatch, type WatchSource, watching } from "./index";

function row(source: WatchSourceId, id: string, state: WatchRowDto["state"], changedAt: string | null): WatchRowDto {
    return {
        source,
        id,
        title: id,
        state,
        detail: "",
        changedAt,
        link: null,
        mutedUntil: null,
        canMute: source === "monitor",
    };
}

function sources(overrides: Partial<Record<WatchSourceId, WatchSource>>): Record<WatchSourceId, WatchSource> {
    const empty: WatchSource = { label: "x", read: async () => ({ rows: [], note: null }) };
    return { monitor: empty, domains: empty, shops: empty, tradingview: empty, hotels: empty, ...overrides };
}

describe("watching", () => {
    it("lists outages and alerts first, then the newest change, and a failed source as a note", async () => {
        const result = await watching(
            sources({
                monitor: {
                    label: "Monitor",
                    read: async () => ({
                        rows: [row("monitor", "1", "ok", "2026-11-04T10:00:00Z"), row("monitor", "2", "down", null)],
                        note: null,
                    }),
                },
                shops: {
                    label: "Shops",
                    read: async () => ({ rows: [row("shops", "9", "alert", "2026-11-04T09:00:00Z")], note: null }),
                },
                domains: {
                    label: "Domains",
                    read: async () => ({ rows: [row("domains", "x.com", "ok", "2026-11-04T11:00:00Z")], note: null }),
                },
                tradingview: {
                    label: "TradingView",
                    read: () => {
                        throw new Error("signed out");
                    },
                },
            })
        );

        expect(result.rows.map((entry) => `${entry.source}:${entry.id}`)).toEqual([
            "monitor:2",
            "shops:9",
            "domains:x.com",
            "monitor:1",
        ]);
        expect(result.sources.find((source) => source.id === "tradingview")?.note).toBe("Could not read: signed out");
    });

    it("mutes through the source that has a mute, and says so for one that has none", async () => {
        const muted: Array<[string, Date | null]> = [];
        const table = sources({
            monitor: {
                label: "Monitor",
                read: async () => ({ rows: [], note: null }),
                mute: async (id, until) => {
                    muted.push([id, until]);
                    return until?.toISOString() ?? null;
                },
            },
            shops: { label: "Shops", read: async () => ({ rows: [], note: null }) },
        });

        expect((await muteWatch({ source: "monitor", id: "4", minutes: 120 }, table)).muted).toBe(true);
        expect((await muteWatch({ source: "shops", id: "9", minutes: 120 }, table)).detail).toBe(
            "Shops has no mute on the Mac."
        );
        expect(muted.map(([id]) => id)).toEqual(["4"]);
    });
});
