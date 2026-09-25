import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { CLAUDE_DIR, PROJECTS_DIR } from "@genesiscz/utils/claude/projects";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { SessionToolCall, SessionTranscript, SessionTurn } from "./types";

const { log } = logger.scoped("session-changes");

/** The harness file tools, by the `via` they produce. Codex/Grok names are folded in lower case. */
const FILE_TOOLS: Readonly<Record<string, "edit" | "write" | "notebook">> = {
    edit: "edit",
    multiedit: "edit",
    write: "write",
    notebookedit: "notebook",
};

export function fileToolVia(name: string): "edit" | "write" | "notebook" | null {
    return FILE_TOOLS[name.toLowerCase().replace(/_/g, "")] ?? null;
}

export function isShellTool(name: string): boolean {
    const normalized = name.toLowerCase();
    return normalized === "bash" || normalized === "shell" || normalized === "exec_command";
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function epoch(value: unknown): number | null {
    if (typeof value !== "string") {
        return null;
    }

    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
}

/** `old` replaced by `next` without `String.replace`, whose `$&` patterns would corrupt the text. */
export function applyReplacement(source: string, old: string, next: string, all: boolean): string | null {
    if (old.length === 0) {
        return null;
    }

    if (all) {
        return source.includes(old) ? source.split(old).join(next) : null;
    }

    const at = source.indexOf(old);
    return at === -1 ? null : source.slice(0, at) + next + source.slice(at + old.length);
}

interface EditSpec {
    old: string;
    next: string;
    all: boolean;
}

function editsOf(input: Json): EditSpec[] {
    const list = Array.isArray(input.edits) ? input.edits : [input];
    const specs: EditSpec[] = [];

    for (const item of list) {
        const edit = record(item);
        const old = text(edit?.old_string);
        const next = text(edit?.new_string);

        if (edit && old !== null && next !== null) {
            specs.push({ old, next, all: edit.replace_all === true });
        }
    }

    return specs;
}

function applyEdits(source: string, input: Json): string | undefined {
    let after: string | null = source;

    for (const edit of editsOf(input)) {
        after = after === null ? null : applyReplacement(after, edit.old, edit.next, edit.all);
    }

    return after ?? undefined;
}

/**
 * Before and after text of a successful Edit/MultiEdit/Write, from the harness's own result
 * record. Claude writes `originalFile: null` for a file too large to echo, so null means
 * "created" only for a Write whose result says `type: "create"`; an Edit always had a file.
 */
function fileToolBytes(
    via: "edit" | "write" | "notebook",
    input: Json,
    result: Json | null
): { before?: string | null; after?: string | null } {
    if (!result || via === "notebook") {
        return {};
    }

    const original = text(result.originalFile);

    if (via === "write") {
        const content = text(input.content) ?? text(result.content) ?? undefined;
        const before = original ?? (result.type === "create" ? null : undefined);
        return { before, after: content };
    }

    return original === null ? {} : { before: original, after: applyEdits(original, input) };
}

function harnessDetected(result: Json | null): { path: string; created: boolean }[] | undefined {
    const diff = record(result?.bashEditDiff);

    if (!diff || !Array.isArray(diff.files)) {
        return undefined;
    }

    const found: { path: string; created: boolean }[] = [];

    for (const item of diff.files) {
        const file = record(item);
        const path = text(file?.filePath);

        if (!file || !path) {
            continue;
        }

        const hunks = Array.isArray(file.hunks) ? file.hunks.map(record) : [];
        const created =
            hunks.length === 1 &&
            hunks[0]?.oldStart === 0 &&
            (hunks[0]?.oldLines === 0 || hunks[0]?.oldLines === undefined);
        found.push({ path, created });
    }

    return found;
}

function promptText(content: unknown): string | null {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return null;
    }

    if (content.some((block) => record(block)?.type === "tool_result")) {
        return null;
    }

    const parts = content.map((block) => text(record(block)?.text)).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Claude's checkpoint backup of a file (`~/.claude/file-history/<session>/<name>`).
 * - `snapshot`: from the snapshot taken when the user message `messageId` arrived: the file as
 *   it was at the start of that turn (a file already tracked by an earlier edit).
 * - `first-edit`: a file edited for the first time in the session; the backup is taken right
 *   before that edit, under the turn whose snapshot is `messageId`.
 */
interface HistoryBackup {
    kind: "snapshot" | "first-edit";
    messageId: string | null;
    path: string;
    /** File name of the backup, or null when the file did not exist. */
    backup: string | null;
    /** When Claude wrote the backup. A later entry with the same file name overwrote its bytes. */
    backupTime: number | null;
}

interface ParseState {
    calls: Map<string, SessionToolCall>;
    inputs: Map<string, Json>;
    turns: Map<string, SessionTurn>;
    cwds: Set<string>;
    /** User message uuid to its prompt id, to place a checkpoint backup in its turn. */
    promptOfMessage: Map<string, string>;
    backups: HistoryBackup[];
}

function backupOf(
    kind: HistoryBackup["kind"],
    messageId: string | null,
    tracking: string,
    value: unknown
): HistoryBackup | null {
    const backup = record(value);

    if (!backup) {
        return null;
    }

    const parent = text(backup.realParentDir);
    const path = isAbsolute(tracking) ? tracking : parent ? join(parent, basename(tracking)) : null;

    return path
        ? { kind, messageId, path, backup: text(backup.backupFileName), backupTime: epoch(backup.backupTime) }
        : null;
}

/** Every backup a `file-history-delta` or `file-history-snapshot` entry names. */
function historyBackups(entry: Json): HistoryBackup[] {
    if (entry.type === "file-history-delta") {
        const tracking = text(entry.trackingPath);
        const found = tracking ? backupOf("first-edit", text(entry.snapshotMessageId), tracking, entry.backup) : null;
        return found ? [found] : [];
    }

    const snapshot = record(entry.snapshot);
    const tracked = record(snapshot?.trackedFileBackups) ?? {};
    const messageId = text(entry.messageId) ?? text(snapshot?.messageId);

    return Object.entries(tracked)
        .map(([tracking, value]) => backupOf("snapshot", messageId, tracking, value))
        .filter((backup): backup is HistoryBackup => backup !== null);
}

function parseLines(content: string, agentId: string | null, state: ParseState): void {
    let currentTurn: string | null = null;

    for (const line of content.split("\n")) {
        // Most bytes of a transcript are lines no rule reads (attachments, snapshots, titles).
        if (
            line.length === 0 ||
            (!line.includes('"promptId"') && !line.includes('"tool_use"') && !line.includes('"file-history-'))
        ) {
            continue;
        }

        let entry: Json | null;

        try {
            entry = record(SafeJSON.parse(line, { strict: true }));
        } catch (error) {
            // A transcript that is being written ends in a partial line.
            log.debug({ error, agentId }, "skipped an unreadable transcript line");
            continue;
        }

        if (!entry) {
            continue;
        }

        if (entry.type === "file-history-delta" || entry.type === "file-history-snapshot") {
            if (agentId === null) {
                state.backups.push(...historyBackups(entry));
            }

            continue;
        }

        const cwd = text(entry.cwd);

        if (cwd) {
            state.cwds.add(cwd);
        }

        const at = text(entry.timestamp);
        const promptId = text(entry.promptId);
        const message = record(entry.message);

        if (entry.type === "user" && promptId) {
            currentTurn = promptId;
            const uuid = text(entry.uuid);

            if (uuid && agentId === null) {
                state.promptOfMessage.set(uuid, promptId);
            }

            if (agentId === null && !state.turns.has(promptId)) {
                state.turns.set(promptId, { turnId: promptId, index: state.turns.size, at, prompt: "" });
            }

            const turn = state.turns.get(promptId);
            const prompt = promptText(message?.content);

            if (turn && turn.prompt === "" && prompt) {
                turn.prompt = prompt;
            }
        }

        const blocks = Array.isArray(message?.content) ? message.content : [];

        for (const raw of blocks) {
            const block = record(raw);

            if (block?.type === "tool_use" && entry.type === "assistant") {
                const id = text(block.id);
                const name = text(block.name);
                const input = record(block.input) ?? {};

                if (!id || !name) {
                    continue;
                }

                state.inputs.set(id, input);
                state.calls.set(id, {
                    id,
                    turnId: currentTurn ?? "",
                    name,
                    startedAt: epoch(at),
                    finishedAt: null,
                    cwd,
                    agentId,
                    isError: false,
                    filePath: text(input.file_path) ?? text(input.notebook_path),
                    command: isShellTool(name) ? text(input.command) : null,
                });
                continue;
            }

            if (block?.type !== "tool_result") {
                continue;
            }

            const call = state.calls.get(text(block.tool_use_id) ?? "");

            if (!call) {
                continue;
            }

            // The result carries the prompt it answered, which is authoritative over "the last prompt seen".
            call.turnId = promptId ?? call.turnId;
            call.finishedAt = epoch(at);
            call.isError = block.is_error === true;
            const result = record(entry.toolUseResult);
            const via = fileToolVia(call.name);

            if (via && !call.isError) {
                Object.assign(call, fileToolBytes(via, state.inputs.get(call.id) ?? {}, result));
            }

            if (call.command !== null) {
                call.harnessDetected = harnessDetected(result);
            }
        }
    }
}

/** The subagent transcripts of a Claude session (`<session>/subagents/agent-<id>.jsonl`) and the call that launched each. */
function subagentFiles(transcriptPath: string): { path: string; agentId: string; parentToolUseId: string | null }[] {
    const dir = join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");

    if (!existsSync(dir)) {
        return [];
    }

    const files: { path: string; agentId: string; parentToolUseId: string | null }[] = [];

    for (const name of readdirSync(dir)) {
        const match = /^agent-(.+)\.jsonl$/.exec(name);

        if (!match?.[1]) {
            continue;
        }

        let parent: string | null = null;
        const meta = join(dir, `agent-${match[1]}.meta.json`);

        if (existsSync(meta)) {
            try {
                parent = text(record(SafeJSON.parse(readFileSync(meta, "utf8"), { strict: true }))?.toolUseId);
            } catch (error) {
                log.debug({ error, meta }, "unreadable subagent meta");
            }
        }

        files.push({ path: join(dir, name), agentId: match[1], parentToolUseId: parent });
    }

    return files;
}

export interface TranscriptSource {
    /** The main transcript's text. */
    main: string;
    /** Subagent transcripts, each with the tool call that launched it. */
    subagents?: { agentId: string; content: string; parentToolUseId: string | null }[];
    /** Reads one of Claude's checkpoint backups by file name, or returns null. */
    readBackup?: (name: string) => string | null;
}

/**
 * Fill the before/after text a file tool's own result left out (Claude often omits
 * `originalFile`). Each (turn, path) chain starts from Claude's checkpoint of that path for the
 * turn (the turn-start snapshot, else the backup taken before the session's first edit to
 * it), then follows the calls in order: a call's before is the previous call's after, and its
 * after is its edits applied to that. A chain with no checkpoint stays unknown.
 */
function fillFromBackups(state: ParseState, readBackup: (name: string) => string | null): void {
    const seeds = new Map<string, HistoryBackup>();
    // Claude restarts a file's versions at `@v1` after a resume and writes over the old backup,
    // so only the newest entry naming a backup file still describes the bytes on disk.
    const newest = new Map<string, number>();

    for (const backup of state.backups) {
        if (backup.backup !== null && backup.backupTime !== null) {
            newest.set(backup.backup, Math.max(newest.get(backup.backup) ?? 0, backup.backupTime));
        }
    }

    for (const backup of state.backups) {
        if (
            backup.backup !== null &&
            backup.backupTime !== null &&
            backup.backupTime < (newest.get(backup.backup) ?? 0)
        ) {
            log.debug({ path: backup.path, backup: backup.backup }, "checkpoint backup overwritten by a later one");
            continue;
        }

        const turn = state.promptOfMessage.get(backup.messageId ?? "");
        const key = `${turn}\0${backup.path}`;
        const existing = seeds.get(key);

        // The turn-start snapshot wins over a first-edit backup: it is the older state of the two.
        if (turn && (!existing || (existing.kind === "first-edit" && backup.kind === "snapshot"))) {
            seeds.set(key, backup);
        }
    }

    const chains = new Map<string, SessionToolCall[]>();

    for (const call of state.calls.values()) {
        if (
            call.isError ||
            !call.filePath ||
            fileToolVia(call.name) === null ||
            fileToolVia(call.name) === "notebook"
        ) {
            continue;
        }

        const key = `${call.turnId}\0${call.filePath}`;
        const list = chains.get(key) ?? [];
        list.push(call);
        chains.set(key, list);
    }

    for (const [key, calls] of chains) {
        if (calls.every((call) => call.before !== undefined && call.after !== undefined)) {
            continue;
        }

        calls.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
        const seed = seeds.get(key);
        let current: string | null | undefined;

        if (seed) {
            current = seed.backup === null ? null : (readBackup(seed.backup) ?? undefined);
        }

        for (const call of calls) {
            const chained = call.before === undefined && current !== undefined;

            if (chained) {
                call.before = current;
            }

            if (call.after === undefined && typeof call.before === "string" && fileToolVia(call.name) === "edit") {
                call.after = applyEdits(call.before, state.inputs.get(call.id) ?? {});

                // The harness applied this edit, so a state it does not apply to was never the file.
                if (call.after === undefined && chained) {
                    call.before = undefined;
                }
            }

            current = call.after;
        }
    }
}

/** Parse a Claude session transcript (main thread plus subagents) into turns and tool calls. */
export function parseClaudeTranscript(sessionId: string, source: TranscriptSource): SessionTranscript {
    const state: ParseState = {
        calls: new Map(),
        inputs: new Map(),
        turns: new Map(),
        cwds: new Set(),
        promptOfMessage: new Map(),
        backups: [],
    };
    parseLines(source.main, null, state);

    for (const agent of source.subagents ?? []) {
        const before = new Set(state.calls.keys());
        parseLines(agent.content, agent.agentId, state);
        const parentTurn = agent.parentToolUseId ? state.calls.get(agent.parentToolUseId)?.turnId : undefined;

        for (const [id, call] of state.calls) {
            // A subagent's prompt id is its own; its work belongs to the turn that launched it.
            if (!before.has(id) && parentTurn && !state.turns.has(call.turnId)) {
                call.turnId = parentTurn;
            }
        }
    }

    if (source.readBackup) {
        fillFromBackups(state, source.readBackup);
    }

    return {
        sessionId,
        turns: [...state.turns.values()],
        calls: [...state.calls.values()],
        cwds: [...state.cwds],
    };
}

/** The main transcript of a Claude session, searched across every project directory. */
export function findClaudeTranscript(sessionId: string, projectsDir: string = PROJECTS_DIR): string | null {
    if (!/^[A-Za-z0-9-]+$/.test(sessionId) || !existsSync(projectsDir)) {
        return null;
    }

    for (const dir of readdirSync(projectsDir)) {
        const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);

        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

/** Read a Claude session's main and subagent transcripts from disk. */
export function readClaudeTranscript(transcriptPath: string): SessionTranscript {
    const sessionId = basename(transcriptPath).replace(/\.jsonl$/, "");
    const subagents = subagentFiles(transcriptPath).map((file) => ({
        agentId: file.agentId,
        parentToolUseId: file.parentToolUseId,
        content: readFileSync(file.path, "utf8"),
    }));
    log.debug({ transcriptPath, subagents: subagents.length }, "reading session transcript");
    const backups = join(CLAUDE_DIR, "file-history", sessionId);
    const readBackup = (name: string): string | null => {
        const path = join(backups, basename(name));

        try {
            return readFileSync(path, "utf8");
        } catch (error) {
            log.debug({ error, path }, "checkpoint backup not readable");
            return null;
        }
    };

    return parseClaudeTranscript(sessionId, { main: readFileSync(transcriptPath, "utf8"), subagents, readBackup });
}
