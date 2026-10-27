#!/usr/bin/env bun
/**
 * The approval monitor for one Codex `--write ask` worker. Every pending command and file-change request goes to the
 * lead because accepting one can authorize an unsandboxed retry. Run-card trust, builds, scope and roots are advisory;
 * they never enable automatic acceptance. Known rituals are denied by the driver, with denial failures reported.
 * NEEDS LEAD lines go to `<run dir>/needs-lead.log`; a request still waiting after 3 minutes is repeated every
 * 10 minutes. The monitor runs until the session closes or a failure prevents safe monitoring.
 *
 * Usage: bun .claude/skills/babysit/scripts/approve-codex.ts --run <run.json> --name <codex session>
 *        bun .claude/skills/babysit/scripts/approve-codex.ts trust <strict|routine|all> --run <run.json> [--name <worker>]
 *        bun .claude/skills/babysit/scripts/approve-codex.ts builds <allow|deny> --run <run.json>
 *        bun .claude/skills/babysit/scripts/approve-codex.ts pending --run <run.json>
 */
import {
    appendFileSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { strictShellWords } from "@app/codex/lib/bus-approval";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { reviewScratch } from "./run";

export interface RunEntry {
    name: string;
    cwd: string;
    scope: string[];
    subject: string;
    verify: string[];
    role?: string;
    pr?: number;
    /** A second scratch folder outside the worktree: a reviewer's probe folder, which its brief names. */
    scratch?: string;
    /** This worker's trust level; the run card's `trust` applies when unset. */
    trust?: Trust;
    /** More folders a trusted worker may write to (the session's scratch folder). */
    roots?: string[];
}

interface RunCard {
    trust?: Trust;
    /** Advisory preference that identifies tests, builds and typechecks for the lead. */
    noBuilds?: boolean;
    prs: RunEntry[];
}

/** What `noBuilds` refuses: test runs, Swift and Xcode builds, the app build, and TypeScript typechecks. */
const BUILDS =
    /(?:scripts\/(?:test|ci\/typecheck)\.ts|\bbun\s+(?:run\s+)?(?:test|typecheck|build)(?=[:\s]|$)|\bswift\s+(?:build|test|run)\b|\bxcodebuild\b|\bbun\s+run\s+app\b|\btools\s+macos\s+permissions\s+build\b|\btsc\b|\btsgo\b|typescript-darwin-arm64)/;

export function buildCommand(request: { command?: unknown }): boolean {
    return typeof request.command === "string" && BUILDS.test(scannedCommand(request.command));
}

/**
 * Advisory classifications for the lead; the driver never approves a request from these classifications:
 * - `strict`: only those rules.
 * - `edits`: classify only scoped edits, guarded reads, fable-replace and scoped writes as within the preference.
 * - `routine` (the default): also any command run inside the worker's worktree, and any file change inside it or a
 *   scratch folder, unless the command matches `DENIED` or writes outside those folders.
 * - `all`: any command or file change that `DENIED` does not name, wherever it runs.
 * These classifications do not establish confinement: an interpreter or writable script can run arbitrary code.
 */
export type Trust = "strict" | "edits" | "routine" | "all";
export const TRUST_LEVELS: readonly Trust[] = ["strict", "edits", "routine", "all"];
export const DEFAULT_TRUST: Trust = "routine";
const isTrust = (value: unknown): value is Trust => TRUST_LEVELS.includes(value as Trust);

const inScope = (entry: RunEntry, path: string) => {
    const root = resolve(entry.cwd);
    const target = resolve(root, path);
    const local = relative(root, target);

    if (!local || isAbsolute(local) || local === ".." || local.startsWith(".." + sep) || /[:*?[\]]/.test(path)) {
        return false;
    }

    const scratch = resolve(root, ".claude/work/babysit");
    return entry.scope.some((allowed) => target === resolve(root, allowed)) || target.startsWith(scratch + sep);
};

/** Follow existing targets, or resolve the nearest existing parent before an editor creates missing directories. */
function canonicalWriteTarget(target: string): string {
    let ancestor = target;
    const suffix: string[] = [];
    for (;;) {
        try {
            // Unlike existsSync, lstat sees dangling symlinks: realpath must then fail, never treat one as a new file.
            lstatSync(ancestor);
        } catch (error) {
            const parent = dirname(ancestor);
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || parent === ancestor) {
                throw error;
            }
            suffix.unshift(basename(ancestor));
            ancestor = parent;
            continue;
        }
        const canonical = realpathSync(ancestor);
        if (suffix.length > 0 && !statSync(ancestor).isDirectory()) {
            throw new Error("write parent is not a directory");
        }
        return join(canonical, ...suffix);
    }
}

/** Resolve the final command's log destination after its preceding directory changes. */
const inScratch = (entry: RunEntry, command: string, path: string) => {
    const segments = chainSegments(command);
    if (!segments?.length) {
        return false;
    }

    const cwd = segments.length === 1 ? entry.cwd : readOnlyCwd(entry, segments.slice(0, -1).join(" && "));
    if (!cwd || (segments.length > 1 && /[;|\n]/.test(command))) {
        return false;
    }

    try {
        const target = isAbsolute(path) ? path : `${cwd}/${path}`;
        // Shell redirection cannot create directories; preserve that stricter prerequisite.
        realpathSync(dirname(target));
        const canonical = canonicalWriteTarget(target);
        try {
            if (lstatSync(target).isSymbolicLink() || !statSync(target).isFile()) {
                return false;
            }
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                return false;
            }
        }

        const scratch = join(realpathSync(entry.cwd), ".claude/work/babysit");
        const roots = [scratch, ...(entry.scratch ? [realpathSync(entry.scratch)] : [])];
        return roots.some((allowed) => canonical.startsWith(allowed + sep));
    } catch {
        // Missing or unreadable destination directories cannot be approved.
        return false;
    }
};

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"];

/**
 * Unwrap only an exactly parsed invocation of a known system shell. Codex wraps a command that holds a single quote in
 * double quotes with backslash escapes (`/bin/zsh -lc "sed -n '1,9p' a; rg '\\.md' b"`), which the strict parser
 * refuses; that form is unwrapped when nothing in it expands (no unescaped `$` or backquote), so its reads chain
 * through `readOnlyChain` instead of waking the lead (2026-10-15: 4 of 6 reviewer requests in one minute).
 */
