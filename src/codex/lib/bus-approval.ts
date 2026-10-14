/**
 * Which `--write ask` approval requests are the worker's own bus commands.
 *
 * The injected contract tells every worker to report in with `tools agents message` as its first action, and
 * `untrusted` asks before any command outside Codex's read-only set. So the first command of every `ask`
 * worker paused for the lead's approval (observed 2026-10-13, approval_request 0). The daemon accepts a
 * command itself only when it is exactly one of the seeded verbs, run as this worker in its own swarm, and
 * holds nothing a shell would expand or chain. Anything else still goes to the lead.
 */

/** Characters a bare (unquoted) word may hold: no expansion, globbing, redirection or chaining. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]$/;

/**
 * The words of one simple command, or null when the text holds anything beyond plain words: an operator,
 * a redirection, a newline, an expansion (`$`, backtick, `~`, globs) or an escape. Single quotes are literal;
 * double quotes are accepted only when nothing inside them would be expanded or escaped.
 */
export function strictShellWords(command: string): string[] | null {
    const words: string[] = [];
    let word: string | null = null;
    let index = 0;

    while (index < command.length) {
        const char = command[index];

        if (char === " " || char === "\t") {
            if (word !== null) {
                words.push(word);
                word = null;
            }

            index += 1;
            continue;
        }

        if (char === "'" || char === '"') {
            const end = command.indexOf(char, index + 1);

            if (end === -1) {
                return null;
            }

            const inner = command.slice(index + 1, end);

            if (char === '"' && /[$`\\!]/.test(inner)) {
                return null;
            }

            word = (word ?? "") + inner;
            index = end + 1;
            continue;
        }

        if (!BARE.test(char)) {
            return null;
        }

        word = (word ?? "") + char;
        index += 1;
    }

    if (word !== null) {
        words.push(word);
    }

    return words;
}

const TRUSTED_SHELLS = new Set(["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"]);

/** Flags each verb may carry; `true` = takes a value. The identity flag is checked separately. */
const VERB_FLAGS: Record<string, Record<string, boolean>> = {
    message: { "--from": true, "--to": true, "--body": true, "--body-file": true, "--reply": true, "--session": true },
    request: {
        "--from": true,
        "--to": true,
        "--body": true,
        "--body-file": true,
        "--timeout": true,
        "--session": true,
    },
    login: { "--agent-name": true, "--once": false, "--session": true, "--format": true, "--kinds": true },
    leave: { "--agent-name": true, "--note": true, "--session": true },
};

const IDENTITY_FLAG: Record<string, string> = {
    message: "--from",
    request: "--from",
    login: "--agent-name",
    leave: "--agent-name",
};

/** True when `command` is a seeded `tools agents` verb run as `agentName` in `session`, and nothing more. */
export function isOwnBusCommand(command: string, bus: { agentName: string; session: string }): boolean {
    const outer = strictShellWords(command);

    if (!outer) {
        return false;
    }

    const words =
        outer.length === 3 && TRUSTED_SHELLS.has(outer[0]) && (outer[1] === "-lc" || outer[1] === "-c")
            ? strictShellWords(outer[2])
            : outer;

    if (words?.[0] !== "tools" || words[1] !== "agents") {
        return false;
    }

    const verb = words[2];
    const allowed = VERB_FLAGS[verb];

    if (!allowed) {
        return false;
    }

    const values = new Map<string, string>();

    for (let index = 3; index < words.length; index += 1) {
        const [flag, inline] = words[index].split(/=(.*)/s, 2);

        if (!(flag in allowed)) {
            return false;
        }

        if (!allowed[flag]) {
            if (inline !== undefined) {
                return false;
            }

            continue;
        }

        const value = inline ?? words[index + 1];

        if (value === undefined || values.has(flag)) {
            return false;
        }

        values.set(flag, value);

        if (inline === undefined) {
            index += 1;
        }
    }

    return values.get(IDENTITY_FLAG[verb]) === bus.agentName && values.get("--session") === bus.session;
}
/**
 * The segments of a shell script, split at a newline, `;`, `|`, `||` and `&&` outside quotes, or null when it
 * runs anything in the background (`&`) or leaves a quote open. The `&` of a descriptor redirect (`2>&1`, `&>`) is
 * not a background job. Each segment still goes through {@link readOnlyWords}.
 */
function scriptSegments(script: string): string[] | null {
    const segments: string[] = [];
    let current = "";
    let quote: string | null = null;

    for (let index = 0; index < script.length; index += 1) {
        const char = script[index];

        if (quote) {
            current += char;

            if (quote === '"' && char === "\\") {
                current += script[index + 1] ?? "";
                index += 1;
            } else if (char === quote) {
                quote = null;
            }

            continue;
        }

        if (char === "\\") {
            current += script.slice(index, index + 2);
            index += 1;
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            current += char;
            continue;
        }

        // A quote in a shell comment is not a quote delimiter. Leave commented scripts to the lead.
        if (char === "#") {
            return null;
        }

        const pair = script.slice(index, index + 2);

        if (pair === "&&" || pair === "||") {
            segments.push(current);
            current = "";
            index += 1;
            continue;
        }

        if (char === "&" && script[index - 1] !== ">" && script[index + 1] !== ">") {
            return null;
        }

        if (char === "\n" || char === ";" || char === "|") {
            segments.push(current);
            current = "";
            continue;
        }

        current += char;
    }

    if (quote) {
        return null;
    }

    segments.push(current);

    return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** Globs can expand into executable options (e.g. rg --pre), so only literal words and tilde paths qualify. */
const READ_BARE = /^[A-Za-z0-9_@%+=:,./~#!-]$/;
/** Redirects that write nothing: an error stream or output thrown away, or one stream joined to the other. */
const DISCARD_REDIRECT = /(^|\s)(\d?>|&>)(\/dev\/null|&[12])(?=\s|$)/g;

/**
 * The words of a read-only command, quotes removed and escapes resolved, or null when it holds anything that runs
 * or writes: an expansion (`$`, backtick), a redirection (other than to `/dev/null`), a subshell or a brace.
 * Unlike {@link strictShellWords}, it takes `~` and backslash escapes. Unquoted globs require lead approval.
 */
function readOnlyWords(text: string): string[] | null {
    const words: string[] = [];
    const source = text.replace(DISCARD_REDIRECT, " ");
    let word: string | null = null;
    let index = 0;

    while (index < source.length) {
        const char = source[index];

        if (char === " " || char === "\t" || char === "\n") {
            if (word !== null) {
                words.push(word);
                word = null;
            }

            index += 1;
            continue;
        }

        if (char === "'") {
            const end = source.indexOf("'", index + 1);

            if (end === -1) {
                return null;
            }

            word = (word ?? "") + source.slice(index + 1, end);
            index = end + 1;
            continue;
        }

        if (char === '"') {
            let value = "";
            index += 1;

            while (index < source.length && source[index] !== '"') {
                const inner = source[index];

                if (inner === "$" || inner === "`") {
                    return null;
                }

                if (inner === "\\" && '$`"\\'.includes(source[index + 1] ?? "")) {
                    value += source[index + 1];
                    index += 2;
                    continue;
                }

                value += inner;
                index += 1;
            }

            if (index >= source.length) {
                return null;
            }

            word = (word ?? "") + value;
            index += 1;
            continue;
        }

        if (char === "\\") {
            if (index + 1 >= source.length) {
                return null;
            }

            word = (word ?? "") + source[index + 1];
            index += 2;
            continue;
        }

        if (!READ_BARE.test(char)) {
            return null;
        }

        word = (word ?? "") + char;
        index += 1;
    }

    if (word !== null) {
        words.push(word);
    }

    return words;
}

