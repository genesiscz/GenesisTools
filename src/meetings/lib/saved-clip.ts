import { constants } from "node:fs";
import { copyFile, mkdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { type MeetingRecord, type MeetingStore, nextId } from "@genesiscz/utils/meetings/record";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Moment } from "./moment";

/** Copies a cached cut into the meeting before publishing its ordinary Context reference. */
export async function persistClip(options: {
    store: MeetingStore;
    record: MeetingRecord;
    clip: Moment & { path: string };
    title?: string;
    quote?: string;
    signal?: AbortSignal;
    now?: Date;
}) {
    const { store, record, clip, signal } = options;
    const from = formatClock(clip.startSec);
    const to = formatClock(clip.endSec);
    const title = options.title ?? `Clip ${from}${from === to ? "" : `–${to}`}`;
    signal?.throwIfAborted();
    const folder = join(store.folder(record.id), "clips");
    await mkdir(folder, { recursive: true });
    const path = join(folder, basename(clip.path));
    return store.storage.withFileLock({
        file: path,
        fn: async () => {
            signal?.throwIfAborted();
            let copied = false;
            try {
                try {
                    await copyFile(clip.path, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
                    copied = true;
                } catch (error) {
                    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
                        throw error;
                    }
                    const [saved, source] = await Promise.all([stat(path), stat(clip.path)]);
                    if (!saved.isFile() || saved.size !== source.size) {
                        throw new Error(`The saved clip path holds another file: ${path}`);
                    }
                }
                signal?.throwIfAborted();
                let created = false;
                const updated = await store.update(
                    record.id,
                    { command: "clip save", change: basename(path) },
                    (current) => {
                        signal?.throwIfAborted();
                        if (current.context.some((entry) => entry.kind === "file" && entry.ref === path)) {
                            return false;
                        }
                        current.context.push({
                            id: nextId("c", current.context),
                            kind: "file",
                            ref: path,
                            title,
                            ...(options.quote ? { note: options.quote } : {}),
                            addedAt: (options.now ?? new Date()).toISOString(),
                            addedBy: "user",
                        });
                        created = true;
                    }
                );
                const entry = updated.context.find((entry) => entry.kind === "file" && entry.ref === path);
                if (!entry) {
                    throw new Error("The saved clip's Context entry is missing");
                }
                return { entry, clip: { ...clip, path }, created };
            } catch (error) {
                if (copied) {
                    try {
                        await unlink(path);
                    } catch (cleanup) {
                        throw new AggregateError(
                            [error, cleanup],
                            `Could not save the clip or remove its incomplete artifact: ${path}`
                        );
                    }
                }
                throw error;
            }
        },
    });
}
