import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { tmpdir } from "@genesiscz/utils/paths";
import { historySourceKey, unresolvedHistorySourceKey } from "./identity";
import { claudePeerSession } from "./readers/claude-peer";

test("source identity collapses symlink homes while separating providers and physical homes", () => {
    const root = mkdtempSync(join(tmpdir(), "history-identity-"));
    const home = join(root, "native");
    const otherHome = join(root, "other");
    const alias = join(root, "alias");
    mkdirSync(home);
    mkdirSync(otherHome);
    symlinkSync(home, alias, "dir");
    const identity = { providerId: "fixture-sub", nativeId: "one", sourceHome: home };
    const key = historySourceKey(identity);

    expect(historySourceKey({ ...identity, sourceHome: alias })).toBe(key);
    expect(
        new Set([
            key,
            historySourceKey({ ...identity, providerId: "another-sub" }),
            historySourceKey({ ...identity, sourceHome: otherHome }),
            historySourceKey({ ...identity, nativeId: "two" }),
            unresolvedHistorySourceKey({ providerId: "fixture-sub", filePath: join(home, "one") }),
        ]).size
    ).toBe(5);
    expect(() => historySourceKey({ ...identity, nativeId: "" })).toThrow();
});

test("a Claude process is named by its session file's procStart, also when startedAt came minutes late", () => {
    const registry = mkdtempSync(join(tmpdir(), "claude-peer-registry-"));
    // The process start as the kernel reports it, and the same second as Claude Code writes it.
    const startSec = Date.parse("2026-11-05T15:56:35.400Z") / 1000;
    const write = (pid: number, fields: Record<string, unknown>) =>
        writeFileSync(
            join(registry, `${pid}.json`),
            SafeJSON.stringify({ pid, sessionId: `session-${pid}`, ...fields })
        );

    // A burst start: startedAt 180 s late, procStart exact.
    write(101, { startedAt: (startSec + 180) * 1000, procStart: "Thu Nov  5 15:56:35 2026" });
    expect(claudePeerSession({ pid: 101, startSec }, registry)).toBe("session-101");

    // A reused pid: the file's process started an hour earlier, by both fields.
    write(102, { startedAt: (startSec - 3600) * 1000, procStart: "Thu Nov  5 14:56:35 2026" });
    expect(claudePeerSession({ pid: 102, startSec }, registry)).toBeNull();

    // An older Claude Code without procStart keeps the startedAt rule.
    write(103, { startedAt: (startSec + 2) * 1000 });
    expect(claudePeerSession({ pid: 103, startSec }, registry)).toBe("session-103");
    write(104, { startedAt: (startSec + 180) * 1000 });
    expect(claudePeerSession({ pid: 104, startSec }, registry)).toBeNull();
});
