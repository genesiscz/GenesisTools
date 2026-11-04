import type { WatchingDto } from "@dd/contract";

// Invented watches for the mock agent and the tests: names, products and symbols are made up.
export const MOCK_WATCHING: WatchingDto = {
    generatedAt: "2026-10-01T12:00:00.000Z",
    sources: [
        { id: "monitor", label: "Monitor", count: 2, note: null },
        { id: "domains", label: "Domains", count: 1, note: null },
        { id: "shops", label: "Shops", count: 1, note: null },
        { id: "tradingview", label: "TradingView", count: 0, note: "Signed out of TradingView (tools tradingview login)." },
        { id: "hotels", label: "Hotels", count: 0, note: "Saved hotel searches live on a local-only branch." },
    ],
    rows: [
        {
            source: "monitor",
            id: "3",
            title: "shop api",
            state: "down",
            detail: "503 Service Unavailable · 210 ms",
            changedAt: "2026-10-01T11:40:00.000Z",
            link: null,
            mutedUntil: null,
            canMute: true,
        },
        {
            source: "monitor",
            id: "7",
            title: "Watchdogs",
            state: "ok",
            detail: "Phone costs 900 (watching below 1000)",
            changedAt: "2026-10-01T09:15:00.000Z",
            link: "https://shop.example/phone",
            mutedUntil: null,
            canMute: true,
        },
        {
            source: "shops",
            id: "12",
            title: "Espresso grinder",
            state: "alert",
            detail: "189.00 at shop-a · target 199.00 · -8.2%",
            changedAt: "2026-10-01T08:00:00.000Z",
            link: null,
            mutedUntil: null,
            canMute: false,
        },
        {
            source: "domains",
            id: "example-name.dev",
            title: "example-name.dev",
            state: "ok",
            detail: "taken · expires in 120 days",
            changedAt: "2026-09-30T20:00:00.000Z",
            link: "https://example-name.dev",
            mutedUntil: null,
            canMute: false,
        },
    ],
};
