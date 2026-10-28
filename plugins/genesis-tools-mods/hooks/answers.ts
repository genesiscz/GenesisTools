// What the answer MCP (`tools question`) holds for this session: its decisions in every state, its todos, the
// messages and answers it recorded, and the forms it left pending. One `tools question inbox --session <id> --json
// --all-items` call reads them all, and it runs only when the files behind it changed, a sidebar asks, or this
// session just called a question tool: every running session reads it. The call passes the cursor of the last answer
// (`--since`), kept in a file across mod reloads: when nothing changed the CLI answers so after a few `stat`s, and
// otherwise it sends only the changed items, which are merged into the last answer.
//
// Also where each item was asked, for "jump to": the transcript row of a decision's first ask (an assistant text
// with `❓ DECISION N` that is not a link) and the tool call that recorded an entry. A row's `requestId` is the
// transcript entry's `uuid` (a text row) or the tool_use id (a tool row). `tools question transcript-rows` finds
// them from an index every caller shares; a CLI without that command falls back to a `grep` of the appended bytes.
import type { ToolCallInput } from "claude-code";
import { sessionDirOf } from "./agents-band";
import { decisionLink, genesisProbe } from "./genesis";
import { agentsDir, type Host, isRecord, logMod, settingsOf } from "./shared";
import { pressed } from "./sidebar";

export type DecisionStatus =
    | "waiting"
    | "drafted"
    | "answered"
    | "sent"
    | "acknowledged"
    | "implemented"
    | "dismissed"
    | "superseded";

/** One decision of the session as the decision log has it. */
export interface LoggedDecision {
    n: number;
    title: string;
    prompt: string;
    status: DecisionStatus;
    options: { letter: string; text: string }[];
    /** The letter the asker recommended. */
    recommended?: string;
    /** The letter picked, and the answer in words. */
    option?: string;
    answer?: string;
    /**
     * Who stored the answer (`inbox`, `agent`, `automatic_heuristic`). The decision log is the one place that says a
     * decision was answered in chat: the decision Stop hook records the user's chat answers there.
     */
    answeredVia?: string;
    /**
     * The text's revision (1 until the agent re-posts it). A stage sends it, so a pick made on text the agent has
     * since changed is refused with "DECISION N changed: …" instead of landing on the new text.
     */
    revision?: number;
    /** A staged answer not sent yet (state `drafted`): the picked letters and a note. The store owns staging. */
    draftOption?: string;
    draft?: string;
    at: number;
}

/** A message the session sent to the inbox, or a question and answer it recorded. */
export interface LoggedEntry {
    id: string;
    at: number;
    tag: "question" | "action" | "directive" | "message";
    title: string;
    text: string;
    isUnread: boolean;
    images: string[];
}

export interface LoggedTodo {
    n: number;
    title: string;
    state: string;
    at: number;
}

export interface LoggedForm {
    id: string;
    at: number;
    prompts: string[];
}

export interface SessionAnswers {
    decisions: LoggedDecision[];
    todos: LoggedTodo[];
    entries: LoggedEntry[];
    forms: LoggedForm[];
    /** The message `[send]` submits now, as the CLI's `stagedSendText` builds it; absent when nothing is staged. */
    staged?: string;
    /** When this read finished. */
    at: number;
}

const QUESTION_TOOLS = new Set([
    "mcp__genesis-tools__question_post",
    "mcp__genesis-tools__question_update",
    "mcp__genesis-tools__question_answer",
    "mcp__genesis-tools__inbox_send",
]);
const STATUSES: ReadonlySet<string> = new Set<DecisionStatus>([
    "waiting",
    "drafted",
    "answered",
    "sent",
    "acknowledged",
    "implemented",
    "dismissed",
    "superseded",
]);
const TAGS: ReadonlySet<string> = new Set<LoggedEntry["tag"]>(["question", "action", "directive", "message"]);
/** How often the files behind the items are checked; the CLI runs only when this session's part of them changed. */
const TICK_MS = 10_000;
/**
 * A read mark or a lost lifecycle event is recovered by a session snapshot this often, including an empty session.
 * Between snapshots, bounded incremental reads of the event logs detect this session's changes. Each snapshot is a
 * `tools question inbox` of about 3 s and a transcript grep of up to 8 s on a loaded Mac; at 5 minutes, 26 sessions ran
 * 566 of them in two hours (2026-10-27).
 */
