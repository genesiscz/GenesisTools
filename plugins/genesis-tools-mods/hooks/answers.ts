// What the answer MCP (`tools question`) holds for this session: its decisions in every state, its todos, the
// messages and answers it recorded, and the forms it left pending. One `tools question inbox --session <id> --json
// --all-items` call reads them all, and it runs only when the files behind it changed, a sidebar asks, or this
// session just called a question tool: every running session reads it.
//
// Also where each item was asked, for "jump to": the transcript row of a decision's first ask (an assistant text
// with `❓ DECISION N` that is not a link) and the tool call that recorded an entry. A row's `requestId` is the
// transcript entry's `uuid` (a text row) or the tool_use id (a tool row); `grep` finds them in the transcript.
import type { ToolCallInput } from "claude-code";
import { sessionDirOf } from "./agents-band";
import { decisionLink, genesisProbe } from "./genesis";
import { type Host, isRecord, logMod } from "./shared";
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
/** How often the files behind the items are checked; the CLI runs only when one changed. */
const TICK_MS = 10_000;
/** A tool call more than this before its entry did not record it. */
const ENTRY_WINDOW_MS = 10 * 60_000;
const FIRST_ASK = /(^|[^[])❓\s*\**\s*DECISION\s+(\d+)/gm;

let held: SessionAnswers | undefined;
let heldStamp = "";
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
    heldStamp = "";
    reading = undefined;
    started = false;
    askRows.clear();
    entryRows.clear();
    searchedSize = -1;
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

/** The files a change of any item shows in: the decision log, today's Q→A log, and the store of forms and reads. */
async function stampOf(host: Host): Promise<string> {
    const home = (await host.env("GENESIS_TOOLS_HOME")) ?? (await host.env("HOME"));

    if (!home) {
        return "";
    }

    const question = `${home}/.genesis-tools/question`;
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const files = [`${question}/decisions/decisions.jsonl`, `${question}/log/${day}.jsonl`, `${question}/qa.db`];
    const stats = await Promise.all(files.map((file) => host.stat(file).catch(() => undefined)));

    return stats.map((stat) => (stat ? `${stat.mtimeMs}:${stat.size}` : "-")).join("|");
}

/** The transcript's size at the last search: a search that found nothing new waits for the transcript to grow. */
let searchedSize = -1;

/**
 * Finds the rows not found yet, for these decision numbers (the log's and the chat's) and entries: one `grep` over
 * the transcript for the assistant lines that could hold them.
 */
async function findRows(host: Host, numbers: readonly number[], entries: readonly LoggedEntry[]): Promise<void> {
    const missing = numbers.some((n) => !askRows.has(n)) || entries.some((entry) => !entryRows.has(entry.id));
    const dir = await sessionDirOf(host);

    if (!missing || !dir) {
        return;
    }

    const transcript = `${dir}.jsonl`;
    const size = (await host.stat(transcript).catch(() => undefined))?.size ?? -1;

    if (size === searchedSize) {
        return;
    }

    const found = await host
        .run(
            [
                "/bin/sh",
                "-c",
                'grep -F -e "DECISION" -e "mcp__genesis-tools__" -e "tools question" "$1" | grep -F \'"type":"assistant"\'',
                "sh",
                transcript,
            ],
            { timeoutMs: 15_000 }
        )
        .catch(() => undefined);

    if (!found || found.exitCode > 1) {
        return;
    }

    searchedSize = size;
    const lines = found.stdout.split("\n").filter(Boolean);

    for (const [n, uuid] of firstAsks(lines)) {
        if (!askRows.has(n)) {
            askRows.set(n, uuid);
        }
    }

    const calls = questionCalls(lines);

    for (const entry of entries) {
        const call = entryRows.has(entry.id) ? undefined : callFor(entry.at, calls);

        if (call) {
            entryRows.set(entry.id, call);
        }
    }
}

/** Finds the first asks of decisions the chat knows and the log may not: called after the chat was read. */
export async function findAskRows(host: Host, numbers: readonly number[]): Promise<void> {
    await findRows(host, numbers, held?.entries ?? []);
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

        if (!force && held && stamp === heldStamp) {
            return held;
        }

        if (!(await genesisProbe(host)).tools) {
            return held;
        }

        const session = await host.sessionId();
        const done = await host
            .run(["tools", "question", "inbox", "--session", session, "--json", "--all-items"], { timeoutMs: 20_000 })
            .catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: String(error) }));
        const read = done.exitCode === 0 ? answersFrom(done.stdout) : undefined;

        if (!read) {
            await logMod(host, "answers", {
                event: "read-failed",
                why,
                exit: done.exitCode,
                stderr: done.stderr.slice(-300),
            });
            return held;
        }

        held = read;
        heldStamp = stamp;
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

/** Starts the reads once per module load: the first now, then each tick when the files changed. */
export function startAnswers(host: Host): void {
    if (started) {
        return;
    }

    started = true;
    void refreshAnswers(host, "start", true);
    host.every(TICK_MS, () => {
        void refreshAnswers(host, "tick");
    });
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
    answer: { option?: string; text?: string }
): Promise<{ error?: string }> {
    const args = ["draft", "--decision", String(n)];

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

    void refreshAnswers(host, "stage", true);

    return {};
}

/**
 * Sends the session's staged answers through its own prompt: the store marks them sent (route `prompt`) and gives
 * the message, which the caller submits. Nothing is typed into the terminal, so a sidebar holding the keys is safe.
 */
export async function sendStaged(host: Host): Promise<{ text?: string; numbers?: number[]; error?: string }> {
    const sent = await questionCommand(host, ["send", "--in-session"]);
    await logMod(host, "decisions", { event: "send", promoted: sent.promoted, error: sent.error });
    void refreshAnswers(host, "send", true);

    if (typeof sent.error === "string") {
        return { error: sent.error };
    }

    return {
        text: text(sent.text),
        numbers: Array.isArray(sent.numbers) ? sent.numbers.filter((n): n is number => typeof n === "number") : [],
    };
}
