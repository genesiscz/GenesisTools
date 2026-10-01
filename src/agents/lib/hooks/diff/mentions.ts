import {
    appendFileSync,
    closeSync,
    fstatSync,
    openSync,
    readFileSync,
    readSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { hookDiag } from "../log";
import { mentionsRoot, safeSegment } from "../paths";
import { makePrivateDir } from "./private-dir";

/**
 * Every path a session's tool inputs have named, kept per session, so the post phase can tell
 * a change THIS session caused from one another session made in the same repository during
 * the command.
 *
 * Measured 2026-09-30: a session from another repository ran one command in GenesisTools while
 * a second session rewrote `src/utils/services/lifecycle.ts` there, and the first session was
 * shown that diff. Its 128 MB transcript never named the file in any tool input.
 *
 * Three sources feed the index, all from processes that already run, so it adds no process:
 *
 *   - the Bash pre phase adds its own command (heredoc bodies and inline scripts included);
 *   - the Edit/MultiEdit/Write post phase adds its `file_path`;
 *   - the Bash pre phase also reads the Claude transcript FORWARD from the last offset it
 *     reached, which is where Read, Grep, Glob and NotebookEdit inputs are found. Measured on
 *     that 128 MB transcript: the bytes appended between two Bash calls are 11.9 KB at p50 and
 *     271 KB at p99, and scanning them costs well under a millisecond. A PreToolUse hook on
 *     those tools would cost a bun start per call instead.
 *
 * Paths are stored canonical (realpath of the parent directory) because the post phase compares
 * them against `git rev-parse --show-toplevel` output, which is always canonical.
 */

/** A session starting on an existing transcript reads at most its last this-many bytes, once. */
const BACKFILL_BYTES = 16 * 1024 * 1024;
const TOOL_USE_MARKER = Buffer.from('"type":"tool_use"');
const GLOB_PREFIX = "glob:";
/** Roots remembered per session; a session rarely works in more than a handful. */
const MAX_ROOTS = 16;
const FILE_MODE = 0o600;

export interface Mentions {
    paths: Set<string>;
    globs: string[];
}

/** One tool input reduced to what the index needs. */
export interface ToolMention {
    tool: string;
    input: unknown;
    cwd: string;
}

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function expandHome(value: string): string {
    if (value === "~") {
        return homedir();
    }

    return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

const parents = new Map<string, string>();

/**
 * The canonical form of `path`: its parent directory through `realpath`, memoised per parent,
 * then the name. A path that does not exist yet (a file a command is about to create) still
 * canonicalises through its parent, and a parent that does not exist keeps its lexical form.
 */
export function canonical(path: string): string {
    const parent = dirname(path);
    let real = parents.get(parent);

    if (real === undefined) {
        try {
            real = realpathSync(parent);
        } catch {
            // Absent directories are the normal case for a path a command only names.
            real = parent;
        }

        parents.set(parent, real);
    }

    return parent === path ? real : join(real, basename(path));
}

function isGlob(value: string): boolean {
    return /[*?[\]{}]/.test(value);
}

/** The directory part of a glob before its first wildcard segment. */
export function globPrefix(glob: string): string {
    const parts = glob.split(sep);
    const literal: string[] = [];

    for (const part of parts) {
        if (isGlob(part)) {
            break;
        }

        literal.push(part);
    }

    return literal.join(sep) || sep;
}

/** Absolute, `~`-expanded, canonical; a glob keeps its wildcards and canonicalises its prefix. */
function normalise(raw: string, base: string): string | null {
    const value = expandHome(raw);
    const absolute = isAbsolute(value) ? resolve(value) : resolve(base, value);

    if (!isGlob(absolute)) {
        return canonical(absolute);
    }

    const prefix = globPrefix(absolute);
    const real = canonical(prefix);

    return `${GLOB_PREFIX}${real}${absolute.slice(prefix.length)}`;
}

/**
 * Path-shaped tokens anywhere in a command's TEXT, heredoc bodies and quoted scripts included.
 *
 * This is deliberately looser than `namedArguments`, which decides what to COPY and so must
 * never guess. Here a false entry only widens what this session may be shown, and a missed one
 * hides a change it caused: `python3 - <<EOF` with `p="src/x.md"` inside names `src/x.md` only
 * in the body, which the scanner blanks.
 */
const TOKEN = /[A-Za-z0-9_.~@%+=,:/*?[\]{}À-ɏ-]+/g;
const QUOTED_WITH_SPACE = /(["'])([^"'\n]*\/[^"'\n]* [^"'\n]*)\1/g;
const BARE_FILE = /^[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;

export function textPaths(command: string): string[] {
    const found = new Set<string>();

    for (const match of command.matchAll(TOKEN)) {
        const at = match.index ?? 0;

        if (command[at - 1] === "$") {
            continue;
        }

        const whole = match[0];

        if (whole.includes("://")) {
            continue;
        }

        // `a.ts,b.ts` is a list; `*.{ts,tsx}` is one glob.
        for (const part of whole.includes("{") ? [whole] : whole.split(",")) {
            let token = part
                .replace(/^[-=:]+/, "")
                .replace(/:\d+(?::\d+)?$/, "")
                .replace(/[.:;]+$/, "");
            const eq = token.indexOf("=");

            if (eq !== -1) {
                token = token.slice(eq + 1);
            }

            if (token.length >= 2 && (token.includes("/") || BARE_FILE.test(token))) {
                found.add(token);
            }
        }
    }

    for (const match of command.matchAll(QUOTED_WITH_SPACE)) {
        const value = match[2];

        if (value && !value.includes("://")) {
            found.add(value);
        }
    }

    return [...found];
}

const CD = /(?:^|[\n;&|(])\s*cd\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|)]+))/g;

/**
 * The cwd plus every `cd` target, each relative one resolved from the one before it.
 *
 * A regex rather than `commandDirs`: the scanner and its `existsSync` per target cost 88 ms over
 * the 2302 Bash commands of a 128 MB transcript, and a target that does not exist only adds a
 * candidate that matches nothing. A `$VAR` target is skipped rather than guessed.
 */
function cdBases(command: string, cwd: string): string[] {
    const bases = [cwd];
    let current = cwd;

    for (const match of command.matchAll(CD)) {
        const target = match[1] ?? match[2] ?? match[3];

        if (!target || target.includes("$") || target === "-") {
            continue;
        }

        current = resolve(current, expandHome(target));

        if (!bases.includes(current)) {
            bases.push(current);
        }
    }

    return bases;
}

/**
 * What one tool input names, normalised. A relative path in a Bash command is read against
 * every directory the command works in (the cwd and each `cd` target), because the text alone
 * cannot always say which one was current.
 */
export function mentionsOf(mention: ToolMention): string[] {
    const { tool, input, cwd } = mention;
    const out: string[] = [];
    const push = (raw: string | null, base: string) => {
        const value = raw ? normalise(raw, base) : null;

        if (value) {
            out.push(value);
        }
    };

    switch (tool) {
        case "Bash":
        case "shell":
        case "run_terminal_command": {
            const command = text(field(input, "command"));

            if (!command) {
                break;
            }

            const bases = cdBases(command, cwd);

            for (const token of textPaths(command)) {
                if (isAbsolute(expandHome(token))) {
                    push(token, cwd);
                    continue;
                }

                for (const base of bases) {
                    push(token, base);
                }
            }

            // Each `cd` target is itself a mentioned directory: `cd pkg && codemod` owns pkg.
            for (const dir of bases.slice(1)) {
                push(dir, cwd);
            }

            break;
        }

        case "Glob": {
            const base = text(field(input, "path")) ?? cwd;
            const pattern = text(field(input, "pattern"));

            push(pattern ? join(expandHome(base), pattern) : base, cwd);
            break;
        }

        case "Grep": {
            const base = text(field(input, "path")) ?? cwd;
            const glob = text(field(input, "glob"));

            push(glob ? join(expandHome(base), "**", glob) : base, cwd);
            break;
        }

        default: {
            push(text(field(input, "file_path")) ?? text(field(input, "notebook_path")), cwd);

            for (const edit of Array.isArray(field(input, "edits")) ? (field(input, "edits") as unknown[]) : []) {
                push(text(field(edit, "file_path")), cwd);
            }
        }
    }

    return out;
}

/** An in-memory index of `entries`, as `mentionsOf` returns them. */
export function mentionsFrom(entries: string[]): Mentions {
    const mentions: Mentions = { paths: new Set(), globs: [] };

    for (const entry of entries) {
        if (entry.startsWith(GLOB_PREFIX)) {
            mentions.globs.push(entry.slice(GLOB_PREFIX.length));
        } else {
            mentions.paths.add(entry);
        }
    }

    return mentions;
}

function indexPath(session: string): string {
    return join(mentionsRoot(), `${session}.txt`);
}

function statePath(session: string): string {
    return join(mentionsRoot(), `${session}.json`);
}

/** The index of one session, or an empty one. Never throws. */
export function loadMentions(sessionId: string | undefined): Mentions {
    const session = safeSegment(sessionId);

    if (session === null) {
        return mentionsFrom([]);
    }

    let raw: string;

    try {
        raw = readFileSync(indexPath(session), "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            hookDiag("Could not read the session's mention index", { err, session });
        }

        return mentionsFrom([]);
    }

    return mentionsFrom(raw.split("\n").filter((line) => line.length > 0));
}

/** Appends what `known` does not already hold, and adds it to `known`. Never throws. */
export function appendMentions(sessionId: string | undefined, known: Mentions, entries: string[]): number {
    const session = safeSegment(sessionId);

    if (session === null) {
        return 0;
    }

    const fresh: string[] = [];

    for (const entry of entries) {
        if (entry.startsWith(GLOB_PREFIX)) {
            const glob = entry.slice(GLOB_PREFIX.length);

            if (!known.globs.includes(glob)) {
                known.globs.push(glob);
                fresh.push(entry);
            }

            continue;
        }

        if (!known.paths.has(entry)) {
            known.paths.add(entry);
            fresh.push(entry);
        }
    }

    if (fresh.length === 0) {
        return 0;
    }

    try {
        // A shared temp tree: refuse one another user planted or linked, as the capture does.
        const refused = makePrivateDir(mentionsRoot());

        if (refused) {
            throw new Error(refused);
        }

        appendFileSync(indexPath(session), `${fresh.join("\n")}\n`, { mode: FILE_MODE });
    } catch (err) {
        hookDiag("Could not append to the session's mention index", { err, session });
    }

    return fresh.length;
}

/**
 * Where the transcript tail stopped, and when this session last began a Bash call. The second
 * one is how another session tells a capture that is still running from one whose command
 * failed: a failed call gets no post phase, so its capture lingers, but its session moves on.
 */
export interface SessionState {
    transcript?: string;
    offset?: number;
    lastPre?: number;
    /** Every git root this session's Bash calls worked in, newest last; the Stop phase reads it. */
    roots?: string[];
}

export function readSessionState(session: string): SessionState {
    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(statePath(session), "utf8"), { strict: true });

        return typeof parsed === "object" && parsed !== null ? (parsed as SessionState) : {};
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            hookDiag("Could not read the transcript offset, so the tail starts over", { err, session });
        }

        return {};
    }
}