export function innerCommand(command: string): string {
    const words = strictShellWords(command);

    if (words?.length === 3 && SHELLS.includes(words[0]) && ["-c", "-lc"].includes(words[1])) {
        return words[2];
    }

    const quoted = /^(\S+) (-c|-lc) "([\s\S]*)"$/.exec(command);

    if (!quoted || !SHELLS.includes(quoted[1])) {
        return command;
    }

    let inner = "";

    for (let index = 0; index < quoted[3].length; index++) {
        const char = quoted[3][index];

        if (char === "\\" && index + 1 < quoted[3].length && '\\"$`'.includes(quoted[3][index + 1])) {
            inner += quoted[3][index + 1];
            index++;
            continue;
        }

        if (char === "$" || char === "`" || char === '"') {
            return command;
        }

        inner += char;
    }

    return inner;
}

/** Closed long-option sets also refuse getopt's abbreviated executable options. */
const longOptionsAllowed = (args: string[], allowed: string) => {
    const names = new Set(allowed.split(" "));
    // Check even after --: a preceding value-taking flag may consume it instead of ending option parsing.
    return args.every((arg) => arg === "--" || !arg.startsWith("--") || names.has(arg.split("=", 1)[0]));
};

/** Each program a reader may run in a chain, with a check of its arguments: it reads, writes nothing, runs no code. */
const READERS: Record<string, (args: string[]) => boolean> = {
    pwd: () => true,
    ls: () => true,
    cat: () => true,
    head: () => true,
    tail: (args) => !args.some((arg) => /^-[a-zA-Z]*[fF]/.test(arg) || arg === "--follow"),
    wc: () => true,
    nl: () => true,
    cut: () => true,
    tr: () => true,
    // -z/-Z run decompressors; -C writes a magic database. Long options are closed against abbreviations.
    file: (args) =>
        !args.some((arg) => /^-[^-]*[zZC]/.test(arg)) &&
        longOptionsAllowed(
            args,
            "--brief --mime --mime-type --mime-encoding --keep-going --dereference --no-dereference --separator --files-from --magic-file --exclude --exclude-quiet --no-pad --raw --special-files --help --version"
        ),
    // zsh stat -A/-H stores results in shell arrays/hashes, which can change later command resolution.
    stat: (args) => !args.some((arg) => /^-[^-]*[AH]/.test(arg)),
    basename: () => true,
    dirname: () => true,
    realpath: () => true,
    echo: () => true,
    // Shell printf -v assigns a variable; %n conversions also assign through a format operand.
    printf: (args) => {
        const format = args[0] === "--" ? args[1] : args[0];
        return (
            format !== undefined &&
            !format.startsWith("-") &&
            !/%(?:\d+\$)?[-+ #0']*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hlLjzt]*n/.test(format)
        );
    },
    true: () => true,
    test: () => true,
    diff: () => true,
    jq: () => true,
    grep: () => true,
    uniq: uniqReader,
    // Unknown long options require the lead, including --compress-program and every accepted abbreviation.
    sort: (args) =>
        !args.some((arg) => /^-[^-]*o/.test(arg)) &&
        longOptionsAllowed(
            args,
            "--ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort --ignore-nonprinting --month-sort --human-numeric-sort --numeric-sort --random-sort --random-source --reverse --sort --version-sort --check --merge --key --stable --unique --field-separator --zero-terminated --buffer-size --temporary-directory --parallel --batch-size --files0-from --debug --help --version"
        ),
    rg: (args) =>
        !args.some(
            (arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg) || arg === "--search-zip" || /^-[^-]*z/.test(arg)
        ),
    find: (args) =>
        !args.some((arg) =>
            ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg)
        ),
    // Only `sed -n <range>p <files>`: a second script (`-e 'w <file>'`, `-f`, `-i`) could write, and passed before
    // (found by a Sol reviewer of #536 on 2026-10-16, which proved a file written through an approved "read").
    sed: (args) =>
        args[0] === "-n" &&
        args.length >= 2 &&
        /^(\d+|\$)(,(\d+|\$))?p$/.test(args[1]) &&
        args.slice(2).every((arg) => !arg.startsWith("-")),
    git: (args) =>
        [
            "diff",
            "log",
            "show",
            "status",
            "rev-parse",
            "ls-files",
            "ls-tree",
            "blame",
            "merge-base",
            "cat-file",
            "grep",
            "shortlog",
            "describe",
        ].includes(args[0] ?? "") &&
        (args[0] !== "cat-file" ||
            longOptionsAllowed(
                args.slice(1),
                "--batch --batch-check --batch-command --buffer --follow-symlinks --unordered --allow-unknown-type --use-mailmap --no-use-mailmap --help"
            )) &&
        (!["diff", "show", "log", "blame", "grep"].includes(args[0]) ||
            args.slice(1, args.indexOf("--") < 0 ? undefined : args.indexOf("--")).includes("--no-textconv")) &&
        (!["diff", "show", "log"].includes(args[0]) ||
            args.slice(1, args.indexOf("--") < 0 ? undefined : args.indexOf("--")).includes("--no-ext-diff")) &&
        !args.some(
            (arg) =>
                // Git accepts unique long-option prefixes, which can re-enable execution after the no-* flags.
                (arg.startsWith("--") &&
                    arg.length > 2 &&
                    ["--output", "--ext-diff", "--textconv", "--open-files-in-pager"].some((option) =>
                        option.startsWith(arg.split("=", 1)[0])
                    )) ||
                // `-O<cmd>` attached runs the command as git grep's pager (a #536 reviewer's probe, 2026-10-16).
                arg.startsWith("-O")
        ),
    gh: (args) =>
        (args[0] === "pr" &&
            ["view", "diff", "checks", "list"].includes(args[1] ?? "") &&
            !args.some((arg) => /^--web(?:=|$)/.test(arg) || /^-[^-]*w/.test(arg))) ||
        (args[0] === "api" &&
            !args.some((arg) => /^(-X|--method|-f|-F|--field|--raw-field|--input|--cache)/.test(arg))),
    tools: toolsReader,
    "./tools": toolsReader,
};

