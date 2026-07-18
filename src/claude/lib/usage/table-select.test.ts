import { describe, expect, test } from "bun:test";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { buildFrameParts, renderFrame } from "@genesiscz/utils/prompts/clack/table-select";
import { stripAnsi } from "@genesiscz/utils/string";
import type { ScoredAccount } from "./account-picker";
import { buildAccountTableOpts } from "./table-select";

const NOW = new Date("2026-07-18T12:00:00");
const in2h = new Date(NOW.getTime() + 2 * 3600e3).toISOString();
const in38h = new Date(NOW.getTime() + 38 * 3600e3).toISOString();

function scoredAccount(name: string, tier: ScoredAccount["tier"], limits: ScoredAccount["limits"]): ScoredAccount {
    return {
        accountName: name,
        tier,
        weeklyRatePctPerHour: 1,
        sessionHeadroomPct: 50,
        weeklyHeadroomPct: 50,
        sessionUsableFraction: 1,
        why: "why-line",
        limits,
    };
}

const SCORED: ScoredAccount[] = [
    scoredAccount("ohfixit", "ready", {
        session: { leftPct: 100, resetsAt: in2h },
        weekly: { leftPct: 99, resetsAt: in38h },
        fable: { leftPct: 98, resetsAt: in38h },
    }),
    scoredAccount("lpreservine", "weekly-blocked", {
        session: { leftPct: 100, resetsAt: null },
        weekly: { leftPct: 20, resetsAt: in38h },
        fable: { leftPct: 0, resetsAt: null },
    }),
];

const ACCOUNTS = new Map<string, AIAccountEntry>([
    [
        "ohfixit",
        {
            name: "ohfixit",
            provider: "anthropic-sub",
            tokens: {},
            label: "max",
            secondary: {
                accessToken: "at",
                refreshToken: "rt",
                emailAddress: "ohfixit@gmail.com",
            },
        },
    ],
]);

const OPTS = buildAccountTableOpts({ message: "Launch as?", scored: SCORED, accountsByName: ACCOUNTS }, NOW);

describe("account table select frame", () => {
    test("active frame: labeled headers, coarse resets, focus pointer", () => {
        const parts = buildFrameParts(OPTS);
        const frame = stripAnsi(renderFrame(OPTS, parts, "active", 0));

        expect(frame).toContain("RESETS 5H·WL");
        expect(frame).toContain("2h · 38h");
        expect(frame).toContain("— · 38h");
        expect(frame).toContain("❯");
    });

    test("detail zone: identity, plan + why line, 3-column limit table", () => {
        const parts = buildFrameParts(OPTS);
        const frame = stripAnsi(renderFrame(OPTS, parts, "active", 0));

        expect(frame).toContain("ohfixit@gmail.com");
        expect(frame).toContain("Max subscription · why-line");
        expect(frame).toContain("5 Hour");
        expect(frame).toContain("Weekly");
        expect(frame).toContain("Fable");
        expect(frame).toContain("in 2h"); // 5h reset
        expect(frame).toContain("= weekly"); // fable shares the weekly reset
        expect(frame).toContain("█"); // headroom bars
    });

    test("detail zone follows the cursor with fixed height", () => {
        const parts = buildFrameParts(OPTS);
        const frame0 = stripAnsi(renderFrame(OPTS, parts, "active", 0));
        const frame1 = stripAnsi(renderFrame(OPTS, parts, "active", 1));

        expect(frame1).not.toContain("ohfixit@gmail.com");
        expect(frame1).toContain("Subscription · why-line");
        expect(frame0.split("\n").length).toBe(frame1.split("\n").length);
    });

    test("focused row name carries the accent color", () => {
        const parts = buildFrameParts(OPTS);
        const frame = renderFrame(OPTS, parts, "active", 1);
        expect(frame).toContain("\x1b[1;38;5;75mlpreservine\x1b[22;39m");
    });

    test("submit frame collapses to the picked name", () => {
        const parts = buildFrameParts(OPTS);
        const frame = stripAnsi(renderFrame(OPTS, parts, "submit", 1));
        expect(frame).toContain("lpreservine");
        expect(frame).not.toContain("RESETS");
    });
});
