import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { runTool, stripAnsi } from "./helpers";

const TEST_PREFIX = `test_e2e_${Date.now()}`;
let tempDir: string;
let indexName: string;

function createFixtureDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "indexer-e2e-"));

    writeFileSync(
        join(dir, "math.ts"),
        `
export function add(a: number, b: number): number {
    return a + b;
}

export function multiply(a: number, b: number): number {
    return a * b;
}
`.trim()
    );

    writeFileSync(
        join(dir, "greet.ts"),
        `
export function greet(name: string): string {
    return \`Hello, \${name}!\`;
}

export function farewell(name: string): string {
    return \`Goodbye, \${name}!\`;
}
`.trim()
    );

    writeFileSync(
        join(dir, "utils.ts"),
        `
export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

export function range(start: number, end: number): number[] {
    const result: number[] = [];
    for (let i = start; i < end; i++) {
        result.push(i);
    }
    return result;
}
`.trim()
    );

    return dir;
}

async function tryRemoveIndex(name: string): Promise<void> {
    await runTool(["indexer", "remove", name, "--force"], 30_000);
}

describe("tools indexer (E2E)", () => {
    beforeAll(() => {
        tempDir = createFixtureDir();
        indexName = `${TEST_PREFIX}_flow`;
    });

    afterAll(async () => {
        await tryRemoveIndex(indexName);

        if (tempDir) {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe("help commands", () => {
        it(
            "indexer --help exits 0 and shows description",
            async () => {
                const r = await runTool(["indexer", "--help"]);
                const output = stripAnsi(r.stdout + r.stderr);

                expect(r.exitCode).toBe(0);
                expect(output.toLowerCase()).toContain("indexer");
                expect(output).toContain("add");
                expect(output).toContain("status");
                expect(output).toContain("search");
                expect(output).toContain("remove");
                expect(output).toContain("rebuild");
                expect(output).toContain("watch");
            },
            { timeout: 30_000 }
        );

        it(
            "indexer add --help exits 0 and shows add options",
            async () => {
                const r = await runTool(["indexer", "add", "--help"]);
                const output = stripAnsi(r.stdout + r.stderr);

                expect(r.exitCode).toBe(0);
                expect(output).toContain("--name");
                expect(output).toContain("--type");
            },
            { timeout: 30_000 }
        );

        it(
            "indexer search --help exits 0 and shows search options",
            async () => {
                const r = await runTool(["indexer", "search", "--help"]);
                const output = stripAnsi(r.stdout + r.stderr);

                expect(r.exitCode).toBe(0);
                expect(output).toContain("--index");
                expect(output).toContain("--mode");
                expect(output).toContain("--format");
            },
            { timeout: 30_000 }
        );
    });

    describe("status with no indexes", () => {
        it(
            "status exits 0 with no indexes",
            async () => {
                const r = await runTool(["indexer", "status"]);
                expect(r.exitCode).toBe(0);
            },
            { timeout: 30_000 }
        );
    });

    describe("full lifecycle flow", () => {
        it(
            "add -> status -> search -> search json -> rebuild -> remove",
            async () => {
                // 1. Add index
                const addResult = await runTool(["indexer", "add", tempDir, "--name", indexName, "--no-embed"], 60_000);
                const addOutput = stripAnsi(addResult.stdout + addResult.stderr);

                expect(addResult.exitCode).toBe(0);
                expect(addOutput.toLowerCase()).toMatch(/index|complete|done/i);

                // 2. Status for specific index
                const statusResult = await runTool(["indexer", "status", indexName], 30_000);
                const statusOutput = stripAnsi(statusResult.stdout + statusResult.stderr);

                expect(statusResult.exitCode).toBe(0);
                expect(statusOutput).toContain(indexName);

                // 3. Search with table format (default)
                const searchResult = await runTool(["indexer", "search", "function", "--index", indexName], 30_000);
                const searchOutput = stripAnsi(searchResult.stdout + searchResult.stderr);

                expect(searchResult.exitCode).toBe(0);
                // Should find results since all fixture files contain functions
                expect(searchOutput.toLowerCase()).toMatch(/result|function|add|greet|clamp/i);

                // 4. Search with JSON format
                const jsonResult = await runTool(
                    ["indexer", "search", "function", "--index", indexName, "--format", "json"],
                    30_000
                );

                expect(jsonResult.exitCode).toBe(0);

                // stdout should be parseable JSON
                const jsonOutput = jsonResult.stdout.trim();
                let parsed: unknown;

                try {
                    parsed = SafeJSON.parse(jsonOutput);
                } catch {
                    // If stdout doesn't have it, try stderr (clack writes to stderr)
                    try {
                        parsed = SafeJSON.parse(jsonResult.stderr.trim());
                    } catch {
                        throw new Error(
                            `Expected JSON output but got:\nstdout: ${jsonOutput}\nstderr: ${jsonResult.stderr}`
                        );
                    }
                }

                expect(Array.isArray(parsed)).toBe(true);

                if (Array.isArray(parsed) && parsed.length > 0) {
                    const first = parsed[0] as Record<string, unknown>;
                    expect(first).toHaveProperty("file");
                    expect(first).toHaveProperty("score");
                    expect(first).toHaveProperty("method");
                }

                // 5. Rebuild
                const rebuildResult = await runTool(["indexer", "rebuild", indexName], 60_000);
                const rebuildOutput = stripAnsi(rebuildResult.stdout + rebuildResult.stderr);

                expect(rebuildResult.exitCode).toBe(0);
                expect(rebuildOutput.toLowerCase()).toMatch(/rebuild|complete|done/i);

                // 6. Remove
                const removeResult = await runTool(["indexer", "remove", indexName, "--force"], 30_000);

                expect(removeResult.exitCode).toBe(0);

                // 7. Verify index is gone
                const statusAfter = await runTool(["indexer", "status"], 30_000);
                const statusAfterOutput = stripAnsi(statusAfter.stdout + statusAfter.stderr);

                expect(statusAfter.exitCode).toBe(0);
                expect(statusAfterOutput).not.toContain(indexName);
            },
            { timeout: 120_000 }
        );
    });

    describe("error handling", () => {
        it(
            "remove nonexistent index errors gracefully",
            async () => {
                const name = `${TEST_PREFIX}_nonexistent`;
                const r = await runTool(["indexer", "remove", name, "--force"], 30_000);
                const output = stripAnsi(r.stdout + r.stderr);

                expect(r.exitCode).not.toBe(0);
                expect(output.toLowerCase()).toContain("not found");
            },
            { timeout: 30_000 }
        );

        it(
            "add with nonexistent path errors gracefully",
            async () => {
                const r = await runTool(["indexer", "add", "/tmp/definitely-does-not-exist-xyz-123"], 30_000);
                const output = stripAnsi(r.stdout + r.stderr);

                expect(r.exitCode).not.toBe(0);
                expect(output.toLowerCase()).toMatch(/not exist|error|fail/i);
            },
            { timeout: 30_000 }
        );
    });
});