const SLOW_MS = 15 * 60_000;
/** The maximum bytes read from one changed shared log, before any allocation or line splitting. */
const LOG_READ_BYTES = 65_536;
/** Bound the older-CLI fallback before its output reaches the plugin. */
const SEARCH_CHUNK_BYTES = 65_536;
const MAX_SEARCH_CHUNK_BYTES = 1_048_576;
/** A tool call more than this before its entry did not record it. */
const ENTRY_WINDOW_MS = 10 * 60_000;
const FIRST_ASK = /(^|[^[])❓\s*\**\s*DECISION\s+(\d+)/gm;

let held: SessionAnswers | undefined;
/** The CLI's last answer as it printed it, and its cursor: the base a `--since` change is merged into. */
let heldRaw: Record<string, unknown> | undefined;
let heldCursor: string | undefined;
/** The CLI refused `--since` / `--transcript` or `transcript-rows` (an older GenesisTools): use the old calls. */
let cursorUnsupported = false;
let rowsUnsupported = false;
/** The transcript size at the last `transcript-rows` call: an unchanged transcript holds no new row. */
let rowsSize = -1;
let indexedCalls: { id: string; at: number }[] = [];
/** What the last read saw: the hash of this session's lines in the shared logs. */
let heldStamp: string | undefined;
let lastReadAt = 0;
/** Each shared file's size and time at the last check, with the hash of this session's lines in it. */
const seenFiles = new Map<string, { mark: string; size: number; own: string; lines: number }>();
let reading: Promise<SessionAnswers | undefined> | undefined;
let started = false;
/** Decision number to the uuid of its first ask; entry id to the tool call that recorded it. Found once, kept. */
const askRows = new Map<number, string>();
const entryRows = new Map<string, string>();

/** The last read, or undefined before the first one finished. */
export function answersOf(): SessionAnswers | undefined {
    return held;
}

/** The transcript row a jump scrolls to: a decision's first ask, or an entry's tool call. */
export function jumpRowOf(target: { decision: number } | { entry: string }): string | undefined {
    return "decision" in target ? askRows.get(target.decision) : entryRows.get(target.entry);
}

/** Drops what was read: a test starts another session. */
export function forgetAnswers(): void {
    held = undefined;
    heldRaw = undefined;
    heldCursor = undefined;
    cursorUnsupported = false;
    rowsUnsupported = false;
    rowsSize = -1;
    indexedCalls = [];
    heldStamp = undefined;
    lastReadAt = 0;
    seenFiles.clear();
    reading = undefined;
    started = false;
    askRows.clear();
    entryRows.clear();
    searchedSize = -1;
    searchedOffset = 0;
    searchChunkBytes = SEARCH_CHUNK_BYTES;
    searchOutputLimit = MAX_SEARCH_CHUNK_BYTES + 1;
    skippingOversized = false;
    searchedTranscript = undefined;
    recentCalls = [];
}

function isStatus(value: string): value is DecisionStatus {
    return STATUSES.has(value);
}

function isTag(value: string): value is LoggedEntry["tag"] {
    return TAGS.has(value);
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function timeOf(value: unknown): number {
    const at = typeof value === "number" ? value : Date.parse(text(value));

    return Number.isFinite(at) ? at : 0;
}

/** `a) Keep it` with the letter `a` gives `Keep it`. */
function withoutLetter(label: string, letter: string): string {
    return label.replace(new RegExp(`^\\s*\\(?${letter}\\)\\s*`), "").trim();
}

/** The JSON `inbox --session <id> --json --all-items` prints, as this plugin keeps it; undefined when it is not that. */
export function answersFrom(stdout: string, at = Date.now()): SessionAnswers | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout);
    } catch {
        return undefined;
    }

    return answersOfValue(parsed, at);
}

const LISTS = ["decisions", "todos", "entries", "forms"] as const;

/**
 * The CLI's last answer with a `--since` change applied: changed items replace the ones with their id, new ones are
 * added, the ids under `removed` go, and `staged` is set or cleared when it is present. Undefined when `change` is not
 * a change (`full` is not false) or names no list.
 */
export function mergedAnswer(
    last: Record<string, unknown>,
    change: Record<string, unknown>
): Record<string, unknown> | undefined {
    if (change.full !== false || !LISTS.every((list) => Array.isArray(change[list]))) {
        return undefined;
    }

    const removed = isRecord(change.removed) ? change.removed : {};
    const merged: Record<string, unknown> = { ...last, cursor: change.cursor };

    for (const list of LISTS) {
        const gone = new Set(Array.isArray(removed[list]) ? removed[list].map(String) : []);
        const changed = (Array.isArray(change[list]) ? change[list] : []).filter(isRecord);
        const byId = new Map(changed.map((item) => [String(item.id), item]));
        const kept = (Array.isArray(last[list]) ? last[list] : [])
            .filter(isRecord)
            .filter((item) => !gone.has(String(item.id)))
            .map((item) => byId.get(String(item.id)) ?? item);
        const known = new Set(kept.map((item) => String(item.id)));
        merged[list] = [...kept, ...changed.filter((item) => !known.has(String(item.id)))];
    }

    if ("staged" in change) {
        if (typeof change.staged === "string" && change.staged) {
            merged.staged = change.staged;
        } else {
            delete merged.staged;
        }
    }

    return merged;
}