/**
 * The tool inputs a Claude transcript gained since `from`, and the offset after the last
 * COMPLETE line. A line still being written is left for the next call.
 *
 * Only lines holding the literal `"type":"tool_use"` are parsed. Inside a tool RESULT that text
 * is JSON-escaped (`\"type\":\"tool_use\"`), so a transcript quoting itself cannot match.
 */
export function transcriptToolUses(path: string, from: number): { uses: ToolMention[]; offset: number } {
    const uses: ToolMention[] = [];
    let fd: number;

    try {
        fd = openSync(path, "r");
    } catch (err) {
        hookDiag("Could not open the transcript to index its tool inputs", { err, path });
        return { uses, offset: from };
    }

    try {
        const size = fstatSync(fd).size;
        // A transcript that shrank was replaced; it is read again from the start.
        let start = from > size ? 0 : from;

        if (size - start > BACKFILL_BYTES) {
            start = size - BACKFILL_BYTES;
        }

        if (size <= start) {
            return { uses, offset: start };
        }

        const buf = Buffer.allocUnsafe(size - start);
        const read = readSync(fd, buf, 0, buf.length, start);
        const data = buf.subarray(0, read);
        const lastNewline = data.lastIndexOf(0x0a);

        if (lastNewline === -1) {
            return { uses, offset: start };
        }

        // A backfill that began mid-line skips that fragment.
        let cursor = start === from ? 0 : data.indexOf(0x0a) + 1;

        while (cursor <= lastNewline) {
            const hit = data.indexOf(TOOL_USE_MARKER, cursor);

            if (hit === -1 || hit > lastNewline) {
                break;
            }

            const lineStart = data.lastIndexOf(0x0a, hit) + 1;
            const lineEnd = data.indexOf(0x0a, hit);

            cursor = lineEnd + 1;

            if (lineStart < 0 || lineEnd === -1) {
                break;
            }

            collectLine(data.subarray(lineStart, lineEnd).toString("utf8"), uses);
        }

        return { uses, offset: start + lastNewline + 1 };
    } finally {
        closeSync(fd);
    }
}

