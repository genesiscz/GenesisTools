import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { STORES } from "@genesiscz/utils/recording-editor/plan";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { recordingsLibraryDir } from "./library";

/** A store of screen recordings: the recorder's library, or the meetings (each meeting's folder holds its frames). */
export type RecordingStoreId = (typeof STORES)[number];

/**
 * Where a store keeps its recordings and what the recorder may do with one. Every "is this a meeting" question of the
 * recorder tool reads this table. The app asks the same in Swift (RecorderMenu.swift, RecordingActions.swift).
 */
export interface RecordingStore {
    id: RecordingStoreId;
    /** The folder that holds the store's recordings. */
    root(): string;
    /** The folder of the recording `id`. The store may not hold it. */
    folderOf(id: string): string;
    /** The folder that holds the frames of the recording `id`. */
    framesOf(id: string): string;
    /** Set when the recorder must never move a recording's folder to the Trash: why, and the tool that removes it. */
    kept?: { what: string; reason: string; tool: string };
    /** The record that "show its meeting" opens, when the recording has one. */
    recordOf?(folder: string): string | undefined;
}

export const RECORDING_STORES: Record<RecordingStoreId, RecordingStore> = {
    recordings: {
        id: "recordings",
        root: () => recordingsLibraryDir(),
        folderOf: (id) => recordingsLibraryDir(id),
        framesOf: (id) => recordingsLibraryDir(id),
    },
    meetings: {
        id: "meetings",
        root: () => toolDataDir("meetings"),
        folderOf: (id) => toolDataDir("meetings", id),
        framesOf: (id) => toolDataDir("meetings", id, "frames"),
        kept: { what: "a meeting's screen recording", reason: "its folder holds the whole meeting", tool: "meetings" },
        recordOf: (folder) => {
            const record = join(folder, "meeting.json");
            return existsSync(record) ? record : undefined;
        },
    },
};

/** The stores in the order a recording id is looked up: the library first. */
export function recordingStores(only?: RecordingStoreId): RecordingStore[] {
    return STORES.filter((id) => only === undefined || id === only).map((id) => RECORDING_STORES[id]);
}

/** The store whose root holds `folder`; `roots` replaces a store's root (a test's fixture folder). */
export function recordingStoreOf(
    folder: string,
    roots: Partial<Record<RecordingStoreId, string>> = {}
): RecordingStore | undefined {
    const path = resolve(folder);
    return recordingStores().find((store) => path.startsWith(resolve(roots[store.id] ?? store.root()) + sep));
}