function answersOfValue(parsed: unknown, at: number): SessionAnswers | undefined {
    if (!isRecord(parsed) || !Array.isArray(parsed.decisions)) {
        return undefined;
    }

    const list = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => isRecord(item)) : [];

    return {
        decisions: list(parsed.decisions).map((item) => {
            const status = text(item.status);

            return {
                n: Number(item.number),
                title: text(item.title) || text(item.prompt).split("\n")[0] || "",
                prompt: text(item.prompt),
                status: isStatus(status) ? status : "waiting",
                options: list(item.choices).map((choice) => {
                    const letter = text(choice.id);

                    return { letter, text: withoutLetter(text(choice.label), letter) };
                }),
                ...(text(item.recommended) ? { recommended: text(item.recommended) } : {}),
                ...(text(item.option) ? { option: text(item.option) } : {}),
                ...(text(item.answer) ? { answer: text(item.answer) } : {}),
                ...(text(item.answeredVia) ? { answeredVia: text(item.answeredVia) } : {}),
                ...(typeof item.revision === "number" ? { revision: item.revision } : {}),
                ...(text(item.draftOption) ? { draftOption: text(item.draftOption) } : {}),
                ...(text(item.draft) ? { draft: text(item.draft) } : {}),
                at: timeOf(item.at),
            };
        }),
        todos: list(parsed.todos).map((item) => ({
            n: Number(item.number),
            title: text(item.title),
            state: text(item.state),
            at: timeOf(item.at),
        })),
        entries: list(parsed.entries)
            .map((item) => {
                const tag = text(item.tag);

                return {
                    id: text(item.id),
                    at: timeOf(item.ts),
                    tag: isTag(tag) ? tag : "message",
                    title: text(item.question),
                    text: text(item.answerMd),
                    isUnread: item.readAt === null || item.readAt === undefined,
                    images: list(item.attachments)
                        .filter((file) => file.type === "image")
                        .map((file) => text(file.path))
                        .filter(Boolean),
                };
            })
            .sort((a, b) => b.at - a.at),
        forms: list(parsed.forms).map((item) => ({
            id: text(item.id),
            at: timeOf(item.at),
            prompts: list(item.questions).map((question) => text(question.prompt)),
        })),
        ...(text(parsed.staged) ? { staged: text(parsed.staged) } : {}),
        at,
    };
}

/** Each decision's first ask in transcript lines: the first assistant entry whose text asks it without a link. */
export function firstAsks(lines: readonly string[]): Map<number, string> {
    const found = new Map<number, string>();

    for (const line of lines) {
        const entry = parseLine(line);

        if (entry?.type !== "assistant" || typeof entry.uuid !== "string") {
            continue;
        }

        for (const block of blocksOf(entry)) {
            if (block.type !== "text") {
                continue;
            }

            for (const match of text(block.text).matchAll(FIRST_ASK)) {
                const n = Number(match[2]);

                if (!found.has(n)) {
                    found.set(n, entry.uuid);
                }
            }
        }
    }

    return found;
}

/** The question tool calls in transcript lines: an MCP question tool, or a Bash command that runs `tools question`. */
export function questionCalls(lines: readonly string[]): { id: string; at: number }[] {
    const calls: { id: string; at: number }[] = [];

    for (const line of lines) {
        const entry = parseLine(line);

        if (entry?.type !== "assistant") {
            continue;
        }

        for (const block of blocksOf(entry)) {
            const input = isRecord(block.input) ? block.input : {};
            const isQuestion =
                QUESTION_TOOLS.has(text(block.name)) ||
                (block.name === "Bash" && /\btools question\b/.test(text(input.command)));

            if (block.type === "tool_use" && isQuestion && text(block.id)) {
                calls.push({ id: text(block.id), at: timeOf(entry.timestamp) });
            }
        }
    }

    return calls;
}

/** The call that recorded an entry: the latest question call before it (a few seconds of clock skew allowed). */
export function callFor(at: number, calls: readonly { id: string; at: number }[]): string | undefined {
    let best: { id: string; at: number } | undefined;

    for (const call of calls) {
        if (call.at <= at + 5_000 && call.at >= at - ENTRY_WINDOW_MS && (!best || call.at > best.at)) {
            best = call;
        }
    }

    return best?.id;
}

