import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, resolve, dirname } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import type { Subprocess, FileSink } from "bun"; // Import Subprocess and FileSink types

// Path to the script to be tested
const scriptPath = resolve(__dirname, "./index.ts");

interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

// Define a type for stdio elements based on common usage for this test helper
type StdioPipeOrIgnore = "pipe" | "ignore";

interface TestSpawnOptions {
    cmd: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: [StdioPipeOrIgnore, StdioPipeOrIgnore, StdioPipeOrIgnore]; // Stdin, Stdout, Stderr
}

async function runScript(args: string[], stdinContent: string | null = null, cwd?: string): Promise<ExecResult> {
    const opts: TestSpawnOptions = {
        cmd: ["bun", "run", scriptPath, ...args],
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: [stdinContent ? "pipe" : "ignore", "pipe", "pipe"],
    };

    const proc: Subprocess = Bun.spawn(opts);

    if (stdinContent && proc.stdin) {
        // When stdio[0] is "pipe", proc.stdin is a FileSink.
        const stdinSink = proc.stdin as FileSink;
        stdinSink.write(stdinContent); // Call write directly on FileSink
        await stdinSink.end();       // Call end directly on FileSink
    }

    // When stdio[1] and stdio[2] are "pipe", proc.stdout/stderr are ReadableStream.
    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
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

// Helper to get all file paths in a directory recursively (for verifying output dir contents)
async function getFilesInDirRecursive(dir: string, baseDir = dir): Promise<string[]> {
    let entries: string[] = [];
    try {
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
            const fullPath = join(dir, item.name);
            const relativePath = fullPath.substring(baseDir.length + 1); // +1 for the slash
            if (item.isDirectory()) {
                entries = entries.concat(await getFilesInDirRecursive(fullPath, baseDir));
            } else {
                entries.push(relativePath);
            }
        }
    } catch (e: any) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
    return entries.sort();
}

