import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";

const ENTRY = join(import.meta.dir, "..", "index.ts");
const SAMPLE = join(import.meta.dir, "..", "lib", "collect.ts");

function cli(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
    // `env` is passed on purpose: Bun does not forward the test preload's sandbox variables to a
    // child spawned without one, so the child would otherwise run against the real store.
    const result = Bun.spawnSync(["bun", ENTRY, ...args], { stdout: "pipe", stderr: "pipe", env: process.env, cwd });

    return {
        code: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
    };
}

describe("tools ts usage errors", () => {
    // Each of these used to escape as an uncaught throw with a Bun stack dump, or to pass
    // silently with a wrong answer.
    const cases: [string, string[], RegExp][] = [
        ["an out-of-range similarity", ["duplicates", SAMPLE, "--similarity", "5"], /at most 1/],
        ["a non-numeric line floor", ["duplicates", SAMPLE, "--min-lines", "abc"], /Not a number/],
        ["an unknown format", ["skeleton", SAMPLE, "--format", "yaml"], /Allowed choices/],
        ["two formats at once", ["skeleton", SAMPLE, "--md", "--json"], /Pick one output format/],
        ["an unknown analyser", ["refactors", SAMPLE, "--include", "bogus"], /Unknown analyser: bogus/],
        ["a fractional context", ["skeleton", SAMPLE, "--function-context", "2.7"], /whole number/],
    ];

    for (const [label, args, message] of cases) {
        test(`${label} is one line on stderr and exit 1`, () => {
            const result = cli(args);

            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(message);
            expect(result.stderr).not.toContain("    at ");
        });
    }
});

describe("tools ts --toon", () => {
    test("comes out as a table with the keys named once", () => {
        // Fed positional arrays, TOON cost 15% more tokens than --json-compact; fed the object
        // rows it names the columns once per table, which is the point of the format.
        const result = cli(["skeleton", SAMPLE, "--toon"]);

        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/symbols\[\d+\]\{startLine,endLine,depth,exported,signature\}:/);
    });

    test("stays tabular with --function-context, where some declarations have no body", () => {
        const result = cli(["skeleton", SAMPLE, "--toon", "--function-context", "2"]);

        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(
            /symbols\[\d+\]\{startLine,endLine,depth,exported,signature,body,bodyTruncated\}/
        );
    });
});