function collectLine(line: string, into: ToolMention[]): void {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(line, { strict: true });
    } catch (err) {
        hookDiag("Skipped a transcript line that is not JSON", { err, bytes: line.length });
        return;
    }

    const cwd = text(field(parsed, "cwd"));
    const content = field(field(parsed, "message"), "content");

    if (!cwd || !Array.isArray(content)) {
        return;
    }

    for (const block of content) {
        const name = text(field(block, "name"));

        if (field(block, "type") === "tool_use" && name) {
            into.push({ tool: name, input: field(block, "input"), cwd });
        }
    }
}

/**
 * Brings the index up to date for one pre phase: the transcript's new tool inputs, then this
 * call's own. Returns the index and, apart, what this call names (which reaches `deep`). Never
 * throws; a failure costs attribution, never the command.
 */
export function refreshMentions(options: {
    sessionId: string | undefined;
    transcript: string | null;
    current: ToolMention | null;
    roots?: string[];
}): { index: Mentions; current: Mentions } {
    const known = loadMentions(options.sessionId);
    const own = options.current ? mentionsOf(options.current) : [];
    const current = mentionsFrom(own);
    const session = safeSegment(options.sessionId);

    if (session === null) {
        return { index: known, current };
    }

    const entries: string[] = [];

    try {
        const state = readSessionState(session);
        const roots = [
            ...(state.roots ?? []).filter((root) => !options.roots?.includes(root)),
            ...(options.roots ?? []),
        ];
        const next: SessionState = {
            lastPre: Date.now(),
            ...(roots.length > 0 ? { roots: roots.slice(-MAX_ROOTS) } : {}),
        };

        if (options.transcript) {
            const from = state.transcript === options.transcript ? (state.offset ?? 0) : 0;
            const { uses, offset } = transcriptToolUses(options.transcript, from);

            for (const use of uses) {
                entries.push(...mentionsOf(use));
            }

            next.transcript = options.transcript;
            next.offset = offset;
        }

        // A shared temp tree: refuse one another user planted or linked, as the capture does.
        const refused = makePrivateDir(mentionsRoot());

        if (refused) {
            throw new Error(refused);
        }

        writeFileSync(statePath(session), SafeJSON.stringify(next), { mode: FILE_MODE });
    } catch (err) {
        hookDiag("Could not refresh the session's mention index", { err, session });
    }

    appendMentions(options.sessionId, known, [...entries, ...own]);

    return { index: known, current };
}