/** `sed -n` with one line-range print script (`sed -n '120,180p' file`): nothing else that sed can write with. */
function readOnlySed(args: string[]): boolean {
    const [flag, script, ...files] = args;

    return (
        flag === "-n" && /^(\d+|\$)(,(\d+|\$))?p$/.test(script ?? "") && files.every((file) => !file.startsWith("-"))
    );
}

const READ_ONLY_GIT = new Set([
    "status",
    "diff",
    "log",
    "show",
    "blame",
    "rev-parse",
    "ls-files",
    "grep",
    "describe",
    "merge-base",
    "rev-list",
    "cat-file",
    "shortlog",
]);
const READ_ONLY_GIT_BRANCH_FLAGS = new Set(["--show-current", "--list", "-a", "-r", "-v", "-vv"]);

/** A git subcommand that only reads, with no `-c` (a config value can name a program) and no `--output=<file>`. */
function readOnlyGit(args: string[]): boolean {
    let index = 0;

    while (args[index] === "-C" || args[index] === "--no-pager") {
        index += args[index] === "-C" ? 2 : 1;
    }

    const [subcommand, ...rest] = args.slice(index);

    if (!subcommand || rest.some((arg) => arg.startsWith("--output"))) {
        return false;
    }

    if (subcommand === "branch") {
        return rest.every((arg) => READ_ONLY_GIT_BRANCH_FLAGS.has(arg));
    }

    if (!READ_ONLY_GIT.has(subcommand)) {
        return false;
    }

    // These commands enable configured text converters by default.
    if (["diff", "show", "log", "blame", "grep"].includes(subcommand) && !rest.includes("--no-textconv")) {
        return false;
    }

    if (["diff", "show", "log"].includes(subcommand) && !rest.includes("--no-ext-diff")) {
        return false;
    }

    const flags: Record<string, readonly string[]> = {
        status: ["--short", "--porcelain", "--porcelain=v1", "--porcelain=v2", "-s", "-b", "--branch"],
        diff: [
            "--stat",
            "--name-only",
            "--name-status",
            "--cached",
            "--staged",
            "--check",
            "--no-ext-diff",
            "--no-textconv",
        ],
        log: ["--oneline", "--all", "--decorate", "--graph", "--no-ext-diff", "--no-textconv"],
        show: ["--stat", "--name-only", "--no-ext-diff", "--no-textconv"],
        blame: ["--no-textconv", "-p", "--line-porcelain"],
        grep: ["--no-textconv", "-n", "-l", "-i", "-F", "-E", "-w"],
        "rev-parse": ["--show-toplevel", "--git-common-dir", "--show-prefix", "--verify", "--short"],
        "ls-files": ["--others", "--exclude-standard", "--stage", "--cached", "-z"],
        describe: ["--always", "--tags", "--dirty"],
        "merge-base": ["--is-ancestor", "--all"],
        "rev-list": ["--count", "--all"],
        "cat-file": ["-p", "-t", "-s", "-e"],
        shortlog: ["-s", "-n", "-sn", "--all"],
    };
    return rest.every(
        (arg) =>
            !arg.startsWith("-") ||
            arg === "--" ||
            flags[subcommand]?.includes(arg) ||
            (["log", "rev-list"].includes(subcommand) && /^-\d+$/.test(arg))
    );
}

