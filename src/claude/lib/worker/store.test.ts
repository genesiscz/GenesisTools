import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { workerMetaPath, workersDir } from "./paths";
import { type ClaudeWorkerMeta, ClaudeWorkerStore } from "./store";

function makeMeta(): ClaudeWorkerMeta {
    return {
        name: "reviewer",
        sessionId: "11111111-aaaa-bbbb-cccc-000000000001",
        account: "work",
        cwd: "/repo",
        turns: 0,
        createdAt: new Date(1_700_000_000_000).toISOString(),
    };
}

function mode(path: string): number {
    return statSync(path).mode & 0o777;
}

// Worker metadata names the account and cwd, and the transcripts next to it
// carry prompts and tool output. Nothing here is for other local users.
describe.skipIf(process.platform === "win32")("ClaudeWorkerStore file modes", () => {
    test("the directory is 0700 and a claimed meta file is 0600", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-claude-workers-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new ClaudeWorkerStore();
            store.createMeta(makeMeta());

            expect(mode(workersDir())).toBe(0o700);
            expect(mode(workerMetaPath("reviewer"))).toBe(0o600);
        });
    });

    test("the atomic rewrite on update keeps 0600", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-claude-workers-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new ClaudeWorkerStore();
            store.createMeta(makeMeta());
            store.updateMeta("reviewer", { turns: 1, safeMode: true });

            expect(mode(workerMetaPath("reviewer"))).toBe(0o600);
            expect(store.readMeta("reviewer")?.safeMode).toBe(true);
        });
    });
});
