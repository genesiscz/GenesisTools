import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { listWorktrees } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { findClaudeTranscript } from "@genesiscz/utils/session-changes";
import { Storage } from "@genesiscz/utils/storage";
import { diffArrays } from "diff";
import { readBlobs } from "./diff";
import { type ChangeEvent, sessionChangesPath } from "./log";

const log = logger.child({ component: "agents/blame" });

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_CHANGE_LOGS = 400;
/** A line this short (a lone brace, an empty line) says nothing about who wrote it. */
const MIN_LINE_CHARS = 3;
/** One line diff past this gives up: that event attributes nothing, rather than stall the blame. */
const ALIGN_BUDGET_MS = 200;
const MAX_PROMPT_CHARS = 160;
/** Transcripts larger than this are not searched for a turn's prompt. */
const MAX_TRANSCRIPT_BYTES = 1024 * 1024 * 1024;
const GREP_TIMEOUT_MS = 5000;
/** A change-log row's `"path":"…"` field, read without parsing the row. */
const PATH_FIELD = /"path":"((?:[^"\\]|\\.)*)"/;
const RG = Bun.which("rg");
const SEARCH = RG ? [RG, "--no-config", "-m", "1", "-F", "--no-filename", "--"] : ["grep", "-m", "1", "-F", "--"];

/** The session turn one or more lines came from: the last agent change that added their text. */
export interface BlameSource {
    provider: string;
    session: string;
    turn: string;
    toolUseId: string | null;
    ts: string;
    /** The turn's prompt (Claude transcripts), so a hover says what the agent was asked. */
    prompt: string | null;
}

/** `[startLine, endLine, sourceIndex]`, 1-based and inclusive, over the file's current text. */
export type BlameRange = [number, number, number];

export interface FileBlame {
    path: string;
    ranges: BlameRange[];
}

export interface BlameResult {
    sources: BlameSource[];
    files: FileBlame[];
    scanned: { logs: number; events: number; blobs: number };
    elapsedMs: number;
}

function lines(text: string): string[] {
    return text.split("\n").map((line) => line.trimEnd());
}

function countAdded(before: readonly string[], after: readonly string[]): string[] {
    const left = new Map<string, number>();

    for (const line of before) {
        left.set(line, (left.get(line) ?? 0) + 1);
    }

    const added: string[] = [];

    for (const line of after) {
        const count = left.get(line) ?? 0;

        if (count > 0) {
            left.set(line, count - 1);
        } else {
            added.push(line);
        }
    }

    return added;
}

/** The lines `after` has beyond `before`, counted: a moved line is not new, a duplicated one is. */
export function addedLines(before: string | null, after: string): string[] {
    return countAdded(before === null ? [] : lines(before), lines(after));
}

/**
 * Where each line of `from` sits in `to` when a line diff keeps it, null for a line the diff drops.
 * Null as a whole when the diff runs past its budget.
 */
function alignLines(from: string[], to: string[]): Array<number | null> | null {
    const changes = diffArrays(from, to, { timeout: ALIGN_BUDGET_MS });

    if (!changes) {
        return null;
    }

    const placed: Array<number | null> = from.map(() => null);
    let left = 0;
    let right = 0;

    for (const change of changes) {
        if (change.added) {
            right += change.count;
            continue;
        }

        if (change.removed) {
            left += change.count;
            continue;
        }

        for (let offset = 0; offset < change.count; offset++) {
            placed[left + offset] = right + offset;
        }

        left += change.count;
        right += change.count;
    }

    return placed;
}

/**
 * The positions of the lines `after` added over `before`. A line diff says WHERE, `countAdded` says
 * how many of each text: a moved line stays old, and of `a` becoming `a a` only one copy is new.
 */
function addedIndexes(before: string[], after: string[]): number[] | null {
    const allowed = new Map<string, number>();

    for (const line of countAdded(before, after)) {
        allowed.set(line, (allowed.get(line) ?? 0) + 1);
    }

    if (allowed.size === 0) {
        return [];
    }

    const kept = alignLines(before, after);

    if (!kept) {
        return null;
    }

    const matched = new Set(kept.filter((index): index is number => index !== null));
    const indexes: number[] = [];

    after.forEach((line, index) => {
        const left = allowed.get(line) ?? 0;

        if (left > 0 && !matched.has(index)) {
            indexes.push(index);
            allowed.set(line, left - 1);
        }
    });

    return indexes;
}

