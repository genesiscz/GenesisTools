import { afterEach, describe, expect, test } from "bun:test";
import { env } from "@app/utils/env";
import { DEFAULT_DU_TIMEOUT_MS, duTimeoutMs, parseDuOutput, shortLabel } from "./usage";

// `du -sk` prints one row per path: "<kilobytes>\t<path>". macOS du uses a tab; we tolerate any whitespace run.
const FIXTURE = [
    "2306867\t/Users/dev/project/node_modules",
    "1468006\t/Users/dev/Library/Caches",
    "512000\t/Users/dev/project/ios/build",
    "4\t/Users/dev/project/dist",
    "",
].join("\n");

describe("parseDuOutput", () => {
    test("parses du -sk rows to {path,bytes} sorted by bytes desc", () => {
        const result = parseDuOutput(FIXTURE);

        expect(result).toHaveLength(4);
        // KB × 1024
        expect(result[0]).toEqual({ path: "/Users/dev/project/node_modules", bytes: 2306867 * 1024 });
        // sorted descending
        expect(result.map((r) => r.bytes)).toEqual([...result.map((r) => r.bytes)].sort((a, b) => b - a));
        expect(result[result.length - 1].path).toBe("/Users/dev/project/dist");
    });

    test("skips blank + malformed lines (no NaN bytes)", () => {
        const result = parseDuOutput("not-a-number\t/x\n\n  \n1024\t/y");
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ path: "/y", bytes: 1024 * 1024 });
    });

    test("empty string returns empty array", () => {
        expect(parseDuOutput("")).toEqual([]);
    });

    test("tolerates a path containing spaces (only the first whitespace run is the separator)", () => {
        const result = parseDuOutput("100\t/Users/dev/My Project/node_modules");
        expect(result).toEqual([{ path: "/Users/dev/My Project/node_modules", bytes: 100 * 1024 }]);
    });
});

describe("duTimeoutMs", () => {
    afterEach(() => {
        env.testing.unset("DD_DISK_DU_TIMEOUT_MS");
    });

    test("defaults when env is unset", () => {
        env.testing.unset("DD_DISK_DU_TIMEOUT_MS");
        expect(duTimeoutMs()).toBe(DEFAULT_DU_TIMEOUT_MS);
    });

    test("honors a valid positive override", () => {
        env.testing.set("DD_DISK_DU_TIMEOUT_MS", "1500");
        expect(duTimeoutMs()).toBe(1500);
    });

    test("falls back to the default on a non-positive or garbage override", () => {
        env.testing.set("DD_DISK_DU_TIMEOUT_MS", "0");
        expect(duTimeoutMs()).toBe(DEFAULT_DU_TIMEOUT_MS);
        env.testing.set("DD_DISK_DU_TIMEOUT_MS", "-5");
        expect(duTimeoutMs()).toBe(DEFAULT_DU_TIMEOUT_MS);
        env.testing.set("DD_DISK_DU_TIMEOUT_MS", "abc");
        expect(duTimeoutMs()).toBe(DEFAULT_DU_TIMEOUT_MS);
    });
});

describe("shortLabel", () => {
    test("uses the last two path segments", () => {
        expect(shortLabel("/Users/dev/project/node_modules", "/nonexistent-home")).toBe("project/node_modules");
    });

    test("collapses a home-relative prefix to ~", () => {
        expect(shortLabel("/Users/dev/Library/Caches", "/Users/dev")).toBe("~/Library/Caches");
    });
});