describe("tools ts skeleton --rank", () => {
    function fixture(): string {
        // The real path: the child's cwd is resolved, and the printed file names are relative to it.
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "ts-rank-")));
        mkdirSync(join(dir, "lib"), { recursive: true });
        writeFileSync(
            join(dir, "lib", "core.ts"),
            "export const core = 1;\nexport function helper(): number {\n    return core;\n}\n"
        );
        writeFileSync(join(dir, "a.ts"), 'import { core } from "./lib/core";\nexport const a = core;\n');
        writeFileSync(join(dir, "b.ts"), 'import { helper } from "./lib/core";\nexport const b = helper();\n');
        writeFileSync(join(dir, "leaf.ts"), "export const leaf = 1;\n");

        return dir;
    }

    test("--files-only puts the file the most others import first and counts its importers", () => {
        const dir = fixture();
        const result = cli(["skeleton", dir, "--files-only", "--json"], dir);
        const files = SafeJSON.parse(result.stdout).files as { file: string; rank: number; importers: number }[];

        expect(result.code).toBe(0);
        expect(files[0].file).toMatch(/lib\/core\.ts$/);
        expect(files[0].importers).toBe(2);
        expect(files.find((file) => file.file.endsWith("leaf.ts"))?.importers).toBe(0);
    });

    test("--files-only prints an aligned table and never shortens a long path", () => {
        const dir = fixture();
        const nested = join("lib", "a-deeply-nested-folder-with-a-long-name", "another-long-folder-name");
        const longFile = join(nested, "module-with-a-very-long-name.ts");

        mkdirSync(join(dir, nested), { recursive: true });
        writeFileSync(join(dir, longFile), "export const long = 1;\n");

        const result = cli(["skeleton", dir, "--files-only"], dir);
        const lines = stripAnsi(result.stdout).split("\n").filter(Boolean);
        const fileColumn = lines[0].indexOf("FILE");

        expect(result.code).toBe(0);
        expect(longFile.length).toBeGreaterThan(50);
        expect(lines[0].trim()).toMatch(/^RANK\s+IMPORTERS\s+DECLS\s+FILE$/);
        expect(lines.slice(2)).toHaveLength(5);
        expect(lines.slice(2).every((line) => line.slice(fileColumn).trim().length > 0)).toBe(true);
        expect(lines.some((line) => line.slice(fileColumn).trim() === longFile)).toBe(true);
    });

    test("--max-tokens keeps the top file and names the ones that did not fit", () => {
        const dir = fixture();
        const result = cli(["skeleton", dir, "--max-tokens", "120", "--json"], dir);
        const parsed = SafeJSON.parse(result.stdout) as { files: { file: string }[]; stats: { omitted: string[] } };

        expect(result.code).toBe(0);
        expect(parsed.files.map((file) => file.file)).toEqual([expect.stringMatching(/lib\/core\.ts$/)]);
        expect(parsed.stats.omitted).toHaveLength(3);
    });

    test("--max-tokens bounds what is printed, function bodies included, not just the signatures", () => {
        const dir = fixture();
        const budget = 100;
        const result = cli(["skeleton", dir, "--max-tokens", String(budget), "--function-context", "6"], dir);
        const printed = Number(/skeleton ([\d,]+) tokens/.exec(stripAnsi(result.stderr))?.[1]?.replace(/,/g, ""));

        expect(result.code).toBe(0);
        expect(printed).toBeLessThanOrEqual(budget);
        expect(result.stderr).toContain("did not fit --max-tokens");
    });

    test("without --rank the order and the output keys are unchanged", () => {
        const dir = fixture();
        const result = cli(["skeleton", dir, "--json"], dir);
        const parsed = SafeJSON.parse(result.stdout) as {
            files: Record<string, unknown>[];
            stats: Record<string, unknown>;
        };

        expect(parsed.files.every((file) => !("rank" in file))).toBe(true);
        expect(parsed.stats).not.toHaveProperty("omitted");
    });

    test("--max-tokens must be a positive whole number", () => {
        const result = cli(["skeleton", SAMPLE, "--max-tokens", "0"]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/at least 1/);
    });
});

describe("sourcemap build interruption", () => {
    for (const keepWorktree of [false, true]) {
        test(`Ctrl-C stops an ${keepWorktree ? "explicit kept" : "interactively selected"} build`, () => {
            const script = `
                import { mock } from "bun:test";
                import { SafeJSON } from "@genesiscz/utils/json";
                import { Command } from "commander";
                const cli = await import("@genesiscz/utils/cli");
                mock.module("@genesiscz/utils/cli", () => ({ ...cli, isInteractive: () => true }));
                mock.module("@genesiscz/utils/prompts/p", () => ({
                    select: async () => "command",
                    text: async ({ message }) => message.startsWith("Build command") ? "sleep 30" : "unused",
                }));
                const build = await import("@genesiscz/utils/ts/sourcemaps/build");
                let worktree;
                mock.module("@genesiscz/utils/ts/sourcemaps/build", () => ({
                    ...build,
                    buildAtCommit: async (options) => {
                        worktree = options.worktree;
                        queueMicrotask(() => process.emit("SIGINT"));
                        return new Promise(() => {});
                    },
                    releaseBuildWorktrees: async (options) => {
                        process.stdout.write(SafeJSON.stringify({ stop: options?.stop, worktree }));
                        return [];
                    },
                }));
                const { registerSourcemapsCommands } = await import(${SafeJSON.stringify(join(import.meta.dir, "sourcemaps.ts"))});
                const program = new Command();
                registerSourcemapsCommands(program);
                await program.parseAsync([
                    "bun", "ts", "sourcemaps", "build", "--repo", "/fixture", "--commit", "HEAD",
                    "--output", "out", "--project", "interrupt-fixture",
                    ...${SafeJSON.stringify(keepWorktree ? ["--build-cmd", "sleep 30", "--keep-worktree"] : [])},
                ]);
            `;
            const result = Bun.spawnSync(["bun", "-e", script], {
                env: process.env,
                stdout: "pipe",
                stderr: "pipe",
                timeout: 3000,
            });
            const stdout = new TextDecoder().decode(result.stdout);
            const stderr = new TextDecoder().decode(result.stderr);
            expect({ code: result.exitCode, stderr }).toMatchObject({ code: 130 });
            const release = SafeJSON.parse(stdout) as { stop: boolean; worktree?: string };
            expect(release.stop).toBe(true);

            if (keepWorktree) {
                expect(release.worktree).toMatch(/interrupt-fixture[/\\]worktree$/);
            } else {
                expect(release.worktree).toBeUndefined();
            }
        });
    }
});