/** Commands that only read, each with the arguments that would make it write or run another program. */
const READ_ONLY_COMMANDS: Record<string, (args: string[]) => boolean> = {
    cat: () => true,
    head: () => true,
    tail: () => true,
    wc: () => true,
    nl: () => true,
    ls: () => true,
    pwd: () => true,
    stat: () => true,
    cd: () => true,
    grep: () => true,
    // `--pre` runs a program on every file it searches.
    rg: (args) => !args.some((arg) => arg.startsWith("--pre")),
    find: (args) => !args.some((arg) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(arg)),
    sed: readOnlySed,
    git: readOnlyGit,
};

/**
 * True when `command` (usually `/bin/zsh -lc '<script>'`) only reads: every segment of the script is a command from
 * {@link READ_ONLY_COMMANDS} with plain words, no redirection, expansion or background job. Codex's own read-only set
 * does not recognise a zsh-wrapped script, so `untrusted` sent every `cat` and `sed -n` to the lead (44 approvals in
 * one 9-minute turn on 2026-10-14).
 */
export function isReadOnlyCommand(command: string): boolean {
    // Shells remove line continuations before recognizing options. Refuse them, including inside wrappers or
    // quotes, so an escaped newline cannot conceal --pre or -exec from the argument checks below.
    if (/\\\r?\n/.test(command)) {
        return false;
    }

    const outer = readOnlyWords(command);
    const script =
        outer?.length === 3 && TRUSTED_SHELLS.has(outer[0]) && (outer[1] === "-lc" || outer[1] === "-c")
            ? outer[2]
            : command;
    const segments = scriptSegments(script);

    if (!segments || segments.length === 0) {
        return false;
    }

    return segments.every((segment) => {
        const words = readOnlyWords(segment);
        const check =
            words?.[0] !== undefined && Object.hasOwn(READ_ONLY_COMMANDS, words[0])
                ? READ_ONLY_COMMANDS[words[0]]
                : undefined;

        return check !== undefined && words !== null && check(words.slice(1));
    });
}