function parseLine(line: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(line);

        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function blocksOf(entry: Record<string, unknown>): Record<string, unknown>[] {
    const message = isRecord(entry.message) ? entry.message : {};

    return Array.isArray(message.content)
        ? message.content.filter((block): block is Record<string, unknown> => isRecord(block))
        : [];
}

/** A short hash (FNV-1a) of a text. */
function hashOf(value: string): string {
    let hash = 0x811c9dc5;

    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(36);
}

/**
 * An append-only log's new bytes, capped before they enter the plugin. A gap or rotation invalidates the snapshot
 * even when the bounded window cannot name this session, so an unseen event is recovered by the scoped CLI read.
 */
async function ownLines(host: Host, file: string, session: string): Promise<{ own: string; lines: number }> {
    const stat = await host.stat(file).catch(() => undefined);
    const mark = stat ? `${stat.mtimeMs}:${stat.size}` : "-";
    const seen = seenFiles.get(file);

    if (seen?.mark === mark) {
        return seen;
    }

    if (!stat || stat.size === 0) {
        const found = { mark, size: 0, own: hashOf(""), lines: 0 };
        seenFiles.set(file, found);
        return found;
    }

    const delta = stat.size - (seen?.size ?? 0);
    const reset = !seen || delta <= 0;
    const gap = (reset ? stat.size : delta) > LOG_READ_BYTES;
    const count = Math.min(LOG_READ_BYTES, reset ? stat.size : delta);
    // Bound the suffix before it reaches the plugin. Accept it only while the file stayed unchanged, so an append
    // during tail cannot shift the window past unread bytes and then be hidden behind the remembered stamp.
    const run = await host.run(["tail", "-c", String(count), file], { timeoutMs: 5_000 }).catch(() => undefined);
    const after = await host.stat(file).catch(() => undefined);

    if (
        !run ||
        run.exitCode !== 0 ||
        run.isStdoutTruncated ||
        run.stdout === "" ||
        !after ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs
    ) {
        // Do not remember a failed, aborted or moving read: the next poll retries it.
        return { own: `unread:${mark}`, lines: 1 };
    }

    const content = gap ? run.stdout.slice(run.stdout.indexOf("\n") + 1) : run.stdout;
    const mine = content.split("\n").filter((line) => line.includes(session));
    const previous = reset ? "" : (seen?.own ?? "");
    const uncertain = gap || (reset && seen !== undefined);
    const own = uncertain
        ? hashOf(`${mark}|${previous}|${mine.join("\n")}`)
        : mine.length > 0
          ? hashOf(`${previous}|${mine.join("\n")}`)
          : previous || hashOf("");
    const found = {
        mark,
        size: stat.size,
        own,
        lines: (reset ? 0 : (seen?.lines ?? 0)) + mine.length + (uncertain ? 1 : 0),
    };
    seenFiles.set(file, found);

    return found;
}

/** This session's changes in the append-only decision, Q→A and pending-form lifecycle logs. */
async function stampOf(host: Host): Promise<{ own: string; lines: number }> {
    const home = (await host.env("GENESIS_TOOLS_HOME")) ?? (await host.env("HOME"));

    if (!home) {
        return { own: "", lines: 0 };
    }

    const question = `${home}/.genesis-tools/question`;
    const session = await host.sessionId();
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const own = await Promise.all([
        ownLines(host, `${question}/decisions/events.jsonl`, session),
        ownLines(host, `${question}/log/${day}.jsonl`, session),
        ownLines(host, `${question}/pending/${day}.jsonl`, session),
    ]);

    return { own: own.map((file) => file.own).join("|"), lines: own.reduce((sum, file) => sum + file.lines, 0) };
}

/** The transcript's size at the last search: a search that found nothing new waits for the transcript to grow. */
let searchedSize = -1;
/** Bytes of the transcript already searched: the next search reads only what was appended after them. */
let searchedOffset = 0;
let searchChunkBytes = SEARCH_CHUNK_BYTES;
let searchOutputLimit = MAX_SEARCH_CHUNK_BYTES + 1;
let skippingOversized = false;
let searchedTranscript: string | undefined;
/** Question tool calls of the last ENTRY_WINDOW_MS, kept so an entry logged after its call's search still finds it. */
let recentCalls: { id: string; at: number }[] = [];
/**
 * Where each transcript's search stopped and what it found, kept in the mods store so a mods reload (every save of a
 * mod file reloads every session) does not grep a 500 MB transcript again: on 2026-10-27, 26 sessions ran 150 full
 * greps of 6 to 9 s each in 90 minutes.
 */
const SEARCH_STORE_KEY = "answers.search";
const SEARCH_STORE_KEEP = 100;

interface SearchMark {
    offset: number;
    skippingOversized?: boolean;
    asks: [number, string][];
    entries: [string, string][];
    at: number;
}

async function restoreSearch(host: Host, transcript: string): Promise<void> {
    searchedTranscript = transcript;
    searchedOffset = 0;
    searchChunkBytes = SEARCH_CHUNK_BYTES;
    searchOutputLimit = MAX_SEARCH_CHUNK_BYTES + 1;
    skippingOversized = false;
    rowsSize = -1;
    indexedCalls = [];
    recentCalls = [];
    const all = await host.storeGet(SEARCH_STORE_KEY).catch(() => undefined);
    const mark = isRecord(all) ? all[transcript] : undefined;

    if (
        !isRecord(mark) ||
        typeof mark.offset !== "number" ||
        !Array.isArray(mark.asks) ||
        !Array.isArray(mark.entries)
    ) {
        return;
    }

    searchedOffset = mark.offset;
    skippingOversized = mark.skippingOversized === true;

    if (skippingOversized) {
        searchChunkBytes = MAX_SEARCH_CHUNK_BYTES;
    }

    for (const pair of mark.asks) {
        if (
            Array.isArray(pair) &&
            typeof pair[0] === "number" &&
            typeof pair[1] === "string" &&
            !askRows.has(pair[0])
        ) {
            askRows.set(pair[0], pair[1]);
        }
    }

    for (const pair of mark.entries) {
        if (
            Array.isArray(pair) &&
            typeof pair[0] === "string" &&
            typeof pair[1] === "string" &&
            !entryRows.has(pair[0])
        ) {
            entryRows.set(pair[0], pair[1]);
        }
    }
}

async function saveSearch(host: Host, transcript: string): Promise<void> {
    const all = await host.storeGet(SEARCH_STORE_KEY).catch(() => undefined);
    const kept = Object.entries(isRecord(all) ? all : {})
        .map(([path, mark]) => ({ path, mark, at: isRecord(mark) && typeof mark.at === "number" ? mark.at : -1 }))
        .filter((held) => held.path !== transcript && held.at >= 0)
        .sort((x, y) => y.at - x.at)
        .slice(0, SEARCH_STORE_KEEP - 1)
        .map((held): [string, unknown] => [held.path, held.mark]);
    const mark: SearchMark = {
        offset: searchedOffset,
        skippingOversized,
        asks: [...askRows],
        entries: [...entryRows],
        at: Date.now(),
    };

    await host
        .storeSet(SEARCH_STORE_KEY, Object.fromEntries([...kept, [transcript, mark]]))
        .catch(async (error: unknown) => {
            await logMod(host, "answers", { event: "search-save-failed", error: String(error) });
        });
}

/**
 * The rows from `tools question transcript-rows`: the index every caller on this Mac shares reads only what was
 * appended since any of them last asked. True when it answered; false when this CLI has no such command (the caller
 * then searches itself) or the call failed (the next poll asks again).
 */
async function rowsFromIndex(
    host: Host,
    transcript: string,
    size: number,
    entries: readonly LoggedEntry[]
): Promise<boolean> {
    if (size === rowsSize) {
        for (const entry of entries) {
            const call = entryRows.has(entry.id) ? undefined : callFor(entry.at, indexedCalls);

            if (call) {
                entryRows.set(entry.id, call);
            }
        }

        return true;
    }

    const done = await host
        .run(["tools", "question", "transcript-rows", "--transcript", transcript, "--json"], { timeoutMs: 60_000 })
        .catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: String(error) }));
    let parsed: unknown;

    try {
        parsed = done.exitCode === 0 ? JSON.parse(done.stdout) : undefined;
    } catch {
        parsed = undefined;
    }

    if (
        !isRecord(parsed) ||
        !isRecord(parsed.file) ||
        typeof parsed.offset !== "number" ||
        ("isStdoutTruncated" in done && done.isStdoutTruncated) ||
        !Array.isArray(parsed.asks) ||
        !Array.isArray(parsed.calls)
    ) {
        if (/unknown command/.test(done.stderr)) {
            rowsUnsupported = true;
        }

        await logMod(host, "answers", {
            event: "rows-failed",
            exit: done.exitCode,
            fallback: rowsUnsupported,
            stderr: done.stderr.slice(-200),
        });
        return false;
    }

    for (const ask of parsed.asks.filter(isRecord)) {
        const n = Number(ask.number);

        if (Number.isInteger(n) && typeof ask.row === "string" && !askRows.has(n)) {
            askRows.set(n, ask.row);
        }
    }

    const calls = parsed.calls
        .filter(isRecord)
        .map((call) => ({ id: text(call.id), at: typeof call.at === "number" ? call.at : 0 }))
        .filter((call) => call.id);

    if (parsed.offset >= size && (!Array.isArray(parsed.issues) || parsed.issues.length === 0)) {
        for (const entry of entries) {
            const call = entryRows.has(entry.id) ? undefined : callFor(entry.at, calls);

            if (call) {
                entryRows.set(entry.id, call);
            }
        }

        indexedCalls = calls;
        rowsSize = size;
    }
    await logMod(host, "answers", { event: "rows", scanned: parsed.scanned, asks: askRows.size, calls: calls.length });
    return true;
}

