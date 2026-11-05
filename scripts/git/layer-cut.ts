#!/usr/bin/env bun
/**
 * Cuts the unified branch's recorder, meetings and REPL work into a stack of exact-tree branches.
 *
 *   bun scripts/git/layer-cut.ts --scratch <dir> [--unified <ref>] [--unified-branch <name>] [--base <ref>]
 *                                [--master <ref>] [--plan-only] [--no-typecheck] [--tests] [--swift] [--json <file>]
 *   bun scripts/git/layer-cut.ts --scratch <dir> --checks-only [--tests] [--swift] [--only <branch>]   (on the cut/
 *                                refs of the last run; --only limits the checks to one branch)
 *
 * --unified takes a sha to pin a moving branch; --unified-branch names its PR head (never an exclusion source).
 * --tests runs `bun scripts/test.ts <folders>` per tree, serially; --swift runs one app `swift build --build-tests`
 * per Swift branch through the babysit skill's shared Swift slot.
 *
 * The final run of a night (unified keeps moving, so pin the head you cut; the open PR heads must be fetched):
 *
 *   git fetch origin
 *   bun scripts/git/layer-cut.ts \
 *       --scratch /tmp/cc/GenesisTools/<session>/layer-cut \
 *       --unified "$(git rev-parse feat/2026-10-13-enhancements-unified)" \
 *       --base origin/feat/2026-11-03-repl-followups \
 *       --tests \
 *       --swift
 *
 * --table <module path> loads a trusted module with a default CutTable export (see layer-cut-tables/types.ts).
 * Without it, layer-cut-tables/unified.ts preserves the original cut. A diff table takes every base-to-source path
 * through its sweeps; a commits table selects by scope and excludes open PR work as before.
 * Obsolete refs are retained for manual cleanup. Derived files fail loudly when the source changes.
 *
 * A replay of unified's commits onto the stack conflicts (27 of 247 applied on 2026-11-05), because unified holds the
 * stack's code in another form. So each cut branch is one commit whose tree is its parent's tree plus unified's
 * version of the branch's files, deletions included. Nothing can conflict, and the full history stays on unified.
 *
 * The file set: the files that unified's commits touch, for the commits that are not on master, not on an open PR
 * (by subject or patch id) and carry one of a branch's subject scopes, intersected with the files that differ between
 * the base and unified. Each file goes to the branch whose path glob matches it most specifically (CUT below).
 *
 * With typechecking on, each tree is checked out in `<scratch>/tree` and checked with `tsc-rs --noEmit`. An error that
 * neither the base nor unified has is traced to a file of a later branch (or to a differing file of no branch) and that
 * file moves down to the earliest branch that needs it, then the tree is rebuilt, until each tree checks clean.
 *
 * Writes only local refs under refs/heads/cut/ and never pushes. `<scratch>/report.json` holds the full result.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";
import { Glob } from "bun";
import { checkSubject } from "./commit-scopes";
import { loadTable } from "./layer-cut-tables/load";
import type { CutBranch, DerivedFile } from "./layer-cut-tables/types";

const table = await loadTable(process.argv.slice(2));
const CUT = table.branches;
const KEEP_AT_BASE = table.keepAtBase;
const MIN_FILES = 50;
const MAX_FILES = 90;
const MAX_TYPECHECK_ROUNDS = 10;
const TEST_FILE = /\.test\.tsx?$/;
const STAYS = new Set(CUT.flatMap((branch) => branch.stays ?? []));
/** Files a layer builds in its own form (part registration); the tracer never moves them. */
const DERIVED = new Set(CUT.flatMap((branch) => (branch.derived ?? []).map((derived) => derived.file)));
/** How many re-export hops the error tracer follows from a failing file's imports. */
const IMPORT_DEPTH = 3;
const CUT_REF_PREFIX = table.refPrefix;
const ZERO_SHA = "0000000000000000000000000000000000000000";

interface Options {
    unified: string;
    /** The unified branch's own PR head, which is never an exclusion source. */
    unifiedBranch: string;
    base: string;
    master: string;
    scratch: string;
    planOnly: boolean;
    checksOnly: boolean;
    /** --only: run the checks of this branch only. */
    only: string | null;
    typecheck: boolean;
    tests: boolean;
    swift: boolean;
    json: string | null;
}

interface Commit {
    sha: string;
    subject: string;
    scopes: string[];
    files: string[];
}

interface Move {
    file: string;
    from: string;
    to: string;
    reason: string;
}

interface OpenPr {
    number: number;
    ref: string;
}

interface TsError {
    file: string;
    /** 1-based line of the error in `file`, 0 for a global error. */
    lineNo: number;
    code: string;
    message: string;
    line: string;
}

interface TypecheckResult {
    ok: boolean;
    rounds: number;
    errorCount: number;
    knownErrors: string[];
    newErrors: string[];
}

interface RunResult {
    ok: boolean;
    exitCode: number;
    summary: string;
    log: string;
}

interface BranchReport {
    name: string;
    ref: string;
    commit: string | null;
    parent: string;
    subject: string;
    subjectProblems: string[];
    files: number;
    added: number;
    modified: number;
    deleted: number;
    moves: Move[];
    sizeWarning: string | null;
    typecheck: TypecheckResult | null;
    tests: (RunResult & { folders: string[] }) | null;
    swift: RunResult | null;
}

// ─── git ─────────────────────────────────────────────────────────────────────

function git(args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string } = {}): string {
    const proc = Bun.spawnSync(["git", ...args], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        stdin: opts.input !== undefined ? Buffer.from(opts.input) : undefined,
        stdout: "pipe",
        stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
        throw new Error(`git ${args.slice(0, 4).join(" ")}: ${proc.stderr.toString().trim()}`);
    }

    return proc.stdout.toString();
}

