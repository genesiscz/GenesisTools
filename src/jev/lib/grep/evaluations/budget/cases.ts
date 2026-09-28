/**
 * Behavior questions about this checkout with the files that answer them, checked by hand on
 * 2026-09-28. A case passes when one `gold` file comes back with source within the first five bullets.
 */
export interface GoldCase {
    id: string;
    query: string;
    root: string;
    /** Any one of these answers the question. */
    gold: string[];
}

export const GOLD_CASES: readonly GoldCase[] = [
    {
        id: "tools-control",
        query: "Where is tools control implemented command?",
        root: ".",
        gold: ["src/control/index.ts"],
    },
    {
        id: "grep-cache-key",
        query: "How is the answer cache key for a Jev grep call built?",
        root: ".",
        gold: ["src/jev/lib/grep/cache.ts"],
    },
    {
        id: "sigint-forward",
        query: "Where is a Ctrl-C forwarded from the tools wrapper to the running tool process?",
        root: ".",
        gold: ["tools", "src/macos/GenesisTools/Sources/Launcher.swift"],
    },
    {
        id: "usage-cost",
        query: "Where is the dollar cost of an AI call computed when the call is recorded in the usage ledger?",
        root: ".",
        gold: ["src/utils/ai/usage/record.ts"],
    },
    {
        id: "port-listen",
        query: "How does tools port find which process is listening on a port?",
        root: ".",
        gold: ["src/port/lib/scanner.ts"],
    },
    {
        id: "say-profile",
        query: "Where does tools say load the voice and volume from a per-app profile?",
        root: ".",
        gold: ["src/utils/macos/SayConfigManager.ts", "src/say/index.ts"],
    },
];
