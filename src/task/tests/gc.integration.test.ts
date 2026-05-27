import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");
const DIR = `${homedir()}/.genesis-tools/task/sessions`;

test("GC removes sessions older than retention window (F6)", () => {
    mkdirSync(DIR, { recursive: true });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const oldName = `gc-old-fixture-${suffix}`;
    const triggerName = `gc-trigger-${suffix}`;
    const path = `${DIR}/${oldName}.jsonl`;
    writeFileSync(path, '{"type":"line","seq":1,"out":"stdout","text":"old","ts":1}\n');
    const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    utimesSync(path, past, past);

    spawnSync("bun", [TASK_TOOL, "task", "run", "--session", triggerName, "--no-tty", "--", "bash", "-c", "echo trigger"], {
        encoding: "utf-8",
    });

    expect(existsSync(path)).toBe(false);
    spawnSync("bun", [TASK_TOOL, "task", "clean", "--session", triggerName]);
});