function revParse(ref: string): string {
    return git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

/** `git log -p <revs> | git patch-id --stable`, as commit → patch id. */
async function patchIds(revs: string[]): Promise<Map<string, string>> {
    const log = Bun.spawn(["git", "log", "-p", "--no-merges", "--no-color", ...revs], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const pid = Bun.spawn(["git", "patch-id", "--stable"], { stdin: log.stdout, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(pid.stdout).text();
    const [logExit, pidExit] = await Promise.all([log.exited, pid.exited]);
    if (logExit !== 0 || pidExit !== 0) {
        throw new Error(`patch-id over ${revs.join(" ")} failed: ${await new Response(log.stderr).text()}`);
    }

    const ids = new Map<string, string>();
    for (const line of text.split("\n")) {
        const [id, sha] = line.split(" ");
        if (id && sha) {
            ids.set(sha, id);
        }
    }

    return ids;
}

function parseScopes(subject: string): string[] {
    const match = /^[a-z]+!?\(([^)]*)\)!?:/.exec(subject);
    if (!match) {
        return [];
    }

    return match[1]
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
}

function readCommits(revs: string[]): Commit[] {
    const raw = git(["log", "--no-merges", "--no-renames", "--format=%x1e%H%x1f%s", "--name-only", ...revs]);
    const commits: Commit[] = [];
    for (const chunk of raw.split("\x1e")) {
        if (!chunk.trim()) {
            continue;
        }

        const [head, ...rest] = chunk.split("\n");
        const [sha, subject] = head.split("\x1f");
        const files = rest.map((line) => line.trim()).filter(Boolean);
        commits.push({ sha, subject, scopes: parseScopes(subject), files });
    }

    return commits;
}

/**
 * The head refs of every open PR except the unified branch's own, as `origin/<head>`. A head that is an ancestor of
 * unified is the unified PR under another name and is skipped too: its subjects would exclude every commit.
 */
function openPrRefs(unifiedBranch: string, unifiedSha: string): OpenPr[] {
    const proc = Bun.spawnSync(
        [
            "gh",
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "200",
            "--json",
            "number,headRefName",
            "--jq",
            ".[] | [.number, .headRefName] | @tsv",
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    if (proc.exitCode !== 0) {
        throw new Error(`gh pr list: ${proc.stderr.toString().trim()}`);
    }

    const refs: OpenPr[] = [];
    for (const line of proc.stdout.toString().split("\n").filter(Boolean)) {
        const [number, head] = line.split("\t");
        if (head === unifiedBranch) {
            continue;
        }

        const ref = `origin/${head}`;
        const exists = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], { stdout: "pipe" }).exitCode;
        if (exists !== 0) {
            process.stderr.write(`! ${ref} is not fetched; its commits are not excluded (git fetch origin ${head})\n`);
            continue;
        }

        const ancestor = Bun.spawnSync(["git", "merge-base", "--is-ancestor", ref, unifiedSha]).exitCode === 0;
        if (ancestor) {
            process.stderr.write(`! ${ref} is an ancestor of unified; not used as an open PR\n`);
            continue;
        }

        refs.push({ number: Number(number), ref });
    }

    if (refs.length === 0) {
        throw new Error("gh pr list gave no usable open PR; without them no commit is excluded");
    }

    return refs;
}

/** Files that an open PR outside the base's own stack changes, as file → PR numbers. */
function outsidePrFiles(prs: OpenPr[], master: string, baseSha: string): Map<string, number[]> {
    const files = new Map<string, number[]>();
    for (const pr of prs) {
        if (Bun.spawnSync(["git", "merge-base", "--is-ancestor", pr.ref, baseSha]).exitCode === 0) {
            continue;
        }

        for (const file of git(["diff", "--name-only", "--no-renames", `${master}...${pr.ref}`]).split("\n")) {
            if (file) {
                files.set(file, [...(files.get(file) ?? []), pr.number]);
            }
        }
    }

    return files;
}

// ─── assignment ──────────────────────────────────────────────────────────────

const globCache = new Map<string, Glob>();

function globMatch(pattern: string, file: string): boolean {
    let glob = globCache.get(pattern);
    if (!glob) {
        glob = new Glob(pattern);
        globCache.set(pattern, glob);
    }

    return glob.match(file);
}

/** The length of the literal prefix of the branch's best matching glob, or -1 when none matches or one excludes. */
function globScore(branch: CutBranch, file: string): number {
    let best = -1;
    for (const pattern of branch.globs) {
        if (pattern.startsWith("!")) {
            if (globMatch(pattern.slice(1), file)) {
                return -1;
            }

            continue;
        }

        if (globMatch(pattern, file)) {
            const literal = pattern.split(/[*?[{]/)[0].length;
            best = Math.max(best, literal);
        }
    }

    return best;
}

interface Assignment {
    /** file → branch name */
    owner: Map<string, string>;
    unplaced: string[];
    selectedCommits: number;
    excludedOnOpenPr: number;
}

function assignFiles(commits: Commit[], differing: Set<string>, onOpenPr: (commit: Commit) => boolean): Assignment {
    const allScopes = new Set(CUT.flatMap((branch) => branch.scopes));
    const touching = new Map<string, Commit[]>();
    let selectedCommits = 0;
    let excludedOnOpenPr = 0;
    for (const commit of commits) {
        if (!commit.scopes.some((scope) => allScopes.has(scope))) {
            continue;
        }

        if (onOpenPr(commit)) {
            excludedOnOpenPr++;
            continue;
        }

        selectedCommits++;
        for (const file of commit.files) {
            if (!differing.has(file)) {
                continue;
            }

            const list = touching.get(file) ?? [];
            list.push(commit);
            touching.set(file, list);
        }
    }

    const derivedFiles = new Set(CUT.flatMap((branch) => (branch.derived ?? []).map((derived) => derived.file)));
    const owner = new Map<string, string>();
    const unplaced: string[] = [];
    for (const [file, fileCommits] of [...touching].sort(([a], [b]) => a.localeCompare(b))) {
        if (derivedFiles.has(file) || KEEP_AT_BASE[file]) {
            continue;
        }

        const stayer = CUT.find((branch) => branch.stays?.includes(file));
        if (stayer) {
            owner.set(file, stayer.name);
            continue;
        }

        let bestBranch: CutBranch | null = null;
        let bestScore = -1;
        for (const branch of CUT) {
            const scoped = fileCommits.filter((commit) => commit.scopes.some((scope) => branch.scopes.includes(scope)));
            if (scoped.length === 0) {
                continue;
            }

            let score = globScore(branch, file);
            if (score < 0) {
                continue;
            }

            if (branch.commits) {
                const patterns = branch.commits;
                if (!scoped.every((commit) => patterns.some((pattern) => pattern.test(commit.subject)))) {
                    continue;
                }

                score += 1_000_000;
            }

            if (score > bestScore) {
                bestScore = score;
                bestBranch = branch;
            }
        }

        if (bestBranch) {
            owner.set(file, bestBranch.name);
        } else {
            unplaced.push(file);
        }
    }

    for (const branch of CUT) {
        for (const file of [...differing].sort()) {
            if (owner.has(file) || derivedFiles.has(file) || KEEP_AT_BASE[file]) {
                continue;
            }

            if ((branch.sweep ?? []).some((pattern) => globMatch(pattern, file))) {
                owner.set(file, branch.name);
            }
        }
    }

    const placed = new Set(owner.keys());
    return { owner, unplaced: unplaced.filter((file) => !placed.has(file)), selectedCommits, excludedOnOpenPr };
}

// ─── the branch graph ────────────────────────────────────────────────────────

function branchByName(name: string): CutBranch {
    const branch = CUT.find((candidate) => candidate.name === name);
    if (!branch) {
        throw new Error(`no cut branch named ${name}`);
    }

    return branch;
}

/** The branch and its cut ancestors, nearest first. */
function lineage(name: string): string[] {
    const chain: string[] = [];
    let current: string | null = name;
    while (current) {
        chain.push(current);
        current = branchByName(current).parent;
    }

    return chain;
}

/** The nearest branch that is an ancestor-or-self of both, or null when they share only the base. */
function nearestCommon(a: string, b: string): string | null {
    const ofB = new Set(lineage(b));
    return lineage(a).find((name) => ofB.has(name)) ?? null;
}

// ─── trees ───────────────────────────────────────────────────────────────────

interface TreeEntry {
    mode: string;
    sha: string;
}

function readTree(ref: string): Map<string, TreeEntry> {
    const entries = new Map<string, TreeEntry>();
    for (const record of git(["ls-tree", "-r", "-z", "--full-tree", ref]).split("\0")) {
        if (!record) {
            continue;
        }

        const tab = record.indexOf("\t");
        const [mode, , sha] = record.slice(0, tab).split(" ");
        entries.set(record.slice(tab + 1), { mode, sha });
    }

    return entries;
}

function buildCommit(params: {
    parentCommit: string;
    files: string[];
    unifiedTree: Map<string, TreeEntry>;
    baseTree: Map<string, TreeEntry>;
    derived: readonly DerivedFile[];
    subject: string;
    indexFile: string;
    /** The unified head's commit date, so a rebuild of the same inputs gives the same SHAs. */
    date: string;
}): string {
    const env = { GIT_INDEX_FILE: params.indexFile };
    git(["read-tree", params.parentCommit], { env });
    const records = params.files.map((file) => {
        const entry = params.unifiedTree.get(file);
        return entry ? `${entry.mode} ${entry.sha}\t${file}` : `0 ${ZERO_SHA}\t${file}`;
    });
    for (const derivedFile of params.derived) {
        const from = derivedFile.from ?? "unified";
        const entry = (from === "base" ? params.baseTree : params.unifiedTree).get(derivedFile.file);
        if (!entry) {
            throw new Error(`${derivedFile.file} is derived from the ${from} tree, which has no such file`);
        }

        let text = git(["cat-file", "blob", entry.sha]);
        for (const [pattern, replacement] of derivedFile.edits) {
            if (!pattern.test(text)) {
                throw new Error(`${derivedFile.file}: the edit ${pattern} no longer matches the ${from} file`);
            }

            text = text.replace(pattern, replacement);
        }

        const sha = git(["hash-object", "-w", "--stdin"], { input: text }).trim();
        records.push(`${entry.mode} ${sha}\t${derivedFile.file}`);
    }

    if (records.length > 0) {
        git(["update-index", "-z", "--index-info"], { env, input: `${records.join("\0")}\0` });
    }

    const tree = git(["write-tree"], { env }).trim();
    const dates = { GIT_AUTHOR_DATE: params.date, GIT_COMMITTER_DATE: params.date };
    return git(["commit-tree", tree, "-p", params.parentCommit, "-m", params.subject], { env: dates }).trim();
}

// ─── imports ─────────────────────────────────────────────────────────────────

const IMPORT_RE =
    /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

const ALIASES: readonly [string, string][] = [
    ["@app/yt/", "src/youtube/ui/"],
    ["@genesiscz/utils/", "src/utils/"],
    ["@app/", "src/"],
    ["@ask/", "src/ask/"],
    ["@ui/", "src/utils/ui/"],
    ["@ext/", "src/youtube/extension/"],
];
const EXACT_ALIASES: Record<string, string> = {
    "@genesiscz/utils": "src/utils/index.ts",
    "@ui": "src/utils/ui/index.ts",
    "@app/yt": "src/youtube/ui/index.ts",
};

function resolveImport(from: string, spec: string, exists: (path: string) => boolean): string | null {
    let base: string | null = EXACT_ALIASES[spec] ?? null;
    if (!base && spec.startsWith(".")) {
        base = posix.normalize(posix.join(posix.dirname(from), spec));
    }

    if (!base) {
        const alias = ALIASES.find(([prefix]) => spec.startsWith(prefix));
        base = alias ? alias[1] + spec.slice(alias[0].length) : null;
    }

    if (!base) {
        return null;
    }

    const stem = base.replace(/\.(js|mjs)$/, "");
    const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, `${base}/index.ts`, `${base}/index.tsx`];
    return candidates.find(exists) ?? null;
}

const importCache = new Map<string, string[]>();

/** The repo files that unified's copy of `file` imports. */
const RE_EXPORT_RE = /(?:^|[\s;}])export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;

/** The repo files that unified's copy of `file` re-exports (`export … from`): the hops of a barrel such as index.ts. */
function reExportsOf(file: string, unified: string, exists: (path: string) => boolean): string[] {
    let text = "";
    try {
        text = git(["show", `${unified}:${file}`]);
    } catch {
        return [];
    }

    const targets = new Set<string>();
    for (const match of text.matchAll(RE_EXPORT_RE)) {
        const target = resolveImport(file, match[1], exists);
        if (target) {
            targets.add(target);
        }
    }

    return [...targets];
}

function importsOf(file: string, unified: string, exists: (path: string) => boolean): string[] {
    const cached = importCache.get(file);
    if (cached) {
        return cached;
    }

    let text = "";
    try {
        text = git(["show", `${unified}:${file}`]);
    } catch {
        text = "";
    }

    const targets = new Set<string>();
    for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2] ?? match[3];
        const target = spec ? resolveImport(file, spec, exists) : null;
        if (target) {
            targets.add(target);
        }
    }

    const list = [...targets];
    importCache.set(file, list);
    return list;
}

const BINDING_RE = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

/** The modules whose imported names appear on an error's line or the few lines above it (a call split over lines). */
function bindingTargets(params: {
    file: string;
    lineNo: number;
    message: string;
    unified: string;
    exists: (path: string) => boolean;
}): string[] {
    let text = "";
    try {
        text = git(["show", `${params.unified}:${params.file}`]);
    } catch {
        return [];
    }

    const local = new Map<string, string>();
    for (const match of text.matchAll(BINDING_RE)) {
        const target = resolveImport(params.file, match[2], params.exists);
        if (!target) {
            continue;
        }

        const clause = match[1].replace(/[{}]/g, " ").replace(/\btype\s+/g, " ");
        for (const part of clause.split(",")) {
            const names = part.trim().split(/\s+as\s+|\s+/);
            const name = names[names.length - 1]?.replace(/^\*$/, "");
            if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
                local.set(name, target);
            }
        }
    }

    const lines = text.split("\n").slice(Math.max(0, params.lineNo - 5), params.lineNo);
    const window = `${lines.join("\n")}\n${params.message}`;
    const targets = new Set<string>();
    for (const token of window.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        const target = local.get(token);
        if (target) {
            targets.add(target);
        }
    }

    return [...targets];
}

