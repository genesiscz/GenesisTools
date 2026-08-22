import { expect, test } from "bun:test";
import { registerUsageCommand } from "@app/claude/commands/usage";
import { Command } from "commander";
import { scoreAccounts, sortGrouped } from "./account-picker";
import type { AccountUsage } from "./api";

const fixture: AccountUsage[] = [
    {
        accountName: "lemon",
        label: "Max",
        usage: {
            five_hour: { utilization: 18, resets_at: "2099-01-01T00:00:00.000Z" },
            seven_day: { utilization: 39, resets_at: "2099-01-08T00:00:00.000Z" },
            limits: [
                {
                    kind: "session",
                    percent: 18,
                    severity: "ok",
                    resets_at: "2099-01-01T00:00:00.000Z",
                    scope: null,
                    is_active: true,
                },
                {
                    kind: "weekly_all",
                    percent: 39,
                    severity: "ok",
                    resets_at: "2099-01-08T00:00:00.000Z",
                    scope: null,
                    is_active: true,
                },
                {
                    kind: "weekly_scoped",
                    percent: 58,
                    severity: "ok",
                    resets_at: "2099-01-08T00:00:00.000Z",
                    scope: { model: { id: "claude-fable-5", display_name: "Fable" }, surface: null },
                    is_active: true,
                },
            ],
        },
    },
];

test("scored json keeps group and compact limits", () => {
    const scored = sortGrouped(scoreAccounts(fixture));
    expect(scored[0]?.accountName).toBe("lemon");
    expect(scored[0]?.group).toBe("fable");
    expect(scored[0]?.limits?.session?.leftPct).toBe(82);
});

test("usage --help lists --scored", () => {
    const program = new Command();
    program.exitOverride();
    registerUsageCommand(program);
    const usage = program.commands.find((c) => c.name() === "usage");
    expect(usage?.helpInformation()).toContain("--scored");
});