const compiled = new Map<string, InstanceType<typeof Bun.Glob>>();

/**
 * How far a mentioned directory or glob reaches. `deep` is for the CURRENT command: `cd pkg &&
 * codemod` owns everything under `pkg`. `shallow` is for EARLIER inputs: a file itself, the
 * direct children of a directory, and a glob only when it has no `**`.
 *
 * Measured 2026-09-30 on the 128 MB transcript of the session that was shown another session's
 * `src/utils/services/lifecycle.ts`: it never named that file, but it had run `ls <repo>/src/`
 * and `rg … <repo>/src/`, and a deep reading of those claimed every file in `src` for it.
 *
 * `file` is for ATTRIBUTION from earlier inputs: the file itself and nothing else. Observed
 * 2026-10-01: `shallow` still showed session b1a2c5fc a `HubMainMenu.swift` edit another
 * session made, because b1a2c5fc had once named the `Sources/Hub` directory. A directory
 * mention says the session looked there, not that it wrote there.
 */
export type Reach = "deep" | "shallow" | "file";

/**
 * Whether the index covers `file` inside repository `root`.
 *
 * 🛑 A directory or glob only counts when it lies strictly INSIDE the root. The session cwd and
 * `cd <repo>` are mentions of the whole repository, and counting them would cover every file a
 * second session writes there, which is the exact case this index exists to separate.
 */