// ─── checks in the scratch worktree ──────────────────────────────────────────

const TS_ERROR_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const TS_GLOBAL_RE = /^error (TS\d+): (.*)$/;

function errorKey(error: TsError): string {
    return `${error.file}|${error.code}|${error.message}`;
}

async function run(params: { cmd: string[]; cwd: string; log: string }): Promise<{ exitCode: number; text: string }> {
    const proc = Bun.spawn(params.cmd, { cwd: params.cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    const text = `${stdout}${stderr}`;
    writeFileSync(params.log, `$ ${params.cmd.join(" ")}\n${text}\nexit ${exitCode}\n`);
    return { exitCode, text };
}

/** Project configs that own selected files; paths stay relative to the repository for the mover. */
export function checkProjects(files: string[], tree: Map<string, TreeEntry>): string[] {
    const configs = new Set<string>(tree.has("tsconfig.json") ? ["tsconfig.json"] : []);
    for (const file of files) {
        let dir = dirname(file);
        while (dir !== ".") {
            const config = `${dir}/tsconfig.json`;
            if (tree.has(config) && tree.has(`${dir}/package.json`)) {
                configs.add(config);
                break;
            }

            dir = dirname(dir);
        }
    }

    return [...configs].sort();
}

export class ScratchTree {
    private lockStamp: string | null = null;

    constructor(
        readonly dir: string,
        private readonly logDir: string,
        private readonly files: string[] = []
    ) {}

    ensure(startCommit: string): void {
        if (!existsSync(this.dir)) {
            git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", this.dir, startCommit]);
            writeFileSync(this.markerPath(), this.identity());
        }

        this.assertOwnedClean();
    }

    private markerPath(): string {
        return git(["rev-parse", "--path-format=absolute", "--git-path", "layer-cut-owner"], { cwd: this.dir }).trim();
    }

    private identity(): string {
        const common = realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
        return `${realpathSync(this.dir)}\n${common}\n`;
    }

    private assertOwnedClean(): void {
        const top = realpathSync(git(["rev-parse", "--show-toplevel"], { cwd: this.dir }).trim());
        const common = realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: this.dir }).trim());
        const marker = this.markerPath();
        if (top !== realpathSync(this.dir) || !existsSync(marker) ||
            readFileSync(marker, "utf8") !== this.identity() || !this.identity().endsWith(`\n${common}\n`)) {
            throw new Error(`refusing unowned scratch tree: ${this.dir}`);
        }

        if (git(["status", "--porcelain", "--untracked-files=normal"], { cwd: this.dir }).trim()) {
            throw new Error(`refusing dirty scratch tree: ${this.dir}`);
        }
    }

    async checkout(commit: string): Promise<void> {
        this.assertOwnedClean();
        git(["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "--quiet", commit], {
            cwd: this.dir,
        });
        const stamp = git(["rev-parse", `${commit}:bun.lock`]).trim();
        if (stamp === this.lockStamp && existsSync(join(this.dir, "node_modules"))) {
            return;
        }

        const install = await run({
            cmd: ["bun", "install", "--ignore-scripts", "--frozen-lockfile"],
            cwd: this.dir,
            log: join(this.logDir, `bun-install-${commit.slice(0, 10)}.log`),
        });
        if (install.exitCode !== 0) {
            throw new Error(`bun install failed in ${this.dir}: ${install.text.slice(-400)}`);
        }

        this.lockStamp = stamp;
    }

    async typecheck(label: string): Promise<TsError[]> {
        const tree = readTree(git(["rev-parse", "HEAD"], { cwd: this.dir }).trim());
        const results = [];
        for (const config of checkProjects(this.files, tree)) {
            results.push(await run({
                cmd: ["tsc-rs", "--noEmit", "-p", config],
                cwd: this.dir,
                log: join(this.logDir, `tsc-${label}-${config.replaceAll("/", "_")}.log`),
            }));
        }

        const result = { text: results.map((r) => r.text).join("\n"), exitCode: results.find((r) => r.exitCode !== 0)?.exitCode ?? 0 };
        const errors: TsError[] = [];
        for (const line of result.text.split("\n")) {
            const located = TS_ERROR_RE.exec(line);
            if (located) {
                errors.push({
                    file: located[1],
                    lineNo: Number(located[2]),
                    code: located[4],
                    message: located[5],
                    line,
                });
                continue;
            }

            const global = TS_GLOBAL_RE.exec(line);
            if (global) {
                errors.push({ file: "", lineNo: 0, code: global[1], message: global[2], line });
            }
        }

        if (result.exitCode !== 0 && errors.length === 0) {
            throw new Error(
                `tsc-rs exited ${result.exitCode} without a parsable error (${label}): ${result.text.slice(-400)}`
            );
        }

        return errors;
    }
}

