#!/usr/bin/env bun
/**
 * The approval driver for one Codex `--write ask` worker. The daemon already accepts plainly read-only commands; this
 * approves what the brief allows and prints the rest as NEEDS LEAD for the master. One line per decision (a Monitor
 * feed). It reads the worker's entry in the run card:
 *   { "prs": [{ "name": "bs-511-sol", "cwd": "<abs>", "scope": ["src/a.ts", …], "subject": "fix(x): #511 followup - …",
 *               "verify": ["bun scripts/test.ts src/a.test.ts", "bunx tsgo --noEmit", "bunx biome check"] }] }
 * Approved: normalized in-scope file changes, path-limited git add and commit commands matching the brief's
 * subject, exact configured verification commands, and creation of the babysit scratch folder.
 * Configure the full round-summary command as a verify entry when it should be approved. Everything else waits:
 * chaining, redirection, expansion, sandbox escalations (their request shows the reason, not the command), rituals.
 * One exception to the chaining rule: a chain (`;`, `&&`, `||`, `|`) whose every command only reads (`readOnlyChain`):
 * an independent reviewer asked the lead for 4 such chains in its first 2 minutes (2026-10-15, GenesisPlayground #93).
 *
 * Usage: bun .claude/skills/babysit/scripts/approve-codex.ts --run <run.json> --name <codex session>
 */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
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
}

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

/** The decision for one pending request: approve, and the label to print. */
export function decide(entry: RunEntry, request: ApprovalRequest): { ok: boolean; label: string } {
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

export async function watchApprovals({
    entry,
    exec = execTool,
    now = Date.now,
    sleep = Bun.sleep,
    timeoutMs = 1_800_000,
    pollMs = 1500,
}: {
    entry: RunEntry;
    exec?: typeof execTool;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    pollMs?: number;
}): Promise<void> {
    const seen = new Set<string>();
    const failures = new Map<string, number>();
    const deadline = now() + timeoutMs;
    // After a worker's turn ended, `codex status` failed with empty stderr on every poll until the deadline (2026-10-14
    // #516 round 4): say what failed, and hand over to the lead instead of printing it every 1.5 s for 30 minutes.
    let statusFailures = 0;
    const options = () => ({ cwd: entry.cwd, timeout: Math.max(1, Math.min(30_000, deadline - now())) });
    while (now() < deadline) {
        const status = await exec(["codex", "status", "--name", entry.name, "--json"], options());
        let meta: { status?: string; pendingApprovals?: Record<string, ApprovalRequest> } | null = null;
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
            console.error(
                `[approver] NEEDS LEAD: codex status failed ${statusFailures} times in a row for ${entry.name}; stopped`
            );
            return;
        }

        if (meta?.status === "closed") {
            console.log("[approver] session " + entry.name + " closed");
            return;
        }

        for (const [id, request] of Object.entries(meta?.pendingApprovals ?? {})) {
            if (seen.has(id) || (failures.get(id) ?? 0) >= 3 || now() >= deadline) {
                continue;
            }
            const { ok, label } = decide(entry, request);
            const shown = label.replace(/\s+/g, " ").slice(0, 200);
            if (!ok) {
                seen.add(id);
                console.log("[approver] NEEDS LEAD #" + id + " " + shown);
                continue;
            }

            let acknowledged = false;
            try {
                const result = await exec(["codex", "approve", "--name", entry.name, "--request", id], options());
                acknowledged = result.success && !result.timedOut;
                if (!acknowledged) {
                    console.error(
                        "[approver] approval failed #" + id + " (exit " + result.exitCode + "): " + result.stderr
                    );
                }
            } catch (error) {
                console.error("[approver] approval failed #" + id + ": " + String(error));
            }

            if (acknowledged) {
                seen.add(id);
                console.log("[approver] approved #" + id + ": " + shown);
            } else {
                const count = (failures.get(id) ?? 0) + 1;
                failures.set(id, count);
                if (count >= 3) {
                    console.error("[approver] NEEDS LEAD #" + id + ": approval failed 3 times");
                }
            }
        }
        await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
    console.error("[approver] watch deadline reached for " + entry.name);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const flag = (name: string) => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const runPath = flag("--run");
    const name = flag("--name");

    if (!runPath || !name) {
        console.error("usage: approve-codex.ts --run <run.json> --name <codex session>");
        process.exit(2);
    }

    const card = SafeJSON.parse(readFileSync(runPath, "utf8"), { strict: true }) as { prs: RunEntry[] };
    const entry = card.prs.find((pr) => pr.name === name);

    if (!entry) {
        console.error(`no entry named ${name} in ${runPath}`);
        process.exit(2);
    }

    // A reviewer writes its probes and logs to the folder review-brief names; the driver approves those writes too.
    const scratch =
        entry.scratch ?? (entry.role === "review" && entry.pr ? reviewScratch(dirname(runPath), entry.pr) : undefined);
    await watchApprovals({ entry: { ...entry, scratch } });
}

if (import.meta.main) {
    await main();
}