/**
 * For each line of `current` (index 0 = line 1), the event that last added that line, or null.
 * Each event's added lines are placed by position, first in its own after-state, then in `current`
 * through a line diff, so a duplicate line belongs only to the event that added that copy. Events
 * are applied oldest first, so a later session that rewrote a line takes it over. Lines shorter
 * than three characters stay unattributed.
 */
export function blameText({
    current,
    events,
    text,
}: {
    current: string;
    events: readonly ChangeEvent[];
    /** A blob's text by oid; a missing blob skips its event. */
    text: (oid: string) => string | null;
}): Array<number | null> {
    const target = lines(current);
    const owners: Array<number | null> = target.map(() => null);
    const unplaced = new Map<string, number[]>();
    const order = events.map((event, index) => ({ event, index })).sort((a, b) => a.event.ts.localeCompare(b.event.ts));

    for (const { event, index } of order) {
        const after = event.afterOid ? text(event.afterOid) : null;

        if (after === null) {
            continue;
        }

        const before = event.beforeOid ? text(event.beforeOid) : null;

        if (event.beforeOid && before === null) {
            // Without the before-state every line would look new.
            continue;
        }

        const afterLines = lines(after);
        const added = addedIndexes(before === null ? [] : lines(before), afterLines);
        const placed = added && added.length > 0 ? alignLines(afterLines, target) : null;

        if (added === null || (added.length > 0 && placed === null)) {
            log.debug({ path: event.path, ts: event.ts }, "blame: a line diff ran past its budget; event skipped");
            continue;
        }

        for (const at of added) {
            const line = placed?.[at];

            if (line !== null && line !== undefined) {
                owners[line] = index;
            } else {
                const text = afterLines[at] ?? "";
                unplaced.set(text, [...(unplaced.get(text) ?? []), index]);
            }
        }
    }

    // A line a later change MOVED no longer lines up with the change that added it. It keeps that
    // owner by its text, one copy per addition, the latest addition first.
    target.forEach((line, at) => {
        const pool = unplaced.get(line);

        if (owners[at] === null && pool && pool.length > 0) {
            owners[at] = pool.pop() ?? null;
        }
    });

    return target.map((line, at) => (line.trim().length < MIN_LINE_CHARS ? null : (owners[at] ?? null)));
}

/** Runs of equal owners as inclusive 1-based ranges; unattributed lines are left out. */
export function toRanges(perLine: ReadonlyArray<number | null>): BlameRange[] {
    const ranges: BlameRange[] = [];

    perLine.forEach((owner, index) => {
        if (owner === null) {
            return;
        }

        const last = ranges.at(-1);

        if (last && last[2] === owner && last[1] === index) {
            last[1] = index + 1;
        } else {
            ranges.push([index + 1, index + 1, owner]);
        }
    });

    return ranges;
}

/** Change-log rows about `paths` (absolute), from logs written since `since`. */
export function changeEventsFor({
    paths,
    since,
    dir = dirname(dirname(sessionChangesPath("probe"))),
}: {
    paths: ReadonlySet<string>;
    since: Date;
    dir?: string;
}): { events: ChangeEvent[]; logs: number } {
    let names: string[];

    try {
        names = readdirSync(dir).filter((name) => !name.startsWith("_"));
    } catch (error) {
        log.debug({ error, dir }, "blame: no change logs");
        return { events: [], logs: 0 };
    }

    const logs: { path: string; mtime: number }[] = [];

    for (const name of names) {
        const path = join(dir, name, "changes.jsonl");

        try {
            const mtime = statSync(path).mtimeMs;

            if (mtime >= since.getTime()) {
                logs.push({ path, mtime });
            }
        } catch (error) {
            log.trace({ error, path }, "blame: no change log");
        }
    }

    const chosen = logs.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_CHANGE_LOGS);
    const events: ChangeEvent[] = [];

    for (const { path: logPath } of chosen) {
        let body: string;

        try {
            body = readFileSync(logPath, "utf8");
        } catch (error) {
            log.debug({ error, logPath }, "blame: change log unreadable");
            continue;
        }

        for (const line of body.split("\n")) {
            // Cheap gate before parsing: most rows are about other files. One set lookup per row; a
            // `line.includes` per wanted path cost 13.8 s for 348 files across the worktrees.
            const path = PATH_FIELD.exec(line)?.[1];

            if (!path || !paths.has(path.replaceAll("\\\\", "\\").replaceAll('\\"', '"'))) {
                continue;
            }

            try {
                const row: ChangeEvent = SafeJSON.parse(line, { strict: true });

                if (paths.has(row.path) && row.ts >= since.toISOString()) {
                    events.push(row);
                }
            } catch (error) {
                log.debug({ error, logPath }, "blame: bad change-log row");
            }
        }
    }

    return { events, logs: chosen.length };
}

