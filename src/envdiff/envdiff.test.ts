import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { tmpdir } from "@app/utils/paths";
import { diffEnv, isFailing } from "./lib/diff";
import { runEnvdiff } from "./lib/driver";
import { maskValue } from "./lib/mask";
import { parseEnv } from "./lib/parse";
import { renderDiff, toJsonShape } from "./lib/render";
import { resolveEnvPaths } from "./lib/resolve";
import { buildSyncedContent } from "./lib/sync";

describe("parseEnv", () => {
    it("parses simple KEY=VALUE", () => {
        const parsed = parseEnv("FOO=bar\nBAZ=qux\n");
        expect(parsed.map.get("FOO")).toBe("bar");
        expect(parsed.map.get("BAZ")).toBe("qux");
        expect(parsed.keys).toEqual(["FOO", "BAZ"]);
    });

    it("strips `export ` prefix", () => {
        const parsed = parseEnv("export TOKEN=abc\n");
        expect(parsed.map.get("TOKEN")).toBe("abc");
    });

    it("handles double- and single-quoted values", () => {
        const parsed = parseEnv(`A="hello world"\nB='single quoted'\n`);
        expect(parsed.map.get("A")).toBe("hello world");
        expect(parsed.map.get("B")).toBe("single quoted");
    });

    it("strips inline comments from unquoted values but keeps # inside quotes", () => {
        const parsed = parseEnv(`A=plain # trailing\nB="has # hash"\n`);
        expect(parsed.map.get("A")).toBe("plain");
        expect(parsed.map.get("B")).toBe("has # hash");
    });

    it("ignores blank lines and full-line comments", () => {
        const parsed = parseEnv("# header\n\nFOO=bar\n   # indented comment\n");
        expect(parsed.keys).toEqual(["FOO"]);
    });

    it("handles empty values", () => {
        const parsed = parseEnv("EMPTY=\nexport ALSO_EMPTY=\n");
        expect(parsed.map.get("EMPTY")).toBe("");
        expect(parsed.map.get("ALSO_EMPTY")).toBe("");
    });

    it("trims whitespace around key and unquoted value", () => {
        const parsed = parseEnv("  SPACED   =   value here   \n");
        expect(parsed.map.get("SPACED")).toBe("value here");
    });

    it("last duplicate key wins but key order is first-seen", () => {
        const parsed = parseEnv("DUP=one\nDUP=two\n");
        expect(parsed.map.get("DUP")).toBe("two");
        expect(parsed.keys).toEqual(["DUP"]);
    });

    it("keeps escaped quotes inside double-quoted values", () => {
        const parsed = parseEnv(`${String.raw`A="value with \"escaped\" quotes"`}\n`);
        expect(parsed.map.get("A")).toBe(`value with "escaped" quotes`);
    });
});

describe("diffEnv", () => {
    it("classifies missing, extra, changed, and in-sync", () => {
        const actual = parseEnv("SHARED=same\nCHANGED=local\nEXTRA=only-here\n");
        const example = parseEnv("SHARED=same\nCHANGED=upstream\nNEW_KEY=placeholder\n");
        const diff = diffEnv(actual, example);

        expect(diff.missing).toEqual([{ key: "NEW_KEY", exampleValue: "placeholder" }]);
        expect(diff.extra).toEqual([{ key: "EXTRA" }]);
        expect(diff.changed).toEqual([{ key: "CHANGED", actualValue: "local", exampleValue: "upstream" }]);
        expect(diff.inSyncCount).toBe(1);
    });

    it("reports no drift when identical", () => {
        const a = parseEnv("A=1\nB=2\n");
        const b = parseEnv("A=1\nB=2\n");
        const diff = diffEnv(a, b);

        expect(diff.missing).toHaveLength(0);
        expect(diff.extra).toHaveLength(0);
        expect(diff.changed).toHaveLength(0);
        expect(diff.inSyncCount).toBe(2);
    });

    it("preserves example order for missing and actual order for extra", () => {
        const actual = parseEnv("Z_EXTRA=1\nA_EXTRA=2\n");
        const example = parseEnv("M_MISS=1\nB_MISS=2\n");
        const diff = diffEnv(actual, example);

        expect(diff.missing.map((m) => m.key)).toEqual(["M_MISS", "B_MISS"]);
        expect(diff.extra.map((e) => e.key)).toEqual(["Z_EXTRA", "A_EXTRA"]);
    });
});

