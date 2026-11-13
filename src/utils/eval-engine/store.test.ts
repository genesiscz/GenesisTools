// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/store.test.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ConversationRecord } from "./conversation";
import { EvalConfigError, parseScenarios } from "./document";
import { planRun } from "./plan";
import { createRun, listRuns, loadRun, makeEvalRunId, openRun, type RunManifest } from "./store";

const dirs: string[] = [];
after(async () => {
    for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true });
    }
});

async function runsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "eval-engine-store-"));
    dirs.push(dir);
    return dir;
}

const parsed = parseScenarios({ id: "a", steps: [{ user: "x" }] }, null, "stdin");
if (!parsed.ok) {
    throw new Error("fixture");
}
const plan = planRun({
    scenarios: parsed.scenarios,
    models: ["fake"],
    variants: ["current"],
    repeats: 2,
    passRate: 1,
    maxErrorRate: 0.1,
});

function manifest(run: string): RunManifest {
    return {
        schema: "eval-manifest/1",
        run,
        label: "a",
        createdAt: "2026-11-10T10:00:00.000Z",
        plannedAt: "2026-11-10T10:00:00.000Z",
        project: "fake",
        target: null,
        rubricVersion: 1,
        signalsVersion: 1,
        plan,
        scenarios: { a: { hash: parsed.ok ? parsed.scenarios[0].hash : "", origin: "stdin", doc: { id: "a" } } },
        setups: { a: {} },
        system: { models: [{ id: "fake", label: "Fake", limitKey: "fake" }], variants: ["current"], fingerprint: null },
        harness: { judge: null, judgePromptVersion: 1, simulator: null, simulatorPromptVersion: 1 },
        maxCostUsd: null,
        argv: [],
    };
}

function record(key: string, outcome: ConversationRecord["outcome"]): ConversationRecord {
    const conversation = plan.conversations.find((c) => c.key === key);
    if (!conversation) {
        throw new Error(key);
    }
    return {
        schema: "eval-conversation/1",
        run: "r",
        key,
        cell: conversation.cell,
        repeat: conversation.repeat,
        outcome,
        safetyMiss: false,
        safetyUnverified: false,
        completed: true,
        brokenBy: null,
        closeError: null,
        attempt: 1,
        startedAt: "2026-11-10T10:00:00.000Z",
        finishedAt: "2026-11-10T10:00:01.000Z",
        setup: {},
        bindings: {},
        turns: [],
        final: [],
        simulator: [],
        systemUsage: { inputTokens: 1, outputTokens: 1 },
        harnessUsage: { inputTokens: 0, outputTokens: 0 },
    };
}

describe("the run folder", () => {
    const now = new Date(2026, 10, 10, 19, 42, 7);

    it("names runs by local time and label, and a second run in the same second gets -2", async () => {
        const base = await runsDir();
        assert.equal(makeEvalRunId(now, "toothache / regression"), "2026-11-10T19-42-07-toothache-regression");
        const first = await createRun(base, { now, label: "a" }, manifest);
        const second = await createRun(base, { now, label: "a" }, manifest);
        assert.equal(first.manifest.run, "2026-11-10T19-42-07-a");
        assert.equal(second.manifest.run, "2026-11-10T19-42-07-a-2");
        assert.deepEqual(await listRuns(base), ["2026-11-10T19-42-07-a-2", "2026-11-10T19-42-07-a"]);
    });

    it("never replaces a final record", async () => {
        const store = await createRun(await runsDir(), { now, label: "a" }, manifest);
        const key = plan.conversations[0].key;
        assert.equal(await store.writeFinal(record(key, "failed")), "written");
        assert.equal(await store.writeFinal(record(key, "passed")), "exists");
        const view = await loadRun(store.dir, "unused");
        assert.equal(view.records[0].outcome, "failed");
        assert.deepEqual((await readdir(join(store.dir, "conversations"))).sort(), [`${key}.json`]);
    });

    it("lists keys without a result with their last error", async () => {
        const base = await runsDir();
        const store = await createRun(base, { now, label: "a" }, manifest);
        const [first, second] = plan.conversations;
        await store.writeFinal(record(first.key, "passed"));
        await store.writeError(second.key, 1, "transient", "5xx");
        await store.writeError(second.key, 2, "rate-limit", "429");
        const view = await loadRun(store.manifest.run, base);
        assert.deepEqual(
            view.missing.map((m) => [m.key, m.kind, m.message]),
            [[second.key, "rate-limit", "429"]]
        );
        assert.equal(view.recordFiles[first.key], join(store.dir, "conversations", `${first.key}.json`));
    });

    it("stores each prompt once and reopens a run by id", async () => {
        const base = await runsDir();
        const store = await createRun(base, { now, label: "a" }, manifest);
        const hash = await store.putPrompt("You are a receptionist.");
        assert.equal(await store.putPrompt("You are a receptionist."), hash);
        const reopened = await openRun(store.manifest.run, base);
        assert.equal(reopened.manifest.plan.hash, plan.hash);
        const view = await loadRun(store.manifest.run, base);
        assert.ok(view.promptFiles[hash]);
        await assert.rejects(
            openRun("nope", base),
            (e: unknown) => e instanceof EvalConfigError && e.code === "unknown-run"
        );
    });
});

it("reopens a run with a truncated diagnostic error tail", async () => {
    const base = await runsDir();
    const store = await createRun(base, { now: new Date(), label: "tail" }, manifest);
    const key = plan.conversations[0].key;
    await store.writeError(key, 1, "transient", "502");
    await appendFile(join(store.dir, "errors", `${key}.jsonl`), '{"schema":');
    const reopened = await loadRun(store.dir, base);
    assert.equal(reopened.records.length, 0);
});