/** The repo folders whose tests cover a branch's files: `src/<tool>`, `src/utils/<pkg>`, or the file's own folder. */
export function testFolders(files: string[], tree: Map<string, TreeEntry>): string[] {
    const folders = new Set<string>();
    for (const file of files) {
        if (!tree.has(file) || !/\.(ts|tsx)$/.test(file)) {
            continue;
        }

        const parts = file.split("/");
        let folder: string;
        if (parts[0] === "src" && parts[1] === "utils" && parts.length > 3) {
            folder = parts.slice(0, 3).join("/");
        } else if (parts[0] === "src" && parts.length > 2) {
            folder = parts.slice(0, 2).join("/");
        } else {
            folder = dirname(file);
        }

        folders.add(folder);
    }

    const testFiles = [...tree.keys()].filter((file) => /\.test\.tsx?$/.test(file));
    return [...folders].filter((folder) => testFiles.some((file) => file.startsWith(`${folder}/`))).sort();
}

function summarizeTests(text: string): string {
    const pass = /^\s*(\d+) pass/m.exec(text)?.[1] ?? "?";
    const fail = /^\s*(\d+) fail/m.exec(text)?.[1] ?? "?";
    const ran = /Ran (\d+) tests? across (\d+) files?/.exec(text);
    const marker = text.includes("suite STALLED") ? " STALLED" : "";
    return `${pass} pass, ${fail} fail${ran ? `, ${ran[1]} tests in ${ran[2]} files` : ""}${marker}`;
}

// ─── reports ─────────────────────────────────────────────────────────────────

