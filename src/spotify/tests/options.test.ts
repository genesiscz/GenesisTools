/**
 * `numberOption` is the one place a string option becomes a number, for the CLI and for the
 * dashboard's query parameters alike. It is unit-tested rather than driven through a command
 * because the option it guards hardest, `enrich --limit`, starts a paced external crawl the
 * moment the guard lets a bad value through — which is exactly what must not happen in a test.
 */
import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { numberOption } from "@app/spotify/lib/context";
import { SafeJSON } from "@genesiscz/utils/json";
import { skip } from "@genesiscz/utils/test/skip";

describe("numberOption", () => {
    test("returns the fallback when the option is absent or empty", () => {
        expect(numberOption(undefined, "top", 20)).toBe(20);
        expect(numberOption("", "top", 20)).toBe(20);
    });

    test("parses a number", () => {
        expect(numberOption("35", "top", 20)).toBe(35);
        expect(numberOption("0", "min", 1)).toBe(0);
    });

    test("rejects a non-numeric value, naming the option", () => {
        expect(() => numberOption("abc", "min", 1)).toThrow('--min must be a number; got "abc"');
    });

    // The default bounds: these are counts, thresholds and durations, never fractional and
    // never negative. `--top -1` used to slice from the end of the ranking instead of erroring.
    test("rejects a fractional or negative value by default", () => {
        expect(() => numberOption("1.5", "top", 20)).toThrow("--top must be a whole number");
        expect(() => numberOption("-1", "top", 20)).toThrow("--top must be at least 0");
        expect(() => numberOption("-5", "min", 1)).toThrow("--min must be at least 0");
    });

    test("bounds can be widened by the caller", () => {
        expect(numberOption("1.5", "ratio", 1, { integer: false })).toBe(1.5);
        expect(numberOption("-3", "offset", 0, {})).toBe(-3);
    });

    // Both enrichers apply the cap under `if (opts.limit)` and then `slice(0, limit)`, so 0
    // disabled the cap entirely and -1 fetched every artist but the last.
    test("rejects a limit below the minimum", () => {
        expect(() => numberOption("0", "limit", 0, { min: 1, integer: true })).toThrow("--limit must be at least 1");
        expect(() => numberOption("-1", "limit", 0, { min: 1, integer: true })).toThrow("--limit must be at least 1");
        expect(() => numberOption("2.5", "limit", 0, { min: 1, integer: true })).toThrow(
            "--limit must be a whole number"
        );
        expect(numberOption("1", "limit", 0, { min: 1, integer: true })).toBe(1);
    });
});

describe("--top help says where it does and does not limit", () => {
    // A usability tester asked for 20 forgotten tracks, got 1,401 back under --json with no
    // error, and nearly piped them onward. The behaviour is deliberate (the dashboard slices
    // client-side and needs the full ranking, and the payload records `limit`), so the help
    // is what has to stop being ambiguous.
    const help = (args: string[]) => {
        const p = Bun.spawnSync(["bun", resolve(dirname(import.meta.dir), "index.ts"), ...args, "--help"], {
            env: { ...process.env, NO_COLOR: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });

        // Help output is wrapped to the terminal width, so compare on collapsed whitespace.
        return (new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)).replace(/\s+/g, " ");
    };

    test("names the table, and says --json returns every row", () => {
        const text = help(["analytics", "forgotten"]);
        expect(text).toContain("the table prints");
        expect(text).toContain("--json returns every row");
    });

    /**
     * This one drives the real analytics query, so it needs a real play history on the
     * machine — `rows.length > 5` cannot come from anywhere else. With no history the
     * command writes nothing to stdout and the parse fails on an empty body, which is
     * what it did on every CI run. The `--help` test above needs no data and stays on.
     */
    test.skipIf(skip.spotifyData)("--json really does return more than --top asked for", async () => {
        const p = Bun.spawn(
            ["bun", resolve(dirname(import.meta.dir), "index.ts"), "analytics", "top", "songs", "--top", "5", "--json"],
            { env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" }
        );
        const body = await new Response(p.stdout).text();
        await p.exited;
        const parsed = SafeJSON.parse(body, { strict: true }) as { rows: unknown[]; limit: number };

        expect(parsed.limit).toBe(5);
        expect(parsed.rows.length).toBeGreaterThan(5);
    });
});
