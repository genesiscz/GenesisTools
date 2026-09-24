#!/usr/bin/env bun
/**
 * Reconcile the TypeScript twins in `src/utils/agent-harness/*.test.ts` against the Go tests of
 * unreallabsai/unreal-agent (`harness/coordinator`, `harness/contextbuilder`).
 *
 * Reports Go tests with no twin, twins with no Go test, skipped twins with their reason, and the
 * upstream drift between the pinned commit (UPSTREAM.md) and a target ref of the local clone.
 * Exit code 1 when a twin is missing or orphaned, or uses `test.only`; drift alone is informational.
 *
 * Read-only: it runs `git show`, `git ls-tree`, `git diff` and `git rev-parse` in the clone.
 *
 * Usage: bun scripts/agent-harness-reconcile.ts [--clone <path>] [--pinned <sha>] [--target <ref>] [--json]
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { runTool, suggestCommand } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";

const { log } = logger.scoped("agent-harness-reconcile");

const REPO_ROOT = resolve(import.meta.dir, "..");
export const HARNESS_DIR = join(REPO_ROOT, "src", "utils", "agent-harness");
export const UPSTREAM_MD = join(HARNESS_DIR, "UPSTREAM.md");
/**
 * The clone to read when `--clone` is not passed: `GENESIS_TOOLS_UNREAL_AGENT_CLONE`, or none.
 * Where a developer keeps clones is their own layout, so there is no built-in path.
 */
export function defaultClone(): string | null {
    return env.test.getHarnessUpstreamClone() ?? null;
}

/** The Go packages whose tests have TypeScript twins. */
export const TWINNED_PACKAGES = ["harness/coordinator", "harness/contextbuilder"] as const;

/** Every upstream package the port depends on, for the drift summary. */
export const DRIFT_PATHS = [
    "harness/coordinator",
    "harness/contextbuilder",
    "harness/llm",
    "harness/inbox",
    "harness/operation",
    "harness/tool",
    "harness/session",
    "harness/sessionstore",
] as const;

/** Go test files keyed by repo-relative path (`harness/coordinator/stop_test.go`). */
export type GoTestsByFile = Record<string, string[]>;

export type TwinMode = "test" | "skip" | "only" | "todo";

export interface Twin {
    /** The Go function name the twin claims: the leading `Test...`/`Fuzz...` token of the title. */
    name: string;
    /** The full title, which may carry a qualifier such as `(cancel site)`. */
    title: string;
    file: string;
    describe: string | null;
    line: number;
    mode: TwinMode;
    skipped: boolean;
    /** For skipped twins: the trailing comment, else the comment block directly above. */
    reason: string | null;
    /** For skipped twins: the `PORT-...` marker inside the reason, if any. */
    tag: string | null;
}

export interface GoTestRef {
    file: string;
    name: string;
}

export interface MisplacedTwin {
    twin: Twin;
    goFiles: string[];
}

export interface ReconcileResult {
    missing: GoTestRef[];
    orphans: Twin[];
    skipped: Twin[];
    /** `test.only` twins: in a real run they silence every other test in their file, so any one fails the check. */
    focused: Twin[];
    /** Twins whose `describe("<file>_test.go")` names another Go file than the one holding the test. */
    misplaced: MisplacedTwin[];
    counts: { goTests: number; twins: number; skipped: number; missing: number; orphans: number };
}

export interface GoFileDrift {
    file: string;
    status: "added" | "removed" | "changed";
    added: string[];
    removed: string[];
}

export interface ReconcileReport extends ReconcileResult {
    clone: string;
    pinned: string;
    target: string;
    targetSha: string;
    drift: { stat: string; files: GoFileDrift[] };
    ok: boolean;
}

