import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJournalRecovery } from "./subscription-auth";

/**
 * The journal is the last resort when a config write is lost mid-rotation, so
 * these tests pin the property that matters: the live pair stays READABLE.
 * Redacting or encrypting it would trade a real recovery path for cosmetic
 * hygiene, and the master key is exactly what may be unavailable then.
 */

let home: string;

function journalPath(): string {
    return join(home, ".genesis-tools", "ai", "token-journal.jsonl");
}

function writeJournal(entries: Array<Record<string, unknown>>): void {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(journalPath(), `${entries.map((entry) => SafeJSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
}

function entry(account: string, suffix: string, ts = new Date().toISOString()): Record<string, unknown> {
    return {
        ts,
        account,
        oldAccessToken: `sk-ant-oat01-old-${suffix}`,
        oldRefreshToken: `sk-ant-ort01-old-${suffix}`,
        newAccessToken: `sk-ant-oat01-new-${suffix}`,
        newRefreshToken: `sk-ant-ort01-new-${suffix}`,
        newExpiresAt: 1785312000000,
    };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-journal-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("token journal recovery", () => {
    test("returns the newest journaled pair when the failed token differs", () => {
        writeJournal([entry("martin-max", "1"), entry("martin-max", "2")]);

        const recovered = readJournalRecovery("martin-max", "sk-ant-ort01-consumed");

        expect(recovered?.refreshToken).toBe("sk-ant-ort01-new-2");
        expect(recovered?.accessToken).toBe("sk-ant-oat01-new-2");
    });

    test("returns nothing when the journaled token is the one that just failed", () => {
        writeJournal([entry("martin-max", "1")]);

        expect(readJournalRecovery("martin-max", "sk-ant-ort01-new-1")).toBeNull();
    });

    test("ignores other accounts", () => {
        writeJournal([entry("someone-else", "9")]);

        expect(readJournalRecovery("martin-max", "sk-ant-ort01-consumed")).toBeNull();
    });

    test("token values are stored readable, not redacted, or recovery is impossible", () => {
        writeJournal([entry("martin-max", "1")]);

        const text = readFileSync(journalPath(), "utf8");
        expect(text).toContain("sk-ant-ort01-new-1");
        expect(statSync(journalPath()).mode & 0o777).toBe(0o600);
    });
});
