// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/schedule.test.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { z } from "zod";
import { parseScenarios, type Scenario } from "./document";
import { planRun } from "./plan";
import { createLimiter, GrowAfter, type RunOptions, runPlan } from "./schedule";
import { createRun, loadRun, type RunManifest } from "./store";
import { EvalSystemError } from "./system";
import { type FakeTurn, type FakeTurnContext, fakeClock, fakeSystem } from "./testing";

const dirs: string[] = [];
after(async () => {
    for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true });
    }
});

describe("createLimiter", () => {
    it("halves on a rate limit, pauses for retryAfterMs, and grows by one after five successes", async () => {
        const clock = fakeClock({ auto: true });
        const changes: number[] = [];
        const limiter = createLimiter({ max: 8, clock, onChange: (_key, limit) => changes.push(limit) });
        await assert.rejects(
            limiter.run("p", () => Promise.reject(new EvalSystemError("rate-limit", "429", { retryAfterMs: 7000 })))
        );
        assert.equal(limiter.limits().p, 4);
        const before = clock.now();
        await limiter.run("p", async () => "ok");
        assert.equal(clock.now() - before, 7000, "the next task waited for Retry-After");
        for (let i = 1; i < GrowAfter; i++) {
            await limiter.run("p", async () => i);
        }
        assert.equal(limiter.limits().p, 5);
        assert.deepEqual(changes, [4, 5]);
    });

    it("backs off 1 s, 2 s, 4 s without Retry-After, and never goes below 1", async () => {
        const clock = fakeClock({ auto: true });
        const limiter = createLimiter({ max: 2, clock });
        for (let i = 0; i < 3; i++) {
            limiter.penalize("p");
        }
        assert.equal(limiter.limits().p, 1);
        await limiter.run("p", async () => null);
        assert.deepEqual(clock.sleeps, [4000], "pauses of 1 s, 2 s and 4 s from the same moment end at 4 s");
    });

    it("keeps at most `limit` tasks in flight per key", async () => {
        const limiter = createLimiter({ max: 2, clock: fakeClock({ auto: true }) });
        let inFlight = 0;
        let peak = 0;
        await Promise.all(
            Array.from({ length: 6 }, () =>
                limiter.run("p", async () => {
                    peak = Math.max(peak, ++inFlight);
                    await new Promise((done) => setImmediate(done));
                    inFlight--;
                })
            )
        );
        assert.equal(peak, 2);
    });
});

const Signals = z.object({ ok: z.boolean() });
type Signals = z.infer<typeof Signals>;

async function setup(
    reply: (c: FakeTurnContext<unknown>) => FakeTurn<Signals>,
    models = [
        { id: "m1", label: "M1", limitKey: "p" },
        { id: "m2", label: "M2", limitKey: "q" },
    ]
) {
    const system = fakeSystem({ tools: ["t"], signals: Signals, defaultSignals: { ok: true }, models, reply });
    const parsed = parseScenarios(
        [
            { id: "s1", steps: [{ user: "hi", expect: [{ check: { signal: "ok", is: true } }] }] },
            { id: "s2", steps: [{ user: "hi" }] },
        ],
        system,
        "stdin"
    );
    if (!parsed.ok) {
        throw new Error("fixture");
    }
    const scenarios: Scenario[] = parsed.scenarios;
    const plan = planRun({
        scenarios,
        models: models.map((m) => m.id),
        variants: ["current"],
        repeats: 2,
        passRate: 1,
        maxErrorRate: 0.1,
    });
    const base = await mkdtemp(join(tmpdir(), "eval-engine-schedule-"));
    dirs.push(base);
    const manifest = (run: string): RunManifest => ({
        schema: "eval-manifest/1",
        run,
        label: "t",
        createdAt: "",
        plannedAt: "",
        project: "fake",
        target: null,
        rubricVersion: 1,
        signalsVersion: 1,
        plan,
        scenarios: {},
        setups: {},
        system: { models, variants: ["current"], fingerprint: null },
        harness: { judge: null, judgePromptVersion: 1, simulator: null, simulatorPromptVersion: 1 },
        maxCostUsd: null,
        argv: [],
    });
    const store = await createRun(base, { now: new Date(), label: "t" }, manifest);
    const connection = system.connect(undefined);
    const info = await connection.describe({ signal: new AbortController().signal });
    const input = {
        runId: store.manifest.run,
        plan,
        scenarios: new Map(scenarios.map((s) => [s.doc.id, s])),
        setups: new Map<string, unknown>(scenarios.map((s) => [s.doc.id, {}])),
        signals: Signals,
        connection,
        info,
        store,
        harness: { judge: null, simulator: null },
    };
    const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
        concurrency: 4,
        maxAttempts: 3,
        keepGoing: false,
        maxCostUsd: null,
        signal: new AbortController().signal,
        clock: fakeClock({ auto: true }),
        ...overrides,
    });
    return { system, plan, store, input, options, base };
}