/** Parse the portable option prefix; after the first operand (or --), even dash words are operands. */
function uniqReader(args: string[]): boolean {
    let operands = 0;
    let options = true;
    const numbers = new Set(["--skip-fields", "--skip-chars", "--check-chars"]);
    const switches = new Set([
        "--count",
        "--repeated",
        "--unique",
        "--ignore-case",
        "--zero-terminated",
        "--help",
        "--version",
    ]);
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (options && arg === "--") {
            options = false;
            continue;
        }

        if (options && arg.startsWith("--")) {
            const [name, inline] = arg.split(/=(.*)/s, 2);
            if (numbers.has(name)) {
                if (!/^\d+$/.test(inline ?? args[++index] ?? "")) {
                    return false;
                }
            } else if (name === "--all-repeated" || name === "--group") {
                const methods =
                    name === "--group" ? ["separate", "prepend", "append", "both"] : ["none", "prepend", "separate"];
                if (inline !== undefined && !methods.includes(inline)) {
                    return false;
                }
            } else if (!switches.has(name) || inline !== undefined) {
                return false;
            }
            continue;
        }

        if (options && arg.startsWith("-") && arg !== "-") {
            for (let offset = 1; offset < arg.length; offset++) {
                const option = arg[offset];
                if ("fsw".includes(option)) {
                    if (!/^\d+$/.test(arg.slice(offset + 1) || args[++index] || "")) {
                        return false;
                    }
                    break;
                }
                if (!"cdiuzD".includes(option)) {
                    return false;
                }
            }
            continue;
        }

        // BSD uniq stops parsing options at its first operand; assuming GNU permutation could approve an output file.
        options = false;
        if (++operands > 1) {
            return false;
        }
    }
    return true;
}

/** Named review reads and their complete flag grammar; every other operation asks the lead. */
function toolsReader(args: string[]): boolean {
    if (args[0] === "ts") {
        return (
            ["skeleton", "duplicates", "refactors"].includes(args[1] ?? "") &&
            !args.some((arg) => arg === "--recommend" || arg.startsWith("--recommend="))
        );
    }

    if (args[0] !== "github" || args[1] !== "review") {
        return false;
    }

    const [operation, ...rest] = args.slice(2);
    if (operation === "sessions") {
        return rest.length === 0;
    }

    const values = new Set(["-s", "--session"]);
    const switches = new Set<string>();
    if (operation === "expand") {
        if (!/^t\d+(?:,t\d+)*$/.test(rest.shift() ?? "")) {
            return false;
        }
        values.add("--repo");
    } else if (operation !== "summary") {
        if (!/^\d+$/.test(operation ?? "")) {
            return false;
        }
        for (const value of ["--repo", "-a", "--author"]) {
            values.add(value);
        }
        for (const option of [
            "-u",
            "--unresolved-only",
            "-g",
            "--group-by-file",
            "-j",
            "--json",
            "--llm",
            "-v",
            "--verbose",
            "--no-pr-comments",
        ]) {
            switches.add(option);
        }
    }

    for (let index = 0; index < rest.length; index++) {
        const [option, inline] = rest[index].split(/=(.*)/s, 2);
        if (switches.has(option) && inline === undefined) {
            continue;
        }

        if (!values.has(option)) {
            return false;
        }

        const value = inline ?? rest[++index];
        if (!value || value.startsWith("-")) {
            return false;
        }
    }

    return true;
}

/**
 * Splits a chain on unquoted `;`, `&&`, `||`, `|` and newlines. Null when it holds anything else that is not a plain
 * word: a redirection, a background `&`, a command substitution or a variable (each can write, or run code).
 */