const GO_TEST_FUNC = /^func ((?:Test|Fuzz|Benchmark)(?![a-z])\w*)\(/gm;
const TWIN_NAME = /^((?:Test|Fuzz|Benchmark)(?![a-z])\w*)/;
// `describe.skipIf(oracle)("file_test.go", ...)` is the conditional form; its title is the Go file.
const DESCRIBE_CALL = /\bdescribe(?:\.\w+(?:\([^)]*\))?)?\(\s*(["'`])(.*?)\1/;
// `test.skipIf(oracle)("Name", ...)` is a conditional twin: it runs on the port, so it is not a skip.
const TEST_CALL = /\btest(?:\.(skip|only|todo)|\.skipIf\([^)]*\))?\(\s*(["'`])(.*?)\2/;
const PORT_TAG = /\bPORT-[A-Z]+\b/;
// The same two calls, global and with match indices (`gd`), run over the whole masked source so a
// call may span lines; the indices locate each title's span in the original.
const DESCRIBE_CALL_ALL = new RegExp(DESCRIBE_CALL.source, "gd");
const TEST_CALL_ALL = new RegExp(TEST_CALL.source, "gd");

function blank(text: string): string {
    return text.replace(/[^\n]/g, " ");
}

/**
 * `source` with every comment and every string BODY replaced by spaces. Quote characters, newlines
 * and columns survive, so an index into the result is an index into `source`: a scan finds code
 * here and reads a title from the original at the same offset. Covers `//`, `/* … *\/`, `"…"`,
 * `'…'` (a Go rune or a TS string) and `` `…` `` (a Go raw string or a TS template, whose `${…}`
 * counts as string text). A quote string ends at its line, as neither language continues one. A
 * backslash escapes the next character, except inside a Go raw string (`goRawStrings`).
 */
export function maskCommentsAndStrings(source: string, { goRawStrings = false } = {}): string {
    let masked = "";
    let i = 0;

    while (i < source.length) {
        const char = source[i];
        const next = source[i + 1];

        if (char === "/" && (next === "/" || next === "*")) {
            const end = next === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2);
            const stop = end === -1 ? source.length : next === "/" ? end : end + 2;
            masked += blank(source.slice(i, stop));
            i = stop;
            continue;
        }

        if (char !== '"' && char !== "'" && char !== "`") {
            masked += char;
            i += 1;
            continue;
        }

        let j = i + 1;

        while (j < source.length && source[j] !== char && (char === "`" || source[j] !== "\n")) {
            j += source[j] === "\\" && !(goRawStrings && char === "`") ? 2 : 1;
        }

        const close = Math.min(j, source.length);
        masked += char + blank(source.slice(i + 1, close)) + (source[close] === char ? char : "");
        i = source[close] === char ? close + 1 : close;
    }

    return masked;
}

/**
 * Names of the Go test functions in one `_test.go` source. `Test`, `Fuzz` and `Benchmark`
 * functions count (the fuzz target `FuzzCoordinatorFaults` has twins); `TestMain` does not, and
 * neither does a helper such as `Testify` whose prefix is followed by a lowercase letter.
 * Subtests (`t.Run`) are out of scope. A declaration inside a comment or a raw string (Go source
 * held as test data) is not a test.
 */
export function parseGoTestNames(source: string): string[] {
    const names: string[] = [];

    for (const match of maskCommentsAndStrings(source, { goRawStrings: true }).matchAll(GO_TEST_FUNC)) {
        const name = match[1];

        if (name !== "TestMain") {
            names.push(name);
        }
    }

    return names;
}

function commentText(line: string): string | null {
    const trimmed = line.trim();

    if (!trimmed.startsWith("//")) {
        return null;
    }

    return trimmed.replace(/^\/\/\s?/, "");
}

function twinMode(modifier: string | undefined): TwinMode {
    if (modifier === "skip" || modifier === "only" || modifier === "todo") {
        return modifier;
    }

    return "test";
}

function reasonFor(lines: string[], index: number, afterCall: string): string | null {
    const trailing = afterCall.match(/\/\/\s?(.*)$/);

    if (trailing) {
        return trailing[1].trim();
    }

    const block: string[] = [];

    for (let i = index - 1; i >= 0; i--) {
        const text = commentText(lines[i]);

        if (text === null) {
            break;
        }

        block.unshift(text);
    }

    return block.length > 0 ? block.join(" ") : null;
}

/**
 * Every `test(...)`, `test.skip(...)`, `test.only(...)` and `test.todo(...)` in one TypeScript
 * test file, with the `describe` title it sits under (the nearest preceding one; the twin files
 * do not nest describes).
 */
export function parseTwins(source: string, file: string): Twin[] {
    const lines = source.split("\n");
    // A call inside a comment (`// test("…")`, a block comment, a trailing `//`) or inside a string
    // (a fixture holding test source) runs nothing. The mask keeps quotes, newlines and offsets, so
    // calls are found in the WHOLE masked source (a `test(` whose title sits on the next line, or two
    // calls on one line, included) and each title is read from the original at the same span.
    const masked = maskCommentsAndStrings(source);
    const lineStarts = [0];

    for (let offset = source.indexOf("\n"); offset !== -1; offset = source.indexOf("\n", offset + 1)) {
        lineStarts.push(offset + 1);
    }

    const lineIndexOf = (offset: number): number => {
        let low = 0;
        let high = lineStarts.length - 1;

        while (low < high) {
            const mid = Math.ceil((low + high) / 2);

            if (lineStarts[mid] <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }

        return low;
    };
    const describes = [...masked.matchAll(DESCRIBE_CALL_ALL)].flatMap((match) =>
        match.indices?.[2] ? [{ offset: match.index, title: source.slice(...match.indices[2]) }] : []
    );
    const twins: Twin[] = [];

    for (const match of masked.matchAll(TEST_CALL_ALL)) {
        const span = match.indices?.[3];

        if (!span) {
            continue;
        }

        const lineIndex = lineIndexOf(match.index);
        const end = match.index + match[0].length;
        const endLine = lineIndexOf(end);
        const afterCall = source.slice(end, (lineStarts[endLine + 1] ?? source.length + 1) - 1);
        const mode = twinMode(match[1]);
        const title = source.slice(...span);
        const skipped = mode === "skip" || mode === "todo";
        const reason = skipped ? reasonFor(lines, lineIndex, afterCall) : null;
        const describe = describes.filter((entry) => entry.offset < match.index).at(-1)?.title ?? null;

        twins.push({
            name: title.match(TWIN_NAME)?.[1] ?? title,
            title,
            file,
            describe,
            line: lineIndex + 1,
            mode,
            skipped,
            reason,
            tag: reason?.match(PORT_TAG)?.[0] ?? null,
        });
    }

    return twins;
}

/** `coordinator.stop.test.ts` belongs to `coordinator`; a twin file of no known package matches any. */
function twinPackage(twin: Twin): string | null {
    const file = basename(twin.file);

    for (const pkg of TWINNED_PACKAGES) {
        const name = basename(pkg);

        if (file === `${name}.test.ts` || file.startsWith(`${name}.`)) {
            return name;
        }
    }

    return null;
}

/** `loop_test.go (1/2)` names `loop_test.go`. */
function describedGoFile(twin: Twin): string | null {
    return twin.describe?.match(/^(\w+_test\.go)\b/)?.[1] ?? null;
}

export function reconcile({ goByFile, twins }: { goByFile: GoTestsByFile; twins: Twin[] }): ReconcileResult {
    const goTests: GoTestRef[] = Object.entries(goByFile).flatMap(([file, names]) =>
        names.map((name) => ({ file, name }))
    );
    const matches = (twin: Twin, go: GoTestRef): boolean => {
        const pkg = twinPackage(twin);

        // A twin outside the two twin file families covers nothing: it stays an orphan.
        return twin.name === go.name && pkg !== null && basename(dirname(go.file)) === pkg;
    };

    const missing = goTests.filter((go) => !twins.some((twin) => matches(twin, go)));
    const orphans: Twin[] = [];
    const misplaced: MisplacedTwin[] = [];

    for (const twin of twins) {
        const goFiles = goTests.filter((go) => matches(twin, go)).map((go) => go.file);

        if (goFiles.length === 0) {
            orphans.push(twin);
            continue;
        }

        const described = describedGoFile(twin);

        if (described !== null && !goFiles.some((file) => basename(file) === described)) {
            misplaced.push({ twin, goFiles });
        }
    }

    const skipped = twins.filter((twin) => twin.skipped);
    const focused = twins.filter((twin) => twin.mode === "only");

    return {
        missing,
        orphans,
        skipped,
        focused,
        misplaced,
        counts: {
            goTests: goTests.length,
            twins: twins.length,
            skipped: skipped.length,
            missing: missing.length,
            orphans: orphans.length,
        },
    };
}

/** Per Go test file, the test names a bump from `pinned` to `target` adds and removes. */
export function diffGoTests(pinned: GoTestsByFile, target: GoTestsByFile): GoFileDrift[] {
    const files = [...new Set([...Object.keys(pinned), ...Object.keys(target)])].sort();
    const drift: GoFileDrift[] = [];

    for (const file of files) {
        const before = pinned[file];
        const after = target[file];
        const beforeSet = new Set(before ?? []);
        const afterSet = new Set(after ?? []);
        const added = (after ?? []).filter((name) => !beforeSet.has(name));
        const removed = (before ?? []).filter((name) => !afterSet.has(name));

        if (before === undefined) {
            drift.push({ file, status: "added", added, removed });
            continue;
        }

        if (after === undefined) {
            drift.push({ file, status: "removed", added, removed });
            continue;
        }

        if (added.length > 0 || removed.length > 0) {
            drift.push({ file, status: "changed", added, removed });
        }
    }

    return drift;
}

export function readPinnedSha(upstreamMarkdown: string): string | null {
    return upstreamMarkdown.match(/^- Pinned commit: `([0-9a-f]{7,40})`/m)?.[1] ?? null;
}

function git(clone: string, args: string[]): string {
    const command = ["git", "-C", clone, ...args];
    log.debug({ command }, "git");
    const proc = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });

    if (proc.exitCode !== 0) {
        const stderr = proc.stderr.toString().trim();
        throw new Error(`${command.join(" ")} exited ${proc.exitCode}: ${stderr}`);
    }

    return proc.stdout.toString();
}

function resolveCommit(clone: string, ref: string): string {
    return git(clone, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

export function loadGoTests(clone: string, ref: string): GoTestsByFile {
    const byFile: GoTestsByFile = {};

    for (const pkg of TWINNED_PACKAGES) {
        const files = git(clone, ["ls-tree", "--name-only", ref, `${pkg}/`])
            .split("\n")
            .filter((path) => path.endsWith("_test.go"));

        for (const file of files) {
            byFile[file] = parseGoTestNames(git(clone, ["show", `${ref}:${file}`]));
        }
    }

    log.debug({ ref, files: Object.keys(byFile).length }, "loaded Go tests");

    return byFile;
}

export function loadTwins(dir: string = HARNESS_DIR): Twin[] {
    const files = readdirSync(dir)
        .filter((name) => name.endsWith(".test.ts"))
        .sort();

    return files.flatMap((name) => parseTwins(readFileSync(join(dir, name), "utf8"), name));
}

export function buildReport({
    clone,
    pinned,
    target,
}: {
    clone: string;
    pinned: string;
    target: string;
}): ReconcileReport {
    const pinnedSha = resolveCommit(clone, pinned);
    const targetSha = resolveCommit(clone, target);
    const pinnedTests = loadGoTests(clone, pinnedSha);
    const targetTests = targetSha === pinnedSha ? pinnedTests : loadGoTests(clone, targetSha);
    const twins = loadTwins();
    const result = reconcile({ goByFile: pinnedTests, twins });
    const stat = git(clone, ["diff", "--stat", pinnedSha, targetSha, "--", ...DRIFT_PATHS]).trimEnd();

    log.debug({ pinnedSha, targetSha, counts: result.counts }, "reconciled");

    return {
        ...result,
        clone,
        pinned: pinnedSha,
        target,
        targetSha,
        drift: { stat, files: diffGoTests(pinnedTests, targetTests) },
        ok: isReconciled(result),
    };
}

/** No missing twin, no orphan, and no `test.only` that would silence the rest of its file. */
export function isReconciled(result: ReconcileResult): boolean {
    return result.missing.length === 0 && result.orphans.length === 0 && result.focused.length === 0;
}

function twinLocation(twin: Twin): string {
    return `${twin.file}:${twin.line}`;
}

export function formatReport(report: ReconcileReport): string {
    const lines: string[] = [];
    const { counts } = report;

    lines.push(`clone:  ${report.clone}`);
    lines.push(`pinned: ${report.pinned}`);
    lines.push(`target: ${report.target} (${report.targetSha})`);
    lines.push(
        `Go tests at pinned: ${counts.goTests}, twins: ${counts.twins} (${counts.skipped} skipped), missing: ${counts.missing}, orphans: ${counts.orphans}`
    );

    lines.push("", `Missing twins (${report.missing.length}):`);

    for (const go of report.missing) {
        lines.push(`  ${go.name}  (${go.file})`);
    }

    lines.push("", `Orphan twins (${report.orphans.length}):`);

    for (const twin of report.orphans) {
        lines.push(`  ${twin.title}  (${twinLocation(twin)})`);
    }

    lines.push("", `Skipped twins (${report.skipped.length}):`);

    for (const twin of report.skipped) {
        lines.push(`  [${twin.tag ?? twin.mode}] ${twin.title}  (${twinLocation(twin)})`);

        if (twin.reason) {
            lines.push(`      ${twin.reason}`);
        }
    }

    if (report.focused.length > 0) {
        lines.push("", `Focused twins, test.only silences the rest of the file (${report.focused.length}):`);

        for (const twin of report.focused) {
            lines.push(`  ${twin.title}  (${twinLocation(twin)})`);
        }
    }

    if (report.misplaced.length > 0) {
        lines.push("", `Twins under another Go file's describe (${report.misplaced.length}):`);

        for (const { twin, goFiles } of report.misplaced) {
            lines.push(`  ${twin.title}  describe "${twin.describe}", Go test in ${goFiles.join(", ")}`);
        }
    }

    lines.push("", `Upstream drift ${report.pinned.slice(0, 12)}..${report.targetSha.slice(0, 12)}:`);

    if (report.drift.stat === "" && report.drift.files.length === 0) {
        lines.push("  none");
    } else {
        for (const statLine of report.drift.stat.split("\n").filter(Boolean)) {
            lines.push(`  ${statLine}`);
        }

        for (const file of report.drift.files) {
            lines.push(`  ${file.file} [${file.status}]`);

            for (const name of file.added) {
                lines.push(`    + ${name}  (write a twin)`);
            }

            for (const name of file.removed) {
                lines.push(`    - ${name}  (drop the twin)`);
            }
        }
    }

    lines.push(
        "",
        report.ok
            ? "OK: every Go test has a twin, every twin has a Go test, and no twin is focused."
            : "FAIL: see above."
    );

    return lines.join("\n");
}

interface CliOptions {
    clone?: string;
    pinned?: string;
    target: string;
    json?: boolean;
}

function main(opts: CliOptions): void {
    const clone = opts.clone ?? defaultClone();

    if (!clone) {
        out.error("No unreal-agent clone: pass --clone <path>, or set GENESIS_TOOLS_UNREAL_AGENT_CLONE.");
        out.info(suggestCommand("bun scripts/agent-harness-reconcile.ts", { add: ["--clone", "<path>"] }));
        process.exitCode = 1;
        return;
    }

    const pinned = opts.pinned ?? readPinnedSha(readFileSync(UPSTREAM_MD, "utf8"));

    if (!pinned) {
        out.error(`No "- Pinned commit: \`<sha>\`" line in ${UPSTREAM_MD}; pass --pinned <sha>.`);
        process.exitCode = 1;
        return;
    }

    const report = buildReport({ clone, pinned, target: opts.target });

    if (opts.json) {
        out.result(report);
    } else {
        out.println(formatReport(report));
    }

    if (!report.ok) {
        process.exitCode = 1;
    }
}

if (import.meta.main) {
    const program = new Command()
        .name("agent-harness-reconcile")
        .description("Reconcile agent-harness TypeScript twins against the unreal-agent Go tests")
        .option(
            "--clone <path>",
            "local clone of unreallabsai/unreal-agent (default: $GENESIS_TOOLS_UNREAL_AGENT_CLONE)"
        )
        .option("--pinned <sha>", "pinned upstream commit (default: read from UPSTREAM.md)")
        .option("--target <ref>", "upstream ref to measure drift against", "HEAD")
        .option("--json", "print one JSON object instead of the human report")
        .action((opts: CliOptions) => {
            main(opts);
        });

    await runTool(program, { tool: "agent-harness-reconcile" });
}