/**
 * Finds the rows not found yet, for these decision numbers (the log's and the chat's) and entries: from the shared
 * index (`tools question transcript-rows`), or with an older CLI one `grep` over the bytes appended to the transcript
 * since the last search, for the assistant lines that could hold them.
 */
export async function findRows(host: Host, numbers: readonly number[], entries: readonly LoggedEntry[]): Promise<void> {
    const dir = await sessionDirOf(host);

    if (!dir) {
        return;
    }

    const transcript = `${dir}.jsonl`;

    if (transcript !== searchedTranscript) {
        await restoreSearch(host, transcript);
    }

    const missing = numbers.some((n) => !askRows.has(n)) || entries.some((entry) => !entryRows.has(entry.id));

    if (!missing) {
        return;
    }

    const size = (await host.stat(transcript).catch(() => undefined))?.size ?? -1;

    if (size < 0) {
        return;
    }

    if (
        !rowsUnsupported &&
        (await genesisProbe(host)).tools &&
        (await rowsFromIndex(host, transcript, size, entries))
    ) {
        return;
    }

    if (!rowsUnsupported || size === searchedSize || size === searchedOffset) {
        return;
    }

    if (size < searchedOffset) {
        searchedOffset = 0;
        skippingOversized = false;
    }

    const from = searchedOffset;
    const count = Math.min(searchChunkBytes, size - from);

    if (skippingOversized) {
        // Only the byte count crosses the process boundary. The unfinished row itself is never parsed.
        const skipScript = `export LC_ALL=C
last=$(tail -c +"$4" "$1" | head -c 1 | wc -l | tr -d ' ')
tail -c +"$2" "$1" | head -c "$3" | awk -v last="$last" '
NR == 1 { bytes = length($0); next }
NR == 2 { complete = 1; exit }
END { if (NR == 1 && last == 1) complete = 1; print "__SKIP_BYTES__" (bytes + complete) ":" (complete + 0) }
'`;
        const skipped = await host
            .run(
                ["/bin/sh", "-c", skipScript, "sh", transcript, String(from + 1), String(count), String(from + count)],
                {
                    timeoutMs: 15_000,
                }
            )
            .catch(() => undefined);
        const marker =
            skipped && !skipped.isStdoutTruncated && skipped.exitCode === 0 && !skipped.stderr
                ? /^__SKIP_BYTES__(\d+):([01])\s*$/.exec(skipped.stdout)
                : null;
        const bytes = marker ? Number(marker[1]) : 0;

        if (bytes <= 0 || bytes > count) {
            await logMod(host, "answers", { event: "search-skip-failed", transcript, from, to: from + count });
            return;
        }

        searchedOffset = from + bytes;
        skippingOversized = marker?.[2] !== "1";
        searchedSize = searchedOffset === size ? size : -1;

        if (!skippingOversized) {
            searchChunkBytes = SEARCH_CHUNK_BYTES;
            searchOutputLimit = MAX_SEARCH_CHUNK_BYTES + 1;
            await logMod(host, "answers", { event: "search-coverage-gap-end", transcript, to: searchedOffset });
        }

        await saveSearch(host, transcript);
        return;
    }

    // Withhold an incomplete last line. LC_ALL=C makes awk's lengths byte offsets, not character counts.
    const script = `export LC_ALL=C
last=$(tail -c +"$4" "$1" | head -c 1 | wc -l | tr -d ' ')
tail -c +"$2" "$1" | head -c "$3" | awk -v last="$last" '
function emit(s) {
    consumed += length(s) + 1
    if (index(s, "\\"type\\":\\"assistant\\"") && (index(s, "DECISION") || index(s, "mcp__genesis-tools__") || index(s, "tools question"))) print s
}
NR > 1 { emit(previous) }
{ previous = $0 }
END { if (NR && last == 1) emit(previous); print "__SEARCH_BYTES__" consumed + 0 }
'`;
    const found = await host
        .run(["/bin/sh", "-c", script, "sh", transcript, String(from + 1), String(count), String(from + count)], {
            timeoutMs: 15_000,
        })
        .catch(() => undefined);

    if (!found || found.exitCode !== 0 || found.stderr) {
        return;
    }

    if (found.isStdoutTruncated) {
        searchOutputLimit = Math.min(searchOutputLimit, count);
        searchChunkBytes = Math.max(1, Math.floor(count / 2));

        if (count <= 1) {
            skippingOversized = true;
            searchChunkBytes = MAX_SEARCH_CHUNK_BYTES;
            await saveSearch(host, transcript);
            await logMod(host, "answers", { event: "search-coverage-gap", transcript, from, reason: "stdout limit" });
        }

        await logMod(host, "answers", { event: "search-truncated", transcript, from, to: from + count });
        return;
    }

    const lines = found.stdout.split("\n").filter(Boolean);
    const marker = /^__SEARCH_BYTES__(\d+)$/.exec(lines.pop() ?? "");
    const consumed = marker ? Number(marker[1]) : -1;

    if (consumed < 0 || consumed > count) {
        await logMod(host, "answers", { event: "search-invalid-marker", transcript, from, to: from + count });
        return;
    }

    if (consumed === 0 && count < size - from) {
        const next = Math.max(searchChunkBytes * 2, count + 1);

        if (next > MAX_SEARCH_CHUNK_BYTES || next >= searchOutputLimit) {
            skippingOversized = true;
            searchChunkBytes = MAX_SEARCH_CHUNK_BYTES;
            await logMod(host, "answers", {
                event: "search-coverage-gap",
                transcript,
                from,
                reason: "oversized or unrepresentable row; a matching row cannot be indexed",
            });
        } else {
            searchChunkBytes = next;
        }
    } else if (consumed > 0) {
        searchOutputLimit = MAX_SEARCH_CHUNK_BYTES + 1;
    }

    searchedOffset = from + consumed;
    searchedSize = searchedOffset === size || (consumed === 0 && count === size - from) ? size : -1;

    for (const [n, uuid] of firstAsks(lines)) {
        if (!askRows.has(n)) {
            askRows.set(n, uuid);
        }
    }

    const known = new Set(recentCalls.map((call) => call.id));
    const calls = [...recentCalls, ...questionCalls(lines).filter((call) => !known.has(call.id))];

    for (const entry of entries) {
        const call = entryRows.has(entry.id) ? undefined : callFor(entry.at, calls);

        if (call) {
            entryRows.set(entry.id, call);
        }
    }

    const newest = Math.max(Date.now(), ...entries.map((entry) => entry.at));
    recentCalls = calls.filter((call) => call.at >= newest - 2 * ENTRY_WINDOW_MS);
    await logMod(host, "answers", { event: "search", from, to: searchedOffset, lines: lines.length });
    await saveSearch(host, transcript);
}

