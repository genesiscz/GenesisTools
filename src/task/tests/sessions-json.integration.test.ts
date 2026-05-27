import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { SafeJSON } from "@app/utils/json";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

const FIXTURE = `json-test-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(() => {
    spawnSync("bun", [TASK_TOOL, "task", "run", "--session", FIXTURE, "--no-tty", "--", "bash", "-c", "echo hi"], {
        encoding: "utf-8",
    });
});

afterAll(() => {
    spawnSync("bun", [TASK_TOOL, "task", "clean", "--session", FIXTURE], { encoding: "utf-8" });
});

test("tools task sessions --json emits parseable JSON array (F4)", () => {
    const r = spawnSync("bun", [TASK_TOOL, "task", "sessions", "--json"], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    const parsed = SafeJSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    const fixture = (parsed as Array<{ name: string }>).find((s) => s.name === FIXTURE);
    expect(fixture).toBeDefined();
    expect(fixture).toHaveProperty("state");
    expect(fixture).toHaveProperty("jsonlSizeBytes");
    expect(fixture).toHaveProperty("lastSeq");
});
