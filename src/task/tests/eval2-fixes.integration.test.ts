import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import { readTaskJsonl, runTaskCapture, runTaskCli } from "../lib/test-harness";

const dirs: string[] = [];

function sessionJsonlPath(homeDir: string, session: string): string {
    const dir = join(homeDir, ".genesis-tools", "task", "sessions");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${session}.jsonl`);
}

afterEach(() => {
    for (const d of dirs) {
        rmSync(d, { recursive: true, force: true });
    }
});

function setupHome(): string {
    const homeDir = mkdtempSync(join(tmpdir(), "task-eval2-"));
    dirs.push(homeDir);
    return homeDir;
}

describe("eval2 bug fixes integration", () => {
    it("pipe mode infers stderr levels from text, not stream (bug #1)", async () => {
        const homeDir = setupHome();
        const session = `levels-${Date.now()}`;

        await runTaskCapture({
            session,
            noTty: true,
            homeDir,
            command: [
                "bun",
                "-e",
                "import{writeSync}from'node:fs';writeSync(2,'INFO  EVAL2_HUNT_TOKEN=abc\\n');writeSync(2,' WARN  Fast Refresh\\n');writeSync(2,'Error: TransformError\\n');",
            ],
        });

        const lines = await readTaskJsonl(session, homeDir);

        expect(lines.find((l) => l.text.includes("INFO"))?.level).toBe("info");
        expect(lines.find((l) => l.text.includes("WARN"))?.level).toBe("warn");
        expect(lines.find((l) => l.text.includes("Error"))?.level).toBe("error");
    }, 30_000);

    it("sessions shows unknown for jsonl-only artifact, not active (bug #3)", async () => {
        const homeDir = setupHome();

        const session = "dash-artifact-cli";
        writeFileSync(
            sessionJsonlPath(homeDir, session),
            [
                '{"type":"meta","session":"dash-artifact-cli","command":"test","mode":"pipe","cwd":"/tmp","startedAt":"2026-05-26T00:00:00.000Z"}',
                '{"type":"exit","code":0,"durationMs":100,"ts":"2026-05-26T00:00:01.000Z"}',
            ].join("\n") + "\n"
        );

        const { stderr, exitCode } = await runTaskCli(["sessions"], { homeDir });

        expect(exitCode).toBe(0);
        expect(stderr).toContain("dash-artifact-cli");
        expect(stderr).toContain("exited (code 0");
        expect(stderr).not.toMatch(/dash-artifact-cli\s+active\s+/);
    }, 30_000);

    it("sessions shows unknown for jsonl-only session without exit meta (bug #3)", async () => {
        const homeDir = setupHome();
        const session = "dash-live-artifact";

        writeFileSync(
            sessionJsonlPath(homeDir, session),
            '{"type":"line","seq":1,"out":"stdout","ts":1,"text":"orphan"}\n'
        );

        const { stderr, exitCode } = await runTaskCli(["sessions"], { homeDir });

        expect(exitCode).toBe(0);
        expect(stderr).toContain("dash-live-artifact");
        expect(stderr).toContain("unknown");
        expect(stderr).not.toMatch(/dash-live-artifact\s+active\s+/);
    }, 30_000);

    it("get shows merged streams note for pty mode (bug #4)", async () => {
        const homeDir = setupHome();
        const session = `pty-note-${Date.now()}`;

        await runTaskCapture({
            session,
            tty: true,
            homeDir,
            command: ["bun", "-e", "console.log('hi')"],
        });

        const { stderr, exitCode } = await runTaskCli(["get", "--session", session], { homeDir });

        expect(exitCode).toBe(0);
        expect(stderr).toContain("pty (interactive");
        expect(stderr).toContain("Streams:   merged");
    }, 30_000);

    it("logs --all returns full session beyond default 50-line window (bug #7)", async () => {
        const homeDir = setupHome();
        const session = `all-lines-${Date.now()}`;

        const lines = Array.from({ length: 100 }, (_, i) =>
            JSON.stringify({
                type: "line",
                seq: i + 1,
                out: "stdout",
                ts: i + 1,
                text: i === 4 ? "EVAL2_EARLY_MARKER" : `line-${i + 1}`,
            })
        ).join("\n");

        writeFileSync(sessionJsonlPath(homeDir, session), `${lines}\n`);

        const defaultWindow = await runTaskCli(["logs", "--session", session, "--raw"], { homeDir });
        expect(defaultWindow.stdout).not.toContain("EVAL2_EARLY_MARKER");

        const allLines = await runTaskCli(["logs", "--session", session, "--raw", "--all"], { homeDir });
        expect(allLines.stdout).toContain("EVAL2_EARLY_MARKER");
        expect(allLines.stdout.split("\n").filter(Boolean).length).toBe(100);
    }, 30_000);

    it("tail --follow exits when session already ended (bug #5 CLI)", async () => {
        const homeDir = setupHome();
        const session = `tail-done-${Date.now()}`;

        writeFileSync(
            sessionJsonlPath(homeDir, session),
            [
                '{"type":"line","seq":1,"out":"stdout","ts":1,"text":"hello"}',
                '{"type":"exit","code":42,"durationMs":100,"ts":"2026-05-26T00:00:00.000Z"}',
            ].join("\n") + "\n"
        );

        const result = await Promise.race([
            runTaskCli(["tail", "--session", session, "--follow", "--raw"], { homeDir }),
            new Promise<{ exitCode: number; stderr: string }>((resolve) =>
                setTimeout(() => resolve({ exitCode: -1, stderr: "timeout" }), 5000)
            ),
        ]);

        expect(result.stderr).not.toBe("timeout");
        expect(result.stderr).toContain("Session exited (code 42)");
    }, 10_000);

    it("collision suffix uses underscore separator (bug #6)", async () => {
        const homeDir = setupHome();
        const session = `eval2-dup-${Date.now()}`;

        const first = await runTaskCli(["run", "--session", session, "--no-tty", "--", "echo", "one"], { homeDir });
        expect(first.exitCode).toBe(0);
        expect(first.stderr).not.toContain("note: session");

        const second = await runTaskCli(["run", "--session", session, "--no-tty", "--", "echo", "two"], { homeDir });
        expect(second.exitCode).toBe(0);
        expect(second.stderr).toMatch(new RegExp(`task-session-id: ${session}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}`));
    }, 30_000);
});

describe("eval2 bug #1 level counts", () => {
    it("does not mark all stderr lines as error in pipe capture", async () => {
        const homeDir = setupHome();
        const session = `level-count-${Date.now()}`;

        await runTaskCapture({
            session,
            noTty: true,
            homeDir,
            command: [
                "bun",
                "-e",
                [
                    "import{writeSync}from'node:fs';",
                    "for(let i=0;i<5;i++) writeSync(2,' WARN  w'+i+'\\n');",
                    "writeSync(2,'Error: one real error\\n');",
                ].join(""),
            ],
        });

        const path = join(homeDir, ".genesis-tools", "task", "sessions", `${session}.jsonl`);
        const lines = filterLineRecords(await readJsonlFile(path));
        const errorCount = lines.filter((l) => l.level === "error").length;
        const warnCount = lines.filter((l) => l.level === "warn").length;

        expect(warnCount).toBe(5);
        expect(errorCount).toBe(1);
    }, 30_000);
});
