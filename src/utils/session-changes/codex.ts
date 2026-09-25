import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { applyPatch, parsePatch, reversePatch } from "diff";
import type { SessionToolCall, SessionTranscript, SessionTurn } from "./types";

const { log } = logger.scoped("session-changes");

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

/** One path of one Codex `FileChange` item, as the rollout records it. */
interface CodexChange {
    callId: string;
    turnId: string;
    at: number | null;
    cwd: string | null;
    path: string;
    kind: "add" | "update" | "delete";
    content: string | null;
    diff: string | null;
    movedTo: string | null;
    /** Set on the add a move produces at its new path: the old path the text came from. */
    movedFrom: string | null;
}

function listDir(dir: string): string[] {
    try {
        return readdirSync(dir).sort().reverse();
    } catch (error) {
        log.debug({ error, dir }, "codex sessions directory not readable");
        return [];
    }
}

function codexHomes(): string[] {
    const override = env.codex.getHomeOverride();
    return override ? override.split(",").map((home) => home.trim()) : [join(homedir(), ".codex")];
}

/**
 * The rollout of a Codex thread: `<home>/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl`, or
 * the same under `archived_sessions`. Newest days are searched first.
 */
export function findCodexRollout(threadId: string, homes: string[] = codexHomes()): string | null {
    if (!/^[A-Za-z0-9-]+$/.test(threadId)) {
        return null;
    }

    const suffix = `-${threadId}.jsonl`;

    for (const home of homes) {
        for (const bucket of ["sessions", "archived_sessions"]) {
            const root = join(home, bucket);

            if (!existsSync(root)) {
                continue;
            }

            for (const year of listDir(root)) {
                for (const month of listDir(join(root, year))) {
                    for (const day of listDir(join(root, year, month))) {
                        const dayDir = join(root, year, month, day);
                        const hit = listDir(dayDir).find(
                            (entry) => entry.startsWith("rollout-") && entry.endsWith(suffix)
                        );

                        if (hit) {
                            return join(dayDir, hit);
                        }
                    }
                }
            }
        }
    }

    return null;
}

export function isCodexRollout(path: string): boolean {
    return /(^|\/)rollout-[^/]+\.jsonl$/.test(path);
}

/** The text of a user message item, unless it is a harness preamble (`<environment_context>`, plugin lists). */
function promptText(payload: Json): string | null {
    const content = Array.isArray(payload.content) ? payload.content : [];
    const first = content.map((block) => text(record(block)?.text)).find((value) => value !== null);

    return first && !first.trimStart().startsWith("<") ? first : null;
}

function changesOf(payload: Json, at: number | null, cwd: string | null): CodexChange[] {
    const item = record(payload.item);
    const changes = record(item?.changes);
    const callId = text(item?.id);
    const turnId = text(payload.turn_id);

    // A declined or failed patch changed nothing.
    if (item?.type !== "FileChange" || !changes || !callId || !turnId || (item.status && item.status !== "completed")) {
        return [];
    }

    return Object.entries(changes).flatMap(([path, value]) => {
        const change = record(value);
        const kind = change?.type;

        if (kind !== "add" && kind !== "update" && kind !== "delete") {
            return [];
        }

        const entry: CodexChange = {
            callId,
            turnId,
            at,
            cwd,
            path,
            kind,
            content: text(change?.content),
            diff: text(change?.unified_diff),
            movedTo: text(change?.move_path),
            movedFrom: null,
        };

        // A move is two changes: the old path goes away and the new one appears with the moved text.
        if (!entry.movedTo) {
            return [entry];
        }

        const arrival: CodexChange = {
            ...entry,
            path: entry.movedTo,
            kind: "add",
            content: null,
            diff: null,
            movedTo: null,
            movedFrom: path,
        };
        return [entry, arrival];
    });
}

function moveKey(callId: string, from: string): string {
    return `${callId}\u0000${from}`;
}

/** `state` before a hunk-only unified diff was applied, or undefined when the diff no longer fits it. */
function unapply(state: string, diff: string): string | undefined {
    try {
        const [patch] = parsePatch(`--- a\n+++ b\n${diff.endsWith("\n") ? diff : `${diff}\n`}`);

        if (!patch) {
            return undefined;
        }

        const before = applyPatch(state, reversePatch(patch));
        return before === false ? undefined : before;
    } catch (error) {
        log.debug({ error }, "codex patch could not be reversed onto the later state");
        return undefined;
    }
}

