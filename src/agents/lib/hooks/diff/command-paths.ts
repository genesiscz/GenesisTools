import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
    commandTokenIndex,
    commandWord,
    lastSimpleCommandOnLine,
    nextRawArgument,
    rawToken,
    type ShellScan,
    type Span,
    scanShell,
    splitPipeline,
    tokenize,
} from "@genesiscz/utils/shell/scan";
import { hookDiag } from "../log";

/**
 * Everything the hook reads OUT of a command's text: the directories it works in, and the
 * files it names. Both go through the scanner rather than a regex over the raw command,
 * because the scanner blanks quoted spans and heredoc bodies. Without that, the wrap-up
 * note's own text (which quotes worktree paths) would be read as paths the command touched.
 */

/**
 * The argument as a PLAIN path, or `null` when the shell would not read it that way.
 *
 * `rawToken` and `nextRawArgument` are naive quote matchers over raw text: they know nothing
 * about backslash escapes, command substitution, or adjacent quoted runs such as `'a'b'c'`.
 * Guessing there would hand a path the shell never meant to `git -C`. So anything with an
 * escape, an inner quote, a substitution or a variable is REFUSED. A missing path costs one
 * diff; a wrong path is a wrong answer.
 */
export function plainArgument(raw: string | null): string | null {
    if (!raw) {
        return null;
    }

    const quoted = /^(['"])(.*)\1$/.exec(raw);
    const value = quoted?.[2] ?? raw;

    if (value.length === 0 || value === "-" || /["'\\$`]/.test(value)) {
        return null;
    }

    return value;
}

/** `NAME=` at the head of a token: a shell assignment, never a path. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const DECLARING = new Set(["export", "readonly", "declare", "typeset"]);
/** A bare variable reference, with or without braces. */
const VARIABLE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

function scan(command: string, what: string): ShellScan | null {
    try {
        return scanShell(command);
    } catch (err) {
        // A scanner that throws must not cost the capture its cwd root.
        hookDiag(`Could not scan the command for ${what}`, { err });
        return null;
    }
}

/**
 * Values the command assigns to ITSELF, so `P=/some/dir && cd "$P"` can be followed.
 *
 * 🛑 The command's own text is the only source. The environment is never read, because a
 * `$HOME` or a `$PWD` resolved from this process is not what the command saw, and a wrong
 * directory handed to `git -C` is a wrong answer rather than a missing one.
 *
 * Measured 2026-09-22: a `fable-replace` sweep written as `P=<worktree>` then `cd "$P"` left
 * the hook watching the session cwd, which was a DIFFERENT checkout, so two edited files
 * produced no diff at all. Assignments are the common shape for a long path.
 *
 * The callers walk the statements in order and apply each element's assignments AFTER reading
 * its arguments, so a `$V` means the value the shell had at that point: `V=/one; cat "$V/a";
 * V=/two; cat "$V/b"` names `/one/a` and `/two/b`. Only an element made of assignments alone
 * keeps them (`V=/x cat "$V"` sets V for that one command), and a value `plainArgument` does not
 * accept (`V=$(pwd)`) forgets the earlier one rather than keep a value the shell no longer has.
 */
function applyAssignments({
    command,
    tokens,
    known,
}: {
    command: string;
    tokens: Span[];
    known: Map<string, string>;
}): void {
    const assigned: Array<[string, string | null]> = [];
    // `export P=/x` (and `readonly`, `declare`) sets P for the rest of the command as a bare assignment does.
    const declares = tokens.length > 0 && DECLARING.has(rawToken(command, tokens[0] as Span));

    for (const token of declares ? tokens.slice(1) : tokens) {
        const raw = rawToken(command, token);
        const head = ASSIGNMENT.exec(raw);
        const name = head?.[1];

        if (declares && !head) {
            // `export P` or a flag (`declare -x`): no value here.
            continue;
        }

        if (!head || !name) {
            return;
        }

        // `V=/x; cat "$V/a"`: the statement's `;` comes with the token and is not part of the value.
        assigned.push([name, plainArgument(raw.slice(head[0].length).replace(/;+$/, ""))]);
    }

    for (const [name, value] of assigned) {
        if (value) {
            known.set(name, value);
        } else {
            known.delete(name);
        }
    }
}

/**
 * The value of a `$NAME` the command set earlier, or `null`.
 *
 * Single quotes do not expand in shell, so `'$P'` is the literal text and must never be
 * substituted. Anything more involved than a bare reference (`${P:-/tmp}`, `$P/sub`) is
 * refused, for the same reason `plainArgument` refuses a substitution.
 */
function variableValue(raw: string | null, known: Map<string, string>): string | null {
    if (!raw) {
        return null;
    }

    const quoted = /^(['"])(.*)\1$/.exec(raw);

    if (quoted?.[1] === "'") {
        return null;
    }

    const match = VARIABLE.exec(quoted?.[2] ?? raw);
    const name = match?.[1] ?? match?.[2];

    return name ? (known.get(name) ?? null) : null;
}

/** Each `cd` argument the command names, in order, read from the ORIGINAL text. */
function cdTargets(command: string): string[] {
    const targets: string[] = [];
    const scanned = scan(command, "a cd target");

    if (!scanned) {
        return targets;
    }

    const known = new Map<string, string>();

    for (const unit of scanned.units) {
        for (const statement of unit) {
            const elements = splitPipeline(statement);

            for (const element of elements) {
                const tokens = tokenize(element);
                const index = commandTokenIndex(tokens);
                const token = index === -1 ? undefined : tokens[index];

                if (token && commandWord(token.text) === "cd") {
                    const raw = nextRawArgument(command, token.start + token.text.length);
                    const target = plainArgument(raw) ?? variableValue(raw, known) ?? expandVariable(raw, known);

                    if (target) {
                        targets.push(target);
                    }
                }

                // A pipeline stage runs in a subshell: its assignments end with it.
                if (elements.length === 1) {
                    applyAssignments({ command, tokens, known });
                }
            }
        }
    }

    return targets;
}

/**
 * Every directory this command could have worked in: the session cwd, plus the target of
 * EVERY `cd` it names, relative ones included.
 *
 * A directory that does not exist cannot be one the command changed, so it is dropped here.
 * That is also the backstop for a target the raw read got wrong in a way `plainArgument` did
 * not catch.
 */
export function commandDirs(command: string, cwd: string): string[] {
    const dirs = [cwd];
    // A relative `cd` moves from wherever the PREVIOUS one landed: `cd packages && cd api` works
    // in `<cwd>/packages/api`, which resolving both against the session cwd never finds. The
    // session cwd stays the fallback for a `cd` that ran in a subshell, which the text alone
    // cannot always tell apart; a guess that does not exist is dropped below either way.
    let current = cwd;

    for (const target of cdTargets(command)) {
        const candidates = isAbsolute(target) ? [target] : [resolve(current, target), resolve(cwd, target)];
        const dir = candidates.find((candidate) => existsSync(candidate));

        if (!dir) {
            continue;
        }

        current = dir;

        if (!dirs.includes(dir)) {
            dirs.push(dir);
        }
    }

    return dirs;
}

/** `~` and `~/x` only. `~user` is a different lookup and is left alone. */
function expandHome(value: string): string {
    if (value === "~") {
        return homedir();
    }

    return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
}

/**
 * A flag's value when it carries one: `--out=/tmp/x` names `/tmp/x`. The flag itself never
 * names a path, so the part before `=` is dropped rather than tested.
 */
function flagValue(value: string): string {
    if (!value.startsWith("-")) {
        return value;
    }

    const eq = value.indexOf("=");

    return eq === -1 ? value : value.slice(eq + 1);
}

/**
 * A candidate only needs to LOOK like a path here; whether it exists is the caller's test.
 *
 * A URL is excluded because `https://host/p` resolves to a real-looking relative path. A
 * newline is excluded because a quoted argument that spans lines is prose, never a path: a
 * commit message or a heredoc-ish string, and reading one as a path only burns a slot.
 * A space is NOT excluded, because `/Users/x/My Notes/a.md` is a real path people pass.
 */
function pathShaped(value: string): boolean {
    return value.includes("/") && !value.includes("://") && !value.includes("\n");
}

/** `$NAME/rest` or `${NAME}/rest`: a variable reference, then a plain remainder. `$V}` and `${V` are not. */
const VARIABLE_PREFIX = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(\/[^"'\\$`]*)?$/;

/**
 * A path that starts with a variable the command set to a plain value earlier (`V=/vault; cat "$V/a.md"`).
 * The same rule as `variableValue`: only the command's own assignments, never the environment, and only
 * a plain remainder, so the result is what the shell saw. Long vault paths are written this way, and
 * refusing them left a sweep's files with no diff (2026-10-01).
 */
function expandVariable(raw: string | null, known: Map<string, string>): string | null {
    if (!raw || known.size === 0) {
        return null;
    }

    const quoted = /^(['"])(.*)\1$/.exec(raw);

    if (quoted?.[1] === "'") {
        return null;
    }

    const match = VARIABLE_PREFIX.exec(quoted?.[2] ?? raw);
    const name = match?.[1] ?? match?.[2];
    const base = name ? known.get(name) : undefined;

    return base ? base + (match?.[3] ?? "") : null;
}

function add({
    into,
    raw,
    bases,
    known = new Map(),
}: {
    into: string[];
    raw: string | null;
    bases: string[];
    known?: Map<string, string>;
}): void {
    // The statement's `;` comes with its last token (`perl -pi … a.ts; echo ok`), and `a.ts;` is a
    // file that never exists, so the edit went unwatched (2026-10-15, a background `perl -pi`).
    const token = raw?.replace(/;+$/, "") ?? null;
    const plain = plainArgument(token) ?? expandVariable(token, known);

    if (plain === null) {
        return;
    }

    // `P=/some/dir` is an assignment, not an argument. Reading it as a path joined the whole
    // token onto the cwd and produced `<cwd>/P=/some/dir`, which can never exist and cost one
    // of the few named slots. The assignment itself is followed by `applyAssignments` instead.
    if (ASSIGNMENT.test(plain)) {
        return;
    }

    const value = expandHome(flagValue(plain));

    if (!pathShaped(value)) {
        return;
    }

    if (isAbsolute(value)) {
        if (!into.includes(value)) {
            into.push(value);
        }

        return;
    }

    // A relative path is read against every directory the command works in, because the `cd`
    // that selected one may sit in the same command. The first that exists wins; when none
    // does, the cwd reading is kept so a file the command CREATES is still watched.
    const resolved = bases.map((base) => resolve(base, value));
    const chosen = resolved.find((candidate) => existsSync(candidate)) ?? resolved[0];

    if (chosen && !into.includes(chosen)) {
        into.push(chosen);
    }
}

/**
 * The folder a `git -C <dir> …` element works in, or null. Git reads the element's relative paths
 * against it, so the session cwd, where the same relative path often exists too (a worktree and its
 * main checkout), must not win: `git -C $W add src/a.ts` watched the main checkout's `src/a.ts`,
 * and a merge there then rendered as this command's named edit (2026-10-15). Only the options
 * before the subcommand count, because `git commit -C <commit>` reuses a commit message.
 */
function gitDirectory({
    command,
    tokens,
    bases,
    known,
}: {
    command: string;
    tokens: Span[];
    bases: string[];
    known: Map<string, string>;
}): string | null {
    const index = commandTokenIndex(tokens);
    const word = index === -1 ? undefined : tokens[index];

    if (!word || commandWord(word.text) !== "git") {
        return null;
    }

    let dir: string | null = null;

    for (let at = index + 1; at < tokens.length; at += 1) {
        const token = tokens[at] as Span;
        const text = rawToken(command, token);

        if (text !== "-C" && text !== "-c") {
            if (text.startsWith("-")) {
                continue;
            }

            break;
        }

        const raw = nextRawArgument(command, token.start + token.text.length);
        const next = tokens[at + 1];

        // An unquoted value is the next token. A quoted one was blanked and has no token.
        if (next && raw !== null && rawToken(command, next) === raw) {
            at += 1;
        }

        if (text === "-c") {
            continue;
        }

        const value = plainArgument(raw) ?? variableValue(raw, known) ?? expandVariable(raw, known);

        if (!value) {
            return null;
        }

        // `git -C a -C b` works in `a/b`.
        const from: string[] = dir ? [dir] : bases;
        const candidates: string[] = isAbsolute(value) ? [value] : from.map((base) => resolve(base, value));
        dir = candidates.find((candidate) => existsSync(candidate)) ?? null;

        if (!dir) {
            return null;
        }
    }

    return dir;
}

/**
 * Absolute paths the command NAMES, plus relative ones resolved against `bases`.
 *
 * Two reads per token, because the two shapes need different handling. `rawToken` recovers an
 * unquoted token (`tee /tmp/x`), and `nextRawArgument` recovers the argument AFTER it, which
 * is how a quoted path is found at all: the scanner blanks a quoted span, so `"…/note.md"`
 * produces no token of its own.
 */
export function namedArguments(command: string, bases: string[]): string[] {
    const found = walkNamed({ command, bases, readings: false }).found;

    return [...new Set([...found, ...scriptPaths(command)])];
}

const INTERPRETER = /^(?:python[0-9.]*|node|bun|deno|perl|ruby|php)$/;
const HEREDOC_OPENER = /<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
const INLINE_SCRIPT =
    /(?:^|[\s;&|(])(?:\S*\/)?(?:python[0-9.]*|node|bun|deno|perl|ruby|php)(?:\s+-[A-Za-z-]+)*?\s+(?:-c|-e|-r|--eval)\s+(['"])/g;
const SCRIPT_LITERAL = /(["'`])((?:~\/|\/)[^"'`\n]+)\1/g;

/**
 * Existing files named by a quoted absolute or `~/` literal inside a script an interpreter RUNS:
 * the body of `python3 - <<'EOF'` (no script file, so the heredoc is the program) and the
 * argument of `-c`/`-e`/`-r`/`--eval`. The scanner blanks both, so `open(os.path.expanduser(
 * '~/.ssh/config'),'w')` in a heredoc edited a file outside every repository with no diff
 * (2026-10-20, session be21be54). A heredoc fed to a command with a script file (`bun cli.ts
 * <<'SPEC'`) stays data. Only files that exist now: a literal that names nothing (`"/api/x"`)
 * would only take one of the few named slots, and a creation found this way is not shown anyway.
 */
export function scriptPaths(command: string): string[] {
    const found: string[] = [];

    for (const script of [...interpreterHeredocs(command), ...inlineScripts(command)]) {
        for (const match of script.matchAll(SCRIPT_LITERAL)) {
            const value = match[2] ?? "";

            if (/[$*?{}%\\]/.test(value) || value.includes("://")) {
                continue;
            }

            const path = expandHome(value);

            if (!found.includes(path) && isFile(path)) {
                found.push(path);
            }
        }
    }

    return found;
}

function isFile(path: string): boolean {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function interpreterHeredocs(command: string): string[] {
    const lines = command.split("\n");
    const bodies: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const opener = HEREDOC_OPENER.exec(line);

        if (!opener || !runsStdin(lastSimpleCommandOnLine(line.slice(0, opener.index)))) {
            continue;
        }

        const body: string[] = [];
        const delim = opener[3];
        let j = i + 1;

        for (; j < lines.length; j++) {
            const text = lines[j] ?? "";

            if ((opener[1] === "-" ? text.replace(/^\t+/, "") : text) === delim) {
                break;
            }

            body.push(text);
        }

        bodies.push(body.join("\n"));
        i = j;
    }

    return bodies;
}

/** `python3 -`, `node`, `env X=1 perl -w`: an interpreter whose arguments are all flags, so it reads its program from stdin. */
function runsStdin(simple: string): boolean {
    const words = simple.split(/\s+/).filter((word) => word && !ASSIGNMENT.test(word));

    if (words[0] === "env") {
        words.shift();
    }

    const program = words[0]?.split("/").pop() ?? "";

    return (
        INTERPRETER.test(program) && words.slice(1).every((word) => word.startsWith("-") && !/^-(c|e|r)$/.test(word))
    );
}

function inlineScripts(command: string): string[] {
    const scripts: string[] = [];

    for (const match of command.matchAll(INLINE_SCRIPT)) {
        const quote = match[1] ?? "'";
        const start = (match.index ?? 0) + match[0].length;
        let end = start;

        // A single-quoted span has no escapes in the shell; a double-quoted one ends at the first unescaped quote.
        while (end < command.length && command[end] !== quote) {
            end += quote === '"' && command[end] === "\\" ? 2 : 1;
        }

        scripts.push(command.slice(start, end));
    }

    return scripts;
}

/**
 * What the relative paths of a `git -C <dir>` element name: `scoped`, read inside `<dir>`, and
 * `misread`, the same tokens read against each of `bases` the way a parser that ignores `-C`
 * reads them, minus every path the rest of the command names. `mentionsOf` reads tokens out of
 * the text with no statement structure, so it drops `misread` and adds `scoped`: through it,
 * `git -C /other add src/a.ts` still named `main/src/a.ts` (eve on #520, 2026-10-15).
 */
export function gitDirReadings(command: string, bases: string[]): { scoped: string[]; misread: string[] } {
    if (!command.includes("-C")) {
        return { scoped: [], misread: [] };
    }

    const walked = walkNamed({ command, bases, readings: true });
    const kept = new Set([...walked.found, ...walked.outside]);

    return { scoped: walked.scoped, misread: walked.misread.filter((path) => !kept.has(path)) };
}

interface Walked {
    found: string[];
    /** Relative tokens of `git -C` elements, read inside their folder. */
    scoped: string[];
    /** The same tokens read against every base. */
    misread: string[];
    /** Every other token read against every base, so a path named outside `git -C` is kept. */
    outside: string[];
}

function walkNamed({ command, bases, readings }: { command: string; bases: string[]; readings: boolean }): Walked {
    const walked: Walked = { found: [], scoped: [], misread: [], outside: [] };
    const scanned = scan(command, "named paths");

    if (!scanned) {
        return walked;
    }

    const known = new Map<string, string>();

    for (const unit of scanned.units) {
        for (const statement of unit) {
            const elements = splitPipeline(statement);

            for (const element of elements) {
                const tokens = tokenize(element);
                const gitDir = gitDirectory({ command, tokens, bases, known });
                const from = gitDir ? [gitDir] : bases;

                for (const token of tokens) {
                    for (const raw of [
                        rawToken(command, token),
                        nextRawArgument(command, token.start + token.text.length),
                    ]) {
                        add({ into: walked.found, raw, bases: from, known });

                        if (!readings) {
                            continue;
                        }

                        for (const base of bases) {
                            add({ into: gitDir ? walked.misread : walked.outside, raw, bases: [base], known });
                        }

                        if (gitDir) {
                            add({ into: walked.scoped, raw, bases: [gitDir], known });
                        }
                    }
                }

                // A pipeline stage runs in a subshell: its assignments end with it.
                if (elements.length === 1) {
                    applyAssignments({ command, tokens, known });
                }
            }
        }
    }

    return walked;
}
