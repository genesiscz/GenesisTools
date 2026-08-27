import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { env } from "@genesiscz/utils/env";
import { removeDbFile } from "@genesiscz/utils/fs";
import type { WarmupConfig } from "./config";
import {
    partialRenameAdvice,
    rekeyNamedRecord,
    renameClaudeAccount,
    resolveRenameTo,
    rewriteWarmupNames,
} from "./rename-account";
import { UsageHistoryDb } from "./usage/history-db";

describe("resolveRenameTo", () => {
    test("non-interactive with no new name requires --to", () => {
        expect(resolveRenameTo({ interactive: false })).toEqual({ error: "to-required" });
    });

    test("non-interactive accepts --to", () => {
        expect(resolveRenameTo({ interactive: false, toFlag: "work@shop" })).toEqual({
            name: "work@shop",
        });
    });

    test("a positional new name is enough in non-interactive mode", () => {
        expect(resolveRenameTo({ interactive: false, positional: "work@shop" })).toEqual({
            name: "work@shop",
        });
    });

    test("--to wins over the positional name", () => {
        // Nothing pinned the precedence, so flipping `toFlag ?? positional`
        // would have stayed green.
        expect(resolveRenameTo({ interactive: false, toFlag: "flag-name", positional: "positional-name" })).toEqual({
            name: "flag-name",
        });
    });

    test("interactive with no name asks", () => {
        expect(resolveRenameTo({ interactive: true })).toEqual({ error: "prompt" });
    });
});

describe("rewriteWarmupNames", () => {
    test("rewrites session, weekly, and today's log to the new name", () => {
        const warmup: WarmupConfig = {
            session: {
                enabled: true,
                accounts: ["work-max", "work", "shop"],
                schedule: { startHour: 6, endHour: 22 },
                notify: true,
                notifyOnlyIfUnused: true,
            },
            weekly: {
                enabled: true,
                accounts: ["work", "personal"],
                notify: true,
            },
            todayLog: {
                date: "2026-08-26",
                events: [
                    { account: "work", type: "weekly", time: "06:00", success: true },
                    { account: "personal", type: "weekly", time: "06:01", success: true },
                ],
            },
        };

        const next = rewriteWarmupNames(warmup, "work", "work@shop");

        expect(next.session.accounts).toEqual(["work-max", "work@shop", "shop"]);
        expect(next.weekly.accounts).toEqual(["work@shop", "personal"]);
        expect(next.todayLog.events.map((e) => e.account)).toEqual(["work@shop", "personal"]);
        expect(warmup.weekly.accounts).toEqual(["work", "personal"]);
    });
});

describe("renameClaudeAccount", () => {
    let home: string;
    let dbPath: string;
    let db: UsageHistoryDb;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "gt-rename-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        AIConfig.invalidate();
        ClaudeDatabase.closeInstance();
        dbPath = join(home, "history.sqlite");
        db = new UsageHistoryDb(dbPath);
    });

    afterEach(() => {
        db.close();
        removeDbFile(dbPath);
        env.testing.unset("GENESIS_TOOLS_HOME");
        AIConfig.invalidate();
        ClaudeDatabase.closeInstance();
        rmSync(home, { recursive: true, force: true });
    });

    test("moves the account, its default, its history, and its warmup slot", async () => {
        const config = await AIConfig.load();
        await config.addAccount({
            name: "work",
            provider: "anthropic-sub",
            tokens: { accessToken: "atok" },
        });
        await config.setDefaultAccount("claude", "work");
        db.recordSnapshot("work", "five_hour", 42, new Date().toISOString());

        let warmup: WarmupConfig = {
            session: {
                enabled: false,
                accounts: [],
                schedule: { startHour: 6, endHour: 22 },
                notify: false,
                notifyOnlyIfUnused: false,
            },
            weekly: { enabled: true, accounts: ["work-max", "work"], notify: true },
            todayLog: { date: "", events: [] },
        };
        let cacheDropped = false;

        const moved = await renameClaudeAccount("work", "work@shop", {
            renameHistory: (oldName, newName) => db.renameAccount(oldName, newName),
            rewriteWarmup: async (oldName, newName) => {
                warmup = rewriteWarmupNames(warmup, oldName, newName);
            },
            rekeyPollGate: async () => {},
            rekeyInvalidGrant: async () => {},
            invalidateUsageCache: async () => {
                cacheDropped = true;
            },
        });

        expect(moved.historyRows).toBe(1);
        expect(config.getAccount("work")).toBeUndefined();
        expect(config.getAccount("work@shop")?.tokens.accessToken).toBe("atok");
        expect(config.getDefaultAccount("claude")?.name).toBe("work@shop");
        expect(db.getSnapshots("work@shop", "five_hour", 60)).toHaveLength(1);
        expect(db.getSnapshots("work", "five_hour", 60)).toHaveLength(0);
        expect(warmup.weekly.accounts).toEqual(["work-max", "work@shop"]);
        expect(cacheDropped).toBe(true);
    });
});

