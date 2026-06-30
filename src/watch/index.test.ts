import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scriptPath = resolve(__dirname, "./index.ts");

interface OutputBuffer {
    stdout: string;
    stderr: string;
}

interface WatchResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    process: ChildProcess;
    // Live, continuously-accumulating buffer (mutated by the stdout/stderr listeners
    // from spawn time). Follow-mode assertions read this via waitForOutput so they never
    // race against output emitted between snapshot time and a late listener attach.
    output: OutputBuffer;
}

// Helper to run the watch script
async function runWatchScript(args: string[], testDir: string, timeoutMs = 5000): Promise<WatchResult> {
    const output: OutputBuffer = { stdout: "", stderr: "" };

    const scriptProcess = spawn("bun", ["run", scriptPath, ...args], {
        cwd: testDir,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
    });

    scriptProcess.stdout.on("data", (data) => {
        output.stdout += data.toString();
        // console.log("[SCRIPT STDOUT]:", data.toString());
    });
    scriptProcess.stderr.on("data", (data) => {
        output.stderr += data.toString();
        // console.error("[SCRIPT STDERR]:", data.toString());
    });

    const exitPromise = new Promise<number | null>((res) => {
        scriptProcess.on("close", res);
        scriptProcess.on("error", () => res(1));
    });

    let exitCode: number | null = null;
    if (!args.includes("-f") && !args.includes("--follow")) {
        exitCode = await Promise.race([
            exitPromise,
            sleep(timeoutMs, null).then(() => {
                if (!scriptProcess.killed) {
                    scriptProcess.kill();
                }
                return -1;
            }),
        ]);
        if (exitCode === -1) {
            console.warn("Script did not exit as expected in non-follow mode.");
        }
    } else {
        await sleep(500);
    }

    return { ...output, exitCode, process: scriptProcess, output };
}

async function stopWatchScript(proc: ChildProcess): Promise<void> {
    if (!proc || proc.killed) {
        return;
    }
    return new Promise((resolve) => {
        let killTimer: NodeJS.Timeout | null = null;
        const onExit = () => {
            if (killTimer) {
                clearTimeout(killTimer);
            }
            resolve();
        };
        proc.on("exit", onExit);
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
            killTimer = null;
            if (!proc.killed) {
                proc.kill("SIGKILL");
            }
            proc.removeListener("exit", onExit);
            resolve();
        }, 1000) as ReturnType<typeof setTimeout>;
    });
}

// Helper to create a directory structure
async function createStructure(basePath: string, structure: Record<string, string | null>) {
    for (const [path, content] of Object.entries(structure)) {
        const fullPath = join(basePath, path);
        await mkdir(dirname(fullPath), { recursive: true });
        if (content !== null) {
            await writeFile(fullPath, content);
        }
    }
}