describe("runPlan", () => {
    it("plays every key once; a second runPlan skips final keys", async () => {
        const { system, plan, input, options, store, base } = await setup(() => ({ reply: "ok" }));
        await runPlan(input, options());
        assert.equal(system.log.opened.length, plan.conversations.length);
        await runPlan(input, options());
        assert.equal(system.log.opened.length, plan.conversations.length);
        assert.equal((await loadRun(store.dir, base)).records.length, 8);
    });

    it("retries a rate limit with a new conversation and penalizes only that key", async () => {
        const progress: string[] = [];
        const { system, input, options, store, base } = await setup((c) =>
            c.model === "m1" && c.opened === 1
                ? { error: new EvalSystemError("rate-limit", "429", { retryAfterMs: 2000 }) }
                : { reply: "ok" }
        );
        await runPlan(
            input,
            options({
                onProgress: (e) => progress.push(e.type === "limit" ? `limit ${e.limitKey}=${e.limit}` : e.type),
            })
        );
        const view = await loadRun(store.dir, base);
        assert.equal(view.records.length, 8);
        assert.ok(progress.includes("limit p=2"));
        assert.ok(!progress.some((p) => p.startsWith("limit q")));
        assert.equal(
            system.log.opened.filter((o) => o.model === "m1").length,
            8,
            "four rate-limited conversations, four new ones"
        );
        assert.ok(view.records.filter((r) => r.cell.model === "m1").every((r) => r.attempt === 2));
    });

    it("a blocked cell stops its other repeats; other cells run", async () => {
        const { system, input, options, store, base } = await setup((c) =>
            c.model === "m2" && c.key.startsWith("s1")
                ? { error: new EvalSystemError("blocked", "no key") }
                : { reply: "ok" }
        );
        await runPlan(input, options({ concurrency: 1 }));
        const view = await loadRun(store.dir, base);
        assert.equal(view.records.length, 6);
        assert.deepEqual(
            view.missing.map((m) => m.kind),
            ["blocked", "blocked"]
        );
        assert.equal(system.log.sent.filter((s) => s.key.startsWith("s1~m2")).length, 1);
    });

    it("gives up after maxAttempts and leaves the key without a result", async () => {
        const { input, options, store, base } = await setup((c) =>
            c.key === "s2~m1~current~r1" ? { error: new Error("socket hang up") } : { reply: "ok" }
        );
        const clock = fakeClock({ auto: true });
        await runPlan(input, options({ clock }));
        const view = await loadRun(store.dir, base);
        assert.deepEqual(
            view.missing.map((m) => [m.key, m.kind]),
            [["s2~m1~current~r1", "transient"]]
        );
        assert.deepEqual(
            clock.sleeps.filter((ms) => ms >= 1000),
            [1000, 2000]
        );
    });

    it("opens no new conversation once the finished ones cost more than maxCostUsd", async () => {
        const { input, options, store, base } = await setup(() => ({ reply: "ok", usage: { costUsd: 0.4 } }));
        const result = await runPlan(input, options({ concurrency: 1, maxCostUsd: 1 }));
        assert.equal(result.stopped?.reason, "cost-limit");
        const view = await loadRun(store.dir, base);
        assert.equal(view.records.length, 3);
        assert.ok(view.missing.every((m) => m.kind === "cost-limit"));
    });
});