export function covers(mentions: Mentions, file: string, root: string, reach: Reach = "deep"): boolean {
    if (mentions.paths.has(file)) {
        return true;
    }

    if (reach === "file") {
        return false;
    }

    const floor = root.endsWith(sep) ? root : `${root}${sep}`;
    const byPrefix = globsByPrefix(mentions.globs);
    let first = true;

    // Only a directory, or a glob whose literal prefix is, on the file's own ancestor chain can
    // cover it, so the chain is walked once instead of testing every glob against every file.
    // Measured: 800 dirty files against 200 globs took 37 ms the naive way.
    for (let dir = dirname(file); dir.startsWith(floor); dir = dirname(dir)) {
        if ((first || reach === "deep") && mentions.paths.has(dir)) {
            return true;
        }

        for (const glob of byPrefix.get(dir) ?? []) {
            if (reach === "shallow" && glob.includes("**")) {
                continue;
            }

            let matcher = compiled.get(glob);

            if (!matcher) {
                matcher = new Bun.Glob(glob);
                compiled.set(glob, matcher);
            }

            if (matcher.match(file)) {
                return true;
            }
        }

        first = false;
    }

    return false;
}

const prefixIndexes = new WeakMap<string[], { count: number; index: Map<string, string[]> }>();

/** The globs keyed by their literal prefix, rebuilt when the list has grown since. */
function globsByPrefix(globs: string[]): Map<string, string[]> {
    const held = prefixIndexes.get(globs);

    if (held && held.count === globs.length) {
        return held.index;
    }

    const index = new Map<string, string[]>();

    for (const glob of globs) {
        const prefix = globPrefix(glob);

        index.set(prefix, [...(index.get(prefix) ?? []), glob]);
    }

    prefixIndexes.set(globs, { count: globs.length, index });

    return index;
}

/**
 * `covers` for many files of ONE root: the index is cut down to the entries under that root
 * first, so a capture that weighs 800 dirty files against a session index of thousands of paths
 * pays for the few entries that can match, not for the whole index each time.
 */
export function coverage(mentions: Mentions, root: string, reach: Reach): (file: string) => boolean {
    const floor = root.endsWith(sep) ? root : `${root}${sep}`;
    const inside: Mentions = {
        paths: new Set([...mentions.paths].filter((path) => path.startsWith(floor))),
        globs: mentions.globs.filter((glob) => glob.startsWith(floor)),
    };

    if (inside.paths.size === 0 && inside.globs.length === 0) {
        return () => false;
    }

    return (file) => covers(inside, file, root, reach);
}