describe("sourcemap cache prune --all", () => {
    for (const json of [false, true]) {
        test(`reports failed removals but not expected retention (${json ? "JSON" : "text"})`, () => {
            const script = `
                import { mock } from "bun:test";
                import { Command } from "commander";
                const cache = await import("@genesiscz/utils/ts/sourcemaps/cache");
                mock.module("@genesiscz/utils/ts/sourcemaps/cache", () => ({
                    ...cache,
                    cacheProjects: async () => ["broken", "busy", "last"],
                    SourcemapCache: class {
                        constructor(project) { this.project = project; }
                        async prune() {
                            return { removed: this.project === "last" ? [{ name: "old", reason: "unused", bytes: 10, diskBytes: 10 }] : [], kept: this.project === "last" ? [] : [{
                                worktree: "/fixture/" + this.project,
                                outcome: this.project === "broken" ? "failed" : "busy",
                                bytes: 0,
                                detail: this.project === "broken" ? "git removal failed" : "a build is running",
                            }] };
                        }
                    },
                }));
                const { registerSourcemapsCommands } = await import(${SafeJSON.stringify(join(import.meta.dir, "sourcemaps.ts"))});
                const program = new Command();
                registerSourcemapsCommands(program);
                await program.parseAsync(["bun", "ts", "sourcemaps", "cache", "prune", "--all", ...${SafeJSON.stringify(json ? ["--json"] : [])}]);
            `;
            const result = Bun.spawnSync(["bun", "-e", script], {
                env: process.env,
                stdout: "pipe",
                stderr: "pipe",
                timeout: 5000,
            });
            const stdout = new TextDecoder().decode(result.stdout);
            const stderr = new TextDecoder().decode(result.stderr);
            expect(result.exitCode).toBe(1);
            if (json) {
                expect(SafeJSON.parse(stdout)).toMatchObject({
                    projects: [{ project: "broken" }, { project: "busy" }, { project: "last" }],
                    failures: [{ project: "broken", error: "/fixture/broken: git removal failed" }],
                });
            } else {
                expect(stdout).toContain("last");
                expect(stderr).toContain("could not prune broken: /fixture/broken: git removal failed");
                expect(stderr).not.toContain("could not prune busy");
            }
        });
        test(`reports successes and failures without aborting later projects (${json ? "JSON" : "text"})`, () => {
            const script = `
                import { mock } from "bun:test";
                import { Command } from "commander";
                const cache = await import("@genesiscz/utils/ts/sourcemaps/cache");
                mock.module("@genesiscz/utils/ts/sourcemaps/cache", () => ({
                    ...cache,
                    cacheProjects: async () => ["first", "broken", "last"],
                    SourcemapCache: class {
                        constructor(project) { this.project = project; }
                        async prune() {
                            if (this.project === "broken") throw new Error("fixture prune failed");
                            return { removed: [{ name: "old", reason: "unused", bytes: 10, diskBytes: 10 }], kept: [] };
                        }
                    },
                }));
                const { registerSourcemapsCommands } = await import(${SafeJSON.stringify(join(import.meta.dir, "sourcemaps.ts"))});
                const program = new Command();
                registerSourcemapsCommands(program);
                await program.parseAsync(["bun", "ts", "sourcemaps", "cache", "prune", "--all", ...${SafeJSON.stringify(json ? ["--json"] : [])}]);
            `;
            const result = Bun.spawnSync(["bun", "-e", script], {
                env: process.env,
                stdout: "pipe",
                stderr: "pipe",
                timeout: 5000,
            });
            const stdout = new TextDecoder().decode(result.stdout);
            const stderr = new TextDecoder().decode(result.stderr);
            expect(result.exitCode).toBe(1);
            if (json) {
                expect(SafeJSON.parse(stdout)).toMatchObject({
                    projects: [{ project: "first" }, { project: "last" }],
                    failures: [{ project: "broken", error: "fixture prune failed" }],
                    freedBytes: 20,
                });
            } else {
                expect(stdout).toContain("first");
                expect(stdout).toContain("last");
                expect(stderr).toContain("could not prune broken: fixture prune failed");
            }
        });
    }
});
