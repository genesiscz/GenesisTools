import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dir, "tdd-gate.ts");

let projectDir: string;
let sessionsRoot: string;

function gate(args: string[]): { exitCode: number; stdout: string; stderr: string; all: string } {
    const proc = Bun.spawnSync([process.execPath, GATE, ...args], {
        cwd: projectDir,
        env: { ...process.env, TDD_GATE_SESSIONS_ROOT: sessionsRoot },
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    return { exitCode: proc.exitCode ?? -1, stdout, stderr, all: stdout + stderr };
}

function writeTestFile(name: string, content: string): string {
    const path = join(projectDir, name);
    writeFileSync(path, content);
    return path;
}

const ASSERTION_TEST_FILE = 'import { expect } from "bun:test";\nexpect(add(2, 3)).toBe(5);\n';

beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "tdd-gate-proj-"));
    sessionsRoot = mkdtempSync(join(tmpdir(), "tdd-gate-sessions-"));
});

afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(sessionsRoot, { recursive: true, force: true });
});

describe("red", () => {
    test("captures a failing run as RED with exit 0", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        const result = gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("RED captured (exit 1)");
    });

    test("a passing run is NO RED and exits 1", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        const result = gate(["red", "--cmd", "exit 0", "--test-file", "t.test.ts", "--session", "s"]);
        expect(result.exitCode).toBe(1);
        expect(result.all).toContain("NO RED");
    });

    test("a load error is flagged as ERROR, NOT AN ASSERTION FAILURE", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        const result = gate([
            "red",
            "--cmd",
            "echo \"error: Cannot find module './nope'\"; exit 1",
            "--test-file",
            "t.test.ts",
            "--session",
            "s",
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.all).toContain("ERROR, NOT AN ASSERTION FAILURE");
    });

    test("warns when the session already holds a RED for a different command", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        const result = gate(["red", "--cmd", "exit 2", "--test-file", "t.test.ts", "--session", "s"]);
        expect(result.all).toContain("already holds a RED for a different command");
    });
});

describe("green blockers", () => {
    test("refuses a command different from the one RED witnessed", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        const result = gate(["green", "--cmd", "true", "--session", "s"]);
        expect(result.exitCode).toBe(2);
        expect(result.all).toContain("COMMAND MISMATCH");
    });

    test("bare green resolves the session the last red wrote, not an older one", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "older"]);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "task2"]);
        const older = join(sessionsRoot, "older");
        writeFileSync(join(older, "poke.txt"), "touch mtime");
        const result = gate(["green", "--cmd", "exit 1"]);
        expect(result.stdout).toContain("Session: task2");
    });

    test("a stale branch-named session does not outrank the session the last red wrote", () => {
        Bun.spawnSync(["git", "init", "-b", "feat-x"], {
            env: process.env,
            cwd: projectDir,
            stdout: "pipe",
            stderr: "pipe",
        });
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "feat-x"]);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "task2"]);
        const result = gate(["green", "--cmd", "exit 1"]);
        expect(result.stdout).toContain("Session: task2");
    });

    test("green without a prior red fails loudly", () => {
        const result = gate(["green", "--cmd", "exit 1", "--session", "nope"]);
        expect(result.exitCode).toBe(2);
        expect(result.all).toContain("no RED recorded");
    });

    test("rejects --test-file on green", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        const result = gate(["green", "--cmd", "exit 1", "--session", "s", "--test-file", "t.test.ts"]);
        expect(result.exitCode).toBe(2);
        expect(result.all).toContain("only valid on `red`");
    });
});

