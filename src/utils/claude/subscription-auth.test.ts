import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJournalRecovery } from "./subscription-auth";

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
