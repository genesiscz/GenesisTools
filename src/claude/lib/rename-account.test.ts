import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { env } from "@genesiscz/utils/env";
import { removeDbFile } from "@genesiscz/utils/fs";
import type { WarmupConfig } from "./config";
import { renameClaudeAccount, resolveRenameTo, rewriteWarmupNames } from "./rename-account";
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