describe("weakened-assertion guard", () => {
    test("trips on any test-file edit without --allow-test-edit", () => {
        const path = writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        writeFileSync(path, ASSERTION_TEST_FILE.replace("toBe(5)", "toBe(-1)"));
        const result = gate(["green", "--cmd", "exit 1", "--session", "s"]);
        expect(result.exitCode).toBe(3);
        expect(result.all).toContain("WEAKENED-ASSERTION GUARD TRIPPED");
    });

    test("--allow-test-edit cannot launder an assertion change", () => {
        const path = writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        writeFileSync(path, ASSERTION_TEST_FILE.replace("toBe(5)", "toBe(-1)"));
        const result = gate(["green", "--cmd", "exit 1", "--session", "s", "--allow-test-edit", "fixture typo"]);
        expect(result.exitCode).toBe(3);
        expect(result.all).toContain("removes or changes an ASSERTION");
    });

    test("--allow-test-edit cannot launder test.skip", () => {
        const content = 'test("sums", () => {\n    expect(add(2, 3)).toBe(5);\n});\n';
        const path = writeTestFile("t.test.ts", content);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        writeFileSync(path, content.replace('test("sums"', 'test.skip("sums"'));
        const result = gate(["green", "--cmd", "exit 1", "--session", "s", "--allow-test-edit", "refactoring"]);
        expect(result.exitCode).toBe(3);
        expect(result.all).toContain("skips, isolates or stubs out");
    });

    test("--allow-test-edit cannot launder a fixture-value change", () => {
        const content = "const expected = 121;\nconsole.log(expected);\n";
        const path = writeTestFile("t.test.ts", content);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        writeFileSync(path, content.replace("121", "100"));
        const result = gate(["green", "--cmd", "exit 1", "--session", "s", "--allow-test-edit", "corrected fixture"]);
        expect(result.exitCode).toBe(3);
        expect(result.all).toContain("changes literal VALUES");
    });

    test("--allow-test-edit permits an identifier rename that keeps literals intact", () => {
        const content = "const cartSize = 3;\nconsole.log(cartSize);\n";
        const path = writeTestFile("t.test.ts", content);
        gate(["red", "--cmd", "test -f fixed", "--test-file", "t.test.ts", "--session", "s"]);
        writeFileSync(path, content.replaceAll("cartSize", "basketSize"));
        writeFileSync(join(projectDir, "fixed"), "");
        const result = gate(["green", "--cmd", "test -f fixed", "--session", "s", "--allow-test-edit", "rename"]);
        expect(result.exitCode).toBe(0);
    });

    test("fewer executed tests at GREEN than at RED trips the guard", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        const cmd =
            "if [ -f fixed ]; then printf ' 1 pass\\n 1 skip\\n 0 fail\\n'; exit 0; " +
            "else printf ' 1 pass\\n 1 fail\\n'; exit 1; fi";
        gate(["red", "--cmd", cmd, "--test-file", "t.test.ts", "--session", "s"]);
        writeFileSync(join(projectDir, "fixed"), "");
        const result = gate(["green", "--cmd", cmd, "--session", "s"]);
        expect(result.exitCode).toBe(3);
        expect(result.all).toContain("FEWER TESTS EXECUTED");
    });

    test("--allow-test-edit records a non-assertion edit and proceeds", () => {
        const path = writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "test -f fixed", "--test-file", "t.test.ts", "--session", "s"]);
        writeFileSync(path, `// clarifying comment\n${ASSERTION_TEST_FILE}`);
        writeFileSync(join(projectDir, "fixed"), "");
        const result = gate([
            "green",
            "--cmd",
            "test -f fixed",
            "--session",
            "s",
            "--allow-test-edit",
            "added comment",
        ]);
        expect(result.exitCode).toBe(0);
        const state = readFileSync(join(sessionsRoot, "s", "state.json"), "utf8");
        expect(state).toContain("added comment");
    });
});

// jest and vitest print a per-file line ("Test Suites:" / "Test Files") above the per-test "Tests" line.
describe("test counts from jest and vitest summaries", () => {
    function cycle(redOutput: string, greenOutput: string) {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        const cmd = `if [ -f fixed ]; then printf '${greenOutput}'; exit 0; else printf '${redOutput}'; exit 1; fi`;
        gate(["red", "--cmd", cmd, "--test-file", "t.test.ts", "--session", "s"]);
        writeFileSync(join(projectDir, "fixed"), "");
        return gate(["green", "--cmd", cmd, "--session", "s"]);
    }

    test("a vitest GREEN that runs every RED test passes the count guard", () => {
        const result = cycle(
            " ❯ x.test.ts (28 tests | 1 failed) 17ms\\n Test Files  1 failed (1)\\n      Tests  1 failed | 27 passed (28)\\n",
            " ✓ x.test.ts (28 tests) 12ms\\n Test Files  1 passed (1)\\n      Tests  28 passed (28)\\n"
        );
        expect(result.exitCode).toBe(0);
    });

    test("a jest GREEN that runs every RED test passes the count guard", () => {
        const result = cycle(
            "Test Suites: 1 failed, 1 total\\nTests:       1 failed, 27 passed, 28 total\\n",
            "Test Suites: 1 passed, 1 total\\nTests:       28 passed, 28 total\\n"
        );
        expect(result.exitCode).toBe(0);
    });

    test("a vitest GREEN that skips a RED test still trips the count guard", () => {
        const result = cycle(
            " Test Files  1 failed (1)\\n      Tests  1 failed | 27 passed (28)\\n",
            " Test Files  1 passed (1)\\n      Tests  27 passed | 1 skipped (28)\\n"
        );
        expect(result.all).toContain("RED executed 28 test(s), 0 skipped; GREEN executed 27, 1 skipped");
    });

    test("a bun RED whose failure output echoes a count reads the summary, not the code frame", () => {
        const result = cycle(
            '12 |     label: "27 passed",\\n(fail) sums\\n 1 pass\\n 1 fail\\nRan 2 tests across 1 file.\\n',
            " 2 pass\\n 0 fail\\nRan 2 tests across 1 file.\\n"
        );
        expect(result.exitCode).toBe(0);
    });
});

