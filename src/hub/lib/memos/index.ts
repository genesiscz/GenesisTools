import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoActInput, MemoActReceiptDto, MemoDto, MemosDto } from "@app/dev-dashboard/contract/memos";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * Memo to action (F28). `scanMemos` turns each new Voice Memo into a stored memo with todos, a note and an agent task,
 * and pushes one notice; the first scan only primes the list, so years of old memos are never offered. `actOnMemo`
 * runs one action once: the todos into Reminders, the note into the vault inbox, the task into a live session.
 *
 * Reading Voice Memos needs Full Disk Access. `tools` runs through GenesisTools.app, so the grant is the app's, and
 * the daemon task that runs `tools hub memos scan` needs that same grant (`tools macos permissions`).
 */

const MAX_KEPT = 50;

interface MemoState extends MemosDto {
    seen: number[];
}

export interface VoiceMemoLike {
    id: number;
    title: string;
    date: Date;
    path: string;
}

export interface MemoSplit {
    todos: string[];
    note: string;
    agentTask: string | null;
}

export interface MemoDeps {
    statePath?: string;
    list?: () => VoiceMemoLike[];
    transcribe?: (memo: VoiceMemoLike) => Promise<string>;
    split?: (text: string) => Promise<MemoSplit>;
    notify?: (memo: MemoDto) => Promise<void>;
    now?: Date;
}

export function memoStatePath(): string {
    return toolDataDir("hub", "memo-actions.json");
}

function readState(path: string): MemoState {
    if (!existsSync(path)) {
        return { memos: [], primedAt: null, seen: [] };
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as Partial<MemoState>;
        return { memos: parsed.memos ?? [], primedAt: parsed.primedAt ?? null, seen: parsed.seen ?? [] };
    } catch (error) {
        logger.warn({ error, path }, "memos: the state file is unreadable; starting from an empty list");
        return { memos: [], primedAt: null, seen: [] };
    }
}

function writeState(path: string, state: MemoState): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, SafeJSON.stringify(state, null, 2));
}

async function liveList(): Promise<VoiceMemoLike[]> {
    const { listMemos } = await import("@genesiscz/utils/macos/voice-memos");
    return listMemos();
}

async function liveTranscribe(memo: VoiceMemoLike): Promise<string> {
    const { extractTranscript } = await import("@genesiscz/utils/macos/voice-memos");
    const onDevice = extractTranscript(memo.path);

    if (onDevice?.text.trim()) {
        return onDevice.text.trim();
    }

    const result = await execTool(["macos", "voice-memos", "transcribe", String(memo.id)], { timeout: 10 * 60_000 });

    if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim().split("\n").at(-1) ?? `transcribe exit ${result.exitCode}`);
    }

    return result.stdout.trim();
}

const SPLIT_PROMPT = [
    "You split a dictated voice memo into actions. Answer with one JSON object and nothing else:",
    '{"todos": string[], "note": string, "agentTask": string | null}.',
    "todos: short imperative items the speaker must do (empty when none).",
    "note: the memo as a clean note in the speaker's language, without the todos.",
    "agentTask: a concrete instruction for a coding agent when the memo asks for code or repo work, else null.",
].join("\n");

/** The memo as one note when the model cannot split it: nothing is lost, the person splits it by hand. */
export function fallbackSplit(text: string): MemoSplit {
    return { todos: [], note: text, agentTask: null };
}

export function parseSplit(content: string, text: string): MemoSplit {
    const json = content.match(/\{[\s\S]*\}/)?.[0];

    if (!json) {
        return fallbackSplit(text);
    }

    try {
        const parsed = SafeJSON.parse(json, { strict: true }) as Record<string, unknown>;
        const todos = Array.isArray(parsed.todos)
            ? parsed.todos
                  .filter((todo): todo is string => typeof todo === "string" && todo.trim() !== "")
                  .map((todo) => todo.trim())
            : [];
        const note = typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim() : text;
        const agentTask =
            typeof parsed.agentTask === "string" && parsed.agentTask.trim() ? parsed.agentTask.trim() : null;
        return { todos, note, agentTask };
    } catch (error) {
        logger.debug({ error }, "memos: the split was not JSON");
        return fallbackSplit(text);
    }
}

async function liveSplit(text: string): Promise<MemoSplit> {
    const { ai } = await import("@genesiscz/utils/ai/tasks/facade");

    try {
        const result = await ai.chat({
            systemPrompt: SPLIT_PROMPT,
            userPrompt: text,
            task: "chat",
            app: "hub-memos",
            maxTokens: 1200,
        });
        return parseSplit(result.content, text);
    } catch (error) {
        logger.warn({ error }, "memos: the split call failed; keeping the memo as one note");
        return fallbackSplit(text);
    }
}

async function liveNotify(memo: MemoDto): Promise<void> {
    const { dispatchNotification } = await import("@genesiscz/utils/notifications");
    const parts = [
        memo.todos.length ? `${memo.todos.length} todo${memo.todos.length === 1 ? "" : "s"}` : null,
        "a note",
        memo.agentTask ? "a task for an agent" : null,
    ].filter(Boolean);
    await dispatchNotification({
        app: "hub-memos",
        title: `Memo: ${memo.title}`,
        message: `${parts.join(", ")}. Open GenesisTools, Memos, to add or send them.`,
        id: `memo-${memo.id}`,
    });
}

