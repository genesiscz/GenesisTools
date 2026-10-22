#!/usr/bin/env bun
/**
 * Typechecks the repo's TypeScript projects with TypeScript 7's `tsc`, each with `--incremental` and its build info
 * under the checkout's git folder, and by default only the projects a change can reach.
 *
 *   bun scripts/ci/typecheck.ts            # changed since the last passing run of each project (local default)
 *   bun scripts/ci/typecheck.ts --base <sha>   # changed between <sha> and HEAD (CI: PR base or the commit before a push)
 *   bun scripts/ci/typecheck.ts --all      # every project (still incremental)
 *
 * A project runs when no build info or state says what it holds, when a file that changes every project changed
 * (`package.json`, `bun.lock`, a `tsconfig`), when a changed file is in its last program (the build info's
 * `fileNames`), or when a TypeScript or JavaScript file was added that its program does not hold yet (only tsc knows
 * which include patterns take a new file, so every such project runs). Build info is a cache only:
 * `tsc` compares file hashes, so build info from another commit still gives the right answer, just slower.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

export interface Project {
    name: string;
    tsconfig: string;
}

/** The order `typecheck:all` had; the root project is the large one. */
export const PROJECTS: Project[] = [
    { name: "root", tsconfig: "tsconfig.json" },
    { name: "claude-history-dashboard", tsconfig: "src/claude-history-dashboard/tsconfig.json" },
    { name: "spotify-ui", tsconfig: "src/spotify/ui/tsconfig.json" },
    { name: "monitor-ui", tsconfig: "src/monitor/ui/tsconfig.json" },
    { name: "clarity-ui", tsconfig: "src/clarity/ui/tsconfig.json" },
    { name: "dev-dashboard-ui", tsconfig: "src/dev-dashboard/ui/tsconfig.json" },
    { name: "fable-replace", tsconfig: "plugins/genesis-tools/skills/fable-replace/scripts/tsconfig.json" },
];

/** What a project can take in: the root project has `allowJs`, so JavaScript inputs count too. */
const TS_FILE = /\.(?:[cm]?[jt]sx?|json)$/;
const EVERY_PROJECT = /(?:^|\/)(?:package\.json|bun\.lock|tsconfig[\w.-]*\.json|bunfig\.toml)$/;

export type Reason =
    | "no build info"
    | "no passing run yet"
    | "base not in this checkout"
    | "shared config"
    | "in its program"
    | "new file"
    | "--all";

interface Selection {
    project: Project;
    reason: Reason | null;
}

export interface Changes {
    /** Every changed, added or deleted path, from the repo top. */
    files: string[];
    /** The added ones (and untracked ones locally): no build info knows them yet. */
    added: string[];
}

/**
 * Why `project` must run for these changes, or null. `programs` holds each project's last program files (absolute,
 * lowercased, as the build info stores them), null when nothing is known. An added TypeScript file this project's
 * program does not hold makes it run: only tsc knows which include patterns take it (spotify-ui includes `../**`), and
 * another project's program holding it says nothing about this one (a root run caches a file a dashboard also takes).
 */
export function reasonToRun({
    project,
    changes,
    programs,
}: {
    project: Project;
    changes: Changes;
    programs: Map<string, Set<string> | null>;
}): Reason | null {
    const program = programs.get(project.name);
    if (!program) {
        return "no build info";
    }

    if (changes.files.some((file) => EVERY_PROJECT.test(file))) {
        return "shared config";
    }

    const key = (file: string) => resolve(file).toLowerCase();
    if (changes.files.some((file) => program.has(key(file)))) {
        return "in its program";
    }

    return changes.added.some((file) => TS_FILE.test(file) && !program.has(key(file))) ? "new file" : null;
}

function git(args: string[]): string | null {
    const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

function lines(text: string | null): string[] {
    return (text ?? "").split("\n").filter(Boolean);
}

/** What changed between `base` and the working tree (in CI the same as HEAD), untracked files included. */
export function changedSince(base: string): Changes | null {
    const diff = git(["diff", "--name-status", "--no-renames", base]);
    if (diff === null) {
        return null;
    }

    const files: string[] = [];
    const added: string[] = [];
    for (const line of lines(diff)) {
        const [status, path] = line.split("\t");
        if (path) {
            files.push(path);
            if (status === "A") {
                added.push(path);
            }
        }
    }

    const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]));
    return { files: [...new Set([...files, ...untracked])], added: [...new Set([...added, ...untracked])] };
}

interface Passed {
    /** HEAD when the project last passed. */
    sha: string;
    /** Files that differed from that HEAD then: they were checked as they were, so they count as changed next time. */
    dirty: string[];
}

interface State {
    passed: Record<string, Passed>;
}

function isPassed(value: unknown): value is Passed {
    const record = value as Partial<Passed> | null;
    return (
        typeof record?.sha === "string" &&
        Array.isArray(record.dirty) &&
        record.dirty.every((file) => typeof file === "string")
    );
}

function cacheDir(): string {
    const path = lines(git(["rev-parse", "--path-format=absolute", "--git-path", "genesis-typecheck"]))[0];
    if (!path) {
        throw new Error("typecheck: not inside a git checkout, so there is nowhere to keep build info");
    }

    mkdirSync(path, { recursive: true });
    return path;
}

