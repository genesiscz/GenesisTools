// `find` / `fd` started from the filesystem root or the home root.
//
// A global walk pins hundreds of thousands of vnodes (kern.maxvnodes ≈ 263168 on
// this Mac) and has disconnected MCP servers with ENFILE mid-session. The
// home-wide answer is `mdfind -name`; otherwise scope to the repo or /tmp.

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

// `/`, `~`, `~/`, `$HOME`, `${HOME}`, `/Users/<name>` with or without a
// trailing slash. Anything deeper (`~/Downloads`, `/tmp`) is scoped and fine.
const ROOT_PATH = /^(\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\/Users\/[^/\s]+\/?)$/;

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
        "find and fd from / or ~ visit every directory on the disk. On this machine that pins hundreds of " +
        "thousands of vnodes and has disconnected MCP servers with ENFILE mid-session, and it takes so " +
        'long that the call usually gets cut off or read as "nothing found". Spotlight already indexes ' +
        "the home directory: `mdfind -name <pattern>` answers in milliseconds.",
    wrong: "find ~ -iname 'report.har' 2>/dev/null | head",
    right: "mdfind -name 'report.har'   # or scope it: find ~/Downloads -maxdepth 2 -iname 'report.har'",
    evidence:
        "CLAUDE.md: Opus 5 recommends `find ~ -iname` as its first answer when asked to locate a file. " +
        "14 real invocations in 30 days (Claude 13, Grok 1), every one `find /`, `find ~` or `find /Users/Martin`, " +
        "most with -maxdepth and `2>/dev/null | head` on the end.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
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

export const findRules: readonly ShellRule[] = [findFromRoot];
