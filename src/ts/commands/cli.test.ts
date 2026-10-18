import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";
import { type CapturedOutput, captureOutput } from "@genesiscz/utils/test/capture-out";
import { Command } from "commander";
import type { MeasureOptions, MeasureResult, WorkerSample } from "../lib/measure";
import { registerImportsCommands } from "./imports";
import { registerSkeletonCommands } from "./skeleton";

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

interface CommandRun extends CapturedOutput {
    error?: unknown;
}

/**
 * Parse and run a registered command inside this process, so its lines count as covered and the test reads what it
 * printed without a child per assertion. `exitOverride` turns commander's exit into a throw, which is returned.
 * `argv` is pinned because `suggestCommand` rebuilds its hints from it.
 */
async function runInProcess(options: {
    register(program: Command): void;
    args: string[];
    cwd?: string;
}): Promise<CommandRun> {
    const program = new Command();
    program.exitOverride();
    options.register(program);

    const previousCwd = process.cwd();
    const previousArgv = process.argv;
    let error: unknown;

    process.argv = ["bun", "tools", ...options.args];

    if (options.cwd) {
        process.chdir(options.cwd);
    }

    try {
        const captured = await captureOutput(async () => {
            try {
                await program.parseAsync(["bun", "tools", ...options.args]);
            } catch (caught) {
                error = caught;
            }
        });

        return { ...captured, error };
    } finally {
        process.chdir(previousCwd);
        process.argv = previousArgv;
    }
}

