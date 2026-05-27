import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");
const SESSION = `grep-implies-all-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function task(args: string[]) {
    const r = spawnSync("bun", [TASK_TOOL, "task", ...args], { encoding: "utf-8" });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeAll(() => {
    task(["clean", "--session", SESSION]);
    task([
        "run",
        "--session",
        SESSION,
        "--no-tty",
        "--",
        "bash",
        "-c",
        "for i in $(seq 1 100); do echo line $i; done",
    ]);
});

afterAll(() => {
    task(["clean", "--session", SESSION]);
});

test("--grep returns ALL matches, not last-50 of matches (F5)", () => {
    const r = task(["logs", "--session", SESSION, "--grep", "^line ", "--raw"]);
    const matches = r.stdout.trim().split("\n").filter((l) => /^line /.test(l));
    expect(matches).toHaveLength(100);
});

test("--grep + explicit --tail 5 honors the explicit window (F5)", () => {
    const r = task(["logs", "--session", SESSION, "--grep", "^line ", "--tail", "5", "--raw"]);
    const matches = r.stdout.trim().split("\n").filter((l) => /^line /.test(l));
    expect(matches).toHaveLength(5);
});
