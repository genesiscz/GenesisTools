import { expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTaskIntegrationHome, withTaskSession } from "./task-integration-env";

const env = setupTaskIntegrationHome();

test("GC removes sessions older than retention window (F6)", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const oldName = `gc-old-fixture-${suffix}`;
    const triggerName = `gc-trigger-${suffix}`;
    const dir = env.sessionsDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${oldName}.jsonl`);
    writeFileSync(path, '{"type":"line","seq":1,"out":"stdout","text":"old","ts":1}\n');
    const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    utimesSync(path, past, past);

    await withTaskSession(env, triggerName, () => {
        env.task(["run", "--session", triggerName, "--no-tty", "--", "bash", "-c", "echo trigger"]);
        expect(existsSync(path)).toBe(false);
    });
    // Spawns several cold `tools task` subprocesses synchronously; generous
    // per-test timeout so it survives subprocess contention when run --parallel.
}, 30_000);
