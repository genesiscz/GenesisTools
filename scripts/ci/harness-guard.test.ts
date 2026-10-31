import { describe, expect, test } from "bun:test";
import { compare, inScope, scanSwift, scanTypeScript, updateAllowlist } from "./harness-guard";

describe("harness guard", () => {
    test("finds lists, unions, tables and branches", () => {
        const source = `
            const list = ["claude", "codex"];
            type Agent = "claude" | "grok";
            const table = { claude: 1, codex: 2 };
            type Lookup = Record <HarnessId, number>;
            if (agent === "grok") {}
        `;
        expect(scanTypeScript("src/example.ts", source).map((hit) => hit.kind)).toEqual([
            "list",
            "list",
            "table",
            "table",
            "branch",
        ]);
        expect(scanTypeScript("src/example.ts", "type Lookup = Record \n <HarnessId, number>;")).toHaveLength(1);
        expect(scanTypeScript("src/example.ts", "const value = 'other';")).toEqual([]);
    });

    test("finds Swift sites and skips comments", () => {
        const hits = scanSwift(
            "src/macos/App/Sources/File.swift",
            '// case .claude\ncase .codex:\nlet all = ["claude", "grok"]'
        );
        expect(hits.map((hit) => hit.kind)).toEqual(["branch", "list"]);
    });

    test("excludes owners and tests", () => {
        expect(inScope("src/app/file.ts")).toBe(true);
        expect(inScope("src/app/file.test.ts")).toBe(false);
        expect(inScope("src/utils/harness/types.ts")).toBe(false);
        expect(inScope("src/macos/App/Sources/Generated/File.swift")).toBe(false);
    });

    test("only lowers selected allowances and rejects every increase", () => {
        const allowed = { "src/a.ts": { list: 2, branch: 1 }, "src/b.ts": { table: 1 } };
        expect([...updateAllowlist(new Map([["src/a.ts", { list: 1 }]]), allowed, ["src/a.ts"])]).toEqual([
            ["src/a.ts", { list: 1 }],
            ["src/b.ts", { table: 1 }],
        ]);
        expect(() => updateAllowlist(new Map([["src/a.ts", { list: 3 }]]), allowed, ["src/a.ts"])).toThrow(
            "cannot increase"
        );
        expect(() => updateAllowlist(new Map([["src/new.ts", { branch: 1 }]]), allowed, ["src/new.ts"])).toThrow(
            "cannot increase"
        );
    });

    test("reports a failed scan when git is unavailable", () => {
        const result = Bun.spawnSync([process.execPath, `${import.meta.dirname}/harness-guard.ts`, "--strict"], {
            env: { ...process.env, PATH: "/nonexistent" },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(result.exitCode).toBe(2);
        expect(result.stderr.toString()).toContain("harness-guard: scan failed:");
    });

    test("compares counts for new and stale violations", () => {
        expect(compare(new Map([["src/a.ts", { branch: 2 }]]), { "src/a.ts": { branch: 1, list: 1 } })).toEqual({
            added: [{ file: "src/a.ts", kind: "branch", allowed: 1, found: 2 }],
            stale: [{ file: "src/a.ts", kind: "list", allowed: 1, found: 0 }],
        });
    });
});
