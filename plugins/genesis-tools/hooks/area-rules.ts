#!/usr/bin/env bun

// Claude Code loads an area's rules (`.claude/rules/*.md` by their `paths` globs, and the CLAUDE.md of a
// subfolder) only when a file there is read, written or edited, or viewed whole by a one-file `cat` or `head`.
// A search loads nothing. Measured 2026-10-13 with haiku in this repo: a Grep-only task loaded its area rules in 0
// of 8 runs, a piped `cat` in 0 of 8, and a subagent exploring with `rg` and `sed -n` in 1 of 7. So an agent could
// answer about an area, or a subagent could explore it, without ever seeing that area's rules.
//
// PostToolUse on Bash: a command that writes into an area (a redirect, `sed -i`, fable-replace, an inline script)
// gets the area file once per agent, as its text (`full`) or one pointer line (`pointer`). That write passes
// Claude Code's own loader by, and Codex and Grok have none. A read gets nothing (Martin, 2026-11-11): the full text
// on every search and listing was 51.7% of all hook context in the 10 days before, and a sample of 63 such
// injections found 16 useful. The levels are settings (`areaRules` in `~/.genesis-tools/agents/hooks.json`).
//
// On Read, Write and Edit it only records the areas Claude Code loads by itself, so it does not add them a second
// time. After a compaction the agent that compacted forgets what was added, because the compaction summary does not
// carry the files.

