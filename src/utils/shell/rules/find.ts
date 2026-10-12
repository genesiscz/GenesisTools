// `find` / `fd` / `rg` / `grep -r` started from the filesystem root or the home root.
//
// A global walk opens hundreds of thousands of vnodes (macOS caps them with
// kern.maxvnodes, about 263000 by default) and can starve every other process of
// file handles: MCP servers have dropped with ENFILE mid-session. The home-wide
// answer is `mdfind -name`; otherwise scope to the repo or /tmp.

import {
    commandTokenIndex,
    commandWord,
    nextRawArgument,
    originalSlice,
    rawToken,
    type Span,
    splitPipeline,
    tokenize,
} from "../scan";
import type { ShellMatch, ShellRule } from "./types";

// `/`, `~`, `~/`, `$HOME`, `${HOME}`, `/Users/<name>`, `/home/<name>` with or
// without a trailing slash. Anything deeper (`~/Downloads`, `/tmp`) is scoped and fine.
const ROOT_PATH = /^(\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\/(?:Users|home)\/[^/\s]+\/?)$/;

// fd flags that take a value, so the value is not mistaken for the search path.
const FD_VALUE_FLAGS = new Set([
    "-e",
    "--extension",
    "-t",
    "--type",
    "-d",
    "--max-depth",
    "--min-depth",
    "-E",
    "--exclude",
    "-x",
    "--exec",
    "-X",
    "--exec-batch",
    "-j",
    "--threads",
    "--base-directory",
    "--search-path",
    "--color",
    "-S",
    "--size",
    "--changed-within",
    "--changed-before",
    "-o",
    "--owner",
]);
// The two flags that NAME a search root. Their value was skipped with the others, so
// `fd --search-path ~ x` walked the whole home directory unchallenged.
const FD_ROOT_FLAGS = new Set(["--base-directory", "--search-path"]);

// The value after -name / -iname, read from the original command because a
// quoted pattern (`-iname 'report.har'`) is blank in the cleaned text.
function firstNameArgument(command: string, tokens: Span[]): string | null {
    for (const token of tokens) {
        if (token.text === "-name" || token.text === "-iname") {
            return nextRawArgument(command, token.start + token.text.length);
        }
    }

    return null;
}