/** The prompts of these turns (user message uuids), from the session's Claude transcript, read once. */
export function turnPrompts(session: string, turns: string[], find = findClaudeTranscript): Map<string, string> {
    const found = new Map<string, string>();
    const file = find(session);

    if (!file) {
        return found;
    }

    try {
        if (statSync(file).size > MAX_TRANSCRIPT_BYTES) {
            return found;
        }

        for (const turn of new Set(turns)) {
            // The change log's turn is the prompt's `promptId`; its first row is the prompt itself.
            // The search stops there, where a JS read would load the whole transcript (often 100 MB+).
            // rg, when installed: macOS's BSD grep took 674 ms for one late turn in a 134 MB file, rg 40 ms.
            const grep = spawnSync(SEARCH[0], [...SEARCH.slice(1), `"promptId":"${turn}"`, file], {
                timeout: GREP_TIMEOUT_MS,
                maxBuffer: 16 * 1024 * 1024,
                encoding: "utf8",
            });

            if (grep.error) {
                log.debug({ error: grep.error, file, turn }, "blame: grep for a turn prompt failed");
            }

            const prompt = grep.stdout ? promptOf(grep.stdout.split("\n")[0]) : null;

            if (prompt) {
                found.set(turn, prompt);
            }
        }
    } catch (error) {
        log.debug({ error, session }, "blame: turn prompts unreadable");
    }

    return found;
}

/**
 * A transcript row's user text: a string content, or its text parts joined. A row that is not JSON
 * (torn, or cut short when the search output passed its buffer) has no prompt; it never throws, so
 * one bad row cannot cost every later turn of the session its prompt.
 */
export function promptOf(line: string): string | null {
    let row: unknown;

    try {
        row = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        log.debug({ error, length: line.length }, "blame: a turn's prompt row is not JSON");
        return null;
    }

    if (typeof row !== "object" || row === null || !("message" in row)) {
        return null;
    }

    const message = row.message;

    if (typeof message !== "object" || message === null || !("content" in message)) {
        return null;
    }

    const content = message.content;
    const text =
        typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                    .map((part: unknown) =>
                        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
                            ? part.text
                            : ""
                    )
                    .join(" ")
              : "";
    const flat = text.replace(/\s+/g, " ").trim();
    return flat ? flat.slice(0, MAX_PROMPT_CHARS) : null;
}

const PROMPT_CACHE = "blame-prompts.json";
const PROMPT_CACHE_TTL = "90 days";
const PROMPT_CACHE_MAX = 5000;

/**
 * `turnPrompts` behind a cache of every prompt found so far: a turn's prompt never changes, and each
 * lookup searches a transcript that is often over 100 MB (2.2 s for 31 turns, measured).
 */
async function cachedTurnPrompts(session: string, turns: string[]): Promise<Map<string, string>> {
    const storage = new Storage("agents");
    const cached = (await storage.getCacheFile<Record<string, string>>(PROMPT_CACHE, PROMPT_CACHE_TTL)) ?? {};
    const found = new Map<string, string>();
    const missing: string[] = [];

    for (const turn of turns) {
        const hit = cached[`${session}:${turn}`];

        if (hit) {
            found.set(turn, hit);
        } else {
            missing.push(turn);
        }
    }

    if (missing.length === 0) {
        return found;
    }

    const fresh = turnPrompts(session, missing);

    for (const [turn, prompt] of fresh) {
        found.set(turn, prompt);
        cached[`${session}:${turn}`] = prompt;
    }

    if (fresh.size > 0) {
        const entries = Object.entries(cached);
        await storage.putCacheFile(
            PROMPT_CACHE,
            Object.fromEntries(entries.slice(-PROMPT_CACHE_MAX)),
            PROMPT_CACHE_TTL
        );
    }

    return found;
}