describe("isFailing", () => {
    it("fails on missing keys regardless of checkValues", () => {
        const diff = diffEnv(parseEnv("A=1\n"), parseEnv("A=1\nB=2\n"));
        expect(isFailing(diff, { checkValues: false })).toBe(true);
        expect(isFailing(diff, { checkValues: true })).toBe(true);
    });

    it("fails on extra keys regardless of checkValues", () => {
        const diff = diffEnv(parseEnv("A=1\nEXTRA=x\n"), parseEnv("A=1\n"));
        expect(isFailing(diff, { checkValues: false })).toBe(true);
    });

    it("does not fail on changed values by default (local secrets differ from placeholders)", () => {
        const diff = diffEnv(parseEnv("A=local-secret\n"), parseEnv("A=placeholder\n"));
        expect(diff.changed).toHaveLength(1);
        expect(isFailing(diff, { checkValues: false })).toBe(false);
    });

    it("fails on changed values when checkValues is set", () => {
        const diff = diffEnv(parseEnv("A=local-secret\n"), parseEnv("A=placeholder\n"));
        expect(isFailing(diff, { checkValues: true })).toBe(true);
    });

    it("passes when fully in sync", () => {
        const diff = diffEnv(parseEnv("A=1\n"), parseEnv("A=1\n"));
        expect(isFailing(diff, { checkValues: false })).toBe(false);
        expect(isFailing(diff, { checkValues: true })).toBe(false);
    });
});

describe("maskValue", () => {
    it("returns a fixed mask token that does not leak length", () => {
        expect(maskValue()).toBe(maskValue());
        expect(maskValue()).not.toContain("secret");
    });
});

describe("buildSyncedContent", () => {
    const fixedNow = new Date("2026-06-02T10:00:00.000Z");

    it("appends only missing keys with example values and preserves existing content", () => {
        const actualContent = "EXISTING=keepme\nCHANGED=local\n";
        const diff = diffEnv(
            parseEnv(actualContent),
            parseEnv("EXISTING=keepme\nCHANGED=upstream\nNEW_ONE=placeholder1\nNEW_TWO=placeholder2\n")
        );

        const result = buildSyncedContent({ actualContent, diff, now: fixedNow });

        expect(result.startsWith(actualContent)).toBe(true);
        expect(result).toContain("NEW_ONE=placeholder1");
        expect(result).toContain("NEW_TWO=placeholder2");
        expect(result).not.toContain("CHANGED=upstream");
        expect(result).toContain("2026-06-02T10:00:00.000Z");
    });

    it("returns content unchanged when nothing is missing", () => {
        const actualContent = "A=1\n";
        const diff = diffEnv(parseEnv(actualContent), parseEnv("A=1\n"));
        expect(buildSyncedContent({ actualContent, diff, now: fixedNow })).toBe(actualContent);
    });

    it("ensures a trailing newline before the appended block", () => {
        const actualContent = "A=1";
        const diff = diffEnv(parseEnv(actualContent), parseEnv("A=1\nB=2\n"));
        const result = buildSyncedContent({ actualContent, diff, now: fixedNow });
        expect(result).toContain("A=1\n");
        expect(result).toContain("B=2");
    });

    it("round-trips a synced value containing # and spaces", () => {
        const example = parseEnv('SECRET="pass word#1"\n');
        const diff = diffEnv(parseEnv(""), example);
        const synced = buildSyncedContent({ actualContent: "", diff, now: fixedNow });
        expect(parseEnv(synced).map.get("SECRET")).toBe("pass word#1");
    });

    it("does not prepend a blank line when the file is empty", () => {
        const diff = diffEnv(parseEnv(""), parseEnv("A=1\n"));
        const result = buildSyncedContent({ actualContent: "", diff, now: fixedNow });
        expect(result.startsWith("\n")).toBe(false);
        expect(result.startsWith("#")).toBe(true);
    });
});