/** Finds the first asks of decisions the chat knows and the log may not: called after the chat was read. */
export async function findAskRows(host: Host, numbers: readonly number[]): Promise<void> {
    await findRows(host, numbers, held?.entries ?? []);
}

/** `<agents>/mods-state/answers/<session>.json`: the last answer and its cursor, so a mod reload asks `--since`. */
async function inboxFile(host: Host, session: string): Promise<string | undefined> {
    const dir = await agentsDir(host);

    return dir ? `${dir}/mods-state/answers/${session.replace(/[^\w.-]/g, "_")}.json` : undefined;
}

async function restoreInbox(host: Host, session: string): Promise<void> {
    const file = await inboxFile(host, session);
    const text = file ? await host.read(file).catch(() => undefined) : undefined;

    try {
        const saved: unknown = text ? JSON.parse(text) : undefined;

        if (isRecord(saved) && saved.session === session && typeof saved.cursor === "string" && isRecord(saved.raw)) {
            heldRaw = saved.raw;
            heldCursor = saved.cursor;
        }
    } catch {
        // A file cut short by another write: read the whole answer once.
    }
}

interface InboxRead {
    /** The answer as the CLI would print it whole; absent when the read failed. */
    raw?: Record<string, unknown>;
    how: "full" | "change" | "unchanged" | "legacy" | "failed";
    exit?: number;
    stderr?: string;
}

