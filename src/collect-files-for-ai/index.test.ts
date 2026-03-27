import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { stat as fsStat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Path to the script to be tested
const scriptPath = resolve(__dirname, "./index.ts");

interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

async function runScript(args: string[]): Promise<ExecResult> {
    const proc = Bun.spawn({
        cmd: ["bun", "run", scriptPath, ...args],
        cwd: process.cwd(), // Or a specific test directory if needed
        env: { ...process.env, BUN_DEBUG: "1" }, // Enable debug logging for Bun
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
}

// Helper to run git commands in a specific directory
async function runGit(args: string[], cwd: string): Promise<ExecResult> {
    // console.log(` M Running git ${args.join(" ")} in ${cwd}`);
    const proc = Bun.spawn({
        cmd: ["git", ...args],
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        // console.error(`Git command [git ${args.join(" ")}] failed in ${cwd}:`);
        // console.error("STDOUT:", stdout);
        // console.error("STDERR:", stderr);
    }
    return { stdout, stderr, exitCode };
}

describe("collect-files-for-ai", () => {
    let testRepoDir: string;
    let originalCwd: string;

    beforeEach(async () => {
        originalCwd = process.cwd();
        // Create a temporary directory for the Git repository
        // realpathSync needed because macOS /var is a symlink to /private/var
        const baseTmpDir = realpathSync(tmpdir());
        testRepoDir = await mkdtemp(join(baseTmpDir, "test-repo-"));
        process.chdir(testRepoDir); // Change CWD to the repo for easier relative paths

        // Initialize Git repository
        await runGit(["init"], testRepoDir);
        // Configure git user for commits
        await runGit(["config", "user.name", "Test User"], testRepoDir);
        await runGit(["config", "user.email", "test@example.com"], testRepoDir);
    });

    afterEach(async () => {
        process.chdir(originalCwd); // Restore original CWD
        // Clean up the temporary Git repository directory
        if (testRepoDir) {
            await rm(testRepoDir, { recursive: true, force: true });
        }
        // Clean up any .ai directories created by tests if not inside testRepoDir
        // For now, assume target dirs are within testRepoDir or specified and cleaned up per test
    });

    const setupFiles = async (files: Record<string, string>) => {
        for (const [path, content] of Object.entries(files)) {
            const dir = dirname(path);
            if (dir !== ".") {
                await mkdir(join(testRepoDir, dir), { recursive: true });
            }
            await writeFile(join(testRepoDir, path), content);
        }
    };

    const getFilesInDir = async (dir: string, baseDir = ""): Promise<string[]> => {
        let entries: string[] = [];
        try {
            const items = await readdir(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = join(dir, item.name);
                const relativePath = baseDir ? join(baseDir, item.name) : item.name;
                if (item.isDirectory()) {
                    entries = entries.concat(await getFilesInDir(fullPath, relativePath));
                } else {
                    entries.push(relativePath);
                }
            }
        } catch (e: unknown) {
            if (e instanceof Error && "code" in e && e.code === "ENOENT") {
                return []; // If dir doesn't exist, return empty
            }
            throw e;
        }
        return entries.sort();
    };

    it("should show help with --help flag", async () => {
        const { stdout, exitCode } = await runScript(["--help"]);
        // console.log("Help STDOUT:", stdout);
        // console.log("Help STDERR:", stderr);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage: collect-uncommitted-files.ts <directory> [options]");
        expect(stdout).toContain("-c, --commits NUM");
        expect(stdout).toContain("-s, --staged");
        expect(stdout).toContain("-f, --flat");
    });

    it("should show help and exit with 1 if no directory is provided", async () => {
        const { stdout, exitCode } = await runScript([]);
        // console.log("No dir STDOUT:", stdout);
        // console.log("No dir STDERR:", stderr);
        expect(exitCode).toBe(1);
        expect(stdout).toContain("Usage: collect-uncommitted-files.ts <directory> [options]");
    });

    it("should exit with error if directory is not a git repository", async () => {
        const nonRepoDir = await mkdtemp(join(realpathSync(tmpdir()), "non-repo-"));
        process.chdir(originalCwd); // Run script from outside the temp non-repo dir

        const { stdout: _stdout, stderr, exitCode } = await runScript([nonRepoDir]);
        // console.log("Non-repo STDOUT:", stdout);
        // console.log("Non-repo STDERR:", stderr);

        expect(exitCode).toBe(1);
        // The script's logger outputs to stdout for info/error by default in the provided script
        // It might be better to configure logger to use stderr for errors in the script itself
        expect(stderr).toMatch(/Error: '.*' does not appear to be a valid Git repository/);

        process.chdir(testRepoDir); // Change back for other tests
        await rm(nonRepoDir, { recursive: true, force: true });
    });

    it("should exit with error for mutually exclusive mode flags", async () => {
        const { stderr, exitCode } = await runScript([testRepoDir, "--staged", "--unstaged"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Error: Options --commits, --staged, --unstaged, --all are mutually exclusive.");
    });

    it("should exit with error for invalid --commits value", async () => {
        let result = await runScript([testRepoDir, "--commits", "0"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Error: --commits must be a positive integer.");

        result = await runScript([testRepoDir, "--commits", "-1"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Error: --commits must be a positive integer.");

        result = await runScript([testRepoDir, "--commits", "abc"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Error: --commits must be a positive integer.");
    });

    describe("File Collection Modes", () => {
        let targetOutputDir: string;

        beforeEach(async () => {
            // Create a unique target directory for each test within this describe block
            // Note: The script itself creates a timestamped dir if -t is not given.
            // For predictable testing, we'll usually provide -t.
            targetOutputDir = join(testRepoDir, ".test-output");
            await mkdir(targetOutputDir, { recursive: true });
        });

        afterEach(async () => {
            // Clean up the specific target output directory
            if (targetOutputDir) {
                await rm(targetOutputDir, { recursive: true, force: true });
            }
            // Clean up default .ai directories, if any were created due to -t not being used
            const defaultAiDir = join(testRepoDir, ".ai");
            try {
                const stats = await fsStat(defaultAiDir);
                if (stats.isDirectory()) {
                    await rm(defaultAiDir, { recursive: true, force: true });
                }
            } catch (e: unknown) {
                if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
                    throw e;
                }
            }
        });

        it("should collect staged files with --staged", async () => {
            await setupFiles({ "file1.txt": "content1", "file2.txt": "content2" });
            await runGit(["add", "file1.txt"], testRepoDir);

            const { stdout, exitCode } = await runScript([testRepoDir, "--staged", "-t", targetOutputDir]);
            // console.log("--staged STDOUT:", stdout);
            // console.log("--staged STDERR:", stderr);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Found 1 file(s) to copy.");
            expect(stdout).toContain("Copied: file1.txt");

            const copiedFiles = await getFilesInDir(targetOutputDir);
            expect(copiedFiles).toEqual(["file1.txt"]);
            const file1Content = await Bun.file(join(targetOutputDir, "file1.txt")).text();
            expect(file1Content).toBe("content1");
        });

        it("should collect staged files with --staged and --flat", async () => {
            await setupFiles({ "dir1/file1.txt": "content1", "file2.txt": "content2" });
            await runGit(["add", "dir1/file1.txt"], testRepoDir);

            const { stdout, exitCode } = await runScript([testRepoDir, "--staged", "-t", targetOutputDir, "--flat"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Found 1 file(s) to copy.");
            expect(stdout).toContain("Copied: dir1/file1.txt as file1.txt");

            const copiedFiles = await getFilesInDir(targetOutputDir);
            expect(copiedFiles).toEqual(["file1.txt"]);
            const file1Content = await Bun.file(join(targetOutputDir, "file1.txt")).text();
            expect(file1Content).toBe("content1");
        });

        it("should collect unstaged (modified) files with --unstaged", async () => {
            await setupFiles({ "file1.txt": "initial content", "file2.txt": "content2" });
            await runGit(["add", "."], testRepoDir);
            await runGit(["commit", "-m", "Initial commit"], testRepoDir);

            await writeFile(join(testRepoDir, "file1.txt"), "modified content"); // Unstaged modification

            const { stdout, exitCode } = await runScript([testRepoDir, "--unstaged", "-t", targetOutputDir]);
            // console.log("--unstaged STDOUT:", stdout);
            // console.log("--unstaged STDERR:", stderr);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Found 1 file(s) to copy.");
            expect(stdout).toContain("Copied: file1.txt");

            const copiedFiles = await getFilesInDir(targetOutputDir);
            expect(copiedFiles).toEqual(["file1.txt"]);
            const file1Content = await Bun.file(join(targetOutputDir, "file1.txt")).text();
            expect(file1Content).toBe("modified content");
        });

        it("should collect all uncommitted (staged + unstaged) with --all", async () => {
            await setupFiles({
                "tracked_modified.txt": "initial",
                "tracked_staged.txt": "initial",
                "new_unstaged.txt": "new", // This won't be picked by 'git diff --name-only HEAD' unless added
                "new_staged.txt": "new staged",
            });
            await runGit(["add", "tracked_modified.txt", "tracked_staged.txt"], testRepoDir);
            await runGit(["commit", "-m", "Initial commit for tracked files"], testRepoDir);

            // Modify a tracked file (becomes unstaged)
            await writeFile(join(testRepoDir, "tracked_modified.txt"), "modified");

            // Stage a different tracked file
            await writeFile(join(testRepoDir, "tracked_staged.txt"), "staged modification");
            await runGit(["add", "tracked_staged.txt"], testRepoDir);

            // Stage a new file
            await runGit(["add", "new_staged.txt"], testRepoDir);

            const { stdout, exitCode } = await runScript([testRepoDir, "--all", "-t", targetOutputDir]);
            // console.log("--all STDOUT:", stdout);
            // console.log("--all STDERR:", stderr);

            expect(exitCode).toBe(0);
            // The script uses `git diff --name-only HEAD` for --all, which shows staged and unstaged *modifications* to *tracked* files.
            // It does not show newly created, unstaged files that are not yet tracked.
            // It does not list untracked files.
            // `git diff --name-only HEAD` shows:
            // 1. tracked_modified.txt (unstaged change to a tracked file)
            // 2. tracked_staged.txt (staged change to a tracked file)
            // 3. new_staged.txt (staged new file)
            expect(stdout).toContain("Found 3 file(s) to copy.");
            expect(stdout).toContain("Copied: tracked_modified.txt");
            expect(stdout).toContain("Copied: tracked_staged.txt");
            expect(stdout).toContain("Copied: new_staged.txt");

            const copiedFiles = await getFilesInDir(targetOutputDir);
            expect(copiedFiles).toEqual(
                expect.arrayContaining(["tracked_modified.txt", "tracked_staged.txt", "new_staged.txt"])
            );
            expect(copiedFiles.length).toBe(3);

            const modContent = await Bun.file(join(targetOutputDir, "tracked_modified.txt")).text();
            expect(modContent).toBe("modified");
            const stagedContent = await Bun.file(join(targetOutputDir, "tracked_staged.txt")).text();
            expect(stagedContent).toBe("staged modification");
            const newStagedContent = await Bun.file(join(targetOutputDir, "new_staged.txt")).text();
            expect(newStagedContent).toBe("new staged");
        });

        it("should use default mode 'all' if no mode specified", async () => {
            await setupFiles({ "file1.txt": "initial" });
            await runGit(["add", "."], testRepoDir);
            await runGit(["commit", "-m", "initial"], testRepoDir);
            await writeFile(join(testRepoDir, "file1.txt"), "modified"); // Unstaged

            const { stdout, exitCode } = await runScript([testRepoDir, "-t", targetOutputDir]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Found 1 file(s) to copy."); // file1.txt is modified
            expect(stdout).toContain("Copied: file1.txt");
            const copiedFiles = await getFilesInDir(targetOutputDir);
            expect(copiedFiles).toEqual(["file1.txt"]);
        });

        describe("--commits mode", () => {
            beforeEach(async () => {
                // Commit 1
                await setupFiles({ "file_c1.txt": "c1", "shared.txt": "c1" });
                await runGit(["add", "."], testRepoDir);
                await runGit(["commit", "-m", "commit 1"], testRepoDir);

                // Commit 2
                await setupFiles({ "file_c2.txt": "c2", "shared.txt": "c2" }); // shared.txt modified
                await runGit(["add", "."], testRepoDir);
                await runGit(["commit", "-m", "commit 2"], testRepoDir);

                // Commit 3
                await setupFiles({ "file_c3.txt": "c3", "shared.txt": "c3" }); // shared.txt modified again
                await runGit(["add", "."], testRepoDir);
                await runGit(["commit", "-m", "commit 3"], testRepoDir);

                // Uncommitted changes (should not be picked by --commits)
                await writeFile(join(testRepoDir, "uncommitted.txt"), "uncommitted");
                await runGit(["add", "uncommitted.txt"], testRepoDir); // stage it
            });

            it("should collect files from the last commit with --commits 1", async () => {
                const { stdout, exitCode } = await runScript([testRepoDir, "--commits", "1", "-t", targetOutputDir]);
                // console.log("--commits 1 STDOUT:", stdout);
                expect(exitCode).toBe(0);
                // Diff between HEAD~1 and HEAD
                // file_c3.txt was added in HEAD, shared.txt was modified in HEAD
                expect(stdout).toContain("Found 2 file(s) to copy.");
                expect(stdout).toContain("Copied: file_c3.txt");
                expect(stdout).toContain("Copied: shared.txt");

                const copiedFiles = await getFilesInDir(targetOutputDir);
                expect(copiedFiles).toEqual(expect.arrayContaining(["file_c3.txt", "shared.txt"]));
                expect(copiedFiles.length).toBe(2);

                const c3Content = await Bun.file(join(targetOutputDir, "file_c3.txt")).text();
                expect(c3Content).toBe("c3");
                const sharedContent = await Bun.file(join(targetOutputDir, "shared.txt")).text();
                expect(sharedContent).toBe("c3"); // Content from HEAD
            });

            it("should collect files from the last 2 commits with --commits 2", async () => {
                const { stdout, exitCode } = await runScript([testRepoDir, "--commits", "2", "-t", targetOutputDir]);
                // console.log("--commits 2 STDOUT:", stdout);
                expect(exitCode).toBe(0);
                // Diff between HEAD~2 and HEAD
                // file_c2.txt (from commit 2)
                // file_c3.txt (from commit 3)
                // shared.txt (modified in commit 2 and commit 3, so it's included, content from HEAD)
                expect(stdout).toContain("Found 3 file(s) to copy.");
                expect(stdout).toContain("Copied: file_c2.txt");
                expect(stdout).toContain("Copied: file_c3.txt");
                expect(stdout).toContain("Copied: shared.txt");

                const copiedFiles = await getFilesInDir(targetOutputDir);
                expect(copiedFiles).toEqual(expect.arrayContaining(["file_c2.txt", "file_c3.txt", "shared.txt"]));
                expect(copiedFiles.length).toBe(3);

                const sharedContent = await Bun.file(join(targetOutputDir, "shared.txt")).text();
                expect(sharedContent).toBe("c3"); // Content from HEAD
            });

            it("should collect files with --commits and --flat", async () => {
                await setupFiles({ "dir/file_c4.txt": "c4" });
                await runGit(["add", "."], testRepoDir);
                await runGit(["commit", "-m", "commit 4 with dir"], testRepoDir); // This is now HEAD

                // HEAD is commit 4, HEAD~1 is commit 3
                const { stdout, exitCode } = await runScript([
                    testRepoDir,
                    "--commits",
                    "1",
                    "-t",
                    targetOutputDir,
                    "--flat",
                ]);
                expect(exitCode).toBe(0);
                expect(stdout).toContain("Found 1 file(s) to copy."); // Only dir/file_c4.txt from the latest commit
                expect(stdout).toContain("Copied: dir/file_c4.txt as file_c4.txt");

                const copiedFiles = await getFilesInDir(targetOutputDir);
                expect(copiedFiles).toEqual(["file_c4.txt"]); // Flattened
            });

            it("should handle --commits NUM greater than history (collects all based on git diff behavior)", async () => {
                const { stdout, exitCode } = await runScript([testRepoDir, "--commits", "10", "-t", targetOutputDir]); // We have 3 commits initially in this describe block
                expect(exitCode).toBe(0);
                // Git diff HEAD~10 HEAD will effectively be all tracked files if 10 > num_commits in the repo
                // For this specific setup (Commit 1, 2, 3): file_c1.txt, file_c2.txt, file_c3.txt, shared.txt
                expect(stdout).toContain("Found 4 file(s) to copy.");
                const copiedFiles = await getFilesInDir(targetOutputDir);
                expect(copiedFiles).toEqual(
                    expect.arrayContaining(["file_c1.txt", "file_c2.txt", "file_c3.txt", "shared.txt"])
                );
                expect(copiedFiles.length).toBe(4);
            });
        });

        it("should create default target directory if -t is not specified", async () => {
            await setupFiles({ "file.txt": "content" });
            await runGit(["add", "file.txt"], testRepoDir);
            // No commit, so it's uncommitted/staged. Default mode is 'all'.

            // Mock getTimestampDirName to return a predictable name for this test
            // This is tricky as the script is run as a separate process.
            // Instead, we'll check for the existence of a .ai directory and its contents.
            // We'll need to clean up this .ai directory in afterEach more robustly.

            const { stdout, exitCode } = await runScript([testRepoDir]); // No -t
            // console.log("Default target STDOUT:", stdout);
            // console.log("Default target STDERR:", stderr);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Found 1 file(s) to copy.");
            expect(stdout).toContain("Copied: file.txt");

            const aiDir = join(testRepoDir, ".ai");
            const subDirs = await readdir(aiDir);
            expect(subDirs.length).toBe(1); // Expect one timestamped directory

            const timestampDir = join(aiDir, subDirs[0]);
            const copiedFiles = await getFilesInDir(timestampDir);
            expect(copiedFiles).toEqual(["file.txt"]);
            const fileContent = await Bun.file(join(timestampDir, "file.txt")).text();
            expect(fileContent).toBe("content");
        });

        it("should handle no files matching criteria", async () => {
            // Fresh repo, no commits, no staged/unstaged files
            await runGit(["commit", "--allow-empty", "-m", "empty initial"], testRepoDir); // Make sure HEAD exists

            const { stdout, exitCode } = await runScript([testRepoDir, "--staged", "-t", targetOutputDir]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("No files found matching the criteria.");
            const copiedFiles = await getFilesInDir(targetOutputDir);
            expect(copiedFiles.length).toBe(0);
        });
    });
});