describe("watch tool", () => {
    let testDir: string;
    let currentProcess: ChildProcess | null = null;

    beforeEach(async () => {
        const baseTmpDir = realpathSync(tmpdir());
        testDir = await mkdtemp(join(baseTmpDir, "test-watch-"));
    });

    afterEach(async () => {
        if (currentProcess) {
            await stopWatchScript(currentProcess);
            currentProcess = null;
        }
        if (testDir) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("should show help with --help flag", async () => {
        const result = await runWatchScript(["--help"], testDir);
        currentProcess = result.process;
        expect(result.exitCode).toBe(0);
        // Help is rendered by commander to stdout.
        expect(result.stdout).toContain("Usage: watch");
        expect(result.stdout).toContain("-f, --follow");
    });

    it("should error if no glob pattern is provided", async () => {
        const result = await runWatchScript([], testDir);
        currentProcess = result.process;
        expect(result.exitCode).toBe(1);
        // `patterns` is a required (variadic) argument; commander reports the missing-arg
        // error and prints usage, both on stderr.
        expect(result.stderr).toContain("missing required argument 'patterns'");
        expect(result.stderr).toContain("Usage: watch");
    });

    it("should warn if glob pattern is likely shell-expanded (single non-glob arg)", async () => {
        await createStructure(testDir, { "testfile.txt": "content" });
        const result = await runWatchScript(["testfile.txt"], testDir);
        currentProcess = result.process;
        expect(result.exitCode).toBe(1);
        // The shell-expansion warning and its guidance are diagnostics → stderr.
        expect(result.stderr).toContain("Error: It appears your glob patterns may have been expanded by the shell");
        expect(result.stderr).toContain("To prevent this, please wrap each pattern in quotes:");
        expect(result.stderr).toContain(
            "Without quotes, the shell expands wildcards before passing arguments to the script."
        );
    });

    it("should not warn for shell expansion if glob pattern is quoted (contains glob chars)", async () => {
        const result = await runWatchScript(["*.nothing"], testDir);
        currentProcess = result.process;
        expect(result.stderr).not.toContain("Error: It appears your glob patterns may have been expanded by the shell");
        expect([1, null].includes(result.exitCode)).toBe(true);
    });

    describe("Non-Follow Mode (Snapshot of files)", () => {
        it("should display initial content of matched files and exit", async () => {
            await createStructure(testDir, {
                "file1.txt": "Line1\nLine2",
                "sub/file2.log": "Log Data 1\nLog Data 2\nLog Data 3",
                "another.txt": "Single line",
            });
            await sleep(50);
            await writeFile(join(testDir, "file1.txt"), "Line1\nLine2\nUpdatedL1");

            const result = await runWatchScript(["*.txt", "sub/*.log", "-n", "2"], testDir);
            currentProcess = result.process;

            expect(result.exitCode).toBe(0);
            // Snapshot output (file headers + content) is rendered via logger → stderr.
            expect(result.stderr).toContain("EXISTING FILE:");
            expect(result.stderr).toContain("another.txt");
            expect(result.stderr).toContain("Single line");
            expect(result.stderr).toContain("file1.txt");
            expect(result.stderr).toContain("UpdatedL1");
            expect(result.stderr).toContain("sub/file2.log");
            expect(result.stderr).toContain("Log Data 3");
            expect(result.stderr).toContain("Log Data 2");
        }, 10000);
    });

    describe("Follow Mode (-f)", () => {
        // Poll the live, continuously-accumulating stderr buffer (where the tool's
        // file output is rendered via logger.info). Polling the shared buffer — rather
        // than attaching a fresh listener — is race-free: output emitted before this call
        // is already captured. Resolves as soon as the pattern appears; the timeout is a
        // ceiling, not a delay.
        async function waitForOutput(output: OutputBuffer, text: string | RegExp, timeout = 5000): Promise<boolean> {
            const matches = () => (typeof text === "string" ? output.stderr.includes(text) : text.test(output.stderr));
            const start = Date.now();
            while (Date.now() - start < timeout) {
                if (matches()) {
                    return true;
                }

                await sleep(50);
            }

            return matches();
        }

        it("should display initial files and then new content for appends", async () => {
            await createStructure(testDir, { "follow.txt": "Initial content." });
            const result = await runWatchScript(["*.txt", "-f", "-n", "10"], testDir, 15000);
            currentProcess = result.process;

            const initialOutputFound = await waitForOutput(
                result.output,
                /EXISTING FILE:.*follow\.txt.*Initial content\./s
            );
            expect(initialOutputFound).toBe(true);

            // Wait until the file watcher is fully active before mutating, so a cold
            // start can't drop the append (root-cause sync, not a timing guess).
            expect(await waitForOutput(result.output, "Watcher initialized and ready")).toBe(true);

            // Follow mode emits only newly-appended content (tail -f semantics), so each
            // update block shows just the new line, not the whole file. The "UPDATED:" header
            // is intentionally suppressed for consecutive appends to the SAME file (index.ts
            // 275-283 dedups on lastUpdatedFile), so we assert on the appended content itself.
            await appendFile(join(testDir, "follow.txt"), "\nAppended line 1.");
            const update1Found = await waitForOutput(result.output, /Appended line 1\./);
            expect(update1Found).toBe(true);

            await appendFile(join(testDir, "follow.txt"), "\nAppended line 2.");
            const update2Found = await waitForOutput(result.output, /Appended line 2\./);
            expect(update2Found).toBe(true);
        }, 15000);

        it("should detect and display content of new files", async () => {
            const result = await runWatchScript(["*.new", "-f"], testDir, 15000);
            currentProcess = result.process;

            // Starting with NO matching file, follow mode keeps watching (index.ts only
            // exits-on-empty in snapshot mode). Detection of a later-created file comes from
            // the 1s directory rescan, not a per-file watcher, so we don't gate on the
            // "ready" line here; we give the NEW FILE wait enough margin for cold start +
            // one rescan cycle.
            await sleep(1000);

            await writeFile(join(testDir, "newfile.new"), "Content of new file.");
            const newFileFound = await waitForOutput(
                result.output,
                /NEW FILE:.*newfile\.new.*Content of new file\./s,
                10000
            );
            expect(newFileFound).toBe(true);
        }, 15000);

        it("should report removed files", async () => {
            await createStructure(testDir, { "todelete.del": "delete me" });
            const result = await runWatchScript(["*.del", "-f"], testDir, 15000);
            currentProcess = result.process;

            // Ensure the watcher is active before removing, so the deletion is observed.
            expect(await waitForOutput(result.output, "Watcher initialized and ready")).toBe(true);

            await unlink(join(testDir, "todelete.del"));
            const removedFileFound = await waitForOutput(result.output, /REMOVED:.*todelete\.del/s);
            expect(removedFileFound).toBe(true);
        }, 15000);
    });
});