function readState(dir: string): State {
    const file = join(dir, "state.json");
    const passed: Record<string, Passed> = {};
    if (!existsSync(file)) {
        return { passed };
    }

    const parsed: unknown = SafeJSON.parse(readFileSync(file, "utf8"));
    const entries = (parsed as { passed?: unknown } | null)?.passed;
    for (const [name, value] of Object.entries(typeof entries === "object" && entries !== null ? entries : {})) {
        if (isPassed(value)) {
            passed[name] = value;
        }
    }

    return { passed };
}

function buildInfoPath(dir: string, project: Project): string {
    return join(dir, `${project.name}.tsbuildinfo`);
}

/** The files of the project's last program, from its build info; null when there is none to read. */
export function programFiles(buildInfo: string): Set<string> | null {
    if (!existsSync(buildInfo)) {
        return null;
    }

    const parsed: unknown = SafeJSON.parse(readFileSync(buildInfo, "utf8"), { strict: true });
    const names = (parsed as { fileNames?: unknown } | null)?.fileNames;
    if (!Array.isArray(names)) {
        return null;
    }

    const base = dirname(buildInfo);
    return new Set(
        names
            .filter((name): name is string => typeof name === "string")
            .map((name) => resolve(base, name).toLowerCase())
    );
}

interface Outcome {
    project: Project;
    ok: boolean;
    ms: number;
    output: string;
}

async function check(project: Project, dir: string): Promise<Outcome> {
    const started = performance.now();
    const tsc = join(import.meta.dir, "../../node_modules/.bin/tsc");
    const proc = Bun.spawn(
        [tsc, "-p", project.tsconfig, "--noEmit", "--incremental", "--tsBuildInfoFile", buildInfoPath(dir, project)],
        { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { project, ok: code === 0, ms: performance.now() - started, output: `${stdout}${stderr}`.trim() };
}

function parseArgs(argv: string[]): { all: boolean; base: string | null } {
    const at = argv.indexOf("--base");
    const base = at === -1 ? null : (argv[at + 1] ?? null);
    if (at !== -1 && !base) {
        throw new Error("--base needs a commit");
    }

    return { all: argv.includes("--all"), base };
}

async function main(): Promise<void> {
    const started = performance.now();
    const { all, base } = parseArgs(process.argv.slice(2));
    const root = lines(git(["rev-parse", "--show-toplevel"]))[0];
    if (!root) {
        throw new Error("typecheck: run it inside the GenesisTools checkout");
    }

    // git prints paths from the top for `diff` but from the cwd for `ls-files`, and the tsconfig paths are from the top.
    process.chdir(root);
    const dir = cacheDir();
    const state = readState(dir);
    const head = lines(git(["rev-parse", "HEAD"]))[0] ?? "";

    // One `git diff` per distinct starting commit: locally most projects last passed at the same HEAD.
    const diffs = new Map<string, Changes | null>();
    const changedFrom = (sha: string) => {
        if (!diffs.has(sha)) {
            diffs.set(sha, changedSince(sha));
        }

        return diffs.get(sha) ?? null;
    };

    const programs = new Map(PROJECTS.map((project) => [project.name, programFiles(buildInfoPath(dir, project))]));
    const selections = PROJECTS.map((project): Selection => {
        if (all) {
            return { project, reason: "--all" };
        }

        const passed = state.passed[project.name];
        const since = base ?? passed?.sha;
        if (!since) {
            return { project, reason: "no passing run yet" };
        }

        const fromSince = changedFrom(since);
        if (fromSince === null) {
            return { project, reason: "base not in this checkout" };
        }

        const dirty = base ? [] : (passed?.dirty ?? []);
        const changes = { files: [...new Set([...fromSince.files, ...dirty])], added: fromSince.added };
        return { project, reason: reasonToRun({ project, changes, programs }) };
    });

    const chosen = selections.filter((selection) => selection.reason !== null);
    const dirtyNow = chosen.length > 0 ? (changedFrom("HEAD")?.files ?? []) : [];
    const outcomes = await Promise.all(chosen.map((selection) => check(selection.project, dir)));

    for (const outcome of outcomes) {
        if (outcome.ok) {
            state.passed[outcome.project.name] = { sha: head, dirty: dirtyNow };
        }
    }

    writeFileSync(join(dir, "state.json"), `${SafeJSON.stringify(state, null, 2)}\n`);

    for (const selection of selections) {
        const outcome = outcomes.find((candidate) => candidate.project === selection.project);
        const where = relative(process.cwd(), selection.project.tsconfig);
        if (!outcome) {
            out.println(`· ${selection.project.name.padEnd(26)} skipped, nothing it holds changed  (${where})`);
            continue;
        }

        const mark = outcome.ok ? "✔" : "✖";
        out.println(
            `${mark} ${selection.project.name.padEnd(26)} ${(outcome.ms / 1000).toFixed(1)} s, ${selection.reason}`
        );
        if (!outcome.ok) {
            out.println(outcome.output);
        }
    }

    const failed = outcomes.filter((outcome) => !outcome.ok).length;
    out.println(
        `typecheck: ${outcomes.length} of ${PROJECTS.length} projects checked, ${failed} failed, ${((performance.now() - started) / 1000).toFixed(1)} s`
    );
    process.exitCode = failed > 0 ? 1 : 0;
}

if (import.meta.main) {
    await main();
}