/**
 * One `tools question inbox` read: `--since` the last cursor when there is one, merged into the last answer. A CLI
 * that refuses the flags is asked the old way from then on.
 */
async function readInbox(host: Host, session: string): Promise<InboxRead> {
    const base = ["tools", "question", "inbox", "--session", session, "--json", "--all-items"];
    const dir = cursorUnsupported ? undefined : await sessionDirOf(host);
    const argv = cursorUnsupported
        ? base
        : [
              ...base,
              ...(dir ? ["--transcript", `${dir}.jsonl`] : []),
              ...(heldRaw && heldCursor ? ["--since", heldCursor] : []),
          ];
    const run = (args: readonly string[]) =>
        host
            .run(args, { timeoutMs: 20_000 })
            .catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: String(error) }));
    let done = await run(argv);

    if (!cursorUnsupported && done.exitCode !== 0 && /unknown option/.test(done.stderr)) {
        cursorUnsupported = true;
        await logMod(host, "answers", { event: "cursor-unsupported", stderr: done.stderr.slice(-200) });
        done = await run(base);
    }

    let parsed: unknown;

    try {
        parsed = done.exitCode === 0 ? JSON.parse(done.stdout) : undefined;
    } catch {
        parsed = undefined;
    }

    if (!isRecord(parsed)) {
        return { how: "failed", exit: done.exitCode, stderr: done.stderr.slice(-300) };
    }

    if (cursorUnsupported || typeof parsed.cursor !== "string") {
        return { raw: parsed, how: "legacy" };
    }

    const merged = heldRaw ? mergedAnswer(heldRaw, parsed) : undefined;
    const raw = merged ?? parsed;
    const unchanged =
        merged !== undefined &&
        parsed.cursor === heldCursor &&
        LISTS.every((list) => Array.isArray(parsed[list]) && parsed[list].length === 0);

    if (parsed.full === false && !merged) {
        // A change with nothing to merge it into: ask for the whole answer next time.
        heldRaw = undefined;
        heldCursor = undefined;
        return { how: "failed", stderr: "a change arrived with no answer to merge it into" };
    }

    heldRaw = raw;
    heldCursor = parsed.cursor;

    if (!unchanged) {
        const file = await inboxFile(host, session);

        if (file) {
            await host.write(file, JSON.stringify({ session, cursor: parsed.cursor, raw })).catch(() => undefined);
        }
    }

    return { raw, how: unchanged ? "unchanged" : merged ? "change" : "full" };
}

/**
 * Reads the session's items again when `force`, or when the files behind them changed since the last read. Callers
 * share a read in flight. Without the `tools` CLI there is nothing to read, and the last read stays.
 */
export function refreshAnswers(host: Host, why: string, force = false): Promise<SessionAnswers | undefined> {
    if (reading) {
        return reading;
    }

    const work = (async () => {
        const stamp = await stampOf(host);
        const ownMoved = stamp.own !== heldStamp;
        const slow = held !== undefined && Date.now() - lastReadAt >= SLOW_MS;

        // A resumed session's old items can precede the bounded log window. Take one initial scoped snapshot,
        // then refresh only on its events or a recovery interval, including when the snapshot was empty.
        if (!force && held && !ownMoved && !slow) {
            return held;
        }

        if (!(await genesisProbe(host)).tools) {
            return held;
        }

        const session = await host.sessionId();

        if (!heldRaw && !cursorUnsupported) {
            await restoreInbox(host, session);
        }

        const answer = await readInbox(host, session);
        const read = answer.raw ? answersOfValue(answer.raw, Date.now()) : undefined;

        if (!read) {
            await logMod(host, "answers", { event: "read-failed", why, exit: answer.exit, stderr: answer.stderr });
            return held;
        }

        held = read;
        heldStamp = stamp.own;
        lastReadAt = Date.now();
        await logMod(host, "answers", { event: "read", why, own: ownMoved, slow, how: answer.how });
        await findRows(
            host,
            read.decisions.map((decision) => decision.n),
            read.entries
        );
        host.redraw();

        return read;
    })();

    reading = work.finally(() => {
        reading = undefined;
    });

    return reading;
}

/** A settings-only check while both consumers are off; lifecycle events call this outside rendering. */
export async function pollAnswers(host: Host, why: string): Promise<void> {
    const settings = await settingsOf(host);

    if (settings.decisions.enabled || settings.inbox.enabled) {
        await refreshAnswers(host, why);
    }
}

/** Install one settings watcher even while disabled, so a live config change can activate answer polling. */
export function startAnswers(host: Host): Promise<void> {
    if (started) {
        return Promise.resolve();
    }

    started = true;
    host.every(TICK_MS, () => {
        void pollAnswers(host, "tick").catch((error: unknown) =>
            logMod(host, "answers", { event: "poll-failed", error: String(error) })
        );
    });
    return pollAnswers(host, "start");
}

/** After this session called a question tool: its items changed, so read them again now. */
export function afterQuestionTool(host: Host, e: ToolCallInput): void {
    const command = e.tool === "Bash" ? e.command : "";

    if (QUESTION_TOOLS.has(e.tool) || /\btools question\b/.test(command)) {
        void refreshAnswers(host, e.tool, true);
    }
}

