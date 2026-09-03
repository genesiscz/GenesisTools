import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDuCommand, createMeasureCommand } from "@app/macos/commands/clones/measure";
import { type ClonesConfig, storage } from "@app/macos/lib/clones/store";
import { SafeJSON } from "@genesiscz/utils/json";

let configSnapshot: ClonesConfig | null;

beforeAll(async () => {
    configSnapshot = await storage.getConfig<ClonesConfig>();
});

afterAll(async () => {
    if (configSnapshot) {
        await storage.setConfig(configSnapshot);
    } else {
        await storage.clearConfig();
    }
});

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
            let output = "";
            const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
                (
                    chunk: string | Uint8Array,
                    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                    callback?: (error?: Error | null) => void
                ) => {
                    output += String(chunk);
                    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                    cb?.();
                    return true;
                }
            );
            try {
                await createMeasureCommand().parseAsync(
                    ["node", "measure", dir, "--format", "json", "--min-real", "1024"],
                    {
                        from: "node",
                    }
                );
            } finally {
                stdoutSpy.mockRestore();
            }

            const parsed = SafeJSON.parse(output);
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
    // The top-level beforeAll/afterAll above snapshots and restores the
    // live `~/.genesis-tools/macos-clones/config.json` for this whole file,
    // so any addWatchedDirs left behind by a killed run is reverted on next pass.
    it("no explicit roots → uses watchedDirs from config", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-cfgroot-"));
        try {
            mkdirSync(join(dir, "s"), { recursive: true });
            writeFileSync(join(dir, "s", "f"), Buffer.alloc(20 * 1024 * 1024, 1));
            await addWatchedDirs([dir]);
            let output = "";
            const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
                (
                    chunk: string | Uint8Array,
                    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                    callback?: (error?: Error | null) => void
                ) => {
                    output += String(chunk);
                    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                    cb?.();
                    return true;
                }
            );
            try {
                await createMeasureCommand().parseAsync(["node", "measure", "--format", "json", "--min-real", "1024"], {
                    from: "node",
                });
            } finally {
                stdoutSpy.mockRestore();
                await removeWatchedDirs([dir]);
            }

            const parsed = SafeJSON.parse(output) as { roots: string[] };
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
            let output = "";
            const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
                (
                    chunk: string | Uint8Array,
                    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                    callback?: (error?: Error | null) => void
                ) => {
                    output += String(chunk);
                    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                    cb?.();
                    return true;
                }
            );
            try {
                await createDuCommand().parseAsync(
                    ["node", "du", dir, "--depth", "1", "--format", "json", "--min-real", "1024"],
                    { from: "node" }
                );
            } finally {
                stdoutSpy.mockRestore();
            }

            const parsed = SafeJSON.parse(output) as { roots: string[] };
            expect(parsed.roots[0]).toBe(dir);
            expect(output).not.toContain("/l1/l2/l3");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("measure --min-real contract", () => {
    it("refuses a non-positive value instead of scanning every file", async () => {
        const errs: string[] = [];
        const origErr = console.error;
        console.error = (...x: unknown[]) => errs.push(x.join(" "));
        process.exitCode = undefined;
        try {
            await createMeasureCommand().parseAsync(["node", "measure", tmpdir(), "--min-real", "-1"], {
                from: "node",
            });
        } finally {
            console.error = origErr;
        }

        const exitCode: unknown = process.exitCode;
        process.exitCode = undefined;
        expect(exitCode).toBe(1);
        expect(errs.join("\n")).toContain("positive whole number");
    });

    it("refuses a non-positive value on du too", async () => {
        const errs: string[] = [];
        const origErr = console.error;
        console.error = (...x: unknown[]) => errs.push(x.join(" "));
        process.exitCode = undefined;
        try {
            await createDuCommand().parseAsync(["node", "du", tmpdir(), "--min-real", "1.5"], { from: "node" });
        } finally {
            console.error = origErr;
        }

        const exitCode: unknown = process.exitCode;
        process.exitCode = undefined;
        expect(exitCode).toBe(1);
        expect(errs.join("\n")).toContain("positive whole number");
    });
});
