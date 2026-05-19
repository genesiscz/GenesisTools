import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDuCommand, createMeasureCommand } from "@app/macos/commands/clones/measure";
import { SafeJSON } from "@app/utils/json";

describe("createMeasureCommand", () => {
    it("is a commander command named 'measure' with the shared flags", () => {
        const cmd = createMeasureCommand();
        expect(cmd.name()).toBe("measure");
        const opts = cmd.options.map((o) => o.long);
        expect(opts).toContain("--format");
        expect(opts).toContain("--node-modules");
        expect(opts).toContain("--min-real");
        expect(opts).toContain("--top");
        expect(opts).toContain("--no-breakdown");
        expect(opts).toContain("--include");
        expect(opts).toContain("--exclude");
        expect(opts).toContain("--sort");
    });

    it("--format json prints a parseable MeasureReport for a temp dir", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-mcmd-"));
        try {
            mkdirSync(join(dir, "s"), { recursive: true });
            writeFileSync(join(dir, "s", "f"), Buffer.alloc(20 * 1024 * 1024, 1));
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...a: unknown[]) => logs.push(a.join(" "));
            try {
                await createMeasureCommand().parseAsync(
                    ["node", "measure", dir, "--format", "json", "--min-real", "1024"],
                    {
                        from: "node",
                    }
                );
            } finally {
                console.log = orig;
            }

            const parsed = SafeJSON.parse(logs.join("\n"));
            expect(parsed).toHaveProperty("totals");
            expect(parsed).toHaveProperty("roots");
            expect((parsed as { roots: string[] }).roots[0]).toBe(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

import { addWatchedDirs, removeWatchedDirs } from "@app/macos/lib/clones/store";

describe("measure roots fall back to configured watchedDirs", () => {
    it("no explicit roots → uses watchedDirs from config", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-cfgroot-"));
        try {
            mkdirSync(join(dir, "s"), { recursive: true });
            writeFileSync(join(dir, "s", "f"), Buffer.alloc(20 * 1024 * 1024, 1));
            await addWatchedDirs([dir]);
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...a: unknown[]) => logs.push(a.join(" "));
            try {
                await createMeasureCommand().parseAsync(
                    ["node", "measure", "--format", "json", "--min-real", "1024"],
                    { from: "node" },
                );
            } finally {
                console.log = orig;
                await removeWatchedDirs([dir]);
            }

            const parsed = SafeJSON.parse(logs.join("\n")) as { roots: string[] };
            expect(parsed.roots).toContain(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("createDuCommand", () => {
    it("named 'du', has --depth, single optional folder arg", () => {
        const cmd = createDuCommand();
        expect(cmd.name()).toBe("du");
        expect(cmd.options.map((o) => o.long)).toContain("--depth");
        expect(cmd.options.map((o) => o.long)).toContain("--format");
    });

    it("--depth 1 limits tree nesting; json parseable", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-du-"));
        try {
            mkdirSync(join(dir, "l1", "l2", "l3"), { recursive: true });
            writeFileSync(join(dir, "l1", "l2", "l3", "f"), Buffer.alloc(20 * 1024 * 1024, 1));
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...a: unknown[]) => logs.push(a.join(" "));
            try {
                await createDuCommand().parseAsync(
                    ["node", "du", dir, "--depth", "1", "--format", "json", "--min-real", "1024"],
                    { from: "node" }
                );
            } finally {
                console.log = orig;
            }

            const parsed = SafeJSON.parse(logs.join("\n")) as { roots: string[] };
            expect(parsed.roots[0]).toBe(dir);
            expect(logs.join("\n")).not.toContain("/l1/l2/l3");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
