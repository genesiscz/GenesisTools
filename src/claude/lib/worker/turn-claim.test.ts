import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { type ClaudeWorkerMeta, ClaudeWorkerStore } from "./store";
import { claimTurnLog } from "./worker";

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

describe("claimTurnLog", () => {
    test("a turn killed before it finished does not wedge the worker forever", async () => {
        // The regression: `turns` advanced only after a clean exit, so a parent
        // killed mid-turn left `reviewer.turn1.jsonl` behind with meta.turns 0.
        // The next steer asked for turn 1 again and died on EEXIST, with no verb
        // able to clear the file.
        const home = mkdtempSync(join(tmpdir(), "gt-claude-turn-claim-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const store = new ClaudeWorkerStore();
            store.createMeta(makeMeta());

            closeSync(claimTurnLog({ store, name: "reviewer", turn: 1 }));
            expect(store.readMeta("reviewer")?.turns).toBe(1);

            // The parent dies here: runTurn never records its outcome.
            const next = (store.readMeta("reviewer")?.turns ?? 0) + 1;
            closeSync(claimTurnLog({ store, name: "reviewer", turn: next }));

            expect(next).toBe(2);
            expect(store.readMeta("reviewer")?.turns).toBe(2);
        });
    });

    test("claiming the same turn twice still refuses, naming the read command", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-claude-turn-claim-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const store = new ClaudeWorkerStore();
            store.createMeta(makeMeta());

            closeSync(claimTurnLog({ store, name: "reviewer", turn: 1 }));

            expect(() => claimTurnLog({ store, name: "reviewer", turn: 1 })).toThrow(/already has a transcript/);
        });
    });
});