describe("files-to-prompt", () => {
    let testDir: string;
    let originalCwd: string;

    beforeEach(async () => {
        originalCwd = process.cwd();
        const baseTmpDir = realpathSync(tmpdir());
        testDir = await mkdtemp(join(baseTmpDir, "test-files-prompt-"));
        // Most tests will run with testDir as CWD or pass paths relative to it
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        if (testDir) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("should show help with --help flag", async () => {
        const { stdout, stderr, exitCode } = await runScript(["--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage: files-to-prompt [options] [paths...]");
        expect(stdout).toContain("-e, --extension");
        expect(stdout).toContain("--include-hidden");
        expect(stdout).toContain("--cxml");
        expect(stdout).toContain("--markdown");
        expect(stdout).toMatch(/-n, --line-numbers\s+Add line numbers to the output/);
        expect(stdout).toMatch(/files-to-prompt v\d+\.\d+\.\d+/);
    });

    it("should output version with --version flag", async () => {
        // Assuming version is hardcoded or accessible. The provided script snippet doesn't show version implementation.
        // This test might need adjustment if version handling is different.
        const { stdout, exitCode } = await runScript(["--version"]);
        expect(exitCode).toBe(0);
        // A simple check, actual version string might vary.
        // The provided script shows 'version?: boolean' in options, but no implementation for it.
        // The actual script might have it or this test will fail until implemented.
        // For now, let's assume it prints something like "files-to-prompt version x.y.z"
        // If not implemented, it might just show help or exit cleanly. Let's check for non-error exit.
        // Based on current script structure (if --version leads to no action and no error), it might show help.
        // The script shows `if (argv.version || argv.v) { showVersion(); process.exit(0); }`
        // but showVersion() is not in the provided snippet.
        // If showVersion() is missing, it would error. Let's assume for now it's a placeholder or exits cleanly.
        // The original script actually has `if (argv.version) { logger.info(VERSION); process.exit(0); }`
        // and `const VERSION = "1.2.0";` so this test should work if that part of script is present.
        // For now, let's assume it contains the word "version" or exits cleanly.
        // The provided code doesn't have VERSION or showVersion. Let's assume it doesn't crash.
        expect(stdout).toMatch(/files-to-prompt v\d+\.\d+\.\d+/);
    });

    describe("Basic File/Directory Processing", () => {
        it("should process a single file", async () => {
            await createStructure(testDir, { "file1.txt": "Hello World" });
            const { stdout, exitCode } = await runScript([join(testDir, "file1.txt")]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(join(testDir, "file1.txt"));
            expect(stdout).toContain("---");
            expect(stdout).toContain("Hello World");
        });

        it("should process multiple files", async () => {
            await createStructure(testDir, {
                "file1.txt": "Content1",
                "file2.log": "Content2"
            });
            const { stdout, exitCode } = await runScript([join(testDir, "file1.txt"), join(testDir, "file2.log")]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(join(testDir, "file1.txt"));
            expect(stdout).toContain("Content1");
            expect(stdout).toContain(join(testDir, "file2.log"));
            expect(stdout).toContain("Content2");
        });

        it("should process a directory recursively", async () => {
            await createStructure(testDir, {
                "file1.txt": "Root file",
                "subdir/file2.txt": "Nested file",
                "subdir/another.log": "Nested log"
            });
            const { stdout, exitCode } = await runScript([testDir]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(join(testDir, "file1.txt"));
            expect(stdout).toContain("Root file");
            expect(stdout).toContain(join(testDir, "subdir/file2.txt"));
            expect(stdout).toContain("Nested file");
            expect(stdout).toContain(join(testDir, "subdir/another.log"));
            expect(stdout).toContain("Nested log");
        });

        it("should output to a specified file with -o", async () => {
            await createStructure(testDir, { "file1.txt": "Output this" });
            const outputFile = join(testDir, "output.txt");
            const { stdout, exitCode } = await runScript([
                join(testDir, "file1.txt"),
                "-o", outputFile
            ]);
            expect(exitCode).toBe(0);
            expect(stdout).toBe(""); // No stdout when -o is used

            const outputContent = await readFile(outputFile, "utf-8");
            expect(outputContent).toContain(join(testDir, "file1.txt"));
            expect(outputContent).toContain("Output this");
        });
    });

    describe("Formatting Options", () => {
        beforeEach(async () => {
            await createStructure(testDir, { "test.js": "console.log('hello');" });
        });

        it("should output with line numbers using -n", async () => {
            const { stdout, exitCode } = await runScript([
                join(testDir, "test.js"),
                "--lineNumbers"
            ]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(join(testDir, "test.js"));
            expect(stdout).toContain("---");
            expect(stdout).toMatch(/1\s+console\.log\('hello'\);/);
        });

        it("should output in Markdown format using -m", async () => {
            const { stdout, exitCode } = await runScript([
                join(testDir, "test.js"),
                "-m"
            ]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(join(testDir, "test.js"));
            expect(stdout).toMatch(/```javascript\s*console\.log\('hello'\);\s*```/s);
        });

        it("should output in Claude XML format using -c", async () => {
            // Reset globalIndex for predictability if possible, or ensure test is isolated
            // The script has globalIndex = 1. If tests run sequentially, this will increment.
            // This requires running the script in a way that resets its global state or making globalIndex not global.
            // For now, we'll just check for the pattern, assuming it starts at some index.
            const { stdout, exitCode } = await runScript([
                join(testDir, "test.js"),
                "-c"
            ]);
            expect(exitCode).toBe(0);
            expect(stdout).toMatch(/<document index="\d+">/);
            expect(stdout).toContain(`<source>${join(testDir, "test.js")}</source>`);
            expect(stdout).toContain("<document_content>");
            expect(stdout).toContain("console.log('hello');");
            expect(stdout).toContain("</document_content>");
            expect(stdout).toContain("</document>");
        });

        it("should use Markdown with line numbers", async () => {
            const { stdout, exitCode } = await runScript([
                join(testDir, "test.js"),
                "-m", "--lineNumbers"
            ]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(join(testDir, "test.js"));
            expect(stdout).toMatch(/```javascript\s*1\s+console\.log\('hello'\);\s*```/s);
        });

        it("should correctly determine backticks for markdown", async () => {
            await createStructure(testDir, { "test_with_backticks.md": "```js\nconsole.log('hello');\n```" });
            const { stdout, exitCode } = await runScript([
                join(testDir, "test_with_backticks.md"),
                "-m"
            ]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(join(testDir, "test_with_backticks.md"));
            expect(stdout).toMatch(/````\s*```js\nconsole\.log\(\'hello\'\);\n```\s*````/s);
        });
    });

    describe("Filtering Options", () => {
        beforeEach(async () => {
            await createStructure(testDir, {
                "file.txt": "text content",
                "file.js": "javascript content",
                "file.ts": "typescript content",
                "subdir/another.txt": "more text",
                ".hiddenfile": "hidden content",
                "subdir/.hidden_in_subdir": "hidden two"
            });
        });

        it("should filter by single extension with -e", async () => {
            const { stdout, exitCode } = await runScript([testDir, "-e", "js"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(join(testDir, "file.js"));
            expect(stdout).toContain("javascript content");
            expect(stdout).not.toContain("text content");
            expect(stdout).not.toContain("typescript content");
        });

        it("should filter by multiple extensions with -e", async () => {
            const { stdout, exitCode } = await runScript([testDir, "-e", "js", "-e", "ts"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("javascript content");
            expect(stdout).toContain("typescript content");
            expect(stdout).not.toContain("text content");
        });

        it("should include hidden files with --includeHidden", async () => {
            const { stdout, exitCode } = await runScript([testDir, "--includeHidden"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(".hiddenfile");
            expect(stdout).toContain("hidden content");
            expect(stdout).toContain(join(testDir, "subdir/.hidden_in_subdir"));
            expect(stdout).toContain("hidden two");
        });

        it("should exclude hidden files by default", async () => {
            const { stdout, exitCode } = await runScript([testDir]);
            expect(exitCode).toBe(0);
            expect(stdout).not.toContain(".hiddenfile");
            expect(stdout).not.toContain(join(testDir, "subdir/.hidden_in_subdir"));
        });

        describe("Ignore Patterns and .gitignore", () => {
            beforeEach(async () => {
                // Reset testDir and create a fresh structure for these specific tests
                // This avoids interference from the parent beforeEach structure if it's too general
                await rm(testDir, { recursive: true, force: true });
                testDir = await mkdtemp(join(realpathSync(tmpdir()), "test-ignore-"));

                await createStructure(testDir, {
                    "fileA.txt": "A",
                    "fileB.log": "B",
                    "node_modules/some_dep/file.js": "dep file",
                    "subdir/fileC.txt": "C",
                    "subdir/fileD.log": "D",
                    ".env": "secret",
                    "data.json": "json data",
                    ".gitignore": "*.log\nnode_modules/\n.env", // Ignore all .log files, node_modules dir, .env file
                    "subdir/.gitignore": "fileC.txt" // Ignore fileC.txt within subdir
                });
            });

            it("should respect .gitignore by default", async () => {
                const { stdout, exitCode } = await runScript([testDir]);
                expect(exitCode).toBe(0);
                expect(stdout).toContain(join(testDir, "fileA.txt")); // A is not ignored
                expect(stdout).not.toContain("fileB.log"); // B is ignored by root .gitignore
                expect(stdout).not.toContain("node_modules"); // node_modules ignored
                expect(stdout).not.toContain(".env"); // .env ignored
                expect(stdout).not.toContain(join(testDir, "subdir/fileC.txt")); // C ignored by subdir .gitignore
                expect(stdout).not.toContain(join(testDir, "subdir/fileD.log")); // D is *.log, ignored by root
                expect(stdout).toContain(join(testDir, "data.json")); // data.json is not ignored
            });

            it("should ignore .gitignore with --ignoreGitignore", async () => {
                const { stdout, stderr, exitCode } = await runScript([testDir, "--ignoreGitignore"]);
                expect(exitCode).toBe(0);
                expect(stdout).toContain(join(testDir, "fileA.txt"));
                expect(stdout).toContain(join(testDir, "fileB.log")); // Now included
                expect(stdout).toContain(join(testDir, "node_modules/some_dep/file.js")); // Now included
                const envPath = join(testDir, ".env");
                expect(stdout).toContain(`${envPath}\n---\nsecret\n---`); // Now included and checking content
                expect(stdout).toContain(join(testDir, "subdir/fileC.txt")); // Now included
                expect(stdout).toContain(join(testDir, "subdir/fileD.log")); // Now included
                // console.log("ignoreGitignore stdout:", stdout);
                // console.log("ignoreGitignore stderr:", stderr);
            });

            it("should use custom --ignore patterns", async () => {
                const { stdout, exitCode } = await runScript([testDir, "--ignore", "*.txt"]);
                expect(exitCode).toBe(0);
                // .gitignore is still active, so .log, node_modules, .env are out
                // --ignore *.txt removes fileA.txt and subdir/fileC.txt (though C already out by .gitignore)
                expect(stdout).not.toContain("fileA.txt");
                expect(stdout).not.toContain("fileB.log");
                expect(stdout).not.toContain(join(testDir, "subdir/fileC.txt"));
                expect(stdout).toContain(join(testDir, "data.json")); // json is not txt, not log
            });

            it("should combine --ignoreGitignore and --ignore", async () => {
                const { stdout, exitCode } = await runScript([
                    testDir,
                    "--ignoreGitignore",
                    "--ignore", "*.log",
                    "--ignore", "**/.env" // More specific ignore for .env
                ]);
                expect(exitCode).toBe(0);
                expect(stdout).toContain(join(testDir, "fileA.txt"));
                expect(stdout).not.toContain("fileB.log"); // Ignored by custom ignore
                expect(stdout).toContain(join(testDir, "node_modules/some_dep/file.js")); // Not .log
                expect(stdout).not.toContain(".env"); // Ignored by custom ignore
                expect(stdout).toContain(join(testDir, "subdir/fileC.txt"));
                expect(stdout).not.toContain(join(testDir, "subdir/fileD.log")); // Ignored by custom ignore
            });

            it("should use --ignoreFilesOnly with --ignore to keep directories", async () => {
                // Test case: ignore *.js files, but still traverse into node_modules if it wasn't gitignored
                const { stdout, exitCode } = await runScript([
                    testDir,
                    "--ignoreGitignore", // So node_modules is considered for traversal
                    "--ignore", "*.js",
                    "--ignoreFilesOnly"
                ]);
                expect(exitCode).toBe(0);
                expect(stdout).toContain(join(testDir, "fileA.txt"));
                expect(stdout).not.toContain("dep file"); // node_modules/some_dep/file.js is ignored
                // Crucially, other files in node_modules (if any and not .js) would be processed.
                // This setup only has one .js file there. If we add a non-js file:
                await createStructure(testDir, {"node_modules/another.txt": "another in node_modules"});
                const result = await runScript([
                    testDir,
                    "--ignoreGitignore",
                    "--ignore", "*.js",
                    "--ignoreFilesOnly"
                ]);
                expect(result.stdout).toContain("another in node_modules");
                expect(result.stdout).not.toContain("dep file");
            });
        });
    });

    describe("Stdin Processing", () => {
        it("should read paths from stdin", async () => {
            await createStructure(testDir, {
                "file1.txt": "Stdin Content 1",
                "file2.txt": "Stdin Content 2"
            });
            const pathsInput = `${join(testDir, "file1.txt")}\n${join(testDir, "file2.txt")}`;
            const { stdout, exitCode } = await runScript([], pathsInput);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Stdin Content 1");
            expect(stdout).toContain("Stdin Content 2");
        });

        it("should read paths from stdin with null separator using -0", async () => {
            await createStructure(testDir, {
                "file1.txt": "Null Sep Content 1",
                "file with space.txt": "Null Sep Content 2"
            });
            const pathsInput = `${join(testDir, "file1.txt")}\0${join(testDir, "file with space.txt")}\0`;
            const { stdout, exitCode } = await runScript(["-0"], pathsInput);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Null Sep Content 1");
            expect(stdout).toContain("Null Sep Content 2");
            expect(stdout).toContain(join(testDir, "file with space.txt"));
        });
    });

    // Add tests for edge cases and error handling, e.g.:
    // - Non-existent input files/dirs (should warn and skip)
    // - Empty directories
    // - Files with weird names or encodings (basic UTF-8 assumed)
    // - Conflicting format options (e.g., -c and -m together - how does the script handle it?)

    it("should warn and skip non-existent files", async () => {
        await createStructure(testDir, { "existing.txt": "I exist" });
        const nonExistentFile = join(testDir, "ghost.txt");

        // Ensure stderr is captured
        const { stdout, stderr, exitCode } = await runScript([nonExistentFile, join(testDir, "existing.txt")]);
        expect(exitCode).toBe(0); // Script exits 0 if all inputs are processed/skipped without fatal error

        // The warning message "Path does not exist..." is logged via logger.error(), so it goes to stderr.
        expect(stderr).toContain(`Path does not exist: ${nonExistentFile}`);
        expect(stdout).not.toContain(nonExistentFile); // Ensure it's not on stdout if it was skipped

        // Check that the valid file was still processed and its output is on stdout
        expect(stdout).toContain(join(testDir, "existing.txt"));
        expect(stdout).toContain("---");
        expect(stdout).toContain("I exist");
    });

    it("should handle conflicting format options (e.g. -c and -m)", async () => {
        // The script's logic for printPath is: if (cxml) else if (markdown) else default.
        // So cxml should take precedence over markdown.
        await createStructure(testDir, { "file.txt": "format test" });
        const { stdout, exitCode } = await runScript([join(testDir, "file.txt"), "-c", "-m"]);
        expect(exitCode).toBe(0);
        expect(stdout).toMatch(/<document index="\d+">/); // cxml format
        expect(stdout).not.toMatch(/```/); // Not markdown format
    });

}); 