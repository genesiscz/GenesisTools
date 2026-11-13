import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    MEETING_FILE,
    type MeetingRecord,
    type MeetingStore,
    meetingRecordSchema,
} from "@genesiscz/utils/meetings/record";
import { clearPidFile, inspectPidFile, writePidFile } from "@genesiscz/utils/process/pidfile";
import { kickDrainer, loadRmConfig, moveToTrash, resolveTarget, rmCallerFromRuntime } from "@genesiscz/utils/rm";
import { ANSWER_LOG_FILE, appendAnswerEvent, readAnswerEvents, runningRound } from "./answer-log";
import { COMMENTS_FILE, MeetingComments } from "./comments";
import { JOURNAL_FILE, journalEntrySchema } from "./decision-journal";
import { cloneTree } from "./merge";
import { interruptedRecording } from "./recorder-adapters";
import { lastRecordingActivity, readRecorderState } from "./recorder-shared";

const { log } = logger.scoped("meetings-duplicate");

export interface DuplicateRequest {
    store: MeetingStore;
    /** The meeting to copy: an id, a unique prefix or last. */
    ref: string;
    /** The copy's title; default: the original's title with " (copy)". */
    title?: string;
    /** Start an independent automatic run with no items or decision journal. */
    withoutItems?: boolean;
}

export interface DuplicateResult {
    from: string;
    id: string;
    title: string;
}

/** The copy's title when none is given. */
export function copyTitle(title: string): string {
    const base = title.trim() || "Untitled meeting";
    return `${base} (copy)`;
}

/**
 * A second record of the same meeting: the same fields, sources, items and context, and a clone of every file in its
 * folder (frames, sound, the decision journal). Paths in the record that point into the original's folder point into
 * the copy's. The copy has its own history, starting with the line that names the original, and no export or project
 * question of its own. The source link stays, so the copy shows the same transcript.
 */
export async function duplicateMeeting(request: DuplicateRequest): Promise<DuplicateResult> {
    const { store } = request;
    const original = store.resolve(request.ref);

    if (!original) {
        throw new Error(`No meeting "${request.ref}".`);
    }

    return store.storage.withFileLock({
        file: join(store.root, ".duplicate"),
        fn: async () => {
            recoverCopies(store);
            return store.storage.withFileLock({
                file: store.path(original.id),
                fn: async () => duplicateLocked({ ...request, ref: original.id }),
            });
        },
    });
}

const PENDING_COPIES = ".duplicate-pending";

/** Only an unpublished folder reserved for this copy may be rolled back; a published copy always stays. */
function discardCopy(store: MeetingStore, id: string): void {
    const folder = store.folder(id);
    if (existsSync(store.path(id)) || !existsSync(folder)) {
        return;
    }

    const config = loadRmConfig();
    const batch = moveToTrash([{ target: resolveTarget(folder, store.root), rule: "meetings-duplicate-rollback" }], {
        config,
        caller: rmCallerFromRuntime(),
        graceMinutes: config.grace.otherMinutes,
    });
    if (!batch || existsSync(folder)) {
        throw new Error(`The unfinished copy ${id} could not be moved to the trash.`);
    }

    kickDrainer(config);
    log.debug({ id, batch: batch.id }, "unfinished meeting copy moved to trash");
}

/** The operation lock serializes recovery with new copies; pid identity also protects another live process. */
function recoverCopies(store: MeetingStore): void {
    const pending = join(store.root, PENDING_COPIES);
    if (!existsSync(pending)) {
        return;
    }

    for (const name of readdirSync(pending)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.pid$/.test(name)) {
            continue;
        }

        const claim = join(pending, name);
        const state = inspectPidFile(claim);
        if (state.status === "dead" || state.status === "foreign") {
            discardCopy(store, name.slice(0, -4));
            clearPidFile(claim, { force: true });
        }
    }
}

function closeCopiedListeners(folder: string): void {
    const comments = new MeetingComments(join(folder, COMMENTS_FILE), { alive: () => true });
    for (const listener of comments.listeners()) {
        comments.leave(listener.pid);
    }

    const answers = join(folder, ANSWER_LOG_FILE);
    const round = runningRound(readAnswerEvents(answers));
    if (round.length > 0) {
        appendAnswerEvent(answers, {
            event: "round-end",
            at: new Date().toISOString(),
            reason: "stopped",
            asked: round.filter((event) => event.event === "answered" || event.event === "skipped").length,
            open: -1,
        });
    }
}