function folderCounts(files: string[]): string {
    const folders = new Map<string, number>();
    for (const file of files) {
        const parts = file.split("/");
        const folder = parts.slice(0, Math.min(3, parts.length - 1)).join("/");
        folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }

    return [...folders]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([folder, count]) => `${folder} ${count}`)
        .join(", ");
}

/** A proposal for a branch outside MIN_FILES..MAX_FILES: split it by folder, or merge it with a neighbour that fits. */
function sizeWarning(name: string, filesOf: (name: string) => string[]): string | null {
    const files = filesOf(name);
    if (files.length >= MIN_FILES && files.length <= MAX_FILES) {
        return null;
    }

    if (files.length > MAX_FILES) {
        return `${files.length} files, over ${MAX_FILES}: split by folder (${folderCounts(files)})`;
    }

    const branch = branchByName(name);
    const neighbours = [branch.parent, ...CUT.filter((other) => other.parent === name).map((other) => other.name)];
    const options = neighbours
        .filter((other): other is string => other !== null)
        .map((other) => ({ other, total: files.length + filesOf(other).length }));
    const fits = options.filter(({ total }) => total <= MAX_FILES);
    if (fits.length > 0) {
        const list = fits.map(({ other, total }) => `${other} (${total} files together)`).join(" or ");
        return `${files.length} files, under ${MIN_FILES}: merge with ${list}`;
    }

    const parent = branch.parent
        ? `; or move a folder in from ${branch.parent} (${folderCounts(filesOf(branch.parent))})`
        : "";
    const sizes = options.map(({ other, total }) => `${other} ${total}`).join(", ");
    return `${files.length} files, under ${MIN_FILES}: no merge fits under ${MAX_FILES} (${sizes})${parent}`;
}