describe("tools ts skeleton, run in process", () => {
    const originalExitCode = process.exitCode;
    let dir: string;

    function put(rel: string, source: string): void {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), source);
    }

    function skeleton(args: string[]): Promise<CommandRun> {
        return runInProcess({ register: registerSkeletonCommands, args: ["skeleton", ...args], cwd: dir });
    }

    beforeAll(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), "ts-skeleton-")));
        put("lib/core.ts", "export const core = 1;\nexport function helper(): number {\n    return core;\n}\n");
        put("a.ts", 'import { core } from "./lib/core";\nexport const a = core;\n');
        put("shape.ts", "export interface Shape {\n    w: number;\n    h: number;\n}\n");
        put(
            "shape-user.ts",
            [
                'import type { Shape } from "./shape";',
                "export function area(s: Shape): number {",
                "    const w = s.w;",
                "    const h = s.h;",
                "    const big = w * h;",
                "    return big;",
                "}",
                "function hidden() {}",
                "",
            ].join("\n")
        );
        put("only-private.ts", "function hidden() {}\n");
        put("class-file.ts", "export class Box {\n    size = 1;\n    grow(): void {}\n}\nexport const unit = 1;\n");
        put(
            "external.ts",
            'import type { Widget } from "acme-widgets";\nexport declare function render(widget: Widget): string;\n'
        );
        put(
            "big-type.ts",
            `export interface Big {\n${Array.from({ length: 45 }, (_, i) => `    field${i}: number;`).join("\n")}\n}\nexport declare function make(): Big;\n`
        );
        put("comments-only.ts", "// nothing declared here\n");
        put("commented.ts", `${"// a note about nothing\n".repeat(10)}export const last = 1;\n`);
    });

    afterEach(() => {
        process.exitCode = originalExitCode;
    });

    test("prints each declaration with its line span, the coverage, and a closing size line on stderr", async () => {
        const run = await skeleton(["lib/core.ts"]);

        expect(run.stdout).toContain("skeleton lib/core.ts (2 decls · 80% of 5 lines)");
        expect(run.stdout).toMatch(/- L1-L1\s+export const core = 1;/);
        expect(run.stdout).toMatch(/- L2-L4\s+export function helper\(\): number/);
        expect(run.stderr).toMatch(
            /● 1 file\(s\) · original \d+ tokens · skeleton \d+ tokens · [\d.]+% (smaller|larger)/
        );
        expect(run.error).toBeUndefined();
    });

    test("--exported drops the declarations that are not exported", async () => {
        const all = await skeleton(["shape-user.ts"]);
        const exported = await skeleton(["shape-user.ts", "--exported"]);

        expect(all.stdout).toContain("function hidden()");
        expect(exported.stdout).toContain("export function area(s: Shape): number");
        expect(exported.stdout).not.toContain("hidden");
    });

    test("--top-level drops the members of a class and keeps the declaration itself", async () => {
        const all = await skeleton(["class-file.ts"]);
        const top = await skeleton(["class-file.ts", "--top-level"]);

        expect(all.stdout).toMatch(/grow\(\): void/);
        expect(top.stdout).toContain("export class Box");
        expect(top.stdout).toContain("export const unit = 1;");
        expect(top.stdout).not.toContain("grow");
        expect(top.stdout).toContain("(2 decls");
    });

    test("--types names a type from a package it cannot open instead of dropping it", async () => {
        const run = await skeleton(["external.ts", "--types"]);

        expect(run.stdout).toContain("referenced types (1)");
        expect(run.stdout).toContain('Widget — declared in "acme-widgets", outside this repo');
    });

    test("--types says where a long type was cut", async () => {
        const run = await skeleton(["big-type.ts", "--types", "--top-level"]);

        expect(run.stdout).toContain("field38: number;");
        expect(run.stdout).not.toContain("field39");
        expect(run.stdout).toContain("… cut here, the rest of Big is not shown");
    });

    test("names the filter when nothing is left, and says there is nothing to show for an empty file", async () => {
        const filtered = await skeleton(["only-private.ts", "--exported"]);
        const empty = await skeleton(["comments-only.ts"]);

        expect(filtered.stdout).toContain("nothing left after the active filters");
        expect(empty.stdout).toContain("nothing to show");
        expect(empty.stdout).not.toContain("nothing left after");
    });

    test("warns in markdown, and flags the percentage in text, when a file is mostly not declarations", async () => {
        const text = await skeleton(["commented.ts"]);
        const md = await skeleton(["commented.ts", "--md"]);
        const json = await skeleton(["commented.ts", "--json"]);
        const files = SafeJSON.parse(json.stdout).files as { coveredPct: number; decls: number }[];

        expect(text.stdout).toMatch(/\(1 decls · 8% of 12 lines\)/);
        expect(md.stdout).toContain("Most of this file is not represented");
        expect(files[0]).toMatchObject({ decls: 1, coveredPct: 8 });
    });

    test("--function-context prints the first body lines, marks a cut body, and --types appends the declaration", async () => {
        const run = await skeleton(["shape-user.ts", "--exported", "--function-context", "2", "--types"]);

        expect(run.stdout).toContain("│ const w = s.w;");
        expect(run.stdout).toContain("│ const h = s.h;");
        expect(run.stdout).not.toContain("const big");
        expect(run.stdout).toMatch(/\n\s+│ …\n/);
        expect(run.stdout).toContain("referenced types (1)");
        expect(run.stdout).toContain("Shape shape.ts:1");
        expect(run.stdout).toContain("export interface Shape {");
    });

    test("--md puts a body under a heading and ends a cut one with a comment", async () => {
        const run = await skeleton(["shape-user.ts", "--exported", "--function-context", "2", "--md"]);

        expect(run.stdout).toContain("# Skeleton");
        expect(run.stdout).toContain("## shape-user.ts");
        expect(run.stdout).toMatch(/\| L2-L7 \| export function area\(s: Shape\): number \|/);
        expect(run.stdout).toContain("### area — L2");
        expect(run.stdout).toContain("const w = s.w;\n    const h = s.h;\n// …");
    });

    test("--json names every field, and --types, --include-* and --function-context add theirs", async () => {
        const run = await skeleton([
            "shape-user.ts",
            "--exported",
            "--json",
            "--types",
            "--include-names",
            "--include-locals",
            "--include-hash",
            "--function-context",
            "1",
        ]);
        const parsed = SafeJSON.parse(run.stdout) as {
            files: { file: string; symbols: Record<string, unknown>[]; types: { name: string }[] }[];
            stats: { files: number; originalChars: number; originalTokens: number };
        };
        const [symbol] = parsed.files[0].symbols;

        expect(parsed.files[0].file).toBe("shape-user.ts");
        expect(parsed.files[0].types.map((type) => type.name)).toEqual(["Shape"]);
        expect(symbol).toMatchObject({
            startLine: 2,
            endLine: 7,
            depth: 0,
            exported: true,
            name: "area",
            kind: "function",
            local: false,
            body: ["    const w = s.w;"],
            bodyTruncated: true,
        });
        expect(symbol.hash).toMatch(/^[0-9a-f]{12}$/);
        expect(parsed.stats.files).toBe(1);
    });

    test("--json-compact lists the columns once and keeps the rows positional", async () => {
        const run = await skeleton([
            "lib/core.ts",
            "--json-compact",
            "--include-names",
            "--include-locals",
            "--include-hash",
        ]);
        const parsed = SafeJSON.parse(run.stdout) as { cols: string[]; files: { symbols: unknown[][] }[] };

        expect(parsed.cols).toEqual([
            "startLine",
            "endLine",
            "depth",
            "exported",
            "name",
            "kind",
            "local",
            "hash",
            "signature",
        ]);
        expect(parsed.files[0].symbols[1].slice(0, 6)).toEqual([2, 4, 0, true, "helper", "function"]);
        expect(parsed.files[0].symbols[1].at(-1)).toBe("export function helper(): number");
    });

    test("--toon names the keys once per table", async () => {
        const run = await skeleton(["lib/core.ts", "--toon"]);

        expect(run.stdout).toMatch(/symbols\[2\]\{startLine,endLine,depth,exported,signature\}:/);
    });

    test("--md says there is nothing to show for a file without declarations", async () => {
        const run = await skeleton(["comments-only.ts", "--md"]);

        expect(run.stdout).toContain("## comments-only.ts");
        expect(run.stdout).toContain("_nothing to show_");
    });

    test("--exact-tokens counts with the tokenizer instead of the characters-per-token estimate", async () => {
        const { countTokens } = await import("@anthropic-ai/tokenizer");
        const source = "export const core = 1;\nexport function helper(): number {\n    return core;\n}\n";
        const run = await skeleton(["lib/core.ts", "--exact-tokens"]);

        expect(run.stderr).toContain(`original ${countTokens(source)} tokens`);
        expect(countTokens(source)).not.toBe(Math.ceil(source.length / 3.77));
    });

    test("--files-only ranks the most imported file first and counts the files on stderr", async () => {
        const text = await skeleton([".", "--files-only"]);
        const json = await skeleton([".", "--files-only", "--json"]);
        const files = SafeJSON.parse(json.stdout).files as { file: string; importers: number }[];

        expect(text.stdout).toMatch(/^RANK\s+IMPORTERS\s+DECLS\s+FILE$/m);
        expect(text.stderr).toMatch(/● \d+ file\(s\) ranked/);
        expect(files.find((file) => file.file === "lib/core.ts")?.importers).toBe(1);
        expect(files.find((file) => file.file === "a.ts")?.importers).toBe(0);
    });

    test("--max-tokens lists at most five omitted files and counts the rest", async () => {
        const many = realpathSync(mkdtempSync(join(tmpdir(), "ts-skeleton-many-")));
        writeFileSync(join(many, "hub.ts"), "export const hub = 1;\n");

        for (let index = 0; index < 8; index++) {
            writeFileSync(join(many, `user-${index}.ts`), 'import { hub } from "./hub";\nexport const v = hub;\n');
        }

        const run = await runInProcess({
            register: registerSkeletonCommands,
            args: ["skeleton", ".", "--max-tokens", "40"],
            cwd: many,
        });

        expect(run.stderr).toMatch(/\d+ lower-ranked file\(s\) did not fit --max-tokens 40: /);
        expect(run.stderr).toMatch(/, \+\d+ more/);
    });

    test("a path with no TypeScript source sets exit code 1 and still prints the size line", async () => {
        const run = await skeleton(["nothing-here"]);

        expect(process.exitCode).toBe(1);
        expect(run.stderr).toContain("No TypeScript source found");
        expect(run.stderr).toContain("0 file(s)");
    });

    test("two output formats at once are a usage error printed on one line", async () => {
        const run = await skeleton(["lib/core.ts", "--md", "--json"]);

        expect(run.stderr).toContain("error: Pick one output format; got json and md");
        expect(run.stdout).toBe("");
        expect(run.error).toMatchObject({ code: "commander.error" });
    });
});

