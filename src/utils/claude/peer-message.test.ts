import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { liveClaudeSessionIds } from "./peer-message";

describe("liveClaudeSessionIds", () => {
    function registry(entries: Record<string, unknown>[]): string {
        const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
        for (const entry of entries) {
            writeFileSync(join(dir, `${entry.pid}.json`), SafeJSON.stringify(entry));
        }
        writeFileSync(join(dir, "123.abc.key"), "not a registry file");
        return dir;
    }

    it("keeps sessions whose pid runs, with or without a messaging socket", () => {
        const dir = registry([
            { pid: 1, sessionId: "AAAA-live", messagingSocketPath: "/tmp/s" },
            { pid: 2, sessionId: "bbbb-nosocket" },
            { pid: 3, sessionId: "cccc-dead" },
        ]);
        const ids = liveClaudeSessionIds(dir, () => new Set([1, 2]));
        expect(ids).toEqual(new Set(["aaaa-live", "bbbb-nosocket"]));
    });

    it("drops a parked entry, whose id moved to a background job", () => {
        const dir = registry([{ pid: 1, sessionId: "parent", parkedJobId: "child" }]);
        expect(liveClaudeSessionIds(dir, () => new Set([1]))).toEqual(new Set());
    });

    it("answers null, not empty, when the registry cannot be read", () => {
        expect(liveClaudeSessionIds(join(tmpdir(), "no-such-registry-dir"), () => new Set())).toBeNull();
    });
});