/**
 * Before and after text of every change, walked BACKWARDS from what is on disk now. An add
 * carries its content and a delete the content it removed; an update carries only its diff, so
 * its after-state is the next state back and its before-state that state with the diff reversed.
 * When a diff no longer fits (the file changed after the session), earlier states stay unknown.
 * One walk over every path, newest change first, because a move links two paths: the text it
 * carried is the new path's state at the move, after any later edit there is walked back.
 */
function fillStates(changes: CodexChange[], calls: SessionToolCall[], readFile: (path: string) => string | null) {
    const states = new Map<string, string | null | undefined>();
    const stateOf = (path: string) => (states.has(path) ? states.get(path) : readFile(path));
    const carried = new Map<string, string | null | undefined>();

    for (let index = changes.length - 1; index >= 0; index--) {
        const change = changes[index];
        const call = calls[index];

        if (!change || !call) {
            continue;
        }

        const state = stateOf(change.path);

        if (change.kind === "add") {
            call.before = null;
            call.after = change.content ?? state;
            states.set(change.path, null);

            if (change.movedFrom) {
                carried.set(moveKey(change.callId, change.movedFrom), call.after);
            }

            continue;
        }

        if (change.kind === "delete") {
            call.before = change.content ?? undefined;
            call.after = null;
            states.set(change.path, call.before);
            continue;
        }

        // A move leaves nothing at the old path; the diff reverses from the text it carried.
        const after = change.movedTo ? carried.get(moveKey(change.callId, change.path)) : state;
        call.after = change.movedTo ? null : (after ?? undefined);
        call.before = typeof after === "string" && change.diff ? unapply(after, change.diff) : undefined;
        states.set(change.path, call.before);
    }
}

/**
 * A Codex rollout as a session transcript: each `task_started` is a turn, and each path of a
 * completed `FileChange` item is one file-tool call (an add is a Write, an update or a delete an
 * Edit) whose id is the item id. Shell commands are left to the change log, which the agents
 * hook writes for Codex's Bash calls too.
 */
export function parseCodexRollout(
    sessionId: string,
    content: string,
    readFile: (path: string) => string | null = readCurrent
): SessionTranscript {
    const turns = new Map<string, SessionTurn>();
    const cwds = new Set<string>();
    const changes: CodexChange[] = [];
    let currentTurn: SessionTurn | null = null;
    let cwd: string | null = null;

    for (const line of content.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        let row: Json | null;

        try {
            row = record(SafeJSON.parse(line, { strict: true }));
        } catch (error) {
            log.debug({ error }, "unreadable rollout line skipped");
            continue;
        }

        const payload = record(row?.payload);

        if (!row || !payload) {
            continue;
        }

        const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
        const when = Number.isNaN(at) ? null : at;

        if (row.type === "turn_context" && text(payload.cwd)) {
            cwd = text(payload.cwd);
            cwds.add(cwd ?? "");
            continue;
        }

        if (row.type === "event_msg" && payload.type === "task_started" && text(payload.turn_id)) {
            const turnId = text(payload.turn_id) ?? "";
            currentTurn = { turnId, index: turns.size, at: text(row.timestamp), prompt: "" };
            turns.set(turnId, currentTurn);
            continue;
        }

        if (row.type === "response_item" && payload.type === "message" && payload.role === "user") {
            const prompt = promptText(payload);

            if (prompt && currentTurn && !currentTurn.prompt) {
                currentTurn.prompt = prompt;
            }

            continue;
        }

        if (row.type === "event_msg" && payload.type === "item_completed") {
            changes.push(...changesOf(payload, when, cwd));
        }
    }

    const calls: SessionToolCall[] = changes.map((change) => ({
        id: change.callId,
        turnId: change.turnId,
        name: change.kind === "add" ? "Write" : "Edit",
        startedAt: change.at,
        finishedAt: change.at,
        cwd: change.cwd,
        agentId: null,
        isError: false,
        filePath: change.path,
        command: null,
    }));
    fillStates(changes, calls, readFile);
    log.debug({ sessionId, turns: turns.size, fileChanges: calls.length }, "parsed codex rollout");

    return { sessionId, turns: [...turns.values()], calls, cwds: [...cwds].filter(Boolean) };
}

function readCurrent(path: string): string | null {
    try {
        return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
    } catch (error) {
        log.debug({ error, path }, "no current file for a codex change");
        return null;
    }
}