describe("renderDiff", () => {
    const diff = diffEnv(
        parseEnv("SHARED=same\nCHANGED=local\nEXTRA=x\n"),
        parseEnv("SHARED=same\nCHANGED=upstream\nMISSING=placeholder\n")
    );

    it("masks values by default and lists each drift category", () => {
        const text = renderDiff({
            diff,
            actualLabel: ".env",
            exampleLabel: ".env.example",
            showValues: false,
            color: false,
        });

        expect(text).toContain("MISSING");
        expect(text).toContain("EXTRA");
        expect(text).toContain("CHANGED");
        expect(text).not.toContain("upstream");
        expect(text).toContain(maskValue());
    });

    it("reveals values when showValues is true", () => {
        const text = renderDiff({
            diff,
            actualLabel: ".env",
            exampleLabel: ".env.example",
            showValues: true,
            color: false,
        });

        expect(text).toContain("upstream");
        expect(text).toContain("local");
    });

    it("renders a no-drift message when in sync", () => {
        const clean = diffEnv(parseEnv("A=1\n"), parseEnv("A=1\n"));
        const text = renderDiff({
            diff: clean,
            actualLabel: ".env",
            exampleLabel: ".env.example",
            showValues: false,
            color: false,
        });

        expect(text.toLowerCase()).toContain("in sync");
    });

    it("does not mask empty values", () => {
        const d = diffEnv(parseEnv(""), parseEnv("EMPTY=\n"));
        const text = renderDiff({
            diff: d,
            actualLabel: ".env",
            exampleLabel: ".env.example",
            showValues: false,
            color: false,
        });

        expect(text).toContain("EMPTY = ");
        expect(text).not.toContain(`EMPTY = ${maskValue()}`);
    });
});

describe("toJsonShape", () => {
    it("produces a serializable diff summary", () => {
        const diff = diffEnv(parseEnv("EXTRA=x\n"), parseEnv("MISSING=p\n"));
        const shape = toJsonShape(diff, { actual: ".env", example: ".env.example" });
        const round = SafeJSON.parse(SafeJSON.stringify(shape)) as typeof shape;

        expect(round.actual).toBe(".env");
        expect(round.missing.map((m) => m.key)).toEqual(["MISSING"]);
        expect(round.extra.map((e) => e.key)).toEqual(["EXTRA"]);
        expect(round.driftCount).toBe(2);
    });
});

describe("resolveEnvPaths", () => {
    it("defaults to <cwd>/.env and <cwd>/.env.example with zero positionals", () => {
        const r = resolveEnvPaths({ positionals: [], cwd: "/proj", actual: undefined, example: undefined });
        expect(r.actual).toBe("/proj/.env");
        expect(r.example).toBe("/proj/.env.example");
    });

    it("treats a single positional as a directory", () => {
        const r = resolveEnvPaths({ positionals: ["/work/app"], cwd: "/proj", actual: undefined, example: undefined });
        expect(r.actual).toBe("/work/app/.env");
        expect(r.example).toBe("/work/app/.env.example");
    });

    it("treats two positionals as explicit actual/example files", () => {
        const r = resolveEnvPaths({
            positionals: [".env.local", ".env.example"],
            cwd: "/proj",
            actual: undefined,
            example: undefined,
        });
        expect(r.actual).toBe(".env.local");
        expect(r.example).toBe(".env.example");
    });

    it("flags override resolved paths", () => {
        const r = resolveEnvPaths({
            positionals: [],
            cwd: "/proj",
            actual: "/custom/.env",
            example: "/custom/.env.tmpl",
        });
        expect(r.actual).toBe("/custom/.env");
        expect(r.example).toBe("/custom/.env.tmpl");
    });
});