describe("snapshot-file guard", () => {
    test("a .snap file created between RED and GREEN trips the guard", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "test -f fixed", "--test-file", "t.test.ts", "--session", "s"]);
        mkdirSync(join(projectDir, "__snapshots__"), { recursive: true });
        writeFileSync(join(projectDir, "__snapshots__", "t.snap"), 'exports["x"] = "whatever";');
        writeFileSync(join(projectDir, "fixed"), "");
        const result = gate(["green", "--cmd", "test -f fixed", "--session", "s"]);
        expect(result.exitCode).toBe(3);
        expect(result.all).toContain("SNAPSHOT FILE created or changed");
    });
});

describe("snapshot-file guard scoping", () => {
    test("a foreign .snap in an unguarded directory does not trip the guard", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "test -f fixed", "--test-file", "t.test.ts", "--session", "s"]);
        mkdirSync(join(projectDir, "other", "__snapshots__"), { recursive: true });
        writeFileSync(join(projectDir, "other", "__snapshots__", "render.test.ts.snap"), 'exports["x"] = "y";');
        writeFileSync(join(projectDir, "fixed"), "");
        const result = gate(["green", "--cmd", "test -f fixed", "--session", "s"]);
        expect(result.exitCode).toBe(0);
    });
});

describe("flake gate", () => {
    test("disagreeing runs exit 4", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        const flakyCmd = "if [ -f marker ]; then rm marker; exit 1; else touch marker; exit 0; fi";
        writeFileSync(join(projectDir, "marker"), "");
        gate(["red", "--cmd", flakyCmd, "--test-file", "t.test.ts", "--session", "s"]);
        const result = gate(["green", "--cmd", flakyCmd, "--session", "s"]);
        expect(result.exitCode).toBe(4);
        expect(result.all).toContain("FLAKY");
    });
});

describe("full cycle with a real bun test", () => {
    test("red on real failure, double green after the fix, report exits 0", () => {
        writeFileSync(join(projectDir, "math.ts"), "export function add(a: number, b: number) { return a - b; }\n");
        writeTestFile(
            "math.test.ts",
            'import { expect, test } from "bun:test";\nimport { add } from "./math";\n\ntest("add sums", () => {\n    expect(add(2, 3)).toBe(5);\n});\n'
        );
        const red = gate(["red", "--cmd", "bun test math.test.ts", "--test-file", "math.test.ts", "--session", "s"]);
        expect(red.exitCode).toBe(0);
        expect(red.stdout).toContain("Received: -1");

        const early = gate(["report", "--session", "s"]);
        expect(early.exitCode).toBe(1);

        writeFileSync(join(projectDir, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
        const green = gate(["green", "--cmd", "bun test math.test.ts", "--session", "s"]);
        expect(green.exitCode).toBe(0);
        expect(green.stdout).toContain("GREEN verified 2/2");

        const report = gate(["report", "--session", "s"]);
        expect(report.exitCode).toBe(0);
        expect(report.stdout).toContain("passed 2/2");
    });
});

describe("clean", () => {
    test("bare clean refuses and lists sessions", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        const result = gate(["clean"]);
        expect(result.exitCode).toBe(2);
        expect(result.all).toContain("clean requires --session");
    });

    test("clean --session removes exactly that session dir", () => {
        writeTestFile("t.test.ts", ASSERTION_TEST_FILE);
        gate(["red", "--cmd", "exit 1", "--test-file", "t.test.ts", "--session", "s"]);
        const result = gate(["clean", "--session", "s"]);
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(sessionsRoot, "s"))).toBe(false);
    });
});
