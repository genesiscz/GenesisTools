import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MonitorAccountSpend, MonitorReport } from "./monitor";
import { monitorEnvelope } from "./register";

/**
 * The Genesis app decodes `tools ai-spend monitor --json` with a STRICT
 * `Codable` envelope: `today.cost`, `today.tokens`, `week.cost`, `week.tokens`
 * must be numbers at exactly those paths. Extra keys are ignored by
 * `JSONDecoder`, so `accounts` may be added — but nothing may move cost into a
 * new top-level key, and nothing may make a leaf a string.
 */

function report(accounts?: MonitorAccountSpend[]): MonitorReport {
    return {
        today: { cost: 1.25, tokens: 1_200 },
        week: { cost: 9.5, tokens: 42_000 },
        todayDate: "2026-09-04",
        weekStart: "2026-08-31",
        timezone: "Europe/Prague",
        agents: {
            claude: { today: { cost: 1.25, tokens: 1_200 }, week: { cost: 9.5, tokens: 42_000 } },
            codex: { today: { cost: 0, tokens: 0 }, week: { cost: 0, tokens: 0 } },
            grok: { today: { cost: 0, tokens: 0 }, week: { cost: 0, tokens: 0 } },
        },
        accounts,
        parsedFiles: 3,
        recentFiles: 3,
    };
}

interface Leaves {
    today: { cost: unknown; tokens: unknown };
    week: { cost: unknown; tokens: unknown };
    accounts?: unknown;
}

function roundTrip(value: Record<string, unknown>): Leaves {
    return SafeJSON.parse(SafeJSON.stringify(value, { strict: true }), { strict: true }) as Leaves;
}

describe("monitor --json envelope", () => {
    test("the four Genesis leaves are numbers at their own keys", () => {
        const decoded = roundTrip(monitorEnvelope(report()));

        expect(typeof decoded.today.cost).toBe("number");
        expect(typeof decoded.today.tokens).toBe("number");
        expect(typeof decoded.week.cost).toBe("number");
        expect(typeof decoded.week.tokens).toBe("number");
        expect(decoded.today).toEqual({ cost: 1.25, tokens: 1_200 });
        expect(decoded.week).toEqual({ cost: 9.5, tokens: 42_000 });
    });

    test("an accounts breakdown rides alongside without moving the four leaves", () => {
        const accounts: MonitorAccountSpend[] = [
            {
                accountId: "claude-all",
                accountName: "claude (all accounts)",
                provider: "anthropic-sub",
                source: "claude",
                today: { cost: 1.25, tokens: 1_200 },
                week: { cost: 9.5, tokens: 42_000 },
            },
        ];
        const decoded = roundTrip(monitorEnvelope(report(accounts)));

        expect(decoded.accounts).toEqual(accounts);
        expect(decoded.today).toEqual({ cost: 1.25, tokens: 1_200 });
        expect(decoded.week).toEqual({ cost: 9.5, tokens: 42_000 });
    });

    test("the key is absent, not null, when no accounts were resolved", () => {
        expect("accounts" in monitorEnvelope(report())).toBe(false);
    });
});