describe("runEnvdiff (integration, tmp dir)", () => {
    const fixedNow = new Date("2026-06-02T10:00:00.000Z");

    function setup(actual: string, example: string): string {
        const dir = mkdtempSync(join(tmpdir(), "envdiff-test-"));
        writeFileSync(join(dir, ".env"), actual);
        writeFileSync(join(dir, ".env.example"), example);
        return dir;
    }

    it("exits 1 and reports drift when keys are missing", () => {
        const dir = setup("A=1\n", "A=1\nB=2\n");
        const res = runEnvdiff({
            positionals: [dir],
            actual: undefined,
            example: undefined,
            showValues: false,
            sync: false,
            json: false,
            checkValues: false,
            color: false,
            cwd: dir,
            now: fixedNow,
        });

        expect(res.exitCode).toBe(1);
        expect(res.stdout).toContain("B");
        rmSync(dir, { recursive: true, force: true });
    });

    it("exits 0 when only values differ (changed keys are not drift by default)", () => {
        const dir = setup("SHARED=local-secret\n", "SHARED=placeholder\n");
        const res = runEnvdiff({
            positionals: [dir],
            actual: undefined,
            example: undefined,
            showValues: false,
            sync: false,
            json: false,
            checkValues: false,
            color: false,
            cwd: dir,
            now: fixedNow,
        });

        expect(res.exitCode).toBe(0);
        rmSync(dir, { recursive: true, force: true });
    });

    it("exits 1 on changed values when --check-values is set", () => {
        const dir = setup("SHARED=local-secret\n", "SHARED=placeholder\n");
        const res = runEnvdiff({
            positionals: [dir],
            actual: undefined,
            example: undefined,
            showValues: false,
            sync: false,
            json: false,
            checkValues: true,
            color: false,
            cwd: dir,
            now: fixedNow,
        });

        expect(res.exitCode).toBe(1);
        rmSync(dir, { recursive: true, force: true });
    });

    it("exits 0 when in sync", () => {
        const dir = setup("A=1\nB=2\n", "A=1\nB=2\n");
        const res = runEnvdiff({
            positionals: [dir],
            actual: undefined,
            example: undefined,
            showValues: false,
            sync: false,
            json: false,
            checkValues: false,
            color: false,
            cwd: dir,
            now: fixedNow,
        });

        expect(res.exitCode).toBe(0);
        rmSync(dir, { recursive: true, force: true });
    });

    it("--sync appends missing keys, leaves existing untouched, exits 0", () => {
        const dir = setup("A=keep\n", "A=ignored\nB=placeholder\n");
        const res = runEnvdiff({
            positionals: [dir],
            actual: undefined,
            example: undefined,
            showValues: false,
            sync: true,
            json: false,
            checkValues: false,
            color: false,
            cwd: dir,
            now: fixedNow,
        });

        expect(res.exitCode).toBe(0);
        const after = readFileSync(join(dir, ".env"), "utf-8");
        expect(after).toContain("A=keep");
        expect(after).not.toContain("A=ignored");
        expect(after).toContain("B=placeholder");
        rmSync(dir, { recursive: true, force: true });
    });

    it("--json emits SafeJSON-parseable output", () => {
        const dir = setup("EXTRA=x\n", "NEEDED=y\n");
        const res = runEnvdiff({
            positionals: [dir],
            actual: undefined,
            example: undefined,
            showValues: false,
            sync: false,
            json: true,
            checkValues: false,
            color: false,
            cwd: dir,
            now: fixedNow,
        });

        const parsed = SafeJSON.parse(res.stdout) as { driftCount: number };
        expect(parsed.driftCount).toBe(2);
        rmSync(dir, { recursive: true, force: true });
    });

    it("exits 2 when the example file is missing", () => {
        const dir = mkdtempSync(join(tmpdir(), "envdiff-test-"));
        writeFileSync(join(dir, ".env"), "A=1\n");
        const res = runEnvdiff({
            positionals: [dir],
            actual: undefined,
            example: undefined,
            showValues: false,
            sync: false,
            json: false,
            checkValues: false,
            color: false,
            cwd: dir,
            now: fixedNow,
        });

        expect(res.exitCode).toBe(2);
        rmSync(dir, { recursive: true, force: true });
    });
});
