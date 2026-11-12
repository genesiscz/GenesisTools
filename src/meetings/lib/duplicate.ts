import { readdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import {
    MEETING_FILE,
    MEETING_UNCHANGED,
    type MeetingRecord,
    type MeetingStore,
    meetingRecordSchema,
} from "@genesiscz/utils/meetings/record";
import { cloneTree } from "./merge";
import { readRecorderState } from "./recorder-shared";

const { log } = logger.scoped("meetings-duplicate");

export interface DuplicateRequest {
    store: MeetingStore;
    /** The meeting to copy: an id, a unique prefix or last. */
    ref: string;
    /** The copy's title; default: the original's title with " (copy)". */
    title?: string;
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
    const copy = await store.create(
        { ...fields, title },
        { command: "duplicate", change: `duplicated from ${original.id}` }
    );
    const from = store.folder(original.id);
    const to = store.folder(copy.id);

    for (const name of readdirSync(from)) {
        if (name === MEETING_FILE) {
            continue;
        }

        cloneTree(join(from, name), join(to, name));
    }

    await store.update(copy.id, { command: "duplicate", change: "paths point into the copy's folder" }, (current) =>
        repointPaths(current, from, to) ? undefined : MEETING_UNCHANGED
    );
    log.debug({ from: original.id, to: copy.id }, "meeting duplicated");
    return { from: original.id, id: copy.id, title };
}

/** Rewrites every string of the record that starts in `from` to start in `to`. False when none does. */
export function repointPaths(record: MeetingRecord, from: string, to: string): boolean {
    const { history, ...rest } = record;
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
