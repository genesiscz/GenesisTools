#!/usr/bin/env bun

// Claude Code loads an area's rules (`.claude/rules/*.md` by their `paths` globs, and the CLAUDE.md of a
// subfolder) only when a file there is read, written or edited, or viewed whole by a one-file `cat` or `head`.
// A search loads nothing. Measured 2026-10-13 with haiku in this repo: a Grep-only task loaded its area rules in 0
// of 8 runs, a piped `cat` in 0 of 8, and a subagent exploring with `rg` and `sed -n` in 1 of 7. So an agent could
// answer about an area, or a subagent could explore it, without ever seeing that area's rules.
//
// PostToolUse on Grep, Glob and Bash: this hook finds the project paths the call touched and adds each matching
// area file to the context once per agent. On Read, Write and Edit it only records the areas Claude Code loads by
// itself, so it does not add them a second time. After a compaction the agent that compacted forgets what was
// added, because the compaction summary does not carry the files.

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
import { parseLenientJson } from "./agents-talk-hint";
import { harnessOf } from "./harness";
import { lockWorktreesForToolUse } from "./worktree-lock";

const SafeJSON = JSON;

/** A response spanning more areas than this is a broad search: only the areas its input names are added. */
const BROAD_SEARCH_AREAS = 2;
const MAX_SCAN_CHARS = 200_000;
/** State key prefix: `@compact:<agent>` holds the time of a compaction that agent has not been checked against. */
const COMPACT_MARK = "@compact:";
/** How much of a transcript's end the compaction check reads. A boundary sat up to 670 KB before the next rows. */
const TRANSCRIPT_TAIL_BYTES = 4_000_000;
/** A compact_boundary row was stamped at most 0.8 s before its SessionStart hook (146 compactions); the margin. */
const COMPACT_SLACK_MS = 10_000;

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

export interface PathAlias {
    /** Import prefix, e.g. `@genesiscz/utils/`. */
    from: string;
    /** Project-relative folder it stands for, e.g. `src/utils/`. */
    to: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
// and Claude Code loads them when the agent opens or edits such a file, so a search does not add them.
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

function stateFile(sessionId: string): string {
    // Standalone hook script: no access to @genesiscz/utils/env, so process.env directly.
    const home = process.env.GENESIS_TOOLS_HOME || homedir();
    return join(home, ".genesis-tools", "agents", "area-rules", `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}

function readState(sessionId: string): Record<string, string[]> {
    try {
        return SafeJSON.parse(readFileSync(stateFile(sessionId), "utf8")) as Record<string, string[]>;
    } catch {
        // First call in this session.
        return {};
    }
}

function writeState(sessionId: string, state: Record<string, string[]>): void {
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
export function markCompaction(state: Record<string, string[]>, now: number): Record<string, string[]> {
    const marked = { ...state };
    for (const agent of Object.keys(state)) {
        if (!agent.startsWith(COMPACT_MARK) && !marked[`${COMPACT_MARK}${agent}`]) {
            marked[`${COMPACT_MARK}${agent}`] = [String(now)];
        }
    }

    return marked;
}

/** The agent's own Claude Code transcript; undefined for another harness, whose transcript has no boundary rows. */
export function agentTranscript(payload: HookPayload): string | undefined {
    const transcript = payload.transcript_path;
    if (!transcript || harnessOf({ transcript_path: transcript }) !== "claude") {
        return undefined;
    }

    if (!payload.agent_id) {
        return transcript;
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
    /** Area files to add to the context now. */
    add: string[];
    /** Area files Claude Code loads by itself for this call (recorded, not added). */
    native: string[];
}

/** Which area files a tool call should add, given what this agent already has. Pure, for tests. */
export function decide(input: {
    payload: HookPayload;
    root: string;
    rules: AreaRule[];
    seen: string[];
    aliases?: PathAlias[];
}): Decision {
    const { payload, root, rules, seen, aliases = [] } = input;
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

    if (["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
        return { add: [], native: areasOf(named, true).filter((area) => !seen.includes(area)) };
    }

    const namedAreas = areasOf(named, false);
    const found = projectPaths(unalias(pathTokens(textOf(payload.tool_response)), { aliases, root }), { root, cwd });
    const foundAreas = areasOf(found, false);
    const wanted = foundAreas.length <= BROAD_SEARCH_AREAS ? [...namedAreas, ...foundAreas] : namedAreas;
    return { add: [...new Set(wanted)].filter((area) => !seen.includes(area)), native: [] };
}

export function contextFor(root: string, areas: string[], tool: string): string {
    const bodies = areas.map((area) => {
        const text = readFileSync(join(root, area), "utf8").replace(/^---\n[\s\S]*?\n---\n*/, "");
        return `Contents of ${join(root, area)} (area rules):\n\n${text.trim()}`;
    });
    return `The ${tool} call touched files whose area rules were not in your context yet (Claude Code loads them only when a file is read or edited). Follow them like the root CLAUDE.md:\n\n${bodies.join("\n\n")}`;
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

    const root = projectRoot(payload.cwd ?? process.cwd());
    if (!root) {
        process.exit(0);
    }

    const rules = readRules(root);
    const state = readState(sessionId);
    const agent = payload.agent_id ?? "main";
    const mark = `${COMPACT_MARK}${agent}`;
    const compactedAt = state[mark] ? Number(state[mark][0]) : null;
    delete state[mark];
    const seen =
        compactedAt !== null && compactedSince(agentTranscript(payload), compactedAt) ? [] : (state[agent] ?? []);
    const decision = decide({ payload, root, rules, seen, aliases: tsconfigAliases(root) });
    if (decision.add.length === 0 && decision.native.length === 0 && compactedAt === null) {
        process.exit(0);
    }

    state[agent] = [...seen, ...decision.native, ...decision.add];
    writeState(sessionId, state);
    if (process.env.AREA_RULES_LOG) {
        appendFileSync(
            process.env.AREA_RULES_LOG,
            `${SafeJSON.stringify({ session: sessionId, agent, tool: payload.tool_name, ...decision })}\n`
        );
    }

    if (decision.add.length > 0) {
        process.stdout.write(
            SafeJSON.stringify({
                hookSpecificOutput: {
                    hookEventName: "PostToolUse",
                    additionalContext: contextFor(root, decision.add, payload.tool_name ?? "tool"),
                },
            })
        );
    }
}