/**
 * Scrolls the transcript to where an item was asked. The scroll is the first call of the press: the engine moves a
 * transcript row only while the call answers the person's own input. A row it cannot show (one from before a
 * compaction is not drawn) falls back, for a decision, to its find link: the transcript search (ctrl+o) at its first
 * ask, typed into this session's terminal by `tools claude cmux find`.
 */
export async function jumpTo(host: Host, key: string, target: { decision: number } | { entry: string }): Promise<void> {
    const row = jumpRowOf(target);
    const moved = row ? await host.scroll(row).catch((error: unknown) => ({ deny: String(error) })) : undefined;
    const what = "decision" in target ? `DECISION ${target.decision}` : "the entry";

    if (moved && !moved.deny) {
        await logMod(host, "answers", { event: "jump", target, row, how: "scroll" });
        await pressed(host, key, `Scrolled to ${what}.`);
        return;
    }

    const reason = moved?.deny ?? "the transcript does not have its row";
    const link =
        "decision" in target
            ? decisionLink(await genesisProbe(host), await host.sessionId(), target.decision)
            : undefined;

    await logMod(host, "answers", { event: "jump", target, row, how: link ? "find" : "none", reason });

    if (!link) {
        await pressed(host, key, `Cannot scroll to ${what}: ${reason}.`, "error");
        return;
    }

    await pressed(host, key, `Not drawn here (${reason}); searching the transcript…`, "busy");
    await host.openUrl(link);
    await pressed(host, key, `Opened the transcript search at ${what}. q or Esc leaves it.`);
}

/** What a store command answered: its JSON, or the error it printed. */
async function questionCommand(host: Host, args: readonly string[]): Promise<Record<string, unknown>> {
    if (!(await genesisProbe(host)).tools) {
        return { error: "the tools CLI is not installed" };
    }

    const session = await host.sessionId();
    const done = await host
        .run(["tools", "question", "inbox", "--session", session, ...args], { timeoutMs: 20_000 })
        .catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: String(error) }));
    let parsed: unknown;

    try {
        parsed = JSON.parse(done.stdout);
    } catch {
        parsed = undefined;
    }

    if (!isRecord(parsed)) {
        return { error: done.stderr.trim().split("\n").at(-1) || `tools question exited ${done.exitCode}` };
    }

    return parsed;
}

/**
 * Stages an answer in the decision store, where the widget sees it too: `option` the picked letter ("" clears it),
 * `text` a note in words ("" clears it). The sidebar shows the store's answer at once, then reads everything again.
 * A decision the store does not know and cannot take from the last reply answers `{ error }`.
 */
export async function stageAnswer(
    host: Host,
    n: number,
    answer: { option?: string; text?: string },
    { refresh = true }: { refresh?: boolean } = {}
): Promise<{ error?: string }> {
    const args = ["draft", "--decision", String(n)];
    const revision = held?.decisions.find((decision) => decision.n === n)?.revision;

    if (revision !== undefined) {
        args.push("--expected-revision", String(revision));
    }

    if (answer.option !== undefined) {
        args.push("--option", answer.option);
    }

    if (answer.text !== undefined) {
        args.push("--text", answer.text);
    }

    const row = await questionCommand(host, args);
    await logMod(host, "decisions", { event: "stage", n, ...answer, error: row.error });

    if (typeof row.error === "string") {
        return { error: row.error };
    }

    if (held) {
        const draftOption = text(row.draftOption);
        const draft = text(row.draft);
        const state = text(row.state);
        held = {
            ...held,
            decisions: held.decisions.map((decision) =>
                decision.n === n
                    ? {
                          ...decision,
                          status: isStatus(state) ? state : decision.status,
                          draftOption: draftOption || undefined,
                          draft: draft || undefined,
                      }
                    : decision
            ),
        };
        host.redraw();
    }

    if (refresh) {
        void refreshAnswers(host, "stage", true);
    }

    return {};
}

/**
 * Prepares the session's answers, submits its own prompt, then acknowledges that exact batch. A failed submission
 * leaves answers pending for a retry or next-prompt injection. Nothing is typed into a terminal pane.
 */
export async function sendStaged(host: Host): Promise<{ text?: string; numbers?: number[]; error?: string }> {
    const sent = await questionCommand(host, ["send", "--in-session"]);
    await logMod(host, "decisions", { event: "send", promoted: sent.promoted, error: sent.error });
    if (typeof sent.error === "string") {
        return { error: sent.error };
    }

    const message = text(sent.text);
    const receipt = sent.promptReceipt;

    if (!message || !isRecord(receipt) || typeof receipt.token !== "string" || !receipt.token) {
        return { error: "The CLI did not reserve a pending prompt batch; update GenesisTools" };
    }

    let submitted = false;
    try {
        await host.submit(message);
        submitted = true;
        const ack = await questionCommand(host, ["send", "--ack-prompt", JSON.stringify(receipt)]);

        if (typeof ack.error === "string") {
            return { error: ack.error };
        }

        return {
            text: message,
            numbers: Array.isArray(ack.numbers) ? ack.numbers.filter((n): n is number => typeof n === "number") : [],
        };
    } catch (error) {
        if (!submitted) {
            const released = await questionCommand(host, ["send", "--release-prompt", JSON.stringify(receipt)]);
            if (typeof released.error === "string") {
                return { error: `${String(error)}; could not release the pending batch: ${released.error}` };
            }
        }
        return { error: String(error) };
    } finally {
        await refreshAnswers(host, "send", true);
    }
}