describe("tools ts imports, run in process", () => {
    const originalExitCode = process.exitCode;
    const SAMPLES: Record<string, number> = {
        "entry.ts": 1,
        "barrel/index.ts": 0.5,
        "barrel/a.ts": 0.25,
        "barrel/b.ts": 0.25,
        "heavy.ts": 10,
        "lazy-ok.ts": 2,
        "cyc/x.ts": 0,
        "cyc/y.ts": 4,
        "multi/a.ts": 1,
        "multi/b.ts": 3,
    };
    const measureCalls: MeasureOptions[] = [];
    let scenario: {
        omit?: string[];
        samples?: Record<string, WorkerSample>;
        stderr?: string;
        timedOut?: boolean;
    } = {};
    let root: string;

    function put(rel: string, source: string): string {
        const file = join(root, rel);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, source);

        return file;
    }

    function imports(args: string[]): Promise<CommandRun> {
        return runInProcess({ register: registerImportsCommands, args: ["imports", ...args] });
    }

    beforeAll(async () => {
        root = realpathSync(mkdtempSync(join(tmpdir(), "ts-imports-")));
        mkdirSync(join(root, ".git"));
        put(
            "entry.ts",
            [
                'import { a } from "./barrel";',
                'import { helper } from "./lazy-ok";',
                'import { x } from "./cyc/x";',
                "export function run() { return helper() + a() + x(); }",
                "",
            ].join("\n")
        );
        put("barrel/index.ts", 'export { a } from "./a";\nexport * from "./b";\n');
        put("barrel/a.ts", "export function a() { return 1; }\n");
        put("barrel/b.ts", 'import { heavy } from "../heavy";\nexport function b() { return heavy; }\n');
        put("heavy.ts", "export const heavy = 42;\n");
        put(
            "lazy-ok.ts",
            'import { readFileSync } from "node:fs";\nexport function helper() { return readFileSync; }\n'
        );
        put("cyc/x.ts", 'import { y } from "./y";\nexport function x() { return y; }\n');
        put("cyc/y.ts", 'import { x } from "./x";\nexport const y = () => x;\n');
        put("multi/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
        put("multi/b.ts", "export const b = 1;\n");
        put("multi/a.test.ts", "export const ignored = 1;\n");

        // The worker is the only slow part: it starts a fresh bun per module. Everything around it is real.
        const real = await import("../lib/measure");
        mock.module("../lib/measure", () => ({
            ...real,
            measureGraph: async (options: MeasureOptions): Promise<MeasureResult> => {
                measureCalls.push(options);
                const self = new Map<string, WorkerSample>();

                for (const id of options.order) {
                    const label = options.graph.nodes.get(id)?.label ?? "";
                    const ms = SAMPLES[label];

                    if (ms !== undefined && !scenario.omit?.includes(label)) {
                        self.set(id, scenario.samples?.[label] ?? { ms, status: "ok" });
                    }
                }

                return {
                    self,
                    cold: { ms: 20, status: "ok" },
                    stderr: scenario.stderr ?? "",
                    timedOut: scenario.timedOut === true,
                };
            },
        }));
    });

    afterEach(() => {
        process.exitCode = originalExitCode;
        scenario = {};
        measureCalls.length = 0;
    });

    test("analyze prints the cold import, the tree, the heaviest modules and the next step", async () => {
        const entry = join(root, "entry.ts");
        const run = await imports(["analyze", entry]);

        expect(run.stdout).toContain("tools ts imports analyze");
        expect(run.stdout).toContain("cold import 20.0 ms   sum of self 18.0 ms");
        expect(run.stdout).toMatch(/entry\.ts\s+total\s+18\.0 ms\s+self\s+1\.00 ms\n/);
        expect(run.stdout).toContain("Heaviest modules by self time (top 15)");
        expect(run.stdout).toContain(`Next: tools ts imports lazy ${entry}`);
        expect(measureCalls).toHaveLength(1);
        expect(measureCalls[0]).toMatchObject({ runs: 3, timeoutMs: 60_000 });
    });

    test("analyze forwards --runs, --timeout, --walk-packages and --include-dynamic, and applies --top and --depth", async () => {
        const run = await imports([
            "analyze",
            join(root, "entry.ts"),
            "--runs",
            "2",
            "--timeout",
            "5",
            "--walk-packages",
            "--include-dynamic",
            "--top",
            "2",
            "--depth",
            "1",
        ]);
        const tree = run.stdout.slice(run.stdout.indexOf("Import tree"), run.stdout.indexOf("Heaviest modules"));

        expect(measureCalls[0]).toMatchObject({ runs: 2, timeoutMs: 5000 });
        expect(measureCalls[0].graph.includeDynamic).toBe(true);
        expect(run.stdout).toContain("sum of self (lazy included)");
        expect(run.stdout).toContain("Heaviest modules by self time (top 2)");
        expect(tree).toContain("barrel/index.ts");
        expect(tree).not.toContain("barrel/a.ts");
    });

    test("analyze rounds --runs down but never below one", async () => {
        await imports(["analyze", join(root, "entry.ts"), "--runs", "2.7"]);
        await imports(["analyze", join(root, "entry.ts"), "--runs", "0.5"]);

        expect(measureCalls.map((call) => call.runs)).toEqual([2, 1]);
    });

    test("analyze --json prints one result per entry and nothing else on stdout", async () => {
        const run = await imports(["analyze", join(root, "entry.ts"), "--json"]);
        const parsed = SafeJSON.parse(run.stdout) as {
            entry: string;
            timedOut: boolean;
            modules: { label: string }[];
        }[];

        expect(parsed).toHaveLength(1);
        expect(parsed[0].entry).toBe("entry.ts");
        expect(parsed[0].timedOut).toBe(false);
        expect(parsed[0].modules.map((module) => module.label)).toContain("barrel/index.ts");
        expect(run.stdout).not.toContain("Import tree");
    });

    test("a --runs or --timeout that is not a positive number stops before any measurement", async () => {
        const runs = await imports(["analyze", join(root, "entry.ts"), "--runs", "0"]);
        const timeout = await imports(["analyze", join(root, "entry.ts"), "--timeout", "abc"]);

        expect(runs.stderr).toContain("--runs must be a positive number, got 0");
        expect(timeout.stderr).toContain("--timeout must be a positive number, got abc");
        expect(process.exitCode).toBe(1);
        expect(measureCalls).toHaveLength(0);
        expect(runs.stdout).toBe("");
    });

    test("every subcommand says when the entry does not exist, and exits 1 without measuring", async () => {
        for (const command of ["analyze", "lazy", "barrels", "cycles"]) {
            process.exitCode = 0;
            const run = await imports([command, join(root, "missing.ts")]);

            expect(run.stderr).toContain(`No entry found at ${join(root, "missing.ts")}. Pass a .ts file`);
            // The hint names the subcommand once: a copy of it in the replacement words would double it.
            const lines = run.stderr.split("\n").map((line) => line.replace(/^■\s+/, "").trim());

            expect(lines).toContain(`tools ts imports ${command} src/notify/index.ts`);
            expect(process.exitCode).toBe(1);
        }

        expect(measureCalls).toHaveLength(0);
    });

    test("a killed worker is reported first, with how many modules have no sample", async () => {
        scenario = { timedOut: true, omit: ["heavy.ts"] };
        const run = await imports(["analyze", join(root, "entry.ts")]);

        expect(run.stderr).toContain(
            "A measure worker was killed at --timeout. 1 of 8 planned module(s) have no sample, and every number below is from a PARTIAL run."
        );
        expect(run.stderr).not.toContain("their subtree totals are lower bounds");
    });

    test("a module with no sample on a finished run is called a lower bound", async () => {
        scenario = { omit: ["heavy.ts"] };
        const run = await imports(["analyze", join(root, "entry.ts")]);

        expect(run.stderr).toContain("1 of 8 planned module(s) have no sample; their subtree totals are lower bounds.");
        expect(run.stderr).not.toContain("killed at --timeout");
    });

    test("a module that never settled and one that threw are named, and an exit status is not reported as a throw", async () => {
        scenario = {
            samples: {
                "heavy.ts": { ms: 5000, status: "hang", message: "never settled" },
                "lazy-ok.ts": { ms: 1, status: "error", message: "boom" },
                "cyc/y.ts": { ms: 1, status: "exit", message: "1" },
            },
        };
        const run = await imports(["analyze", join(root, "entry.ts")]);

        expect(run.stderr).toContain("1 module(s) never settled during import and were given up on. First: heavy.ts.");
        expect(run.stderr).toContain(
            "2 module(s) rejected during import; their time is what a caller pays before the throw."
        );
        expect(run.stdout).toMatch(/lazy-ok\.ts\s+total.*boom/);
    });

    test("a worker's own stderr goes to the log, not to the report", async () => {
        scenario = { stderr: "worker noise: deprecated call" };
        const run = await imports(["analyze", join(root, "entry.ts")]);

        expect(run.stdout).toContain("cold import");
        expect(run.stdout).not.toContain("worker noise");
        expect(run.stderr).not.toContain("worker noise");
    });

    test("analyze over a folder with no index analyzes each file and ends with a one-line summary per entry", async () => {
        const run = await imports(["analyze", join(root, "multi")]);

        expect(measureCalls).toHaveLength(2);
        expect(run.stdout).toContain("2 entries");
        expect(run.stdout).toMatch(/multi\/a\.ts\s+cold\s+20\.0 ms\s+modules\s+2\s+heaviest multi\/b\.ts \(3\.00 ms\)/);
        expect(run.stdout).toMatch(/multi\/b\.ts\s+cold\s+20\.0 ms\s+modules\s+1\s+heaviest —/);
        expect(run.stdout).not.toContain("a.test.ts");
    });

    test("lazy lists the import that can become await import(), and --min-ms raises the bar", async () => {
        const entry = join(root, "entry.ts");
        const text = await imports(["lazy", entry]);
        const strict = await imports(["lazy", entry, "--min-ms", "1000"]);

        expect(text.stdout).toContain("tools ts imports lazy");
        expect(text.stdout).toMatch(/entry\.ts\s+│\s+2\s+│\s+lazy-ok\.ts\s+│\s+2\.00 ms\s+│\s+2\s+│/);
        expect(strict.stdout).toContain("no static import saves 1000 ms or more when made lazy");
    });

    test("lazy --json wraps the candidates with the run's completeness fields", async () => {
        const run = await imports(["lazy", join(root, "entry.ts"), "--json"]);
        const [envelope] = SafeJSON.parse(run.stdout) as {
            entry: string;
            planned: number;
            unmeasured: number;
            candidates: { target: string; savingMs: number }[];
        }[];

        expect(envelope).toMatchObject({ entry: "entry.ts", planned: 8, unmeasured: 0 });
        expect(envelope.candidates.find((candidate) => candidate.target === "lazy-ok.ts")?.savingMs).toBe(2);
    });

    test("barrels names the unused re-export a barrel drags in, as text and as JSON", async () => {
        const entry = join(root, "entry.ts");
        const text = await imports(["barrels", entry]);
        const json = await imports(["barrels", entry, "--json"]);
        const [envelope] = SafeJSON.parse(json.stdout) as { waste: { barrel: string; unusedTargets: string[] }[] }[];

        expect(text.stdout).toContain("tools ts imports barrels");
        expect(text.stdout).toContain("entry.ts:1 imports {a} from barrel/index.ts");
        expect(text.stdout).toContain("drags  barrel/b.ts");
        expect(envelope.waste[0]).toMatchObject({ barrel: "barrel/index.ts", unusedTargets: ["barrel/b.ts"] });
    });

    test("cycles names the two modules that import each other, as text and as JSON", async () => {
        const entry = join(root, "entry.ts");
        const text = await imports(["cycles", entry]);
        const json = await imports(["cycles", entry, "--json"]);
        const [envelope] = SafeJSON.parse(json.stdout) as {
            cycles: { members: string[]; selfMs: number; edges: unknown[] }[];
        }[];

        expect(text.stdout).toContain("cyc/x.ts ⇄ cyc/y.ts");
        expect(envelope.cycles).toHaveLength(1);
        expect(envelope.cycles[0]).toMatchObject({ members: ["cyc/x.ts", "cyc/y.ts"], selfMs: 4 });
        expect(envelope.cycles[0].edges).toHaveLength(2);
    });

    test("lazy, barrels and cycles warn about a killed worker the same way analyze does", async () => {
        scenario = { timedOut: true };

        for (const command of ["lazy", "barrels", "cycles"]) {
            const run = await imports([command, join(root, "entry.ts")]);

            expect(run.stderr).toContain("A measure worker was killed at --timeout.");
        }
    });
});
