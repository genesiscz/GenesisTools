import { afterAll, beforeAll, expect, test } from "bun:test";
import { setupTaskIntegrationHome } from "./task-integration-env";

const env = setupTaskIntegrationHome();
const SESSION = `grep-implies-all-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
});

afterAll(() => {
    env.clean(SESSION);
});

test("--grep returns ALL matches, not last-50 of matches (F5)", () => {
    const r = env.task(["logs", "--session", SESSION, "--grep", "^line ", "--raw"]);
    const matches = r.stdout.trim().split("\n").filter((l) => /^line /.test(l));
    expect(matches).toHaveLength(100);
});

test("--grep + explicit --tail 5 honors the explicit window (F5)", () => {
    const r = env.task(["logs", "--session", SESSION, "--grep", "^line ", "--tail", "5", "--raw"]);
    const matches = r.stdout.trim().split("\n").filter((l) => /^line /.test(l));
    expect(matches).toHaveLength(5);
});
