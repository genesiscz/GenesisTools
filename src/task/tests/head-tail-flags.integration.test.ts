import { afterAll, beforeAll, expect, test } from "bun:test";
import { setupTaskIntegrationHome } from "./task-integration-env";

const env = setupTaskIntegrationHome();
const SESSION = `head-tail-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(() => {
    env.clean(SESSION);
    env.task([
        "run",
        "--session",
        SESSION,
        "--no-tty",
        "--",
        "bash",
        "-c",
        "for i in $(seq 1 100); do echo line $i; done",
    ]);
}, 15_000);

afterAll(() => {
    env.clean(SESSION);
}, 15_000);

test("--head 5 returns first 5 lines (F7)", () => {
    const r = env.task(["logs", "--session", SESSION, "--head", "5", "--raw"]);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("line 1");
    expect(lines[4]).toBe("line 5");
});

test("--tail 5 returns last 5 lines (F7)", () => {
    const r = env.task(["logs", "--session", SESSION, "--tail", "5", "--raw"]);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("line 96");
    expect(lines[4]).toBe("line 100");
});

test("--head 5 --tail 5 returns 10 lines with elision marker (F7)", () => {
    const r = env.task(["logs", "--session", SESSION, "--head", "5", "--tail", "5", "--raw"]);
    const lines = r.stdout.trim().split("\n");
    expect(lines.filter((l) => l.startsWith("line "))).toHaveLength(10);
    const elision = lines.find((l) => /elided/i.test(l)) ?? r.stderr;
    expect(elision).toMatch(/90 lines elided/);
});

test("--all dumps every line, overrides --head/--tail (F7)", () => {
    const r = env.task(["logs", "--session", SESSION, "--all", "--raw"]);
    const lines = r.stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("line "));
    expect(lines).toHaveLength(100);
});

test("B1 repro — tail --all returns ALL lines, not just last 10", () => {
    const r = env.task(["tail", "--session", SESSION, "--all", "--raw"]);
    const matchingLines = r.stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("line "));
    expect(matchingLines).toHaveLength(100);
});

test("B1 repro — tail --all --grep returns ALL matching lines", () => {
    const r = env.task(["tail", "--session", SESSION, "--all", "--grep", "^line ", "--raw"]);
    const matchingLines = r.stdout
        .trim()
        .split("\n")
        .filter((l) => /^line /.test(l));
    expect(matchingLines).toHaveLength(100);
});