import {
    appendFileSync,
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { byHarness, HARNESS_FACTS, HARNESS_IDS, type Harness } from "../lib/Generated/harness-facts";
import { parseLenientJson } from "./agents-talk-hint";
import { harnessFor, harnessOf } from "./harness";
import { lockWorktreesForToolUse } from "./worktree-lock";

const SafeJSON = JSON;

const MAX_SCAN_CHARS = 200_000;
/** State key prefix: `@compact:<agent>` holds the time of a compaction that agent has not been checked against. */
const COMPACT_MARK = "@compact:";
/** State key prefix: `@pointer:<agent>` holds the areas that agent got as a pointer line only. */
const POINTER_MARK = "@pointer:";
/** How much of a transcript's end the compaction check reads. A boundary sat up to 670 KB before the next rows. */
const TRANSCRIPT_TAIL_BYTES = 4_000_000;
/** A compact_boundary row was stamped at most 0.8 s before its SessionStart hook (146 compactions); the margin. */
const COMPACT_SLACK_MS = 10_000;
const NATIVE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"];

export interface HookPayload {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    source?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: unknown;
    agent_id?: string;
}

export interface AreaRule {
    /** Path relative to the project root. */
    file: string;
    globs: string[];
}

/** How an area file reaches the agent: its whole text, one pointer line, or not at all. */
export type AreaLevel = "full" | "pointer" | "off";
/** What a subagent gets: the same as the main agent, at most a pointer, or nothing. */
export type AreaAgents = "same" | "pointer" | "off";

/** A stored `read` key from the first version of these settings is ignored: a read gets nothing. */
export interface AreaRulesLevels {
    /** A Bash command that writes into the area. */
    write: AreaLevel;
    agents: AreaAgents;
}

/** `areaRules` in `hooks.json`: one set of levels for every harness, and each harness's overrides. */
export interface AreaRulesSettings extends AreaRulesLevels {
    harnesses: { readonly [H in Harness]: Partial<AreaRulesLevels> };
}

export const AREA_LEVELS: readonly AreaLevel[] = ["full", "pointer", "off"];
export const AREA_AGENTS: readonly AreaAgents[] = ["same", "pointer", "off"];

/**
 * The shipped settings. Mirrors `AREA_RULES_HOOK_SECTION.defaults()` in `src/agents/lib/hooks/sections/area-rules.ts`,
 * which this standalone hook cannot import; `hooks.test.ts` holds the two equal.
 */
export const AREA_RULES_DEFAULTS: AreaRulesSettings = {
    write: "full",
    agents: "same",
    harnesses: byHarness(() => ({})),
};

const LEVEL_RANK: Readonly<Record<AreaLevel, number>> = { off: 0, pointer: 1, full: 2 };
const AGENT_CAP: Readonly<Record<AreaAgents, AreaLevel>> = { same: "full", pointer: "pointer", off: "off" };

function lower(a: AreaLevel, b: AreaLevel): AreaLevel {
    return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored value when it is one of `choices` and differs from the copy of the shipped defaults the writer stored
 * beside it (`_shippedDefaults`), else `fallback`: a value equal to that copy was never chosen, so a later default
 * still reaches it. The main loader applies the same rule (`storedOverrides` in `config-section.ts`).
 */
function overrideOf<T extends string>(input: {
    value: unknown;
    shipped: unknown;
    hasShipped: boolean;
    choices: readonly T[];
}): T | undefined {
    const choice = input.choices.find((candidate) => candidate === input.value);
    if (choice === undefined || (input.hasShipped && input.value === input.shipped)) {
        return undefined;
    }

    return choice;
}

/** The levels a stored part sets over its fallback, field by field. */
function levelsOver(
    stored: Record<string, unknown>,
    shipped: Record<string, unknown> | undefined
): Partial<AreaRulesLevels> {
    const field = <T extends string>(key: keyof AreaRulesLevels, choices: readonly T[]) =>
        overrideOf({ value: stored[key], shipped: shipped?.[key], hasShipped: shipped !== undefined, choices });
    const write = field("write", AREA_LEVELS);
    const agents = field("agents", AREA_AGENTS);
    return {
        ...(write ? { write } : {}),
        ...(agents ? { agents } : {}),
    };
}

/** The `areaRules` part of a parsed `hooks.json` merged over the shipped settings. Anything unreadable is ignored. */
export function mergeAreaRules(file: unknown): AreaRulesSettings {
    const root = isRecord(file) ? file : {};
    const stored = isRecord(root.areaRules) ? root.areaRules : {};
    const shippedRoot = isRecord(root._shippedDefaults) ? root._shippedDefaults : undefined;
    const shipped = shippedRoot ? (isRecord(shippedRoot.areaRules) ? shippedRoot.areaRules : {}) : undefined;
    const storedHarnesses = isRecord(stored.harnesses) ? stored.harnesses : {};
    const shippedHarnesses = shipped && isRecord(shipped.harnesses) ? shipped.harnesses : shipped ? {} : undefined;
    const harnesses = { ...AREA_RULES_DEFAULTS.harnesses };

    for (const harness of HARNESS_IDS) {
        const own = storedHarnesses[harness];
        const ownShipped = shippedHarnesses ? shippedHarnesses[harness] : undefined;
        if (isRecord(own)) {
            harnesses[harness] = {
                ...harnesses[harness],
                ...levelsOver(own, shippedHarnesses ? (isRecord(ownShipped) ? ownShipped : {}) : undefined),
            };
        }
    }

    return { ...AREA_RULES_DEFAULTS, ...levelsOver(stored, shipped), harnesses };
}

function hooksConfigPath(): string {
    // Standalone hook script: no access to @genesiscz/utils/env, so process.env directly.
    return join(process.env.GENESIS_TOOLS_HOME || homedir(), ".genesis-tools", "agents", "hooks.json");
}

/** `areaRules` from the hooks config file; the shipped settings when the file is missing or broken. */
export function areaRulesSettings(configPath = hooksConfigPath()): AreaRulesSettings {
    try {
        return mergeAreaRules(parseLenientJson(readFileSync(configPath, "utf8")));
    } catch {
        // No file is the normal case, and a broken one keeps the shipped settings as the main loader does. Nothing
        // is printed: this runs on every tool call, and `tools agents hooks doctor` names a broken file.
        return AREA_RULES_DEFAULTS;
    }
}

/** One harness's levels: its overrides over the shared ones. */
export function levelsFor(settings: AreaRulesSettings, harness: Harness): AreaRulesLevels {
    return {
        write: settings.write,
        agents: settings.agents,
        ...settings.harnesses[harness],
    };
}

/** Whether a Bash call of this agent can add anything at all; false lets the hook exit at once. */
export function canInject(levels: AreaRulesLevels, isSubagent: boolean): boolean {
    const cap = isSubagent ? AGENT_CAP[levels.agents] : "full";
    return lower(levels.write, cap) !== "off";
}

export function projectRoot(start: string): string | null {
    let dir = resolve(start);
    for (;;) {
        if (existsSync(join(dir, ".git"))) {
            return dir;
        }

        const parent = dirname(dir);
        if (parent === dir) {
            return null;
        }

        dir = parent;
    }
}

/** The `paths` list of a rule file's YAML frontmatter: a block list, an inline list, or one string. */
export function frontmatterPaths(text: string): string[] {
    const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
    if (!block) {
        return [];
    }

    const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");
    const inline = block.match(/^paths:[ \t]*(\S.*)$/m)?.[1];
    if (inline) {
        return inline.startsWith("[") ? inline.slice(1, -1).split(",").map(unquote).filter(Boolean) : [unquote(inline)];
    }

    const list = block.match(/^paths:[ \t]*\n((?:[ \t]+-[ \t]+.*\n?)+)/m)?.[1] ?? "";
    return list
        .split("\n")
        .map((line) => line.replace(/^\s+-\s+/, ""))
        .map(unquote)
        .filter(Boolean);
}

export function readRules(root: string): AreaRule[] {
    const rulesDir = join(root, ".claude", "rules");
    const rules: AreaRule[] = [];
    const walk = (dir: string) => {
        let entries: string[];

        try {
            entries = readdirSync(dir);
        } catch {
            // No rules folder is the normal case for most projects.
            return;
        }

        for (const name of entries) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (name.endsWith(".md")) {
                const globs = frontmatterPaths(readFileSync(full, "utf8"));
                if (globs.length > 0) {
                    rules.push({ file: relative(root, full), globs });
                }
            }
        }
    };
    walk(rulesDir);
    return rules;
}

/** Path-like tokens in a command or a tool's output, with any `:line` suffix removed. */
export function pathTokens(text: string): string[] {
    const tokens = new Set<string>();
    for (const match of text
        .slice(0, MAX_SCAN_CHARS)
        .matchAll(/(?:^|[\s'"`=(,])((?:\/|\.{1,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\/?)/gm)) {
        const token = (match[1] ?? "").replace(/:\d+(?::\d+)?$/, "").replace(/\/$/, "");
        if (token && !/^\w+:\/\//.test(token)) {
            tokens.add(token);
        }
    }

    return [...tokens];
}

/** One word of a shell command, or a redirect with the file it names. */
export type ShellToken = { kind: "word"; text: string } | { kind: "redirect"; op: string; target: string };

const WORD_END = /[\s;&|<>()]/;
/** A redirect operator with its optional fd, matched where the scan stands (sticky, so no copy of the rest). */
const REDIRECT = /(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/y;

/** The word starting at `start`, quotes and escapes removed, and where it ends. */
function readWord(text: string, start: number): { word: string; end: number } {
    let word = "";
    let i = start;
    while (i < text.length && !WORD_END.test(text[i] ?? "")) {
        const char = text[i] ?? "";
        if (char === "'") {
            const close = text.indexOf("'", i + 1);
            const end = close === -1 ? text.length : close;
            word += text.slice(i + 1, end);
            i = end + 1;
        } else if (char === '"') {
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === "\\") {
                    i++;
                }

                word += text[i] ?? "";
                i++;
            }

            i++;
        } else if (char === "\\") {
            word += text[i + 1] === "\n" ? "" : (text[i + 1] ?? "");
            i += 2;
        } else if (char === "$" && text[i + 1] === "(") {
            let depth = 0;
            const from = i;
            do {
                if (text[i] === "(") {
                    depth++;
                } else if (text[i] === ")") {
                    depth--;
                }

                i++;
            } while (i < text.length && depth > 0);
            word += text.slice(from, i);
        } else if (char === "`") {
            const close = text.indexOf("`", i + 1);
            const end = close === -1 ? text.length : close + 1;
            word += text.slice(i, end);
            i = end;
        } else {
            word += char;
            i++;
        }
    }

    return { word, end: i };
}

/**
 * A command split into simple commands (at `;`, `&&`, `||`, `|`, `&`, a newline or a parenthesis), each a list of
 * words and redirects. Quotes are honoured, so `echo "a > b"` has no redirect, and here-document bodies are skipped.
 * Not a full shell parser: enough to tell a write from a read, and anything it cannot read stays a read.
 */
export function shellSegments(text: string): ShellToken[][] {
    const command = text.slice(0, MAX_SCAN_CHARS);
    const segments: ShellToken[][] = [];
    const heredocs: string[] = [];
    let current: ShellToken[] = [];
    let i = 0;
    const close = () => {
        if (current.length > 0) {
            segments.push(current);
        }

        current = [];
    };

    while (i < command.length) {
        const char = command[i] ?? "";
        if (char === "\n") {
            close();
            i++;
            while (heredocs.length > 0 && i < command.length) {
                const lineEnd = command.indexOf("\n", i);
                const end = lineEnd === -1 ? command.length : lineEnd;
                if (command.slice(i, end).trim() === heredocs[0]) {
                    heredocs.shift();
                }

                i = end + 1;
            }

            continue;
        }

        if (char === " " || char === "\t" || char === "\r") {
            i++;
            continue;
        }

        if (char === "#" && (i === 0 || /\s/.test(command[i - 1] ?? ""))) {
            const lineEnd = command.indexOf("\n", i);
            i = lineEnd === -1 ? command.length : lineEnd;
            continue;
        }

        REDIRECT.lastIndex = i;
        const redirect = REDIRECT.exec(command);
        if (redirect) {
            const op = redirect[2] ?? "";
            i += redirect[0].length;
            while (command[i] === " " || command[i] === "\t") {
                i++;
            }

            if (command[i] === "(") {
                // Process substitution `>(cmd)`: a command, not a file.
                continue;
            }

            const { word, end } = readWord(command, i);
            i = end;
            if (op === "<<" || op === "<<-") {
                heredocs.push(word);
            } else if (op.includes(">") && !(op === ">&" && /^(\d+|-)$/.test(word))) {
                current.push({ kind: "redirect", op, target: word });
            }

            continue;
        }

        if (";&|()".includes(char)) {
            close();
            i++;
            continue;
        }

        const { word, end } = readWord(command, i);
        current.push({ kind: "word", text: word });
        i = end;
    }

    close();
    return segments;
}

/** Words that run the next word as the command (`sudo sed -i …`, `bunx biome …`). */
const WRAPPERS = new Set([
    "sudo",
    "env",
    "command",
    "builtin",
    "exec",
    "time",
    "nice",
    "nohup",
    "then",
    "do",
    "else",
    "if",
    "while",
    "until",
    "!",
    "{",
    "bunx",
    "npx",
]);

/** The words after the program (flags and operands), and the program's name. */
function commandOf(words: string[]): { program: string; args: string[] } | null {
    let at = 0;
    while (at < words.length && (WRAPPERS.has(words[at] ?? "") || /^[A-Za-z_]\w*=/.test(words[at] ?? ""))) {
        at++;
    }

    if (words[at] === "bun" && words[at + 1] === "x") {
        at += 2;
    }

    const first = words[at];
    if (first === undefined) {
        return null;
    }

    const args = words.slice(at + 1);
    // `bun <plugin>/skills/fable-replace/scripts/cli.ts`: the script names the program.
    if (["bun", "node", "tsx"].includes(basename(first)) && /fable-replace\//.test(args[0] ?? "")) {
        return { program: "fable-replace", args: args.slice(1) };
    }

    return { program: basename(first), args };
}

/** The operands of a command: words that are not flags, without the values the given flags take. */
function operands(args: string[], valueFlags: readonly string[] = []): string[] {
    const out: string[] = [];
    let afterDashes = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";
        if (afterDashes || !arg.startsWith("-") || arg === "-") {
            if (arg !== "") {
                out.push(arg);
            }
        } else if (arg === "--") {
            afterDashes = true;
        } else if (valueFlags.includes(arg)) {
            i++;
        }
    }

    return out;
}

/** What a write rule found: the paths written, and whether the call's output names more of them. */
export interface WriteTargets {
    paths: string[];
    /** `git apply -v`, `patch` and fable-replace print the files they changed. */
    output: boolean;
}

interface WriteRule {
    programs: readonly string[];
    /** The paths this call writes, or null when this call of the program does not write. */
    targets(args: string[], command: string): WriteTargets | null;
}

const written = (paths: string[], output = false): WriteTargets => ({ paths, output });

/** Into a destination: the `-t` folder, else the last operand. */
function destination(args: string[]): WriteTargets | null {
    const flagged = args.findIndex((arg) => arg === "-t" || arg.startsWith("--target-directory"));
    if (flagged !== -1) {
        const arg = args[flagged] ?? "";
        return written([arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : (args[flagged + 1] ?? "")]);
    }

    const named = operands(args, ["-S", "--suffix"]);
    return named.length >= 2 ? written([named.at(-1) ?? ""]) : null;
}

/** Git's subcommand and its arguments, with `-C <dir>` applied to relative operands. */
function gitTargets(args: string[]): WriteTargets | null {
    let at = 0;
    let dir = "";
    while (at < args.length && (args[at] ?? "").startsWith("-")) {
        if (args[at] === "-C") {
            dir = args[at + 1] ?? "";
            at++;
        } else if (args[at] === "-c") {
            at++;
        }

        at++;
    }

    const sub = args[at];
    const rest = args.slice(at + 1);
    const inDir = (paths: string[]) => paths.map((path) => (dir && !isAbsolute(path) ? join(dir, path) : path));
    if (sub === "apply" || sub === "am") {
        const checks = rest.some((arg) => ["--check", "--stat", "--numstat", "--summary"].includes(arg));
        return checks && !rest.includes("--apply") ? null : written(inDir(operands(rest, ["-p", "--directory"])), true);
    }

    if (sub === "checkout") {
        const dashes = rest.indexOf("--");
        return dashes === -1 ? null : written(inDir(rest.slice(dashes + 1)));
    }

    if (sub === "restore") {
        return written(inDir(operands(rest, ["-s", "--source"])));
    }

    if (sub === "mv") {
        const target = destination(rest);
        return target ? written(inDir(target.paths)) : null;
    }

    return null;
}

/** The first operand is the script unless `-e` or `-f` carries it. */
function editedFiles(args: string[], scriptFlag: (arg: string) => boolean): string[] {
    const files: string[] = [];
    let scriptGiven = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";
        if (arg === "") {
            continue;
        }

        if (arg.startsWith("-") && arg !== "-") {
            if (scriptFlag(arg)) {
                scriptGiven = true;
                i++;
            }

            continue;
        }

        if (!scriptGiven) {
            scriptGiven = true;
            continue;
        }

        files.push(arg);
    }

    return files;
}

/**
 * An interpreter that runs code from the command itself (`python3 -c`, `bun -e`, `node --eval`), or from a
 * here-document in the same command (`python3 - <<EOF`, a script written by `cat > x.ts <<EOF` and run after it):
 * the code is in view but its writes are not, so every path the command names counts as written (Martin,
 * 2026-11-11: "bash python scripts"), but only when the code calls something that writes: a probe script that only
 * reads and prints names many paths, and got 10.7 KB of rules on its first try. Running a script file alone stays a
 * read: `bun scripts/test.ts src/x` writes nothing it names.
 */
const WRITE_CALL = /write|rename|appendFile|copyFile|unlink|\bopen\([^)]*["'][wax]|\.replace_all|shutil\.(copy|move)/i;

function inlineScript(args: string[], command: string, inlineFlags: readonly string[]): WriteTargets | null {
    const inline = args.some(
        (arg) => inlineFlags.includes(arg) || inlineFlags.some((flag) => arg.startsWith(`${flag}=`))
    );
    if ((!inline && !command.includes("<<")) || !WRITE_CALL.test(command)) {
        return null;
    }

    return written(pathTokens(command));
}

/**
 * Commands that write files, by program. Anything not here (and no `>` redirect) is a read: list, read, search,
 * show, diff, log, run a test or a tool. When unsure, a rule answers null, and the call stays a read.
 */
export const WRITE_RULES: readonly WriteRule[] = [
    {
        programs: ["sed"],
        targets: (args) =>
            args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place"))
                ? written(editedFiles(args, (arg) => ["-e", "-f", "--expression", "--file"].includes(arg)))
                : null,
    },
    {
        programs: ["perl"],
        targets: (args, command) =>
            // `-pi`, `-i.bak`, `-0777pi`; not `-Mlib` or `-mstrict`, whose letters after M are a module name.
            args.some((arg) => /^-[0-9a-ln-zA-LN-Z]*i/.test(arg))
                ? written(editedFiles(args, (arg) => /^-\w*[eE]$/.test(arg)))
                : inlineScript(args, command, ["-e", "-E"]),
    },
    {
        programs: ["python", "python3", "node", "bun", "deno", "ruby", "tsx"],
        targets: (args, command) => inlineScript(args, command, ["-c", "-e", "--eval", "-p", "--print"]),
    },
    { programs: ["mv", "cp", "ln"], targets: destination },
    { programs: ["tee", "touch", "mkdir"], targets: (args) => written(operands(args, ["-m", "--mode"])) },
    { programs: ["patch"], targets: (args) => written(operands(args, ["-p", "-d", "-i", "-o"]), true) },
    { programs: ["git"], targets: gitTargets },
    {
        programs: ["biome"],
        targets: (args) =>
            args.some((arg) => ["--write", "--fix", "--apply", "--apply-unsafe", "--unsafe"].includes(arg))
                ? written(operands(args).filter((arg, i) => i > 0 || !["format", "check", "lint", "ci"].includes(arg)))
                : null,
    },
    {
        programs: ["prettier"],
        targets: (args) => (args.includes("--write") || args.includes("-w") ? written(operands(args)) : null),
    },
    {
        programs: ["fable-replace"],
        // The spec names its files, often in a here-document, so every path in the whole command counts but the
        // script's own path.
        targets: (args, command) =>
            args.some((arg) => ["--api", "--help", "--dry-run", "--check"].includes(arg))
                ? null
                : written(
                      pathTokens(command).filter((path) => !path.includes("fable-replace/")),
                      true
                  ),
    },
];

/** The paths a Bash command writes into, by the rules above and its `>` redirects; empty for a read. */
export function writeTargets(command: string): WriteTargets {
    const paths = new Set<string>();
    let output = false;
    for (const segment of shellSegments(command)) {
        for (const token of segment) {
            if (token.kind === "redirect" && token.target) {
                paths.add(token.target);
            }
        }

        const words = segment.flatMap((token) => (token.kind === "word" ? [token.text] : []));
        const call = commandOf(words);
        const rule = call ? WRITE_RULES.find((candidate) => candidate.programs.includes(call.program)) : undefined;
        const found = call && rule ? rule.targets(call.args, command) : null;
        for (const path of found?.paths ?? []) {
            paths.add(path);
        }

        output ||= found?.output === true;
    }

    return { paths: [...paths].flatMap(literalPath), output };
}

/**
 * A target as a path, `~/` expanded; none when the shell would expand it (`$S/out.txt`, a backtick), because it can
 * point anywhere and resolved from the cwd it would name a file in the project.
 */
function literalPath(target: string): string[] {
    if (!target || /[$`]/.test(target)) {
        return [];
    }

    return [target.startsWith("~/") ? join(homedir(), target.slice(2)) : target];
}

export interface PathAlias {
    /** Import prefix, e.g. `@genesiscz/utils/`. */
    from: string;
    /** Project-relative folder it stands for, e.g. `src/utils/`. */
    to: string;
}

/**
 * The `compilerOptions.paths` wildcard aliases of the root tsconfig, longest prefix first. Code reached through an
 * import name (`@genesiscz/utils/database/migrations`) names no folder, so a search that only meets the import
 * would otherwise miss the area it lives in.
 */
export function tsconfigAliases(root: string): PathAlias[] {
    let config: unknown;

    try {
        config = parseLenientJson(readFileSync(join(root, "tsconfig.json"), "utf8"));
    } catch {
        // No tsconfig, or one this parser cannot read: no aliases.
        return [];
    }

    const options = isRecord(config) ? config.compilerOptions : undefined;
    const paths = isRecord(options) ? options.paths : undefined;
    if (!isRecord(paths)) {
        return [];
    }

    const aliases: PathAlias[] = [];
    for (const [key, targets] of Object.entries(paths)) {
        const target = Array.isArray(targets) ? targets[0] : undefined;
        if (key.endsWith("/*") && typeof target === "string" && target.endsWith("/*")) {
            aliases.push({ from: key.slice(0, -1), to: target.slice(0, -1).replace(/^\.\//, "") });
        }
    }

    return aliases.sort((a, b) => b.from.length - a.from.length);
}

/**
 * Tokens with a known import prefix rewritten to the absolute folder it stands for; other tokens unchanged. The
 * folder is resolved from the project root, because an import name means the same folder from any cwd.
 */
export function unalias(tokens: string[], options: { aliases: PathAlias[]; root: string }): string[] {
    return tokens.map((token) => {
        const alias = options.aliases.find((candidate) => token.startsWith(candidate.from));
        return alias ? join(options.root, `${alias.to}${token.slice(alias.from.length)}`) : token;
    });
}

/** Project-relative paths for tokens that resolve inside the project. */
export function projectPaths(tokens: string[], options: { root: string; cwd: string }): string[] {
    const paths = new Set<string>();
    for (const token of tokens) {
        const absolute = isAbsolute(token) ? token : resolve(options.cwd, token);
        const rel = relative(options.root, absolute);
        if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
            paths.add(rel);
        }
    }

    return [...paths];
}

function isFolder(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        // A path the output named that is gone or never existed.
        return false;
    }
}

// A glob that covers a file type across a whole tree (`**/*.ts`, `src/**/*.ts`). Its rules are about writing code,
// and Claude Code loads them when the agent opens or edits such a file, so a search does not add them. A Bash write
// does: Claude Code loads nothing for it.
export function isBroadGlob(glob: string): boolean {
    return /^(?:[\w.-]+\/)?\*\*\/\*\.[\w{},]+$/.test(glob);
}

/** The area files (project-relative) that apply to one project path: matching rules, then folder CLAUDE.md files. */
export function areasFor(path: string, options: { root: string; rules: AreaRule[]; broad?: boolean }): string[] {
    const areas: string[] = [];
    // A folder token (`rg x src/du`) stands for the files in it.
    const candidates = isFolder(join(options.root, path)) ? [path, `${path}/_.ts`] : [path];
    for (const rule of options.rules) {
        const globs = options.broad === false ? rule.globs.filter((glob) => !isBroadGlob(glob)) : rule.globs;
        if (globs.some((glob) => candidates.some((candidate) => new Bun.Glob(glob).match(candidate)))) {
            areas.push(rule.file);
        }
    }

    const parts = path.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
        const folderFile = join(...parts.slice(0, depth), "CLAUDE.md");
        if (folderFile !== path && existsSync(join(options.root, folderFile))) {
            areas.push(folderFile);
        }
    }

    return areas;
}

/** Per agent: the areas it has whole (`full`, also the ones Claude Code loaded) and the ones it got as a pointer. */
export type AreaState = Record<string, string[]>;

function stateFile(sessionId: string): string {
    // Standalone hook script: no access to @genesiscz/utils/env, so process.env directly.
    const home = process.env.GENESIS_TOOLS_HOME || homedir();
    return join(home, ".genesis-tools", "agents", "area-rules", `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}

function readState(sessionId: string): AreaState {
    try {
        return SafeJSON.parse(readFileSync(stateFile(sessionId), "utf8")) as AreaState;
    } catch {
        // First call in this session.
        return {};
    }
}

function writeState(sessionId: string, state: AreaState): void {
    const file = stateFile(sessionId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, SafeJSON.stringify(state));
}

/**
 * SessionStart `compact` names the session but not the agent that compacted: a subagent's compaction carries the
 * parent's session id and transcript and no `agent_id` (the hook log of 2026-10-13 18:12, session 4578e02a). So
 * every agent is marked here and checked against its own transcript at its next tool call. Wiping every agent
 * caused 59 of the 60 repeated injections measured from 2026-10-13 to 2026-10-23.
 */
export function markCompaction(state: AreaState, now: number): AreaState {
    const marked = { ...state };
    const agents = new Set(
        Object.keys(state)
            .filter((key) => !key.startsWith(COMPACT_MARK))
            .map((key) => (key.startsWith(POINTER_MARK) ? key.slice(POINTER_MARK.length) : key))
    );
    for (const agent of agents) {
        if (!marked[`${COMPACT_MARK}${agent}`]) {
            marked[`${COMPACT_MARK}${agent}`] = [String(now)];
        }
    }

    return marked;
}

/** The agent's own transcript; undefined for a harness whose transcript has no compaction boundary rows. */
export function agentTranscript(payload: HookPayload): string | undefined {
    const transcript = payload.transcript_path;
    const facts = transcript ? HARNESS_FACTS[harnessOf({ transcript_path: transcript })] : undefined;
    if (!transcript || !facts?.compactBoundaryRows) {
        return undefined;
    }

    if (!payload.agent_id) {
        return transcript;
    }

    if (!facts.subagentsOnDisk) {
        return undefined;
    }

    return join(dirname(transcript), basename(transcript, ".jsonl"), "subagents", `agent-${payload.agent_id}.jsonl`);
}

/**
 * Whether the transcript holds a compaction at or after `since`. When the read tail does not reach back past
 * `since`, or the file cannot be read, the answer is true: a repeated area costs context, a lost one costs rules.
 */
export function compactedSince(transcript: string | undefined, since: number): boolean {
    if (!transcript) {
        return true;
    }

    let fd: number;

    try {
        fd = openSync(transcript, "r");
    } catch {
        // No transcript at this path: assume the compaction was this agent's.
        return true;
    }

    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        // The first line of a partial tail is cut; the rest are whole rows.
        const start = length < size ? buffer.indexOf(10) + 1 : 0;
        const from = since - COMPACT_SLACK_MS;
        for (let at = buffer.indexOf('"compact_boundary"', start); at !== -1; ) {
            const lineStart = buffer.lastIndexOf(10, at) + 1;
            const lineEnd = buffer.indexOf(10, at);
            const end = lineEnd === -1 ? length : lineEnd;
            const row = parseRow(buffer.toString("utf8", Math.max(lineStart, start), end));
            if (
                row?.type === "system" &&
                row.subtype === "compact_boundary" &&
                Date.parse(String(row.timestamp)) >= from
            ) {
                return true;
            }

            at = buffer.indexOf('"compact_boundary"', end);
        }

        const firstStamp = Date.parse(
            buffer.toString("utf8", start, Math.min(length, start + 64_000)).match(/"timestamp":"([^"]+)"/)?.[1] ?? ""
        );
        return length < size && !(firstStamp <= from);
    } finally {
        closeSync(fd);
    }
}

function parseRow(line: string): Record<string, unknown> | null {
    try {
        const row: unknown = SafeJSON.parse(line);
        return isRecord(row) ? row : null;
    } catch {
        // A row cut by a concurrent append.
        return null;
    }
}

function textOf(value: unknown): string {
    return typeof value === "string" ? value : SafeJSON.stringify(value ?? "");
}

export interface Decision {
    /** Area files to add whole now. */
    full: string[];
    /** Area files to name in one pointer line now. */
    pointer: string[];
    /** Area files Claude Code loads by itself for this call (recorded, not added). */
    native: string[];
}

/** What a tool call should add, given what this agent already has. Pure, for tests. */
export function decide(input: {
    payload: HookPayload;
    root: string;
    rules: AreaRule[];
    /** Areas this agent has whole. */
    seen: string[];
    /** Areas this agent got as a pointer. */
    pointed?: string[];
    aliases?: PathAlias[];
    /** This harness's levels; the shared shipped ones when absent. */
    levels?: AreaRulesLevels;
}): Decision {
    const { payload, root, rules, seen, pointed = [], aliases = [] } = input;
    const levels = input.levels ?? AREA_RULES_DEFAULTS;
    const cwd = payload.cwd ?? root;
    const tool = payload.tool_name ?? "";
    const toolInput = payload.tool_input ?? {};
    const areasOf = (paths: string[], broad: boolean) => [
        ...new Set(paths.flatMap((path) => areasFor(path, { root, rules, broad }))),
    ];
    const named = projectPaths(
        pathTokens(
            [toolInput.file_path, toolInput.path, toolInput.notebook_path, toolInput.command, toolInput.pattern]
                .filter((value) => typeof value === "string")
                .join("\n")
        ),
        { root, cwd }
    );

    if (NATIVE_TOOLS.includes(tool)) {
        return { full: [], pointer: [], native: areasOf(named, true).filter((area) => !seen.includes(area)) };
    }

    const command = tool === "Bash" && typeof toolInput.command === "string" ? toolInput.command : "";
    const writes = command ? writeTargets(command) : { paths: [], output: false };
    const writePaths = projectPaths(writes.paths, { root, cwd });
    const found = writes.output
        ? projectPaths(unalias(pathTokens(textOf(payload.tool_response)), { aliases, root }), { root, cwd })
        : [];
    const writeAreas = areasOf([...writePaths, ...found], true);

    const cap = payload.agent_id ? AGENT_CAP[levels.agents] : "full";
    const full: string[] = [];
    const pointer: string[] = [];
    for (const area of writeAreas) {
        const level = lower(levels.write, cap);
        if (level === "full" && !seen.includes(area)) {
            full.push(area);
        } else if (level === "pointer" && !seen.includes(area) && !pointed.includes(area)) {
            pointer.push(area);
        }
    }

    return { full, pointer, native: [] };
}

/** The file's "Loaded by Claude Code when ..." sentence, else its `paths` globs, else the folder a CLAUDE.md covers. */
export function scopeOf(text: string, area: string): string {
    const sentence = text.match(/^Loaded by Claude Code when [\s\S]*?\.(?=\s|$)/m)?.[0];
    if (sentence) {
        return sentence.replace(/\s+/g, " ");
    }

    const globs = frontmatterPaths(text);
    if (globs.length > 0) {
        return `paths: ${globs.join(", ")}`;
    }

    return `files under ${dirname(area)}/`;
}

/** The pointer line for one area file. The metrics ledger parses this exact shape; change both together. */
export function pointerLine(root: string, area: string): string {
    const text = readFileSync(join(root, area), "utf8");
    const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    return `Area rules (pointer): ${join(root, area)} (${lines} lines): ${scopeOf(text, area)}`;
}

export function contextFor(root: string, areas: { full: string[]; pointer: string[] }, tool: string): string {
    const head = `The ${tool} call writes into an area whose rules were not in your context yet (Claude Code loads them only on its Read, Write and Edit tools). Follow them like the root CLAUDE.md:`;
    const pointers =
        areas.pointer.length > 0
            ? [
                  "Read the named file before you change code in that area or state one of its rules.",
                  ...areas.pointer.map((area) => pointerLine(root, area)),
              ].join("\n")
            : "";
    const bodies = areas.full.map((area) => {
        const text = readFileSync(join(root, area), "utf8").replace(/^---\n[\s\S]*?\n---\n*/, "");
        return `Contents of ${join(root, area)} (area rules):\n\n${text.trim()}`;
    });
    return [pointers ? `${head}\n${pointers}` : head, ...bodies].join("\n\n");
}

if (import.meta.main) {
    let payload: HookPayload;

    try {
        payload = SafeJSON.parse(await Bun.stdin.text()) as HookPayload;
    } catch {
        // Not a hook payload: nothing to do.
        process.exit(0);
    }

    // The worktree lock rides in this process because it already starts on every Bash and edit call; a
    // hook of its own would cost a second `bun` start on each of them. It never throws and never prints.
    lockWorktreesForToolUse(payload);

    const sessionId = payload.session_id;
    if (!sessionId) {
        process.exit(0);
    }

    if (payload.hook_event_name === "SessionStart") {
        if (payload.source === "clear") {
            writeState(sessionId, {});
        } else if (payload.source === "compact") {
            writeState(sessionId, markCompaction(readState(sessionId), Date.now()));
        }

        process.exit(0);
    }

    // Read, Write and Edit only record what Claude Code loaded, so a level switched on mid-session repeats nothing.
    const levels = levelsFor(areaRulesSettings(), harnessFor(payload));
    if (!NATIVE_TOOLS.includes(payload.tool_name ?? "") && !canInject(levels, Boolean(payload.agent_id))) {
        process.exit(0);
    }

    const root = projectRoot(payload.cwd ?? process.cwd());
    if (!root) {
        process.exit(0);
    }

    const rules = readRules(root);
    const state = readState(sessionId);
    const agent = payload.agent_id ?? "main";
    const mark = `${COMPACT_MARK}${agent}`;
    const pointerKey = `${POINTER_MARK}${agent}`;
    const compactedAt = state[mark] ? Number(state[mark][0]) : null;
    delete state[mark];
    const reset = compactedAt !== null && compactedSince(agentTranscript(payload), compactedAt);
    const seen = reset ? [] : (state[agent] ?? []);
    const pointed = reset ? [] : (state[pointerKey] ?? []);
    const decision = decide({ payload, root, rules, seen, pointed, levels, aliases: tsconfigAliases(root) });
    const added = decision.full.length + decision.pointer.length;
    if (added === 0 && decision.native.length === 0 && compactedAt === null) {
        process.exit(0);
    }

    state[agent] = [...seen, ...decision.native, ...decision.full];
    if (pointed.length + decision.pointer.length > 0) {
        state[pointerKey] = [...pointed, ...decision.pointer];
    } else {
        delete state[pointerKey];
    }

    writeState(sessionId, state);
    if (process.env.AREA_RULES_LOG) {
        appendFileSync(
            process.env.AREA_RULES_LOG,
            `${SafeJSON.stringify({ session: sessionId, agent, tool: payload.tool_name, ...decision })}\n`
        );
    }

    if (added > 0) {
        process.stdout.write(
            SafeJSON.stringify({
                hookSpecificOutput: {
                    hookEventName: "PostToolUse",
                    additionalContext: contextFor(root, decision, payload.tool_name ?? "tool"),
                },
            })
        );
    }
}
