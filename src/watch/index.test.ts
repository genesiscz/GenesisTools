import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scriptPath = resolve(__dirname, "./index.ts");

interface WatchResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    process: ChildProcess;
}

// Helper to run the watch script
async function runWatchScript(args: string[], testDir: string, timeoutMs = 5000): Promise<WatchResult> {
    const output = { stdout: "", stderr: "" };

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

    return { ...output, exitCode, process: scriptProcess };
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
        expect(result.stdout).toContain("Usage:\n  tools watch [glob-pattern] [options]");
    });

    it("should error if no glob pattern is provided", async () => {
        const result = await runWatchScript([], testDir);
        currentProcess = result.process;
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Error: No glob pattern provided");
        expect(result.stdout).toContain("Use --help for usage information");
    });

    it("should warn if glob pattern is likely shell-expanded (single non-glob arg)", async () => {
        await createStructure(testDir, { "testfile.txt": "content" });
        const result = await runWatchScript(["testfile.txt"], testDir);
        currentProcess = result.process;
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Error: It appears your glob patterns may have been expanded by the shell");
        expect(result.stdout).toContain("To prevent this, please wrap each pattern in quotes:");
        expect(result.stdout).toContain(
            "Without quotes, the shell expands wildcards before passing arguments to the script."
        );
    });

    it("should not warn for shell expansion if glob pattern is quoted (contains glob chars)", async () => {
        const result = await runWatchScript(["*.nothing"], testDir);
        currentProcess = result.process;
        expect(result.stdout).not.toContain("Error: It appears your glob patterns may have been expanded by the shell");
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
            expect(result.stdout).toContain("EXISTING FILE:");
            expect(result.stdout).toContain("another.txt");
            expect(result.stdout).toContain("Single line");
            expect(result.stdout).toContain("file1.txt");
            expect(result.stdout).toContain("UpdatedL1");
            expect(result.stdout).toContain("sub/file2.log");
            expect(result.stdout).toContain("Log Data 3");
            expect(result.stdout).toContain("Log Data 2");
        }, 10000);
    });

    describe("Follow Mode (-f)", () => {
        async function waitForOutput(proc: ChildProcess, text: string | RegExp, timeout = 5000): Promise<boolean> {
            return new Promise((resolve) => {
                let accumulatedStdout = "";
                let timer: NodeJS.Timeout | null = null;
                const listener = (data: Buffer) => {
                    const chunk = data.toString();
                    accumulatedStdout += chunk;
                    if (typeof text === "string" ? accumulatedStdout.includes(text) : text.test(accumulatedStdout)) {
                        if (timer) {
                            clearTimeout(timer);
                        }
                        proc.stdout?.removeListener("data", listener);
                        resolve(true);
                    }
                };
                proc.stdout?.on("data", listener);
                timer = setTimeout(() => {
                    timer = null;
                    proc.stdout?.removeListener("data", listener);
                    resolve(false);
                }, timeout) as ReturnType<typeof setTimeout>;
            });
        }

        it("should display initial files and then new content for appends", async () => {
            await createStructure(testDir, { "follow.txt": "Initial content." });
            const result = await runWatchScript(["*.txt", "-f", "-n", "10"], testDir, 15000);
            currentProcess = result.process;

            const initialOutputFound = await waitForOutput(
                result.process,
                /EXISTING FILE: .*follow.txt.*Initial content\./s
            );
            expect(initialOutputFound).toBe(true);

            await appendFile(join(testDir, "follow.txt"), "\nAppended line 1.");
            const update1Found = await waitForOutput(
                result.process,
                /UPDATED: follow.txt.*Initial content\.\nAppended line 1\./s
            );
            expect(update1Found).toBe(true);

            await appendFile(join(testDir, "follow.txt"), "\nAppended line 2.");
            const update2Found = await waitForOutput(
                result.process,
                /UPDATED: follow.txt.*Appended line 1\.\nAppended line 2\./s
            );
            expect(update2Found).toBe(true);
        }, 5000);

        it("should detect and display content of new files", async () => {
            const result = await runWatchScript(["*.new", "-f"], testDir, 15000);
            currentProcess = result.process;

            await sleep(1000);

            await writeFile(join(testDir, "newfile.new"), "Content of new file.");
            const newFileFound = await waitForOutput(result.process, /NEW FILE: .*newfile.new.*Content of new file\./s);
            expect(newFileFound).toBe(true);
        }, 5000);

        it("should report removed files", async () => {
            await createStructure(testDir, { "todelete.del": "delete me" });
            const result = await runWatchScript(["*.del", "-f"], testDir, 15000);
            currentProcess = result.process;

            await unlink(join(testDir, "todelete.del"));
            const removedFileFound = await waitForOutput(result.process, /REMOVED: .*todelete.del/s);
            expect(removedFileFound).toBe(true);
        }, 5000);
    });
});
