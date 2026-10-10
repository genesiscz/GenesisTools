import { describe, expect, spyOn, test } from "bun:test";
import { closeSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { workerMetaPath } from "./paths";
import { type ClaudeWorkerMeta, ClaudeWorkerStore } from "./store";
import { claimTurnLog, steerWorker } from "./worker";

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

    test("a live orphan child blocks a competing turn after its launcher dies", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-claude-turn-owner-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new ClaudeWorkerStore();
            store.createMeta({
                ...makeMeta(),
                turns: 1,
                activeTurn: {
                    turn: 1,
                    ownerPid: -1,
                    childPid: process.pid,
                    startedAt: new Date().toISOString(),
                },
            });

            await expect(
                steerWorker({ name: "reviewer", account: { name: "work", token: "fixture" }, prompt: "next" })
            ).rejects.toThrow(/still has turn 1 running/);
        });
    });
});

test("guarded Claude delivery refuses changed identity, home, turn and busy owners before spawning", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "claude-delivery-guard-"));
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: scratch }, async () => {
        const store = new ClaudeWorkerStore();
        const meta = { ...makeMeta(), turns: 1, sourceHome: scratch };
        store.createMeta(meta);
        const delivery = { sessionId: meta.sessionId, sourceHome: scratch, afterTurn: 1 };
        const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
            throw new Error("provider spawn must not be reached");
        });
        try {
            for (const changed of [{ sessionId: "foreign" }, { sourceHome: "/wrong/home" }, { afterTurn: 2 }]) {
                await expect(
                    steerWorker({
                        name: meta.name,
                        account: { name: "work", token: "fixture" },
                        prompt: "Synthetic",
                        delivery: { ...delivery, ...changed },
                    })
                ).rejects.toThrow(/changed/);
            }
            store.updateMeta(meta.name, {
                activeTurn: { turn: 1, ownerPid: process.pid, startedAt: new Date().toISOString() },
            });
            await expect(
                steerWorker({
                    name: meta.name,
                    account: { name: "work", token: "fixture" },
                    prompt: "Synthetic",
                    delivery,
                })
            ).rejects.toThrow("busy");
            store.updateMeta(meta.name, { activeTurn: undefined });
            let pending: Promise<unknown> | undefined;
            await withFileLock(`${workerMetaPath(meta.name)}.turn.lock`, async () => {
                pending = steerWorker({
                    name: meta.name,
                    account: { name: "work", token: "fixture" },
                    prompt: "Synthetic",
                    delivery,
                });
                store.updateMeta(meta.name, { sessionId: "changed-during-lock" });
            });
            await expect(pending!).rejects.toThrow("session or source home changed");
            expect(spawn).not.toHaveBeenCalled();
            expect(store.readMeta(meta.name)?.turns).toBe(1);
        } finally {
            spawn.mockRestore();
        }
    });
});