export const findFromRoot: ShellRule = {
    id: "find-from-root",
    kind: "destructive",
    title: "find/fd started at /, ~ or the home root walks the whole filesystem",
    severity: "block",
    why:
        "find and fd from / or ~ visit every directory on the disk. That opens hundreds of thousands of " +
        "vnodes, can starve other processes of file handles (MCP servers have dropped with ENFILE " +
        'mid-session), and takes so long that the call usually gets cut off or read as "nothing found". ' +
        "On macOS Spotlight already indexes the home directory: `mdfind -name <pattern>` answers in milliseconds.",
    wrong: "find ~ -iname 'report.har' 2>/dev/null | head",
    right: "mdfind -name 'report.har'   # or scope it: find ~/Downloads -maxdepth 2 -iname 'report.har'",
    evidence:
        "Coding agents suggest `find ~ -iname` as the first answer when asked to locate a file. A 30-day " +
        "transcript corpus held 14 real invocations, every one `find /`, `find ~` or `find /Users/<name>`, " +
        "most with -maxdepth and `2>/dev/null | head` on the end.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!statement.text.includes("find") && !statement.text.includes("fd")) {
                    continue;
                }

                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens);

                    if (cmd === -1) {
                        continue;
                    }

                    const word = commandWord(tokens[cmd].text);

                    if (word !== "find" && word !== "fd") {
                        continue;
                    }

                    // Compare the raw spelling: `"$HOME/.codex"` scans as `$HOME`. A fully
                    // quoted literal root (`find "/"`) leaves no token at all and is not
                    // seen; nobody types that.
                    const args = tokens.slice(cmd + 1).map((t) => ({ ...t, text: rawToken(scan.command, t) }));
                    let rootToken: (typeof args)[number] | undefined;

                    if (word === "find") {
                        // find [-H|-L|-P|-E…] <paths…> <expression>: paths come first, before the
                        // first token that starts with `-` and is an expression primary.
                        for (const arg of args) {
                            if (/^-[HLPEXdsx]+$/.test(arg.text)) {
                                continue;
                            }

                            if (arg.text.startsWith("-") || arg.text === "(" || arg.text === "!") {
                                break;
                            }

                            if (ROOT_PATH.test(arg.text)) {
                                rootToken = arg;
                                break;
                            }
                        }
                    } else {
                        // fd [flags] [pattern] [path…]: skip flags and their values, then the
                        // first positional is the pattern, the rest are search paths.
                        let positional = 0;

                        for (let i = 0; i < args.length; i++) {
                            const text = args[i].text;

                            if (text.startsWith("-")) {
                                const [flag, inline] = text.split("=", 2);

                                if (FD_ROOT_FLAGS.has(flag ?? "")) {
                                    const value = inline ?? args[i + 1]?.text;

                                    if (value !== undefined && ROOT_PATH.test(value)) {
                                        rootToken = inline === undefined ? args[i + 1] : args[i];
                                        break;
                                    }
                                }

                                if (FD_VALUE_FLAGS.has(text)) {
                                    i++;
                                }

                                continue;
                            }

                            positional++;

                            if (positional === 1 && !ROOT_PATH.test(text)) {
                                continue;
                            }

                            if (ROOT_PATH.test(text)) {
                                rootToken = args[i];
                                break;
                            }
                        }
                    }

                    if (!rootToken) {
                        continue;
                    }

                    const matched = originalSlice(scan, tokens[cmd].start, element.start + element.text.length);
                    const name = word === "find" ? firstNameArgument(scan.command, tokens.slice(cmd + 1)) : null;
                    const suggestion = name ? `mdfind -name ${name}` : undefined;

                    return { matched, index: tokens[cmd].start, ...(suggestion ? { suggestion } : {}) };
                }
            }
        }

        return null;
    },
};

// rg and grep flags that take the next token as their value, so the value is not read as a path.
const RG_VALUE_FLAGS = new Set([
    "-A",
    "-B",
    "-C",
    "-d",
    "-E",
    "-e",
    "-f",
    "-g",
    "-j",
    "-M",
    "-m",
    "-t",
    "-T",
    "--after-context",
    "--before-context",
    "--context",
    "--max-depth",
    "--encoding",
    "--regexp",
    "--file",
    "--glob",
    "--iglob",
    "--threads",
    "--max-columns",
    "--max-count",
    "--type",
    "--type-not",
    "--type-add",
    "--sort",
    "--sortr",
    "--color",
    "--colors",
    "--max-filesize",
    "--pre",
    "--pre-glob",
    "--ignore-file",
    "--engine",
    "--path-separator",
    "--context-separator",
    "--field-match-separator",
]);
const GREP_VALUE_FLAGS = new Set([
    "-A",
    "-B",
    "-C",
    "-D",
    "-d",
    "-e",
    "-f",
    "-m",
    "--regexp",
    "--file",
    "--max-count",
    "--include",
    "--exclude",
    "--exclude-dir",
    "--directories",
    "--devices",
    "--context",
    "--after-context",
    "--before-context",
]);
// Short flags whose value is the rest of the cluster (`-C3`) or the next token (`-nC 3`).
const SHORT_VALUE_LETTERS = { rg: "ABCdEefgjMmtT", grep: "ABCDdefm" } as const;
// A pattern given by flag: every positional is then a path.
const PATTERN_FLAGS = new Set(["-e", "-f", "--regexp", "--file", "--files", "--type-list"]);

interface SearchArgs {
    positional: Span[];
    patternByFlag: boolean;
    recursive: boolean;
}