export function chainSegments(command: string): string[] | null {
    const segments: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;

    for (let index = 0; index < command.length; index++) {
        const char = command[index];

        if (quote) {
            current += char;

            if (char === quote) {
                quote = null;
            }

            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            current += char;
            continue;
        }

        const pair = command.slice(index, index + 2);

        if (pair === "&&" || pair === "||") {
            segments.push(current);
            current = "";
            index++;
            continue;
        }

        if (char === ";" || char === "|" || char === "\n") {
            segments.push(current);
            current = "";
            continue;
        }

        if (char === "&" || char === ">" || char === "<" || char === "`" || char === "$") {
            return null;
        }

        current += char;
    }

    if (quote) {
        return null;
    }

    segments.push(current);
    return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif"]);

/** A chain of commands that only read: each one a known reader with arguments it cannot write or execute with. */
export function readOnlyChain(entry: RunEntry, command: string): boolean {
    return readOnlyCwd(entry, command) !== null;
}

function readOnlyCwd(entry: RunEntry, command: string): string | null {
    const segments = chainSegments(command);

    if (!segments || segments.length === 0) {
        return null;
    }

    let cwd = entry.cwd;
    let logicalCwd = entry.cwd;
    const accepted = segments.every((segment) => {
        // `test ! -f X || cat X` opens every worker's first command; the negation reads nothing, but the strict
        // parser refuses a bare `!`, so it is dropped before parsing (only right after `test`).
        const parsed = strictShellWords(segment.replace(/^test ! /, "test "));

        if (!parsed || parsed.length === 0) {
            return false;
        }

        // `if test -f X; then cat X; fi` splits into `if test …`, `then cat …` and `fi`: the keywords run nothing
        // themselves, so the reader after each one decides (a Sol reviewer's first command, 2026-10-15).
        if (parsed[0] === "fi") {
            return parsed.length === 1;
        }

        const words = SHELL_KEYWORDS.has(parsed[0]) ? parsed.slice(1) : parsed;

        if (words.length === 0) {
            return false;
        }

        if (words[0] === "cd") {
            if (
                words.length !== 2 ||
                /[;|\n]/.test(command) ||
                segments.some((part) => /^(if|then|else|elif)\b/.test(part))
            ) {
                return false;
            }

            try {
                const logicalTarget = resolve(logicalCwd, words[1]);
                const target = realpathSync(logicalTarget);
                const root = realpathSync(entry.cwd);
                if (!statSync(target).isDirectory() || !(target + sep).startsWith(root + sep)) {
                    return false;
                }
                cwd = target;
                logicalCwd = logicalTarget;
                return true;
            } catch {
                return false;
            }
        }

        if (words[0].includes("/")) {
            try {
                const executable = realpathSync(isAbsolute(words[0]) ? words[0] : `${cwd}/${words[0]}`);
                const trusted = realpathSync(resolve(import.meta.dir, "../../../../tools"));
                return executable === trusted && toolsReader(words.slice(1));
            } catch {
                return false;
            }
        }

        const check = READERS[words[0]];
        return check !== undefined && check(words.slice(1));
    });
    return accepted ? cwd : null;
}

/**
 * The briefs' own test command, `timeout <seconds> bun scripts/test.ts <test files>`: every file a `.test.ts(x)` path
 * inside the worktree. A reviewer runs it once per area, and each one woke the lead (2026-10-16: 6 of the first 15
 * NEEDS LEAD lines of five Sol reviewers). It runs inside the worker's sandbox like any other approved command.
 */
export function testRunCommand(entry: RunEntry, words: string[]): boolean {
    const rest = words[0] === "timeout" && /^\d+$/.test(words[1] ?? "") ? words.slice(2) : words;

    if (rest[0] !== "bun" || rest[1] !== "scripts/test.ts" || rest.length < 3) {
        return false;
    }

    const root = resolve(entry.cwd);
    return rest.slice(2).every((path) => {
        const local = relative(root, resolve(root, path));
        return /\.test\.tsx?$/.test(path) && !isAbsolute(local) && !local.startsWith("..") && !/[*?[\]]/.test(path);
    });
}

const MAIN_CLI = (() => {
    const common = Bun.spawnSync(
        [
            "git",
            "-C",
            resolve(import.meta.dir, "../../../.."),
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    return common.exitCode === 0
        ? resolve(dirname(common.stdout.toString().trim()), "plugins/genesis-tools/skills/fable-replace/scripts/cli.ts")
        : null;
})();
const CACHE_ROOT = join(homedir(), ".codex/plugins/cache/genesis-tools/genesis-tools");
const FABLE_ENV = new Set(["GENESIS_TOOLS_HOME", "TMPDIR", "FABLE_REPLACE_HOME"]);

/** Compare canonical paths, never a worker-controlled suffix. Temp paths stay untrusted even through symlinks. */
function trustedFableCli(entry: RunEntry, path: string): boolean {
    const candidate = resolve(entry.cwd, path);
    const forbidden = (value: string) =>
        /^\/(?:private\/)?tmp(?:\/|$)/.test(value) || /\/\.claude\/work(?:\/|$)/.test(value);
    if (forbidden(candidate)) {
        return false;
    }

    try {
        const canonical = realpathSync(candidate);
        if (forbidden(canonical)) {
            return false;
        }

        if (MAIN_CLI && canonical === realpathSync(MAIN_CLI)) {
            return true;
        }

        const cache = realpathSync(CACHE_ROOT);
        const local = relative(cache, canonical);
        return /^\d+(?:\.\d+)*\/skills\/fable-replace\/scripts\/cli\.ts$/.test(local);
    } catch {
        // Missing or unreadable tools cannot be trusted.
        return false;
    }
}

/** Only literal invocations of the trusted editor, with one closed quoted heredoc and scoped edits. */
export function fableReplaceCommand(entry: RunEntry, command: string): boolean {
    const match = /^([^\n]+) <<'([A-Za-z0-9_]+)'\n([\s\S]*)\n\2\n?$/.exec(command);
    if (!match || match[3].split("\n").includes(match[2]) || match[3].trimStart().startsWith("[")) {
        return false;
    }

    const prefix = strictShellWords(match[1]);
    if (!prefix || prefix.length < 2 || prefix[prefix.length - 2] !== "bun") {
        return false;
    }

    const cli = prefix.at(-1) ?? "";
    if (!trustedFableCli(entry, cli)) {
        return false;
    }

    const envOk = prefix.slice(0, -2).every((pair) => {
        const equals = pair.indexOf("=");
        const [key, value] = [pair.slice(0, equals), pair.slice(equals + 1)];
        return (
            equals > 0 && FABLE_ENV.has(key) && /^\/(private\/)?tmp\/cc\/[\w./-]+$/.test(value) && !value.includes("..")
        );
    });
    const lines = match[3].split("\n");
    // Moves can also rewrite importers. All such operations require the lead, even with a scoped destination.
    if (lines.some((line) => line.startsWith("<<<") && /(?:^|\s)(?:move|to=|imports=|renameTo=)/.test(line.slice(3)))) {
        return false;
    }

    const targets = lines.filter((line) => line.startsWith("@@")).map((line) => line.slice(2).trim());
    return (
        envOk &&
        targets.length > 0 &&
        targets.every((path) => {
            if (/[\x60$]/.test(path) || !inScope(entry, path)) {
                return false;
            }
            try {
                const canonical = canonicalWriteTarget(resolve(entry.cwd, path));
                // Project the physical target back onto the logical root so /tmp aliases and scoped absolute paths
                // keep their meaning, without trusting a symlink's destination as a new allowed root.
                return inScope(entry, relative(realpathSync(entry.cwd), canonical));
            } catch {
                // Dangling links, loops, unreadable paths and non-directory parents cannot be approved.
                return false;
            }
        })
    );
}

/** Whether a command approval is one the brief allows. Pure, so it can be replayed on a past session's requests. */
export function allowedCommand(entry: RunEntry, command: string): boolean {
    if (readOnlyChain(entry, command) || fableReplaceCommand(entry, command)) {
        return true;
    }

    // A check whose output goes to the scratch folder (`<check> > .claude/work/babysit/x.log 2>&1`), or that runs
    // under `timeout <s>`, is the same check: the fixers write every verify log there (2026-10-16, #537 round 1).
    const logged = /^(.*\S)\s+>\s*(.+?)\s+2>&1$/.exec(command);
    const destination = logged ? strictShellWords(logged[2]) : null;

    if (logged && destination?.length === 1 && inScratch(entry, logged[1], destination[0]) && !/[<>]/.test(logged[1])) {
        return allowedCommand(entry, logged[1]);
    }

    const timed = /^timeout \d+ (.+)$/s.exec(command);

    if (timed && !timed[1].startsWith("timeout ") && allowedCommand(entry, timed[1])) {
        return true;
    }

    const words = strictShellWords(command);

    if (!words || words.length === 0) {
        return false;
    }

    if (words[0] === "git" && words[1] === "add" && words[2] === "--") {
        return words.length > 3 && words.slice(3).every((path) => inScope(entry, path));
    }

    if (words[0] === "git" && words[1] === "commit" && words[2] === "-m") {
        return (
            words[4] === "--" &&
            words.length > 5 &&
            words[3].startsWith(entry.subject.split(" - ")[0] + " - ") &&
            words.slice(5).every((path) => inScope(entry, path))
        );
    }

    // The babysit scratch folder, relative or as its absolute path (reviewers write the absolute one from the brief).
    if (
        words.length === 3 &&
        words[0] === "mkdir" &&
        words[1] === "-p" &&
        resolve(entry.cwd, words[2]) === resolve(entry.cwd, ".claude/work/babysit")
    ) {
        return true;
    }

    if (testRunCommand(entry, words)) {
        return true;
    }

    // Biome on files of the scope, with or without --write (the brief's format step).
    if (words[0] === "bunx" && words[1] === "biome" && words[2] === "check") {
        const rest = words.slice(3).filter((word) => word !== "--write");
        return rest.length > 0 && rest.every((path) => !path.startsWith("-") && inScope(entry, path));
    }

    return entry.verify.some((verify) => {
        const allowed = strictShellWords(verify);
        return allowed?.length === words.length && allowed.every((word, index) => word === words[index]);
    });
}

interface ApprovalRequest {
    method?: string;
    detail?: string;
    /** Exact paths from the daemon's file-change item. Missing on older daemons: ask the lead. */
    paths?: unknown;
    command?: unknown;
    cwd?: unknown;
}

/**
 * Commands no trust level approves: they publish, delete, rewrite or move a branch, change the Mac or its packages,
 * reach the network, or start other agents. A match anywhere in the command (heredoc bodies aside) asks the lead, so a
 * quoted mention costs one question, never a silent approval. A commit passes only through the brief's own rule.
 */
const DENIED: RegExp[] = [
    /\bgit\b[^\n;&|]*\b(?:push|commit|reset|clean|checkout|restore|switch|rebase|merge|cherry-pick|revert|worktree|branch|tag|config(?!\s+--get\b)|stash|update-ref|filter-branch|filter-repo|gc|prune|reflog|remote|fetch|pull|am|apply|notes|replace)\b/,
    /(?:^|[\s;&|(])(?:[^\s;&|()]+\/)?(?:rm|rmdir|unlink|shred|sudo|su|kill|pkill|killall|launchctl|osascript|open|shutdown|reboot|diskutil|security|defaults|tccutil|chown|curl|wget|gh|glab|ssh|scp|rsync|nc|npm|npx|pnpm|yarn|brew|pip|pip3|xattr|codesign|spctl|lsregister|crontab|swift-format)(?=\s|$)/,
    /\bbunx?\s+(?:add|install|i|remove|rm|update|upgrade|link|unlink|publish|pm)\b/,
    /\b(?:\.\/)?tools\s+(?:say|claude|codex|grok|notify|question|macos|github|git|agents|ai|update|mcp-manager|cmux|hub|genesis-tools)\b/,
    /\bbun\s+run\s+app\b/,
];

/** Heredoc bodies are data (a fable-replace spec, a file being written), not commands, so they are not scanned. */
function withoutHeredocBodies(command: string): string {
    return command.replace(/<<-?\s*(['"]?)([A-Za-z0-9_]+)\1([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, "<<$1$2$1$3");
}

/** A ritual a worker must not run (the brief says so); the driver refuses it by itself instead of asking the lead. */
export function ritualCommand(request: { command?: unknown }): boolean {
    return typeof request.command === "string" && /\btools\s+say\b/.test(scannedCommand(request.command));
}

export function deniedCommand(command: string): boolean {
    const scanned = withoutHeredocBodies(command);
    return DENIED.some((pattern) => pattern.test(scanned));
}

const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** A write target inside the worktree (never its `.git`), the reviewer's scratch folder or another configured root. */
function insideRoots(entry: RunEntry, cwd: string, path: string, roots = writeRoots(entry)): boolean {
    if (DEVICES.has(path)) {
        return true;
    }

    try {
        const canonical = canonicalWriteTarget(resolve(cwd, path));
        const worktree = realpathSync(entry.cwd);
        if (/^\.git(?:\/|$)/.test(relative(worktree, canonical))) {
            return false;
        }

        return roots.some((root) => {
            const real = realpathSync(root);
            return canonical === real || canonical.startsWith(real + sep);
        });
    } catch {
        // A missing or unreadable root, a dangling link or a file used as a folder cannot be approved.
        return false;
    }
}

const writeRoots = (entry: RunEntry) => [entry.cwd, ...(entry.scratch ? [entry.scratch] : []), ...(entry.roots ?? [])];

const FILE_WRITERS = new Set(["touch", "mkdir", "truncate", "chmod", "tee"]);
const COPIERS = new Set(["cp", "mv", "ln", "install"]);

/** Every path a command writes through a redirection, `tee`, a copy or move, `touch`/`mkdir`, or fable-replace. */
export function writeTargets(command: string, cwd: string): string[] | null {
    const scanned = withoutHeredocBodies(command);
    const targets: string[] = [];
    for (const match of scanned.matchAll(/(?:^|[^<>&0-9-])[0-9&]?>>?\s*(?!&)(['"]?)([^\s'";|&<>()]+)\1/g)) {
        targets.push(match[2]);
    }

    for (const segment of scanned.split(/&&|\|\||[;|\n]/)) {
        const words = (strictShellWords(segment.trim()) ?? segment.trim().split(/\s+/)).filter(
            (word) => !/^[A-Z_][A-Z0-9_]*=/.test(word)
        );
        const program = basename(words[0] === "timeout" ? (words[2] ?? "") : (words[0] ?? ""));
        const args = (words[0] === "timeout" ? words.slice(3) : words.slice(1)).filter((word) => !word.startsWith("-"));
        if (FILE_WRITERS.has(program)) {
            targets.push(...args);
        } else if (COPIERS.has(program) && args.length > 0) {
            targets.push(args[args.length - 1]);
        } else if (program === "dd") {
            targets.push(...args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3)));
        }
    }

    if (/fable-replace\/scripts\/cli\.ts/.test(command)) {
        const lines = command.split("\n").filter((line) => line.startsWith("@@"));
        const spec = /--spec\s+(['"]?)([^\s'"]+)\1/.exec(command);
        if (spec) {
            try {
                lines.push(
                    ...readFileSync(resolve(cwd, spec[2]), "utf8")
                        .split("\n")
                        .filter((line) => line.startsWith("@@"))
                );
            } catch {
                // A spec the driver cannot read names targets it cannot check.
                return null;
            }
        }

        targets.push(...lines.map((line) => line.slice(2).trim()));
    }

    return targets;
}

/**
 * The command a trust check scans. `innerCommand` refuses to unwrap a shell call that mixes quotes or expands a variable
 * (`FABLE_REPLACE_HOME="$PWD/…"`, a heredoc with `"` in its body); for a scan that only looks for denied commands and
 * write targets, dropping the wrapper and its quote juggling is enough (2026-10-26: such calls were half the questions).
 */
export function scannedCommand(command: string): string {
    const inner = innerCommand(command);
    const wrapped = /^(\S+) (?:-c|-lc) (['"])([\s\S]*)\2$/.exec(inner);
    if (!wrapped || !SHELLS.includes(wrapped[1])) {
        return inner;
    }

    return wrapped[3].replace(/'"'"'|'"'|"'/g, "").replace(/\\(["$`\\])/g, "$1");
}

/** Under `edits`, accept the existing guarded readers and scoped literal writes only. */
export function editOnlyCommand(entry: RunEntry, command: string, cwd: string): boolean {
    if (fableReplaceCommand(entry, command)) {
        return true;
    }

    // Strip only literal redirections which writeTargets checks below. Other shell syntax is rejected by
    // chainSegments/strictShellWords rather than guessed at; in particular, substitutions cannot execute code.
    let unparsed = false;
    const stripped = command.replace(
        /(?:^|\s)(?:2>\/dev\/null|(?:[12]?>|>>|2>>)\s*([^\s;&|<>()]+))/g,
        (_match, target: string | undefined) => {
            if (target && /[\x60$'"\\*?[\]]/.test(target)) {
                unparsed = true;
            }
            return " ";
        }
    );
    const segments = chainSegments(stripped);
    if (unparsed || !segments?.length) {
        return false;
    }

    const programsOk = segments.every((segment) => {
        const parsed = strictShellWords(segment.replace(/^test ! /, "test "));
        if (!parsed?.length) {
            return false;
        }
        if (parsed[0] === "fi") {
            return parsed.length === 1;
        }
        const words = SHELL_KEYWORDS.has(parsed[0]) ? parsed.slice(1) : parsed;
        if (!words.length) {
            return false;
        }
        const reader = READERS[words[0]];
        if (reader) {
            return reader(words.slice(1));
        }
        if (words[0] === "mkdir" || words[0] === "tee") {
            return words.slice(1).every((word) => word === "-p" || word === "-a" || !word.startsWith("-"));
        }
        return false;
    });
    const targets = writeTargets(command, cwd);
    return programsOk && targets !== null && targets.every((target) => insideRoots(entry, cwd, target));
}

/** Advisory classification only; callers must never use it to approve without an explicit lead decision. */
export function trustedRequest(entry: RunEntry, request: ApprovalRequest, trust: Trust): boolean {
    if (trust === "strict") {
        return false;
    }

    const method = request.method ?? "";
    if (method.includes("fileChange")) {
        const paths = request.paths;
        return (
            Array.isArray(paths) &&
            paths.length > 0 &&
            paths.every((path) => typeof path === "string" && (trust === "all" || insideRoots(entry, entry.cwd, path)))
        );
    }

    const isCommand = method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
    const cwd = request.cwd;
    if (!isCommand || typeof request.command !== "string" || typeof cwd !== "string") {
        return false;
    }

    if (!isAbsolute(cwd) || (trust === "routine" && !insideRoots(entry, cwd, ".", [entry.cwd]))) {
        return false;
    }

    const command = scannedCommand(request.command);
    if (deniedCommand(command)) {
        return false;
    }

    if (trust === "edits") {
        return editOnlyCommand(entry, command, cwd);
    }

    if (trust === "all") {
        return true;
    }

    const targets = writeTargets(command, cwd);
    // A relative target after `cd` cannot safely be resolved against the request's original cwd.
    // Escalate these rather than trying to infer shell control flow.
    if (targets?.length && /\b(?:cd|chdir|pushd|popd)(?:\s|$)/.test(command)) {
        return false;
    }
    return targets?.every((target) => insideRoots(entry, cwd, target)) ?? false;
}

/** Advisory classification for one pending request, not an authorization decision. */
export function decide(
    entry: RunEntry,
    request: ApprovalRequest,
    trust: Trust = "strict",
    noBuilds = false
): { ok: boolean; label: string } {
    if (noBuilds && buildCommand(request)) {
        return { ok: false, label: `${String(request.detail ?? "")} (builds and tests are off)` };
    }

    if (trust === "edits") {
        return { ok: trustedRequest(entry, request, trust), label: String(request.detail ?? "") };
    }

    const own = briefDecision(entry, request);
    return own.ok || trust === "strict" ? own : { ok: trustedRequest(entry, request, trust), label: own.label };
}

/** The brief's own rules: scoped file changes and the commands `allowedCommand` names, in the worker's cwd. */
function briefDecision(entry: RunEntry, request: ApprovalRequest): { ok: boolean; label: string } {
    const method = request.method ?? "";
    const detail = String(request.detail ?? "");

    if (method.includes("fileChange")) {
        const paths = request.paths;

        return {
            ok:
                Array.isArray(paths) &&
                paths.length > 0 &&
                paths.every((path) => typeof path === "string" && path.length > 0 && inScope(entry, path)),
            label: detail,
        };
    }

    const isCommand = method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
    const command = typeof request.command === "string" ? innerCommand(request.command) : null;
    const sameCwd =
        typeof request.cwd === "string" && isAbsolute(request.cwd) && resolve(request.cwd) === resolve(entry.cwd);

    return { ok: isCommand && sameCwd && command !== null && allowedCommand(entry, command), label: detail };
}

const STATUS_FAILURE_LIMIT = 10;
const REMIND_AFTER_MS = 180_000;
const REMIND_EVERY_MS = 600_000;

export async function watchApprovals({
    entry,
    exec = execTool,
    now = Date.now,
    sleep = Bun.sleep,
    timeoutMs = Number.POSITIVE_INFINITY,
    pollMs = 1500,
    trust = () => "strict",
    noBuilds = () => false,
    feed = () => {},
    remindAfterMs = REMIND_AFTER_MS,
    remindEveryMs = REMIND_EVERY_MS,
}: {
    entry: RunEntry;
    exec?: typeof execTool;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
    /** The driver stops here; by default it runs until the worker's session closes. */
    timeoutMs?: number;
    pollMs?: number;
    /** Read on every poll, so the lead can switch it on a running driver. The CLI reads it from the run card. */
    trust?: () => Trust;
    /** Read on every poll: true identifies tests, builds and typechecks as outside the advisory preference. */
    noBuilds?: () => boolean;
    /** The run's shared NEEDS LEAD feed: every question and reminder also goes here. */
    feed?: (line: string) => void;
    remindAfterMs?: number;
    remindEveryMs?: number;
}): Promise<void> {
    const seen = new Set<string>();
    const failures = new Map<string, number>();
    /** Requests waiting on the lead: when they were asked and last repeated. */
    const asked = new Map<string, { since: number; reminded: number; shown: string }>();
    const deadline = now() + timeoutMs;
    const ask = (line: string) => {
        console.log(line);
        feed(line);
    };
    let level: Trust | undefined;
    let buildsOff: boolean | undefined;
    // After a worker's turn ended, `codex status` failed with empty stderr on every poll until the deadline (2026-10-14
    // #516 round 4): say what failed, and hand over to the lead instead of printing it every 1.5 s for 30 minutes.
    let statusFailures = 0;
    const options = () => ({ cwd: entry.cwd, timeout: Math.max(1, Math.min(30_000, deadline - now())) });
    while (now() < deadline) {
        const current = trust();
        const currentBuildsOff = noBuilds();
        if (current !== level || currentBuildsOff !== buildsOff) {
            if (level !== undefined) {
                console.log(`[approver] trust is now ${current}`);
            }

            level = current;
            buildsOff = currentBuildsOff;
            // A policy switch rechecks the advisory state but never authorizes the waiting request.
            for (const id of asked.keys()) {
                seen.delete(id);
            }
        }

        const status = await exec(["codex", "status", "--name", entry.name, "--json"], options());
        let meta: {
            status?: string;
            writePolicy?: string;
            sandbox?: string;
            pendingApprovals?: Record<string, ApprovalRequest>;
        } | null = null;
        try {
            if (status.success && !status.timedOut) {
                meta = SafeJSON.parse(status.stdout, { strict: true });
                statusFailures = 0;
            } else {
                statusFailures += 1;
                const said = (status.stderr.trim() || status.stdout.trim() || "no output").replace(/\s+/g, " ");
                console.error(
                    `[approver] status failed (exit ${status.exitCode}${status.timedOut ? ", timed out" : ""}): ${said.slice(0, 200)}`
                );
            }
        } catch (error) {
            console.error("[approver] invalid status: " + String(error));
        }

        if (statusFailures >= STATUS_FAILURE_LIMIT) {
            const line = `[approver] NEEDS LEAD: codex status failed ${statusFailures} times in a row for ${entry.name}; stopped`;
            console.error(line);
            feed(line);
            return;
        }

        if (
            meta &&
            ((meta.writePolicy && meta.writePolicy !== "ask") || (meta.sandbox && meta.sandbox !== "workspace-write"))
        ) {
            const line = `[approver] NEEDS LEAD: ${entry.name} is not an ask/workspace-write worker; driver stopped`;
            console.error(line);
            feed(line);
            return;
        }

        if (meta?.status === "closed") {
            console.log("[approver] session " + entry.name + " closed");
            return;
        }

        const pending = meta?.pendingApprovals ?? {};
        for (const [id, request] of Object.entries(pending)) {
            if (seen.has(id) || (failures.get(id) ?? 0) >= 3 || now() >= deadline) {
                continue;
            }
            const shown = String(request.detail ?? "")
                .replace(/\s+/g, " ")
                .slice(0, 200);
            if (ritualCommand(request)) {
                let acknowledged = false;
                try {
                    const refused = await exec(["codex", "deny", "--name", entry.name, "--request", id], options());
                    acknowledged = refused.success && !refused.timedOut;
                } catch (error) {
                    console.error(`[approver] denial failed #${id}: ${String(error)}`);
                }
                if (acknowledged) {
                    seen.add(id);
                    asked.delete(id);
                    console.log(`[approver] refused #${id}: ${shown}`);
                } else {
                    const count = (failures.get(id) ?? 0) + 1;
                    failures.set(id, count);
                    if (count >= 3) {
                        const message = `denial failed 3 times: ${shown}`;
                        asked.set(id, { since: now(), reminded: now(), shown: message });
                        ask(`[approver] NEEDS LEAD #${id}: ${message}`);
                    }
                }
                continue;
            }

            seen.add(id);
            if (!asked.has(id)) {
                const reason = `sandbox authority unavailable; manual approval required: ${shown}`;
                asked.set(id, { since: now(), reminded: now(), shown: reason });
                ask(`[approver] NEEDS LEAD #${id} ${reason}`);
            }
        }

        // A question nobody answered comes back, so a lead whose monitor was down still sees it (2026-10-26).
        for (const [id, info] of asked) {
            if (meta && !(id in pending)) {
                asked.delete(id);
                continue;
            }

            const wait = info.reminded === info.since ? remindAfterMs : remindEveryMs;
            if (now() - info.reminded >= wait) {
                info.reminded = now();
                ask(`[approver] STILL WAITING #${id} ${Math.round((now() - info.since) / 60_000)}m ${info.shown}`);
            }
        }

        await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
    console.error("[approver] watch deadline reached for " + entry.name);
}

const readCard = (runPath: string) => SafeJSON.parse(readFileSync(runPath, "utf8"), { strict: true }) as RunCard;

/** The worker's trust level and the build switch from the run card, re-read only when the card changed. */
function policyReader(runPath: string, name: string): () => { trust: Trust; noBuilds: boolean } {
    let stamp = -1;
    // A failed first read must not widen a previously configured policy.
    let policy: { trust: Trust; noBuilds: boolean } = { trust: "strict", noBuilds: true };
    return () => {
        try {
            const mtime = statSync(runPath).mtimeMs;
            if (mtime !== stamp) {
                const card = readCard(runPath);
                const value = card.prs.find((pr) => pr.name === name)?.trust ?? card.trust;
                policy = { trust: isTrust(value) ? value : DEFAULT_TRUST, noBuilds: card.noBuilds === true };
                stamp = mtime;
            }
        } catch (error) {
            // A card caught mid-write parses on the next poll; the last policy holds until then.
            console.error(`[approver] could not read the run card: ${String(error)}`);
        }

        return policy;
    };
}

function updateCard(runPath: string, update: (card: RunCard) => void): void {
    // mkdir is exclusive across processes. A concurrent update fails instead of overwriting a newer policy.
    // If a process dies with the lock held, the lead must inspect and clear it before retrying.
    const lock = `${runPath}.policy-lock`;
    mkdirSync(lock, { mode: 0o700 });
    try {
        const card = readCard(runPath);
        update(card);
        const temporary = `${runPath}.policy-${process.pid}`;
        writeFileSync(temporary, SafeJSON.stringify(card, null, 2) + "\n");
        renameSync(temporary, runPath);
    } finally {
        rmdirSync(lock);
    }
}

function setBuilds(runPath: string, allowed: boolean): string {
    updateCard(runPath, (card) => {
        card.noBuilds = !allowed;
    });
    return allowed
        ? "advisory build preference: allow (manual approval still required)"
        : "advisory build preference: deny (manual approval still required)";
}

/** The extra write roots and scratch folder a driver gives its worker. */
function withRunFolders(entry: RunEntry, runPath: string): RunEntry {
    const runDir = dirname(runPath);
    // Keep the reviewer's scratch folder in the advisory classification.
    const scratch =
        entry.scratch ?? (entry.role === "review" && entry.pr ? reviewScratch(runDir, entry.pr) : undefined);
    // The run folder sits in the session's scratch folder (`/tmp/cc/<project>/<session>/babysit`).
    return { ...entry, scratch, roots: entry.roots ?? [dirname(runDir)] };
}

function setTrust(runPath: string, level: Trust, name?: string): string {
    updateCard(runPath, (card) => {
        if (name) {
            const entry = card.prs.find((pr) => pr.name === name);
            if (!entry) {
                throw new Error(`no entry named ${name} in ${runPath}`);
            }
            entry.trust = level;
        } else {
            card.trust = level;
            for (const entry of card.prs) {
                delete entry.trust;
            }
        }
    });
    return name ? `${name} advisory trust is ${level}` : `every worker's advisory trust is ${level}`;
}

/** Every worker's waiting requests; all require an explicit lead decision. */
async function listPending(runPath: string): Promise<void> {
    const card = readCard(runPath);
    let waiting = 0;
    for (const raw of card.prs) {
        const entry = withRunFolders(raw, runPath);
        const status = await execTool(["codex", "status", "--name", entry.name, "--json"], { timeout: 30_000 });
        if (!status.success) {
            console.log(`${entry.name}: status failed (exit ${status.exitCode})`);
            continue;
        }

        const meta = SafeJSON.parse(status.stdout, { strict: true }) as {
            pendingApprovals?: Record<string, ApprovalRequest>;
        };
        const level = entry.trust ?? card.trust ?? DEFAULT_TRUST;
        const noBuilds = card.noBuilds === true;
        for (const [id, request] of Object.entries(meta.pendingApprovals ?? {})) {
            waiting += 1;
            const { label } = decide(entry, request, level, noBuilds);
            console.log(
                `${entry.name} #${id} NEEDS LEAD (sandbox authority unavailable; manual approval required): ${label.replace(/\s+/g, " ").slice(0, 160)}`
            );
        }
    }

    console.log(`${waiting} waiting request(s) across ${card.prs.length} worker(s)`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const flag = (name: string) => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const runPath = flag("--run");
    const name = flag("--name");

    if (args[0] === "trust") {
        const level = args[1];
        if (!runPath || !isTrust(level)) {
            console.error(
                `usage: approve-codex.ts trust <${TRUST_LEVELS.join("|")}> --run <run.json> [--name <worker>]`
            );
            process.exit(2);
        }

        console.log(setTrust(runPath, level, name));
        return;
    }

    if (args[0] === "builds") {
        if (!runPath || !["allow", "deny"].includes(args[1] ?? "")) {
            console.error("usage: approve-codex.ts builds <allow|deny> --run <run.json>");
            process.exit(2);
        }

        console.log(setBuilds(runPath, args[1] === "allow"));
        return;
    }

    if (args[0] === "pending") {
        if (!runPath) {
            console.error("usage: approve-codex.ts pending --run <run.json>");
            process.exit(2);
        }

        await listPending(runPath);
        return;
    }

    if (!runPath || !name) {
        console.error("usage: approve-codex.ts --run <run.json> --name <codex session>");
        process.exit(2);
    }

    const entry = readCard(runPath).prs.find((pr) => pr.name === name);

    if (!entry) {
        console.error(`no entry named ${name} in ${runPath}`);
        process.exit(2);
    }

    const feedPath = join(dirname(runPath), "needs-lead.log");
    const policy = policyReader(runPath, name);
    await watchApprovals({
        entry: withRunFolders(entry, runPath),
        trust: () => policy().trust,
        noBuilds: () => policy().noBuilds,
        feed: (line) => {
            const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
            appendFileSync(feedPath, `${time} ${name} ${line.replace(/^\[approver\] /, "")}\n`);
        },
    });
}

if (import.meta.main) {
    await main();
}
