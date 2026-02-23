import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Path to the script to be tested
const scriptPath = resolve(__dirname, "./index.ts");

interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

async function runScript(args: string[], cwd?: string): Promise<ExecResult> {
    const proc = Bun.spawn({
        cmd: ["bun", "run", scriptPath, ...args],
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
}

// Helper to run git commands in a specific directory
async function runGit(args: string[], cwd: string): Promise<ExecResult> {
    const proc = Bun.spawn({
        cmd: ["git", ...args],
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        console.error(`Git command [git ${args.join(" ")}] failed in ${cwd}:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
    }
    return { stdout, stderr, exitCode };
}

describe("git-last-commits-diff", () => {
    let testRepoDir: string;
    let originalCwd: string;

    beforeEach(async () => {
        originalCwd = process.cwd();
        const baseTmpDir = realpathSync(tmpdir());
        testRepoDir = await mkdtemp(join(baseTmpDir, "test-git-diff-"));
        process.chdir(testRepoDir); // Change CWD to the repo for script execution context

        // Initialize Git repository
        await runGit(["init", "-b", "main"], testRepoDir);
        await runGit(["config", "user.name", "Test User"], testRepoDir);
        await runGit(["config", "user.email", "test@example.com"], testRepoDir);
        await runGit(["config", "commit.gpgsign", "false"], testRepoDir);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        if (testRepoDir) {
            await rm(testRepoDir, { recursive: true, force: true });
        }
        // Ensure env var is cleaned up if a test fails before deleting it
        delete process.env.TEST_MODE_CLIPBOARD_OUTPUT_FILE;
    });

    const setupCommits = async (commitDetails: Array<{ files: Record<string, string>; message: string }>) => {
        for (const commit of commitDetails) {
            for (const [file, content] of Object.entries(commit.files)) {
                const dir = dirname(file);
                if (dir !== ".") {
                    await mkdir(join(testRepoDir, dir), { recursive: true });
                }
                await writeFile(join(testRepoDir, file), content);
                await runGit(["add", file], testRepoDir);
            }
            await runGit(["commit", "-m", commit.message], testRepoDir);
        }
        const { stdout: _log } = await runGit(["log", "--oneline"], testRepoDir);
        // console.log("Repo log after setup:\n", log);
    };

    it("should show help with --help flag", async () => {
        const { stdout, exitCode } = await runScript(["--help"], originalCwd); // Run from original CWD if script expects repo path as arg
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage: tools git-last-commits-diff <directory>");
    });

    it("should show help and exit with 1 if no directory is provided", async () => {
        const { stdout, exitCode } = await runScript([], originalCwd);
        expect(exitCode).toBe(1);
        expect(stdout).toContain("Usage: tools git-last-commits-diff <directory>");
    });

    it("should exit with error for invalid --commits value", async () => {
        await setupCommits([{ files: { "a.txt": "1" }, message: "c1" }]);
        let result = await runScript([testRepoDir, "--commits", "0"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Error: --commits value must be a positive integer.");

        result = await runScript([testRepoDir, "--commits", "abc"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Error: --commits value must be a positive integer.");
    });

    describe("Diff Generation with --commits", () => {
        beforeEach(async () => {
            await setupCommits([
                { files: { "file1.txt": "content v1" }, message: "Commit 1" },
                { files: { "file1.txt": "content v2", "file2.txt": "new file" }, message: "Commit 2" },
                { files: { "file1.txt": "content v3", "file2.txt": "new file\nupdated" }, message: "Commit 3" },
            ]);
        });

        it("should output diff for last 1 commit to stdout by default (if --output is empty string)", async () => {
            // The script defaults to interactive if no output flags. Forcing stdout via --output ""
            const { stdout, exitCode } = await runScript([testRepoDir, "--commits", "1", "--output", ""]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("diff --git a/file1.txt b/file1.txt");
            expect(stdout).toContain("-content v2");
            expect(stdout).toContain("+content v3");
            expect(stdout).toContain("diff --git a/file2.txt b/file2.txt");
            expect(stdout).not.toContain("-new file");
            expect(stdout).toContain(" new file\n+updated");
        });

        it("should output diff for last 2 commits to specified file", async () => {
            const outputFile = join(testRepoDir, "diff_output.txt");
            const { stdout, exitCode } = await runScript([testRepoDir, "--commits", "2", "--output", outputFile]);
            expect(exitCode).toBe(0);
            // Informational messages go to stdout
            expect(stdout).toContain("ℹ Will diff the last 2 commit(s)");
            expect(stdout).toContain(`ℹ Output will be written to file: ${outputFile}`);
            expect(stdout).toContain(`✔ Diff successfully written to ${outputFile}`);
            expect(stdout).toContain("✔ Absolute path ");
            expect(stdout).toContain(`"${outputFile}"`);
            expect(stdout).toContain(" copied to clipboard.");

            const diffContent = await readFile(outputFile, "utf-8");
            expect(diffContent).toContain("diff --git a/file1.txt b/file1.txt");
            expect(diffContent).toContain("-content v1"); // Diff from C1 to C3
            expect(diffContent).toContain("+content v3");

            // file2.txt did not exist in C1, created in C2, content "new file\nupdated" in C3.
            // So, when diffing C1 vs C3, file2.txt is a new file.
            expect(diffContent).toContain("diff --git a/file2.txt b/file2.txt");
            expect(diffContent).toContain("new file mode 100644");
            expect(diffContent).toContain("--- /dev/null");
            expect(diffContent).toContain("+++ b/file2.txt");
            // Content of file2.txt in C3 is "new file\nupdated"
            expect(diffContent).toContain("+new file\n+updated");
            // Since "updated" doesn't end with a newline in the setup string:
            expect(diffContent).toContain("+updated\n\\ No newline at end of file");
        });

        it("--output FILE should take precedence over --clipboard", async () => {
            const outputFile = join(testRepoDir, "output_prec.txt");
            const testClipboardFile = join(testRepoDir, "clipboard_prec_test_output.txt");
            // Set the env var to ensure that even if clipboard mode was somehow triggered, it would write to a file we can check.
            // process.env.TEST_MODE_CLIPBOARD_OUTPUT_FILE = testClipboardFile; // REMOVE, not needed as --output takes precedence

            const { stdout, exitCode, stderr } = await runScript([
                testRepoDir,
                "--commits",
                "1",
                "--output",
                outputFile,
                "--clipboard", // This should be ignored
                // No need to pass --test-mode-clipboard-file here, as clipboard action shouldn't be taken
            ]);

            // delete process.env.TEST_MODE_CLIPBOARD_OUTPUT_FILE; // REMOVE

            expect(exitCode).toBe(0);
            // Informational messages go to stdout
            expect(stdout).toContain("ℹ Will diff the last 1 commit(s)");
            expect(stdout).toContain(`ℹ Output will be written to file: ${outputFile}`);
            expect(stdout).toContain(`✔ Diff successfully written to ${outputFile}`);
            expect(stdout).toContain("✔ Absolute path ");
            expect(stdout).toContain(`"${outputFile}"`);
            expect(stdout).toContain(" copied to clipboard.");

            // Ensure the actual output file was written
            const fileContent = await readFile(outputFile, "utf-8");
            expect(fileContent).toContain("+content v3");

            // Ensure clipboard test file was NOT written and no clipboard messages in stderr
            try {
                await readFile(testClipboardFile, "utf-8");
                // If readFile succeeds, the file was created, which is an error for this test.
                throw new Error("Clipboard test file was created, but --output should have taken precedence.");
            } catch (error: unknown) {
                // Expecting ENOENT (file not found) or similar error
                expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
            }
            expect(stderr).not.toContain("[TEST MODE] Diff intended for clipboard written to");
        });
    });

    // describe("Interactive Mode - Commit Selection", () => {
    //     beforeEach(async () => {
    //         await setupCommits([
    //             { files: { "f1.txt": "a" }, message: "Short Commit A (sha_A)" },
    //             { files: { "f1.txt": "b" }, message: "Short Commit B (sha_B)" },
    //         ]);
    //     });

    //     it("should generate diff if a commit is selected interactively", async () => {
    //         // Need HEAD SHA and the SHA of HEAD~1
    //         const headShaRes = await runGit(["rev-parse", "--short", "HEAD"], testRepoDir);
    //         const prevShaRes = await runGit(["rev-parse", "--short", "HEAD~1"], testRepoDir);
    //         const headSha = headShaRes.stdout.trim();
    //         const prevSha = prevShaRes.stdout.trim();

    //         enquirerPromptSpy.mockImplementation(async (questions: any) => {
    //             if (questions.name === "selectedCommitValue") {
    //                 // Simulate user selecting the second to last commit (HEAD~1)
    //                 const choice = questions.choices.find((c: any) => c.name === prevSha);
    //                 return { selectedCommitValue: choice ? choice.name : prevSha };
    //             }
    //             if (questions.name === "selectedAction") {
    //                 return { selectedAction: "stdout" }; // Default to stdout for this test
    //             }
    //             return {};
    //         });

    //         // Run without --commits to trigger interactive commit selection, and without output flags
    //         const { stdout, stderr, exitCode } = await runScript([testRepoDir, "--output", ""]); // Force stdout
    //         console.log("Interactive stdout:", stdout);
    //         console.log("Interactive stderr:", stderr);

    //         expect(exitCode).toBe(0);
    //         expect(enquirerPromptSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'selectedCommitValue' }));
    //         expect(stdout).toContain(`diff --git a/f1.txt b/f1.txt`);
    //         expect(stdout).toContain("-a"); // Content from prevSha (Commit A)
    //         expect(stdout).toContain("+b"); // Content from HEAD (Commit B)
    //     });
    // });
});