// Walks the arguments the way rg and grep read them: flags, their values, then positionals.
function searchArgs(command: string, args: Span[], tool: "rg" | "grep"): SearchArgs {
    const valueFlags = tool === "rg" ? RG_VALUE_FLAGS : GREP_VALUE_FLAGS;
    const valueLetters = SHORT_VALUE_LETTERS[tool];
    const positional: Span[] = [];
    let patternByFlag = false;
    let recursive = tool === "rg";

    for (let i = 0; i < args.length; i++) {
        const text = rawToken(command, args[i]);

        if (text === "--") {
            positional.push(...args.slice(i + 1));
            break;
        }

        if (text.startsWith("--")) {
            const [flag = ""] = text.split("=", 1);

            if (PATTERN_FLAGS.has(flag)) {
                patternByFlag = true;
            }

            if (flag === "--recursive" || flag === "--dereference-recursive" || text === "--directories=recurse") {
                recursive = true;
            }

            if (valueFlags.has(flag) && !text.includes("=")) {
                i++;
            }

            continue;
        }

        if (text.startsWith("-") && text.length > 1) {
            // A cluster such as `-rn`, `-nC3` or `-ie`: the first value letter takes the rest.
            for (let k = 1; k < text.length; k++) {
                const letter = text[k] ?? "";

                if (tool === "grep" && (letter === "r" || letter === "R")) {
                    recursive = true;
                }

                if (!valueLetters.includes(letter)) {
                    continue;
                }

                if (letter === "e" || letter === "f") {
                    patternByFlag = true;
                }

                if (k === text.length - 1) {
                    if (
                        tool === "grep" &&
                        letter === "d" &&
                        args[i + 1] &&
                        rawToken(command, args[i + 1]) === "recurse"
                    ) {
                        recursive = true;
                    }

                    i++;
                }

                break;
            }

            continue;
        }

        positional.push(args[i]);
    }

    return { positional, patternByFlag, recursive };
}

export const searchFromRoot: ShellRule = {
    id: "search-from-root",
    kind: "destructive",
    title: "rg or grep -r started at /, ~ or the home root reads every file on the disk",
    severity: "block",
    why:
        "rg, and grep with -r, from / or ~ open every file under it. That is the same vnode storm as find from " +
        "the root (other processes can run out of file handles), it reads every byte of every file, and it runs " +
        'so long that the call is cut off and its partial output read as "not found". Search the project you ' +
        "are in, or the folder the user named; for a file name use `mdfind -name` (macOS) or a scoped fd.",
    wrong: "rg -l 'API_TOKEN' ~",
    right: "rg -l 'API_TOKEN' ~/Projects/app   # the folder that can hold it",
    evidence:
        "Ported from the home-search guard this registry replaced, which caught rg and grep rooted at the home " +
        "folder beside the find and fd cases that find-from-root holds.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!statement.text.includes("rg") && !statement.text.includes("grep")) {
                    continue;
                }

                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens);

                    if (cmd === -1) {
                        continue;
                    }

                    const word = commandWord(tokens[cmd].text);

                    if (word !== "rg" && word !== "grep") {
                        continue;
                    }

                    const parsed = searchArgs(scan.command, tokens.slice(cmd + 1), word);

                    if (!parsed.recursive) {
                        continue;
                    }

                    // The pattern is the first positional unless a flag gave it. A QUOTED pattern
                    // leaves no token in the scan, so a lone positional after a quote is a path.
                    const first = parsed.positional[0];
                    const quotedBefore =
                        first !== undefined && /["']/.test(scan.command.slice(tokens[cmd].start, first.start));
                    const paths =
                        parsed.patternByFlag || (parsed.positional.length === 1 && quotedBefore)
                            ? parsed.positional
                            : parsed.positional.slice(1);
                    const root = paths.find((path) => ROOT_PATH.test(rawToken(scan.command, path)));

                    if (!root) {
                        continue;
                    }

                    const matched = originalSlice(scan, tokens[cmd].start, element.start + element.text.length);

                    return { matched, index: tokens[cmd].start };
                }
            }
        }

        return null;
    },
};

export const findRules: readonly ShellRule[] = [findFromRoot, searchFromRoot];