function parseOptions(argv: string[]): Options {
    const options: Options = {
        ...table.defaults,
        master: "origin/master",
        scratch: "",
        planOnly: false,
        checksOnly: false,
        only: null,
        typecheck: true,
        tests: false,
        swift: false,
        json: null,
    };
    const valueFlags: Record<string, "unified" | "unifiedBranch" | "base" | "master" | "scratch" | "json" | "only"> = {
        "--unified": "unified",
        "--unified-branch": "unifiedBranch",
        "--base": "base",
        "--master": "master",
        "--scratch": "scratch",
        "--json": "json",
        "--only": "only",
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--table") {
            i++;
            continue;
        }

        const key = valueFlags[arg];
        if (key) {
            options[key] = argv[++i] ?? "";
        } else if (arg === "--plan-only") {
            options.planOnly = true;
        } else if (arg === "--checks-only") {
            options.checksOnly = true;
        } else if (arg === "--no-typecheck") {
            options.typecheck = false;
        } else if (arg === "--tests") {
            options.tests = true;
        } else if (arg === "--swift") {
            options.swift = true;
        } else {
            throw new Error(`unknown argument ${arg}`);
        }
    }

    if (!options.scratch) {
        throw new Error("--scratch <dir> is required (use your session's /tmp/cc/<project>/<session>/ folder)");
    }

    return options;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
    const options = parseOptions(process.argv.slice(2));
    if (options.checksOnly) {
        return checksOnly(options);
    }

    const logDir = join(options.scratch, "logs");
    mkdirSync(logDir, { recursive: true });
    const say = (line: string): void => {
        process.stderr.write(`${line}\n`);
    };

    const unifiedSha = revParse(options.unified);
    const baseSha = revParse(options.base);
    say(`unified ${options.unified} ${unifiedSha.slice(0, 10)} · base ${options.base} ${baseSha.slice(0, 10)}`);

    const statuses = new Map<string, string>();
    for (const line of git(["diff", "--name-status", "--no-renames", baseSha, unifiedSha]).split("\n")) {
        const [status, file] = line.split("\t");
        if (status && file) {
            statuses.set(file, status);
        }
    }

    const commits = table.selection === "diff" ? [] : readCommits([`^${options.master}`, unifiedSha]);
    const openPrs = table.selection === "diff" ? [] : openPrRefs(options.unifiedBranch, unifiedSha);
    const prRefs = openPrs.map((pr) => pr.ref);
    const prRevs = [`^${options.master}`, ...prRefs];
    const outside = outsidePrFiles(openPrs, options.master, baseSha);
    const prSubjects = new Set(table.selection === "diff" ? [] : readCommits(prRevs).map((commit) => commit.subject));
    const [unifiedPatchIds, prPatchIds] =
        table.selection === "diff"
            ? [new Map(), new Map()]
            : await Promise.all([patchIds([`^${options.master}`, unifiedSha]), patchIds(prRevs)]);
    const prPatchSet = new Set(prPatchIds.values());
    const onOpenPr = (commit: Commit): boolean => {
        const id = unifiedPatchIds.get(commit.sha);
        return prSubjects.has(commit.subject) || (id !== undefined && prPatchSet.has(id));
    };

    const assignment = assignFiles(commits, new Set(statuses.keys()), onOpenPr);
    const { owner } = assignment;
    if (table.selection === "diff" && owner.size !== statuses.size) {
        const missing = [...statuses.keys()].filter((file) => !owner.has(file));
        throw new Error(`diff table must place every changed path: ${missing.join(", ")}`);
    }
    say(
        `${commits.length} commits off master · ${assignment.excludedOnOpenPr} in scope but on an open PR (${prRefs.length} PRs) · ` +
            `${assignment.selectedCommits} selected · ${owner.size} files placed · ${assignment.unplaced.length} unplaced`
    );

    const unifiedTree = readTree(unifiedSha);
    const unifiedDate = git(["show", "-s", "--format=%cI", unifiedSha]).trim();
    const baseTree = readTree(baseSha);
    const exists = (path: string): boolean => unifiedTree.has(path) || baseTree.has(path);
    const moves = new Map<string, Move[]>(CUT.map((branch) => [branch.name, []]));
    const filesOf = (name: string): string[] =>
        [...owner]
            .filter(([, branch]) => branch === name)
            .map(([file]) => file)
            .sort();

    /** Files kept at their base form because their unified form needs a file another open PR owns. */
    const pinned = new Map<string, string>();
    const commitsBuilt = new Map<string, string>();
    const typechecks = new Map<string, TypecheckResult>();
    const subjects = new Map<string, { subject: string; problems: string[] }>();
    const build = (branch: CutBranch): string => {
        const parentCommit = branch.parent ? commitsBuilt.get(branch.parent) : baseSha;
        if (!parentCommit) {
            throw new Error(`${branch.name} is built before its parent ${branch.parent}`);
        }

        const files = filesOf(branch.name);
        const check = checkSubject(branch.subject, [...files, ...(branch.derived ?? []).map((d) => d.file)]);
        subjects.set(branch.name, { subject: check.subject, problems: check.problems });
        const commit = buildCommit({
            parentCommit,
            files,
            unifiedTree,
            baseTree,
            derived: branch.derived ?? [],
            subject: check.subject,
            date: unifiedDate,
            indexFile: join(options.scratch, `index-${CUT.indexOf(branch)}`),
        });
        commitsBuilt.set(branch.name, commit);
        return commit;
    };

    if (!options.planOnly) {
        const scratchTree = new ScratchTree(join(options.scratch, "tree"), logDir, [...owner.keys()]);
        let known = new Set<string>();
        if (options.typecheck) {
            scratchTree.ensure(baseSha);
            for (const [label, sha] of [
                ["base", baseSha],
                ["unified", unifiedSha],
            ] as const) {
                await scratchTree.checkout(sha);
                const errors = await scratchTree.typecheck(label);
                say(
                    `typecheck ${label}: ${errors.length} errors (${[...new Set(errors.map((e) => e.code))].join(", ") || "none"})`
                );
                known = new Set([...known, ...errors.map(errorKey)]);
            }
        }

        let index = 0;
        let restarts = 0;
        while (index < CUT.length) {
            const branch = CUT[index];
            let restartAt: number | null = null;
            let rounds = 0;
            let result: TypecheckResult | null = null;
            while (options.typecheck) {
                rounds++;
                const commit = build(branch);
                await scratchTree.checkout(commit);
                const errors = await scratchTree.typecheck(`${index + 1}-${rounds}`);
                const fresh = errors.filter((error) => !known.has(errorKey(error)));
                result = {
                    ok: fresh.length === 0,
                    rounds,
                    errorCount: errors.length,
                    knownErrors: [...new Set(errors.filter((e) => known.has(errorKey(e))).map((e) => e.code))],
                    newErrors: fresh.map((error) => error.line),
                };
                say(`  ${branch.name} round ${rounds}: ${errors.length} errors, ${fresh.length} new`);
                if (fresh.length === 0 || rounds >= MAX_TYPECHECK_ROUNDS) {
                    break;
                }

                const ancestry = new Set(lineage(branch.name));
                const movedNow = new Map<string, Move>();
                const pinnedBefore = pinned.size;
                const outsideNote = (file: string): string => {
                    const prs = !owner.has(file) ? outside.get(file) : undefined;
                    return prs ? ` (also changed by PR #${prs.join(", #")})` : "";
                };
                /** A file that belongs to a cut branch outside this branch's lineage. */
                const inLaterBranch = (file: string): boolean => {
                    const current = owner.get(file);
                    return current !== undefined && !ancestry.has(current);
                };
                /** A precise target may also come from no branch, as long as it differs and is not kept at base. */
                const preciseMovable = (file: string): boolean =>
                    !pinned.has(file) &&
                    !DERIVED.has(file) &&
                    (inLaterBranch(file) || (!owner.has(file) && statuses.has(file)));
                /** Puts a file the cut placed back to its base form, because its new form needs another PR's change. */
                const keepAtBase = (file: string, why: string): void => {
                    const current = owner.get(file);
                    if (!current || movedNow.has(file)) {
                        return;
                    }

                    const move: Move = { file, from: current, to: "(base form)", reason: why };
                    movedNow.set(file, move);
                    owner.delete(file);
                    pinned.set(file, why);
                    moves.get(current)?.push(move);
                    const currentIndex = CUT.findIndex((candidate) => candidate.name === current);
                    if (currentIndex < index) {
                        restartAt = Math.min(restartAt ?? currentIndex, currentIndex);
                    }
                };
                /**
                 * A test follows only when everything else it imports is already there (in the target's lineage, or
                 * unchanged since the base): a broad test such as meetings.test.ts would drag its whole folder down.
                 */
                const testFitsIn = (test: string, target: string): boolean => {
                    const there = new Set(lineage(target));
                    return importsOf(test, unifiedSha, exists).every((imported) => {
                        const importedOwner = owner.get(imported);
                        return importedOwner ? there.has(importedOwner) : !statuses.has(imported);
                    });
                };
                const moveDown = (file: string, why: string): void => {
                    if (movedNow.has(file) || pinned.has(file) || STAYS.has(file) || DERIVED.has(file)) {
                        return;
                    }

                    const current = owner.get(file) ?? null;
                    if (current && ancestry.has(current)) {
                        return;
                    }

                    if (!current && !statuses.has(file)) {
                        return;
                    }

                    const target = current ? (nearestCommon(branch.name, current) ?? branch.name) : branch.name;
                    const move: Move = {
                        file,
                        from: current ?? "(no branch)",
                        to: target,
                        reason: why + outsideNote(file),
                    };
                    movedNow.set(file, move);
                    owner.set(file, target);
                    moves.get(target)?.push(move);
                    const targetIndex = CUT.findIndex((candidate) => candidate.name === target);
                    if (targetIndex < index) {
                        restartAt = Math.min(restartAt ?? targetIndex, targetIndex);
                    }

                    // A test of the moved file comes with it: left behind, it tests the old code against the new one,
                    // which typechecks but fails at run time (a config test and its migration, 2026-11-05).
                    for (const [test, testOwner] of [...owner]) {
                        if (
                            TEST_FILE.test(test) &&
                            !STAYS.has(test) &&
                            testOwner !== target &&
                            !lineage(target).includes(testOwner) &&
                            importsOf(test, unifiedSha, exists).includes(file) &&
                            testFitsIn(test, target)
                        ) {
                            const testMove: Move = {
                                file: test,
                                from: testOwner,
                                to: target,
                                reason: `the test of ${file}, which moved to ${target}`,
                            };
                            movedNow.set(test, testMove);
                            owner.set(test, target);
                            moves.get(target)?.push(testMove);
                        }
                    }
                };

                for (const error of fresh) {
                    if (!error.file) {
                        continue;
                    }

                    const why = `${branch.name.split("/").pop()} ${error.code} in ${error.file}: ${error.message.slice(0, 140)}`;
                    const current = owner.get(error.file);
                    const atUnifiedForm = (current && ancestry.has(current)) || !statuses.has(error.file);
                    if (!atUnifiedForm) {
                        moveDown(error.file, why);
                        continue;
                    }

                    // Precise targets: the module the message names, else the imports used on the failing lines.
                    const named = /['"]([@.][^'"]+)['"]/.exec(error.message)?.[1];
                    const namedTarget = named ? resolveImport(error.file, named, exists) : null;
                    const precise = namedTarget
                        ? [namedTarget]
                        : bindingTargets({
                              file: error.file,
                              lineNo: error.lineNo,
                              message: error.message,
                              unified: unifiedSha,
                              exists,
                          });
                    const ownPrs = new Set(outside.get(error.file) ?? []);
                    const pinnedNeed = precise.find((file) => pinned.has(file));
                    const samePrNeed = precise.find(
                        (file) => !owner.has(file) && (outside.get(file) ?? []).some((pr) => ownPrs.has(pr))
                    );
                    if (current && (pinnedNeed || samePrNeed)) {
                        // The file's unified form is that PR's work (or needs a file kept at base): keep its base form.
                        const need = pinnedNeed
                            ? `${pinnedNeed}, which is kept at base form`
                            : `${samePrNeed}${outsideNote(samePrNeed ?? "")}, and this file is that PR's change too`;
                        keepAtBase(error.file, `${why}; its unified form needs ${need}`);
                        continue;
                    }

                    const preciseMoves = precise.filter(preciseMovable);
                    if (preciseMoves.length > 0) {
                        for (const target of preciseMoves) {
                            moveDown(target, why);
                        }

                        continue;
                    }

                    // Imprecise: every import, then through re-exports (a barrel index.ts), up to IMPORT_DEPTH hops.
                    // Only files of a later cut branch move this way, never a file of no branch.
                    const seen = new Set<string>([error.file]);
                    let frontier = precise.length > 0 ? precise : importsOf(error.file, unifiedSha, exists);
                    for (let depth = 0; depth < IMPORT_DEPTH && frontier.length > 0; depth++) {
                        const movable = frontier.filter((file) => !pinned.has(file) && inLaterBranch(file));
                        if (movable.length > 0) {
                            for (const target of movable) {
                                moveDown(
                                    target,
                                    depth === 0 ? `${why} (an import)` : `${why} (${depth} re-export hop)`
                                );
                            }

                            break;
                        }

                        for (const file of frontier) {
                            seen.add(file);
                        }

                        frontier = [
                            ...new Set(frontier.flatMap((file) => reExportsOf(file, unifiedSha, exists))),
                        ].filter((file) => !seen.has(file));
                    }
                }

                if (movedNow.size === 0 && pinned.size === pinnedBefore) {
                    say(`  ${branch.name}: ${fresh.length} new errors trace to no movable file; stopping`);
                    break;
                }

                if (restartAt !== null) {
                    break;
                }
            }

            if (!options.typecheck) {
                build(branch);
            }

            if (restartAt !== null) {
                restarts++;
                if (restarts > CUT.length * 2) {
                    throw new Error("the cut keeps moving files into earlier branches; check the CUT table");
                }

                say(`  a file moved into ${CUT[restartAt].name}; rebuilding from there`);
                index = restartAt;
                continue;
            }

            if (result) {
                typechecks.set(branch.name, result);
            }

            index++;
        }

        for (const branch of CUT) {
            const ref = `${CUT_REF_PREFIX}${branch.name}`;
            const commit = commitsBuilt.get(branch.name);
            if (!ref.startsWith(CUT_REF_PREFIX) || !commit) {
                throw new Error(`refusing to write ${ref}`);
            }

            git(["update-ref", ref, commit]);
        }

        // Ref names do not prove table ownership. Retain obsolete refs for explicit manual cleanup.

        const checks = await runChecks({
            options,
            scratchTree,
            logDir,
            baseSha,
            branches: CUT.map((branch) => ({
                branch,
                commit: commitsBuilt.get(branch.name) ?? null,
                files: filesOf(branch.name),
            })),
        });
        const testResults = checks.tests;
        const swiftResults = checks.swift;

        return finish({
            options,
            owner,
            moves,
            typechecks,
            subjects,
            commitsBuilt,
            testResults,
            swiftResults,
            assignment,
            statuses,
        });
    }

    return finish({
        options,
        owner,
        moves,
        typechecks,
        subjects,
        commitsBuilt,
        testResults: new Map(),
        swiftResults: new Map(),
        assignment,
        statuses,
    });
}