/** Turns the memos recorded since the last scan into actions; the first scan only primes. Returns the new memos. */
export async function scanMemos(deps: MemoDeps = {}): Promise<MemoDto[]> {
    const path = deps.statePath ?? memoStatePath();
    const state = readState(path);
    const memos = deps.list ? deps.list() : await liveList();
    const seen = new Set(state.seen);
    const now = deps.now ?? new Date();

    if (!state.primedAt) {
        writeState(path, { ...state, primedAt: now.toISOString(), seen: memos.map((memo) => memo.id) });
        logger.info({ memos: memos.length }, "memos: primed; memos recorded before now are not offered");
        return [];
    }

    const fresh: MemoDto[] = [];

    for (const memo of memos.filter((entry) => !seen.has(entry.id))) {
        try {
            const transcript = await (deps.transcribe ?? liveTranscribe)(memo);
            const split = await (deps.split ?? liveSplit)(transcript);
            const stored: MemoDto = {
                id: `${memo.id}-${memo.date.getTime()}`,
                memoId: memo.id,
                title: memo.title || "Voice memo",
                recordedAt: memo.date.toISOString(),
                transcript,
                ...split,
                done: {},
            };
            fresh.push(stored);
            seen.add(memo.id);
        } catch (error) {
            // Not marked seen: the next scan tries it again (a memo iCloud has not finished downloading fails here).
            logger.warn({ error, memo: memo.id }, "memos: could not transcribe a memo; the next scan retries it");
        }
    }

    if (fresh.length > 0) {
        const kept = [...fresh.reverse(), ...state.memos].slice(0, MAX_KEPT);
        writeState(path, { ...state, memos: kept, seen: [...seen] });

        for (const memo of fresh) {
            await (deps.notify ?? liveNotify)(memo).catch((error: unknown) => {
                logger.warn({ error, memo: memo.id }, "memos: the notice was not sent");
            });
        }
    }

    return fresh;
}

export function listMemoActions(deps: Pick<MemoDeps, "statePath"> = {}): MemosDto {
    const { memos, primedAt } = readState(deps.statePath ?? memoStatePath());
    return { memos, primedAt };
}

export interface MemoActDeps {
    statePath?: string;
    addTodo?: (title: string) => Promise<void>;
    appendNote?: (text: string) => Promise<string>;
    sendToSession?: (key: string, text: string, idempotencyKey: string) => Promise<{ ok: boolean; detail: string }>;
    now?: Date;
}

async function liveAddTodo(title: string): Promise<void> {
    const [{ addTodo }, { getConfig }] = await Promise.all([
        import("@app/dev-dashboard/lib/todos/service"),
        import("@app/dev-dashboard/config"),
    ]);
    await addTodo({ title, listName: (await getConfig()).todoListName });
}

async function liveAppendNote(text: string): Promise<string> {
    const { appendToVault } = await import("../vault/index");
    return (await appendToVault({ text })).note;
}

async function liveSend(key: string, text: string, idempotencyKey: string): Promise<{ ok: boolean; detail: string }> {
    const { sendToBoardSession } = await import("../send/index");
    const receipt = await sendToBoardSession({ key, text, timing: "next-turn", idempotencyKey });
    const ok =
        receipt.outcome === "delivered" || receipt.outcome === "queued-daemon" || receipt.outcome === "queued-session";
    return { ok, detail: `${receipt.outcome} via ${receipt.route}: ${receipt.detail}` };
}

/** Runs one action of a stored memo, once: a second call answers that it already ran. */
export async function actOnMemo(input: MemoActInput, deps: MemoActDeps = {}): Promise<MemoActReceiptDto> {
    const path = deps.statePath ?? memoStatePath();
    const state = readState(path);
    const memo = state.memos.find((entry) => entry.id === input.id);
    const answer = (ok: boolean, detail: string): MemoActReceiptDto => ({
        id: input.id,
        action: input.action,
        ok,
        detail,
    });

    if (!memo) {
        return answer(false, "No such memo.");
    }

    if (memo.done[input.action]) {
        return answer(true, `Already done at ${memo.done[input.action]}.`);
    }

    let detail: string;

    if (input.action === "reminders") {
        if (memo.todos.length === 0) {
            return answer(false, "The memo holds no todos.");
        }

        for (const todo of memo.todos) {
            await (deps.addTodo ?? liveAddTodo)(todo);
        }

        detail = `Added ${memo.todos.length} reminder${memo.todos.length === 1 ? "" : "s"}.`;
    } else if (input.action === "note") {
        const note = await (deps.appendNote ?? liveAppendNote)(
            `## ${memo.title}\n\nRecorded ${memo.recordedAt}\n\n${memo.note}\n`
        );
        detail = `Saved into ${note}.`;
    } else {
        if (!memo.agentTask || !input.sessionKey) {
            return answer(
                false,
                memo.agentTask ? "Pick a session to send the task to." : "The memo holds no agent task."
            );
        }

        const sent = await (deps.sendToSession ?? liveSend)(input.sessionKey, memo.agentTask, `memo-${memo.id}`);

        if (!sent.ok) {
            return answer(false, `Not sent: ${sent.detail}`);
        }

        detail = `Sent to the session (${sent.detail}).`;
    }

    const latest = readState(path);
    const updated = latest.memos.map((entry) =>
        entry.id === memo.id
            ? { ...entry, done: { ...entry.done, [input.action]: (deps.now ?? new Date()).toISOString() } }
            : entry
    );
    writeState(path, { ...latest, memos: updated });
    logger.info({ id: memo.id, action: input.action }, "memos: action ran");
    return answer(true, detail);
}
