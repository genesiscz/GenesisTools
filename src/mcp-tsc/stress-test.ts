#!/usr/bin/env bun

/**
 * Comprehensive stress test for MCP TypeScript LSP server
 * Tests:
 * - Sequential diagnostics and hover calls
 * - Concurrent calls (both same and different files)
 * - File modification during requests
 * - Timeout handling
 * - Error recovery and retry logic
 * - Queue behavior under load
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Configuration
const CONFIG = {
    // Number of iterations for each test type
    sequentialDiagnostics: 5,
    sequentialHover: 5,
    concurrentDiagnostics: 10,
    concurrentHover: 10,
    mixedConcurrent: 20,
    fileModificationTests: 3, // Reduced since each takes ~10s

    // Test file paths (relative to cwd)
    testFiles: [
        "src/mcp-tsc/LspWorker.ts",
        "src/mcp-tsc/protocols/McpAdapter.ts",
        "src/mcp-tsc/core/interfaces.ts",
        "src/mcp-tsc/types/mcp.ts",
        "src/mcp-tsc/providers/LspServer.ts",
    ],

    // Timeouts
    diagnosticsTimeout: 10,
    hoverTimeout: 3,
};

interface TestResult {
    name: string;
    success: boolean;
    duration: number;
    error?: string;
}

interface TestStats {
    total: number;
    passed: number;
    failed: number;
    avgDuration: number;
    errors: string[];
}

class StressTest {
    private client!: Client;
    private cwd: string;
    private results: TestResult[] = [];

    constructor() {
        this.cwd = process.cwd();
    }

    async setup(): Promise<void> {
        console.error("Setting up MCP client...");

        const transport = new StdioClientTransport({
            command: "bun",
            args: [path.join(this.cwd, "src/mcp-tsc/index.ts"), "--mcp", "--root", this.cwd],
        });

        this.client = new Client({ name: "stress-test", version: "1.0.0" }, { capabilities: {} });

        await this.client.connect(transport);
        console.error("Connected to MCP server");

        // Verify tools are available
        const tools = await this.client.listTools();
        console.error(`Available tools: ${tools.tools.map((t) => t.name).join(", ")}`);
    }

    async teardown(): Promise<void> {
        console.error("\nClosing client connection...");
        await this.client.close();
    }

    private async callDiagnostics(files: string[], timeout = CONFIG.diagnosticsTimeout): Promise<TestResult> {
        const start = Date.now();
        const testName = `Diagnostics(${files.length} files)`;

        try {
            const result = await this.client.callTool({
                name: "GetTsDiagnostics",
                arguments: { files, showWarnings: false, timeout },
            });

            return {
                name: testName,
                success: !result.isError,
                duration: Date.now() - start,
                error: result.isError
                    ? String((result as { content?: { text?: string }[] }).content?.[0]?.text)
                    : undefined,
            };
        } catch (error) {
            return {
                name: testName,
                success: false,
                duration: Date.now() - start,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private async callHover(file: string, line: number, timeout = CONFIG.hoverTimeout): Promise<TestResult> {
        const start = Date.now();
        const testName = `Hover(${path.basename(file)}:${line})`;

        try {
            const result = await this.client.callTool({
                name: "GetTsHover",
                arguments: { file, line, timeout },
            });

            return {
                name: testName,
                success: !result.isError,
                duration: Date.now() - start,
                error: result.isError
                    ? String((result as { content?: { text?: string }[] }).content?.[0]?.text)
                    : undefined,
            };
        } catch (error) {
            return {
                name: testName,
                success: false,
                duration: Date.now() - start,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    // =========================================================================
    // Test suites
    // =========================================================================

    async testSequentialDiagnostics(): Promise<void> {
        console.error("\n=== Sequential Diagnostics Test ===");

        for (let i = 0; i < CONFIG.sequentialDiagnostics; i++) {
            const file = CONFIG.testFiles[i % CONFIG.testFiles.length];
            const absolutePath = path.resolve(this.cwd, file);
            const result = await this.callDiagnostics([absolutePath]);
            this.results.push(result);
            console.error(
                `  [${i + 1}/${CONFIG.sequentialDiagnostics}] ${result.success ? "✓" : "✗"} ${result.name} (${result.duration}ms)`,
            );
            if (!result.success) {
                console.error(`    Error: ${result.error}`);
            }
        }
    }

    async testSequentialHover(): Promise<void> {
        console.error("\n=== Sequential Hover Test ===");

        for (let i = 0; i < CONFIG.sequentialHover; i++) {
            const file = CONFIG.testFiles[i % CONFIG.testFiles.length];
            const absolutePath = path.resolve(this.cwd, file);
            const line = 10 + i * 10; // Different lines
            const result = await this.callHover(absolutePath, line);
            this.results.push(result);
            console.error(
                `  [${i + 1}/${CONFIG.sequentialHover}] ${result.success ? "✓" : "✗"} ${result.name} (${result.duration}ms)`,
            );
            if (!result.success) {
                console.error(`    Error: ${result.error}`);
            }
        }
    }

    async testConcurrentDiagnostics(): Promise<void> {
        console.error("\n=== Concurrent Diagnostics Test ===");
        console.error(`  Launching ${CONFIG.concurrentDiagnostics} concurrent requests...`);

        const promises = CONFIG.testFiles.slice(0, CONFIG.concurrentDiagnostics).map(async (file, i) => {
            const absolutePath = path.resolve(this.cwd, file);
            const result = await this.callDiagnostics([absolutePath]);
            console.error(`  [${i + 1}] ${result.success ? "✓" : "✗"} ${result.name} (${result.duration}ms)`);
            return result;
        });

        const results = await Promise.all(promises);
        this.results.push(...results);
    }

    async testConcurrentHover(): Promise<void> {
        console.error("\n=== Concurrent Hover Test ===");
        console.error(`  Launching ${CONFIG.concurrentHover} concurrent requests...`);

        const promises: Promise<TestResult>[] = [];
        for (let i = 0; i < CONFIG.concurrentHover; i++) {
            const file = CONFIG.testFiles[i % CONFIG.testFiles.length];
            const absolutePath = path.resolve(this.cwd, file);
            // Keep line numbers low to avoid out-of-range errors
            const line = 10 + (i % 5) * 3;
            promises.push(
                this.callHover(absolutePath, line).then((result) => {
                    console.error(`  [${i + 1}] ${result.success ? "✓" : "✗"} ${result.name} (${result.duration}ms)`);
                    return result;
                }),
            );
        }

        const results = await Promise.all(promises);
        this.results.push(...results);
    }

    async testMixedConcurrent(): Promise<void> {
        console.error("\n=== Mixed Concurrent Test (Diagnostics + Hover) ===");
        console.error(`  Launching ${CONFIG.mixedConcurrent} mixed concurrent requests...`);

        const promises: Promise<TestResult>[] = [];
        for (let i = 0; i < CONFIG.mixedConcurrent; i++) {
            const file = CONFIG.testFiles[i % CONFIG.testFiles.length];
            const absolutePath = path.resolve(this.cwd, file);

            if (i % 2 === 0) {
                // Diagnostics
                promises.push(
                    this.callDiagnostics([absolutePath]).then((result) => {
                        console.error(
                            `  [${i + 1}] ${result.success ? "✓" : "✗"} ${result.name} (${result.duration}ms)`,
                        );
                        return result;
                    }),
                );
            } else {
                // Hover - keep line numbers low to avoid out-of-range errors
                const line = 5 + (i % 8) * 2;
                promises.push(
                    this.callHover(absolutePath, line).then((result) => {
                        console.error(
                            `  [${i + 1}] ${result.success ? "✓" : "✗"} ${result.name} (${result.duration}ms)`,
                        );
                        return result;
                    }),
                );
            }
        }

        const results = await Promise.all(promises);
        this.results.push(...results);
    }

    async testMultipleFileDiagnostics(): Promise<void> {
        console.error("\n=== Multiple Files in Single Request Test ===");

        const absolutePaths = CONFIG.testFiles.map((f) => path.resolve(this.cwd, f));
        const result = await this.callDiagnostics(absolutePaths, 30);
        this.results.push(result);
        console.error(`  ${result.success ? "✓" : "✗"} ${result.name} (${result.duration}ms)`);
        if (!result.success) {
            console.error(`    Error: ${result.error}`);
        }
    }

    async testFileModification(): Promise<void> {
        console.error("\n=== File Modification During Request Test ===");

        // Create a temp test file
        const testFilePath = path.resolve(this.cwd, "src/mcp-tsc/test-temp.ts");
        const originalContent = `
// Test file for stress testing
export interface TestInterface {
    value: string;
    count: number;
}

export function testFunction(input: TestInterface): string {
    return input.value.repeat(input.count);
}
`;

        writeFileSync(testFilePath, originalContent);
        console.error("  Created test file");

        try {
            // First call to warm up
            let result = await this.callDiagnostics([testFilePath]);
            this.results.push(result);
            console.error(`  [Warm-up] ${result.success ? "✓" : "✗"} (${result.duration}ms)`);

            for (let i = 0; i < CONFIG.fileModificationTests; i++) {
                // Modify the file while making a request
                const modifiedContent = `${originalContent}\n// Modification ${i + 1}\n`;
                writeFileSync(testFilePath, modifiedContent);

                // Immediately request diagnostics
                result = await this.callDiagnostics([testFilePath]);
                this.results.push(result);
                console.error(`  [Mod ${i + 1}] ${result.success ? "✓" : "✗"} (${result.duration}ms)`);
            }

            // Add an error to the file
            const errorContent = `${originalContent}\nconst err: number = "string"; // Type error\n`;
            writeFileSync(testFilePath, errorContent);

            result = await this.callDiagnostics([testFilePath]);
            this.results.push(result);
            // This should succeed but report an error
            console.error(`  [Error test] ${result.success ? "✓" : "✗"} (${result.duration}ms)`);
        } finally {
            // Cleanup
            try {
                const fs = await import("node:fs");
                fs.unlinkSync(testFilePath);
                console.error("  Cleaned up test file");
            } catch {
                // Ignore cleanup errors
            }
        }
    }

    async testTimeouts(): Promise<void> {
        console.error("\n=== Timeout Handling Test ===");

        // Test hover with very short timeout
        const file = path.resolve(this.cwd, CONFIG.testFiles[0]);

        // Short timeout - might fail
        let result = await this.callHover(file, 100, 0.1);
        this.results.push({ ...result, name: "Hover(100ms timeout)" });
        console.error(`  [Short timeout] ${result.success ? "✓" : "✗"} (${result.duration}ms)`);

        // Normal timeout - should succeed
        result = await this.callHover(file, 100, 3);
        this.results.push({ ...result, name: "Hover(3s timeout)" });
        console.error(`  [Normal timeout] ${result.success ? "✓" : "✗"} (${result.duration}ms)`);
    }

    async testRapidFireSameFile(): Promise<void> {
        console.error("\n=== Rapid Fire Same File Test ===");
        console.error("  Sending 20 rapid requests to the same file...");

        const file = path.resolve(this.cwd, CONFIG.testFiles[0]);
        const promises: Promise<TestResult>[] = [];

        for (let i = 0; i < 20; i++) {
            promises.push(
                this.callDiagnostics([file], 5).then((result) => {
                    console.error(`  [${i + 1}] ${result.success ? "✓" : "✗"} (${result.duration}ms)`);
                    return result;
                }),
            );
        }

        const results = await Promise.all(promises);
        this.results.push(...results);
    }

    // =========================================================================
    // Execution and reporting
    // =========================================================================

    private getStats(): TestStats {
        const total = this.results.length;
        const passed = this.results.filter((r) => r.success).length;
        const failed = total - passed;
        const avgDuration = this.results.reduce((sum, r) => sum + r.duration, 0) / total;
        const errors = this.results.filter((r) => !r.success && r.error).map((r) => `${r.name}: ${r.error}`);

        return { total, passed, failed, avgDuration, errors };
    }

    printReport(): void {
        console.error(`\n${"=".repeat(60)}`);
        console.error("STRESS TEST REPORT");
        console.error("=".repeat(60));

        const stats = this.getStats();

        console.error(`\nResults:`);
        console.error(`  Total tests:    ${stats.total}`);
        console.error(`  Passed:         ${stats.passed} (${((stats.passed / stats.total) * 100).toFixed(1)}%)`);
        console.error(`  Failed:         ${stats.failed} (${((stats.failed / stats.total) * 100).toFixed(1)}%)`);
        console.error(`  Avg duration:   ${stats.avgDuration.toFixed(0)}ms`);

        // Duration distribution
        const durations = this.results.map((r) => r.duration).sort((a, b) => a - b);
        console.error(`\nDuration distribution:`);
        console.error(`  Min:    ${durations[0]}ms`);
        console.error(`  P50:    ${durations[Math.floor(durations.length * 0.5)]}ms`);
        console.error(`  P90:    ${durations[Math.floor(durations.length * 0.9)]}ms`);
        console.error(`  P99:    ${durations[Math.floor(durations.length * 0.99)]}ms`);
        console.error(`  Max:    ${durations[durations.length - 1]}ms`);

        if (stats.errors.length > 0) {
            console.error(`\nErrors (first 10):`);
            stats.errors.slice(0, 10).forEach((err, i) => {
                console.error(`  ${i + 1}. ${err.substring(0, 100)}${err.length > 100 ? "..." : ""}`);
            });
        }

        console.error(`\n${"=".repeat(60)}`);
    }

    async run(): Promise<number> {
        try {
            await this.setup();

            // Run all test suites
            await this.testSequentialDiagnostics();
            await this.testSequentialHover();
            await this.testConcurrentDiagnostics();
            await this.testConcurrentHover();
            await this.testMixedConcurrent();
            await this.testMultipleFileDiagnostics();
            await this.testFileModification();
            await this.testTimeouts();
            await this.testRapidFireSameFile();

            this.printReport();

            const stats = this.getStats();
            return stats.failed > 0 ? 1 : 0;
        } catch (error) {
            console.error("\nFatal error during stress test:", error);
            return 1;
        } finally {
            await this.teardown();
        }
    }
}

// Main entry
const test = new StressTest();
test.run().then((exitCode) => {
    process.exit(exitCode);
});
