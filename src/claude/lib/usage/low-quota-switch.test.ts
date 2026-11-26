import { describe, expect, test } from "bun:test";
import type { AccountUsage, UsageResponse } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/api";
import { lowQuotaHit, switchRelaunch, withoutSessionArgs } from "./low-quota-switch";

const NOW = new Date("2026-11-25T18:00:00Z");
const IN_2H = "2026-11-25T20:00:00Z";
const IN_3D = "2026-11-28T18:00:00Z";
const SETTING = { fiveHourLeftBelowPct: 10, weeklyLeftBelowPct: 5 };

function account(usage: Partial<UsageResponse>): AccountUsage {
    return {
        accountName: "work",
        usage: {
            five_hour: { utilization: 20, resets_at: IN_2H },
            seven_day: { utilization: 30, resets_at: IN_3D },
            ...usage,
        } as UsageResponse,
    };
}

describe("when the question is asked", () => {
    test("a 5-hour window with 7% left is under 10%", () => {
        const hit = lowQuotaHit({
            usage: account({ five_hour: { utilization: 93, resets_at: IN_2H } }),
            setting: SETTING,
            now: NOW,
        });

        expect(hit).toEqual({ window: "five-hour", leftPct: 7, belowPct: 10, resetsAt: IN_2H });
    });

    test("NEGATIVE CONTROL: 15% of the 5-hour window and 70% of the week ask nothing", () => {
        const usage = account({ five_hour: { utilization: 85, resets_at: IN_2H } });

        expect(lowQuotaHit({ usage, setting: SETTING, now: NOW })).toBeNull();
    });

    test("the weekly limit is named before the 5-hour window when both are low", () => {
        const usage = account({
            five_hour: { utilization: 95, resets_at: IN_2H },
            seven_day: { utilization: 97, resets_at: IN_3D },
        });

        expect(lowQuotaHit({ usage, setting: SETTING, now: NOW })).toMatchObject({ window: "weekly", leftPct: 3 });
    });

    test("the Fable weekly limit counts only for a Fable session", () => {
        const usage = account({
            limits: [
                { kind: "weekly_all", percent: 40, resets_at: IN_3D },
                { kind: "weekly_scoped", percent: 98, resets_at: IN_3D, scope: { model: { display_name: "Fable" } } },
            ],
        } as Partial<UsageResponse>);

        expect(lowQuotaHit({ usage, modelFamily: "fable", setting: SETTING, now: NOW })).toMatchObject({
            window: "fable-weekly",
            leftPct: 2,
        });
        expect(lowQuotaHit({ usage, modelFamily: "opus", setting: SETTING, now: NOW })).toBeNull();
    });

    test("a 5-hour window whose reset already passed is a fresh window", () => {
        const usage = account({ five_hour: { utilization: 99, resets_at: "2026-11-25T17:00:00Z" } });

        expect(lowQuotaHit({ usage, setting: SETTING, now: NOW })).toBeNull();
    });

    test("an account without usage data asks nothing", () => {
        expect(lowQuotaHit({ usage: { accountName: "work" }, setting: SETTING, now: NOW })).toBeNull();
        expect(lowQuotaHit({ usage: undefined, setting: SETTING, now: NOW })).toBeNull();
    });
});

describe("the relaunch after a yes", () => {
    test("every flag that names a session is taken out, and the other flags stay in order", () => {
        expect(
            withoutSessionArgs(["--resume", "abc", "--settings", "{}", "-c", "--session-id", "x", "--model", "opus"])
        ).toEqual(["--settings", "{}", "--model", "opus"]);
        expect(withoutSessionArgs(["--resume", "--model", "opus"])).toEqual(["--model", "opus"]);
        expect(withoutSessionArgs(["--continue", "--", "--continue"])).toEqual(["--", "--continue"]);
        expect(withoutSessionArgs(["--resume=abc", "-r", "def", "--fork-session", "--effort", "high"])).toEqual([
            "--effort",
            "high",
        ]);
    });

    test("a known session resumes through the account picker, and the other options stay", () => {
        const next = switchRelaunch({
            opts: { resume: "abc", keychain: true, model: "opus", autopick: true },
            passthrough: ["--settings", "{}", "--resume", "old"],
            sessionId: "new-session",
        });

        expect(next.opts).toEqual({
            resume: undefined,
            continue: undefined,
            keychain: true,
            model: "opus",
            pick: true,
            autopick: undefined,
        });
        expect(next.passthrough).toEqual(["--resume", "new-session", "--settings", "{}"]);
    });

    test("an unknown session opens the folder's session picker after the account picker", () => {
        const next = switchRelaunch({ opts: { continue: true }, passthrough: ["-c"], sessionId: null });

        expect(next.opts).toMatchObject({ resume: true, continue: undefined, pick: true });
        expect(next.passthrough).toEqual([]);
    });
});
