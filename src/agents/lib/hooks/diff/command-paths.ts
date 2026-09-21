import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
    commandTokenIndex,
    commandWord,
    nextRawArgument,
    rawToken,
    type ShellScan,
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

function scan(command: string, what: string): ShellScan | null {
    try {
        return scanShell(command);
    } catch (err) {
        // A scanner that throws must not cost the capture its cwd root.
        hookDiag(`Could not scan the command for ${what}`, { err });
        return null;
    }
}

/** Each `cd` argument the command names, in order, read from the ORIGINAL text. */
function cdTargets(command: string): string[] {
    const targets: string[] = [];
    const scanned = scan(command, "a cd target");

    if (!scanned) {
        return targets;
    }

    for (const unit of scanned.units) {
        for (const statement of unit) {
            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const index = commandTokenIndex(tokens);
                const token = index === -1 ? undefined : tokens[index];

                if (!token || commandWord(token.text) !== "cd") {
                    continue;
                }

                const target = plainArgument(nextRawArgument(command, token.start + token.text.length));

                if (target) {
                    targets.push(target);
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

    for (const target of cdTargets(command)) {
        const dir = isAbsolute(target) ? target : resolve(cwd, target);

        if (existsSync(dir) && !dirs.includes(dir)) {
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

function add(into: string[], raw: string | null, bases: string[]): void {
    const plain = plainArgument(raw);

    if (plain === null) {
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
 * Absolute paths the command NAMES, plus relative ones resolved against `bases`.
 *
 * Two reads per token, because the two shapes need different handling. `rawToken` recovers an
 * unquoted token (`tee /tmp/x`), and `nextRawArgument` recovers the argument AFTER it, which
 * is how a quoted path is found at all: the scanner blanks a quoted span, so `"…/note.md"`
 * produces no token of its own.
 */
export function namedArguments(command: string, bases: string[]): string[] {
    const found: string[] = [];
    const scanned = scan(command, "named paths");

    if (!scanned) {
        return found;
    }

    for (const unit of scanned.units) {
        for (const statement of unit) {
            for (const element of splitPipeline(statement)) {
                for (const token of tokenize(element)) {
                    add(found, rawToken(command, token), bases);
                    add(found, nextRawArgument(command, token.start + token.text.length), bases);
                }
            }
        }
    }

    return found;
}