async function duplicateLocked(request: DuplicateRequest): Promise<DuplicateResult> {
    const { store } = request;
    const original = store.read(request.ref);
    if (!original) {
        throw new Error(`No meeting "${request.ref}".`);
    }

    const recorder = readRecorderState(store);
    if (recorder.running && recorder.state?.meetingId === original.id) {
        throw new Error(`${original.id} is being recorded now; stop the recording first, then duplicate it.`);
    }

    const title = request.title?.trim() || copyTitle(original.title);
    const {
        id: _id,
        createdAt: _createdAt,
        history: _history,
        exports: _exports,
        assign: _assign,
        title: _title,
        ...fields
    } = original;
    if (fields.recording?.status === "recording" || fields.recording?.status === "paused") {
        const spans = [...(fields.recording.spans ?? []), ...(fields.recording.displaySpans ?? [])];
        const knownTimes = [
            original.start,
            fields.recording.startedAt,
            ...spans.flatMap((span) => [span.from, span.to]),
        ]
            .flatMap((value) => (value ? [Date.parse(value)] : []))
            .filter(Number.isFinite);
        const at = new Date(Math.max(lastRecordingActivity(store, original.id) ?? 0, ...knownTimes)).toISOString();
        fields.recording = interruptedRecording(fields.recording, at);
    }
    const from = store.folder(original.id);
    let prepared: { id: string; claim: string } | undefined;
    const rollback = () => {
        if (prepared) {
            discardCopy(store, prepared.id);
            clearPidFile(prepared.claim);
        }
    };
    let copy: MeetingRecord;
    try {
        copy = await store.createWithFiles({
            fields: { ...fields, title, ...(request.withoutItems ? { items: [] } : {}) },
            change: {
                command: "duplicate",
                change: `duplicated from ${original.id}${request.withoutItems ? " without items" : ""}`,
            },
            beside: {
                write: (record) => {
                    const to = store.folder(record.id);
                    const claim = join(store.root, PENDING_COPIES, `${record.id}.pid`);
                    prepared = { id: record.id, claim };
                    try {
                        writePidFile(claim, { exclusive: true });
                        for (const name of readdirSync(from)) {
                            if (name === MEETING_FILE || /(?:\.pid|\.lock)(?:$|\.)/.test(name)) {
                                continue;
                            }

                            if (name === JOURNAL_FILE) {
                                if (!request.withoutItems) {
                                    const entries = readFileSync(join(from, name), "utf8")
                                        .split("\n")
                                        .filter((line) => line.trim())
                                        .map((line) => {
                                            const entry = journalEntrySchema.parse(
                                                SafeJSON.parse(line, { jsonl: true })
                                            );
                                            if (entry.meeting !== original.id || entry.action.kind === "unsupported") {
                                                throw new Error(
                                                    `Cannot copy incompatible journal entry ${entry.token}; use --without-items for a clean copy.`
                                                );
                                            }

                                            return SafeJSON.stringify(
                                                {
                                                    ...entry,
                                                    meeting: record.id,
                                                    copiedFrom: original.id,
                                                    corrections: entry.corrections.map((correction) => ({
                                                        ...correction,
                                                        meeting: record.id,
                                                    })),
                                                },
                                                { jsonl: true }
                                            );
                                        });
                                    writeFileSync(join(to, name), entries.length ? `${entries.join("\n")}\n` : "", {
                                        mode: 0o600,
                                    });
                                }

                                continue;
                            }

                            cloneTree(join(from, name), join(to, name));
                        }

                        closeCopiedListeners(to);
                        repointPaths(record, from, to);
                    } catch (error) {
                        try {
                            rollback();
                        } catch (undoError) {
                            log.error(
                                { id: record.id, error: undoError },
                                "unfinished meeting copy could not be rolled back"
                            );
                        }

                        throw error;
                    }
                },
                undo: rollback,
                saved: () => {
                    if (prepared) {
                        clearPidFile(prepared.claim);
                    }
                },
            },
        });
    } catch (error) {
        // Releasing a file lock may recreate its parent for arbitration. Finish cleanup after that release.
        try {
            rollback();
        } catch (undoError) {
            log.error({ error: undoError }, "unfinished copy cleanup failed after its record lock was released");
        }
        throw error;
    }
    log.debug({ from: original.id, to: copy.id }, "meeting duplicated");
    return { from: original.id, id: copy.id, title };
}

/** Repoints record paths from `from` to `to`, preserving history and opaque context revision content. */
export function repointPaths(record: MeetingRecord, from: string, to: string): boolean {
    const { history, ...rest } = record;
    const revisions = new Set<object>(
        record.context.flatMap((entry) => (entry.file?.revision ? [entry.file.revision] : []))
    );
    let changed = false;
    const repoint = (value: unknown): unknown => {
        if (typeof value === "string") {
            if (value === from || value.startsWith(`${from}/`)) {
                changed = true;
                return `${to}${value.slice(from.length)}`;
            }

            return value;
        }

        if (Array.isArray(value)) {
            return value.map(repoint);
        }

        if (value !== null && typeof value === "object") {
            if (revisions.has(value)) {
                return value;
            }

            return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, repoint(child)]));
        }

        return value;
    };
    const moved = repoint(rest);

    if (!changed) {
        return false;
    }

    Object.assign(record, meetingRecordSchema.parse(moved), { history });
    return true;
}