describe("rekeyNamedRecord", () => {
    test("moves the key and leaves every other entry alone", () => {
        // The poll gate and invalid-grant cooldown are the two steps whose real
        // implementations rewrite JSON files; the rename test stubs both with
        // no-ops, so this covers the shared key-move directly.
        const gate = { work: { at: 1 }, personal: { at: 2 } };

        expect(rekeyNamedRecord(gate, "work", "work@shop")).toEqual({ "work@shop": { at: 1 }, personal: { at: 2 } });
    });

    test("a missing old key is a no-op, not an undefined entry", () => {
        expect(rekeyNamedRecord({ personal: { at: 2 } }, "ghost", "new")).toEqual({ personal: { at: 2 } });
    });
});

describe("partialRenameAdvice", () => {
    test("names the reverse rename rather than only the dead end", () => {
        const advice = partialRenameAdvice("work", "work@shop");

        expect(advice.join("\n")).toContain("tools claude config rename work@shop --to work");
        expect(advice[0]).toContain('AIConfig no longer knows "work"');
    });
});

describe("renameClaudeAccount partial failure", () => {
    test("a failing secondary step is reported, not swallowed or fatal", async () => {
        // Before this, one throw left the account renamed in AIConfig while the
        // other stores still held oldName — a state no retry can repair.
        const moved = await renameClaudeAccount("work", "work@shop", {
            renameAiAccount: async () => {},
            renameHistory: () => 3,
            rewriteWarmup: async () => {
                throw new Error("warmup file is locked");
            },
            rekeyPollGate: async () => {},
            rekeyInvalidGrant: async () => {},
            invalidateUsageCache: async () => {},
        });

        expect(moved.historyRows).toBe(3);
        expect(moved.failed).toEqual([{ step: "warmup", error: "warmup file is locked" }]);
    });

    test("a failing history migration is reported like every other secondary store", async () => {
        // renameHistory ran outside the guarded loop, so a locked SQLite file threw
        // after AIConfig was already renamed and skipped every remaining step.
        const ran: string[] = [];
        const moved = await renameClaudeAccount("work", "work@shop", {
            renameAiAccount: async () => {},
            renameHistory: () => {
                throw new Error("database is locked");
            },
            rewriteWarmup: async () => {
                ran.push("warmup");
            },
            rekeyPollGate: async () => {
                ran.push("pollGate");
            },
            rekeyInvalidGrant: async () => {
                ran.push("invalidGrant");
            },
            invalidateUsageCache: async () => {
                ran.push("usageCache");
            },
        });

        expect(moved.failed).toEqual([{ step: "history", error: "database is locked" }]);
        expect(moved.historyRows).toBe(0);
        // The later stores must still be migrated rather than skipped.
        expect(ran).toEqual(["warmup", "pollGate", "invalidGrant", "usageCache"]);
    });

    test("a clean rename reports no failures", async () => {
        const moved = await renameClaudeAccount("work", "work@shop", {
            renameAiAccount: async () => {},
            renameHistory: () => 1,
            rewriteWarmup: async () => {},
            rekeyPollGate: async () => {},
            rekeyInvalidGrant: async () => {},
            invalidateUsageCache: async () => {},
        });

        expect(moved.failed).toEqual([]);
    });
});