interface Checks {
    tests: Map<string, RunResult & { folders: string[] }>;
    swift: Map<string, RunResult>;
}

/** Runs each branch's folder tests (--tests) and one app swift build per Swift branch (--swift), one tree at a time. */
async function runChecks(params: {
    options: Options;
    scratchTree: ScratchTree;
    logDir: string;
    baseSha: string;
    branches: { branch: CutBranch; commit: string | null; files: string[] }[];
}): Promise<Checks> {
    const { options, scratchTree, logDir } = params;
    const checks: Checks = { tests: new Map(), swift: new Map() };
    const say = (line: string): void => {
        process.stderr.write(`${line}\n`);
    };
    if (!options.tests && !options.swift) {
        return checks;
    }

    scratchTree.ensure(params.baseSha);
    for (const [position, { branch, commit, files }] of params.branches.entries()) {
        if (!commit || (!options.tests && !(options.swift && branch.swift))) {
            continue;
        }

        if (options.only && branch.name !== options.only) {
            continue;
        }

        await scratchTree.checkout(commit);
        const folders = testFolders(files, readTree(commit));
        const log = join(logDir, `tests-${position + 1}.log`);
        if (options.tests && folders.length === 0) {
            // `bun scripts/test.ts` with no path runs the whole suite, which this must never start.
            checks.tests.set(branch.name, {
                ok: true,
                exitCode: 0,
                summary: "no TypeScript test folder",
                log,
                folders,
            });
            say(`  tests ${branch.name}: no TypeScript test folder, skipped`);
        }

        if (options.tests && folders.length > 0) {
            const tests = await run({ cmd: ["bun", "scripts/test.ts", ...folders], cwd: scratchTree.dir, log });
            const summary = summarizeTests(tests.text);
            checks.tests.set(branch.name, {
                ok: tests.exitCode === 0,
                exitCode: tests.exitCode,
                summary,
                log,
                folders,
            });
            say(`  tests ${branch.name}: ${summary} (exit ${tests.exitCode})`);
        }

        if (options.swift && branch.swift) {
            const log = join(logDir, `swift-${position + 1}.log`);
            const slot = join(revParseMainCheckout(), ".claude/skills/babysit/scripts/swift-slot.ts");
            const swift = await run({
                cmd: [
                    "bun",
                    slot,
                    "--",
                    "swift",
                    "build",
                    // The test target too: a test whose helper sat in a later layer passed a plain build (2026-11-05).
                    "--build-tests",
                    "--package-path",
                    "src/macos/GenesisTools",
                    "--disable-build-manifest-caching",
                ],
                cwd: scratchTree.dir,
                log,
            });
            const plain = stripAnsi(swift.text);
            const errors = new Set(plain.split("\n").filter((line) => /\.swift:\d+:\d+: error: /.test(line)));
            const summary = swift.exitCode === 0 ? "build ok" : `${errors.size} errors`;
            checks.swift.set(branch.name, { ok: swift.exitCode === 0, exitCode: swift.exitCode, summary, log });
            say(`  swift ${branch.name}: ${summary} (exit ${swift.exitCode})`);
        }
    }

    return checks;
}