export interface BlameDeps {
    checkouts: (repo: string) => Promise<string[]>;
    events: (paths: ReadonlySet<string>, since: Date) => { events: ChangeEvent[]; logs: number };
    blobs: (oids: string[]) => Map<string, Buffer>;
    read: (path: string) => string | null;
    prompts: (session: string, turns: string[]) => Promise<Map<string, string>>;
    now: () => Date;
}

/**
 * Which agent session and turn wrote each line of these files, as they are in `repo` now. Every
 * checkout of the repository counts: a PR's lines are often written in its own worktree. Read-only.
 */
export async function blameFiles(
    { repo, files, since }: { repo: string; files: string[]; since?: Date },
    deps: BlameDeps
): Promise<BlameResult> {
    const started = performance.now();
    const from = since ?? new Date(deps.now().getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
    const roots = [...new Set([repo, ...(await deps.checkouts(repo))])];
    const byAbsolute = new Map<string, string>();

    for (const file of files) {
        for (const root of roots) {
            byAbsolute.set(join(root, file), file);
        }
    }

    const { events, logs } = deps.events(new Set(byAbsolute.keys()), from);
    const oids = [
        ...new Set(events.flatMap((event) => [event.beforeOid, event.afterOid]).filter((oid) => oid !== null)),
    ];
    const blobs = oids.length ? deps.blobs(oids) : new Map<string, Buffer>();
    const text = (oid: string) => blobs.get(oid)?.toString("utf8") ?? null;
    const sources: BlameSource[] = [];
    const sourceIndex = new Map<ChangeEvent, number>();
    const result: FileBlame[] = [];

    for (const file of files) {
        const current = deps.read(join(repo, file));
        const mine = events.filter((event) => byAbsolute.get(event.path) === file);

        if (current === null || mine.length === 0) {
            continue;
        }

        const perLine = blameText({ current, events: mine, text }).map((owner) => {
            if (owner === null) {
                return null;
            }

            const event = mine[owner];
            let index = sourceIndex.get(event);

            if (index === undefined) {
                // One source per turn: every change of that turn shares its hover.
                index = sources.findIndex((source) => source.session === event.session && source.turn === event.turn);

                if (index === -1) {
                    index = sources.length;
                    sources.push({
                        provider: event.provider,
                        session: event.session,
                        turn: event.turn,
                        toolUseId: event.toolUseId ?? null,
                        ts: event.ts,
                        prompt: null,
                    });
                } else if (event.ts > sources[index].ts) {
                    sources[index].ts = event.ts;
                    sources[index].toolUseId = event.toolUseId ?? sources[index].toolUseId;
                }

                sourceIndex.set(event, index);
            }

            return index;
        });
        const ranges = toRanges(perLine);

        if (ranges.length) {
            result.push({ path: file, ranges });
        }
    }

    const claude = sources.filter((source) => source.provider === "claude");

    for (const session of new Set(claude.map((source) => source.session))) {
        const mine = claude.filter((source) => source.session === session);
        const prompts = await deps.prompts(
            session,
            mine.map((source) => source.turn)
        );

        for (const source of mine) {
            source.prompt = prompts.get(source.turn) ?? null;
        }
    }

    const elapsedMs = Math.round(performance.now() - started);
    log.debug(
        {
            repo,
            files: files.length,
            roots: roots.length,
            logs,
            events: events.length,
            sources: sources.length,
            elapsedMs,
        },
        "blame: done"
    );
    return { sources, files: result, scanned: { logs, events: events.length, blobs: blobs.size }, elapsedMs };
}

export const realBlameDeps: BlameDeps = {
    checkouts: async (repo) => {
        try {
            return (await listWorktrees(repo)).map((worktree) => worktree.path);
        } catch (error) {
            log.debug({ error, repo }, "blame: no worktree list");
            return [];
        }
    },
    events: (paths, since) => changeEventsFor({ paths, since }),
    blobs: (oids) => readBlobs(oids),
    read: (path) => {
        try {
            return readFileSync(path, "utf8");
        } catch (error) {
            log.debug({ error, path }, "blame: file not readable");
            return null;
        }
    },
    prompts: cachedTurnPrompts,
    now: () => new Date(),
};
