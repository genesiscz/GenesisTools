import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { clearInvalidGrant, readJournalRecovery } from "./subscription-auth";

const HOME = join(tmpdir(), `sub-auth-test-${process.pid}`);
const JOURNAL = join(HOME, ".genesis-tools", "ai", "token-journal.jsonl");

function writeJournal(lines: object[]): void {
    writeFileSync(JOURNAL, `${lines.map((l) => SafeJSON.stringify(l)).join("\n")}\n`);
}

describe("readJournalRecovery", () => {
    beforeEach(() => {
        mkdirSync(join(HOME, ".genesis-tools", "ai"), { recursive: true });
        env.testing.set("GENESIS_TOOLS_HOME", HOME);
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        rmSync(HOME, { recursive: true, force: true });
    });

    it("returns the newest journaled pair when it differs from the consumed token", () => {
        writeJournal([
            { ts: "t1", account: "acc", newAccessToken: "at-old", newRefreshToken: "rt-old", newExpiresAt: 1 },
            { ts: "t2", account: "other", newAccessToken: "x", newRefreshToken: "y", newExpiresAt: 2 },
            { ts: "t3", account: "acc", newAccessToken: "at-new", newRefreshToken: "rt-new", newExpiresAt: 3 },
        ]);

        expect(readJournalRecovery("acc", "rt-consumed")).toEqual({
            accessToken: "at-new",
            refreshToken: "rt-new",
            expiresAt: 3,
        });
    });

    it("returns null when the newest journaled token IS the consumed one (grant genuinely dead)", () => {
        writeJournal([{ ts: "t1", account: "acc", newAccessToken: "at", newRefreshToken: "rt-consumed" }]);

        expect(readJournalRecovery("acc", "rt-consumed")).toBeNull();
    });

    it("returns null when the account has no journal entries", () => {
        writeJournal([{ ts: "t1", account: "other", newRefreshToken: "rt" }]);

        expect(readJournalRecovery("acc", "rt-consumed")).toBeNull();
    });

    it("returns null when the journal file does not exist", () => {
        rmSync(JOURNAL, { force: true });

        expect(readJournalRecovery("acc", "rt-consumed")).toBeNull();
    });

    it("skips malformed lines and still finds the newest valid entry", () => {
        writeFileSync(
            JOURNAL,
            [
                SafeJSON.stringify({
                    ts: "t1",
                    account: "acc",
                    newAccessToken: "at",
                    newRefreshToken: "rt-good",
                    newExpiresAt: 9,
                }),
                "{not json",
            ].join("\n")
        );

        expect(readJournalRecovery("acc", "rt-consumed")).toEqual({
            accessToken: "at",
            refreshToken: "rt-good",
            expiresAt: 9,
        });
    });
});

describe("invalid_grant cooldown persistence", () => {
    const COOLDOWN = join(HOME, ".genesis-tools", "ai", "invalid-grant.json");

    beforeEach(() => {
        mkdirSync(join(HOME, ".genesis-tools", "ai"), { recursive: true });
        env.testing.set("GENESIS_TOOLS_HOME", HOME);
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        rmSync(HOME, { recursive: true, force: true });
    });

    function readCooldowns(): Record<string, number> {
        return SafeJSON.parse(readFileSync(COOLDOWN, "utf8")) as Record<string, number>;
    }

    it("drops only the named account and leaves the others cooled down", async () => {
        writeFileSync(COOLDOWN, SafeJSON.stringify({ dead: 1000, "still-dead": 2000 }) ?? "{}");

        await clearInvalidGrant("dead");

        expect(readCooldowns()).toEqual({ "still-dead": 2000 });
    });

    // The real race is CROSS-PROCESS: usage polling runs as a fresh process per minute
    // while `tools claude login` clears cooldowns from another terminal. The unlocked
    // read-modify-write this replaced lost updates there — every writer read the same
    // object and the last write discarded the others' deletes.
    it("does not lose updates when separate processes clear different accounts at once", async () => {
        const accounts = ["a", "b", "c", "d"];
        writeFileSync(COOLDOWN, SafeJSON.stringify({ a: 1, b: 2, c: 3, d: 4, keep: 5 }) ?? "{}");

        const script = `
            const { clearInvalidGrant } = await import(${SafeJSON.stringify(import.meta.dir)} + "/subscription-auth.ts");
            await clearInvalidGrant(process.argv[1]);
        `;

        const workers = accounts.map((account) =>
            Bun.spawn(["bun", "-e", script, "--", account], {
                env: { ...process.env, GENESIS_TOOLS_HOME: HOME },
                stdio: ["ignore", "ignore", "pipe"],
            })
        );

        const exits = await Promise.all(workers.map((w) => w.exited));
        expect(exits).toEqual([0, 0, 0, 0]);

        expect(readCooldowns()).toEqual({ keep: 5 });
    }, 30_000);

    it("is a no-op when the account has no cooldown, leaving the file untouched", async () => {
        writeFileSync(COOLDOWN, SafeJSON.stringify({ other: 5 }) ?? "{}");

        await clearInvalidGrant("never-failed");

        expect(readCooldowns()).toEqual({ other: 5 });
    });

    it("treats a missing cooldown file as empty and writes nothing", async () => {
        rmSync(COOLDOWN, { force: true });

        await clearInvalidGrant("acc");

        expect(() => readFileSync(COOLDOWN, "utf8")).toThrow();
    });

    it("survives a corrupt cooldown file instead of throwing at the caller", async () => {
        writeFileSync(COOLDOWN, "{ not json");

        await clearInvalidGrant("acc");

        expect(readFileSync(COOLDOWN, "utf8")).toBe("{ not json");
    });
});