/** --checks-only: the tests and Swift builds of the cut/ branches a previous run wrote, without building again. */
async function checksOnly(options: Options): Promise<number> {
    const reportPath = options.json ?? join(options.scratch, "report.json");
    const report: unknown = SafeJSON.parse(await Bun.file(reportPath).text());
    const listed = new Map<string, { commit: string; fileList: string[] }>();
    if (report && typeof report === "object" && "branches" in report && Array.isArray(report.branches)) {
        for (const entry of report.branches) {
            if (typeof entry?.name === "string" && typeof entry.commit === "string" && Array.isArray(entry.fileList)) {
                listed.set(entry.name, { commit: entry.commit, fileList: entry.fileList.map(String) });
            }
        }
    }

    const branches = CUT.map((branch) => {
        const entry = listed.get(branch.name);
        const commit = revParse(`${CUT_REF_PREFIX}${branch.name}`);
        if (!entry || entry.commit !== commit) {
            throw new Error(`cut/${branch.name} is ${commit.slice(0, 10)}, not the commit ${reportPath} lists`);
        }

        return { branch, commit, files: entry.fileList };
    });
    const logDir = join(options.scratch, "logs");
    const checks = await runChecks({
        options,
        scratchTree: new ScratchTree(join(options.scratch, "tree"), logDir, branches.flatMap((entry) => entry.files)),
        logDir,
        baseSha: revParse(options.base),
        branches,

    });
    const output = {
        tests: Object.fromEntries(checks.tests),
        swift: Object.fromEntries(checks.swift),
    };
    const checksPath = join(options.scratch, "checks.json");
    writeFileSync(checksPath, `${SafeJSON.stringify(output, null, 4)}\n`);
    process.stderr.write(`\nchecks: ${checksPath}\n`);
    const failed = [...checks.tests.values(), ...checks.swift.values()].some((result) => !result.ok);
    return failed ? 1 : 0;
}

function revParseMainCheckout(): string {
    const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    return dirname(common);
}

function finish(state: {
    options: Options;
    owner: Map<string, string>;
    moves: Map<string, Move[]>;
    typechecks: Map<string, TypecheckResult>;
    subjects: Map<string, { subject: string; problems: string[] }>;
    commitsBuilt: Map<string, string>;
    testResults: Map<string, RunResult & { folders: string[] }>;
    swiftResults: Map<string, RunResult>;
    assignment: Assignment;
    statuses: Map<string, string>;
}): number {
    const filesWithDerived = (name: string): string[] => [
        ...[...state.owner].filter(([, owner]) => owner === name).map(([file]) => file),
        ...(branchByName(name).derived ?? []).map((derived) => derived.file),
    ];
    const reports: BranchReport[] = CUT.map((branch) => {
        const files = [
            ...[...state.owner].filter(([, name]) => name === branch.name).map(([file]) => file),
            ...(branch.derived ?? []).map((derived) => derived.file),
        ];
        const count = (status: string): number => files.filter((file) => state.statuses.get(file) === status).length;
        const subject = state.subjects.get(branch.name) ?? checkSubject(branch.subject, files);
        return {
            name: branch.name,
            ref: `${CUT_REF_PREFIX.slice("refs/heads/".length)}${branch.name}`,
            commit: state.commitsBuilt.get(branch.name) ?? null,
            parent: branch.parent ?? state.options.base,
            subject: subject.subject,
            subjectProblems: subject.problems,
            files: files.length,
            added: count("A"),
            modified: count("M") + count("T"),
            deleted: count("D"),
            // A restart can move a file twice; the last move is where it ended.
            moves: [...new Map((state.moves.get(branch.name) ?? []).map((move) => [move.file, move])).values()],
            sizeWarning: sizeWarning(branch.name, filesWithDerived),
            typecheck: state.typechecks.get(branch.name) ?? null,
            tests: state.testResults.get(branch.name) ?? null,
            swift: state.swiftResults.get(branch.name) ?? null,
        };
    });

    const say = (line: string): void => {
        process.stderr.write(`${line}\n`);
    };
    say("");
    for (const report of reports) {
        say(`${report.ref}  ${report.commit?.slice(0, 10) ?? "(not built)"}  on ${report.parent}`);
        say(`  ${report.files} files (${report.added} added, ${report.modified} changed, ${report.deleted} deleted)`);
        say(`  subject: ${report.subject}`);
        for (const problem of report.subjectProblems) {
            say(`  ! subject: ${problem}`);
        }

        for (const move of report.moves) {
            say(`  moved ${move.file} from ${move.from}: ${move.reason}`);
        }

        if (report.typecheck) {
            const tc = report.typecheck;
            say(
                `  typecheck: ${tc.ok ? "ok" : `${tc.newErrors.length} new errors`} after ${tc.rounds} round(s), ` +
                    `${tc.errorCount} total (known: ${tc.knownErrors.join(", ") || "none"})`
            );
            for (const line of tc.newErrors.slice(0, 10)) {
                say(`    ${line}`);
            }
        }

        if (report.tests) {
            say(`  tests (${report.tests.folders.join(" ")}): ${report.tests.summary}, exit ${report.tests.exitCode}`);
        }

        if (report.swift) {
            say(`  swift build: ${report.swift.summary}, exit ${report.swift.exitCode}`);
        }

        if (report.sizeWarning) {
            say(`  ! size: ${report.sizeWarning}`);
        }
    }

    for (const [file, why] of Object.entries(KEEP_AT_BASE)) {
        say(`kept at base by the table: ${file}: ${why}`);
    }

    if (state.assignment.unplaced.length > 0) {
        say(
            `\n${state.assignment.unplaced.length} files of selected commits match no branch glob (left at base form):`
        );
        for (const file of state.assignment.unplaced) {
            say(`  ${file}`);
        }
    }

    const output = {
        unified: state.options.unified,
        base: state.options.base,
        unplaced: state.assignment.unplaced,
        branches: reports.map((report) => ({
            ...report,
            fileList: [...state.owner]
                .filter(([, name]) => name === report.name)
                .map(([file]) => file)
                .sort(),
        })),
    };
    const jsonPath = state.options.json ?? join(state.options.scratch, "report.json");
    writeFileSync(jsonPath, `${SafeJSON.stringify(output, null, 4)}\n`);
    say(`\nreport: ${jsonPath}`);

    const failed = reports.some(
        (report) =>
            (report.typecheck && !report.typecheck.ok) ||
            (report.tests && !report.tests.ok) ||
            (report.swift && !report.swift.ok)
    );
    return failed ? 1 : 0;
}

if (import.meta.main) {
    process.exitCode = await main();
}
