import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { type RecordingStoreId, recordingStores } from "@genesiscz/utils/screen-recorder/recording-stores";
import { probeVideo } from "@genesiscz/utils/video/probe";
import type { VideoInfo } from "@genesiscz/utils/video/types";
import { type EditSource, STORES } from "./plan";

/** A frame of a frames source (a recording or meeting folder): its file, time from the first frame, display. */
export interface SourceFrame {
    path: string;
    atUs: number;
    displayId?: number;
    changePercent?: number;
}

/** The final still lasts until the recording ends; a folder without an endpoint holds it for one second. */
export function framesDurationUs({ lastUs, startedAt, endedAt }: { lastUs: number; startedAt?: string; endedAt?: string }): number {
    const elapsedUs = endedAt && startedAt ? (Date.parse(endedAt) - Date.parse(startedAt)) * 1000 : NaN;
    return Number.isFinite(elapsedUs) && elapsedUs > 0 ? Math.max(lastUs + 1, elapsedUs) : lastUs + 1_000_000;
}

/** Where a source is, found without reading it: what the receipts and the input guard need first. */
export interface LocatedSource {
    kind: "video" | "frames";
    /** The video file, or the folder holding the frames. */
    path: string;
    /** Changes when the source changes: its size and time, or its frame count and newest time. */
    fingerprint: {
        path: string;
        size: number;
        mtimeMs: number;
        frames?: Array<{ path: string; size: number; mtimeMs: number }>;
    };
    store?: RecordingStoreId;
    id?: string;
}

export type LoadedSource =
    | { kind: "video"; path: string; info: VideoInfo }
    | { kind: "frames"; path: string; frames: SourceFrame[]; durationUs: number; displays: number[] };

const IMAGE = /\.(png|jpe?g|webp)$/i;
/** The meetings recorder's frame names: `HH-MM-SS-mmm[-d<display>].jpg`. */
const MEETING_FRAME = /^(\d{2})-(\d{2})-(\d{2})-(\d{3})(?:-d(\d+))?\.(?:jpe?g|png)$/i;

function folderFingerprint(path: string): LocatedSource["fingerprint"] {
    let size = 0;
    let mtimeMs = statSync(path).mtimeMs;

    for (const name of readdirSync(path)) {
        const stat = statSync(join(path, name));
        size += 1;
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    }

    return { path, size, mtimeMs, frames: readFrameFolder(path).map((frame) => fileFingerprint(frame.path)) };
}

function fileFingerprint(path: string): LocatedSource["fingerprint"] {
    const stat = statSync(path);
    return { path, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** The folder whose frames a recording id names, in the recordings store first, then the meetings store. */
function recordingFolder(id: string, store?: RecordingStoreId): { path: string; store: RecordingStoreId } {
    const found = recordingStores(store)
        .map((candidate) => ({ path: candidate.framesOf(id), store: candidate.id }))
        .find((candidate) => existsSync(candidate.path));

    if (!found) {
        throw new Error(`No recording "${id}" in the ${store ?? STORES.join(" or ")} store`);
    }

    return found;
}

export function locateSource(source: EditSource): LocatedSource {
    if ("recording" in source) {
        const folder = recordingFolder(source.recording, source.store);
        return {
            kind: "frames",
            path: folder.path,
            fingerprint: folderFingerprint(folder.path),
            store: folder.store,
            id: source.recording,
        };
    }

    const path = resolve(source.file);

    if (!existsSync(path)) {
        throw new Error(`No such file or folder: ${path}`);
    }

    return statSync(path).isDirectory()
        ? { kind: "frames", path, fingerprint: folderFingerprint(path) }
        : { kind: "video", path, fingerprint: fileFingerprint(path) };
}

function meetingFrameTime(name: string): { ms: number; displayId?: number } | undefined {
    const match = MEETING_FRAME.exec(name);

    if (!match) {
        return undefined;
    }

    const [hours, minutes, seconds, millis] = match.slice(1, 5).map(Number);
    return {
        ms: ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis,
        displayId: match[5] === undefined ? undefined : Number(match[5]),
    };
}

/** The frames of a folder: from its `recording.json`, from meeting frame names, or by file time. */
export function readFrameFolder(path: string): SourceFrame[] {
    const manifest = readRecordingManifest(path);

    if (manifest) {
        return manifest.frames
            .map((frame) => ({
                path: join(path, frame.file),
                atUs: Math.round(frame.atMs * 1000),
                displayId: frame.displayId,
                changePercent: frame.changePercent,
            }))
            .sort((a, b) => a.atUs - b.atUs);
    }

    const files = readdirSync(path).filter((name) => IMAGE.test(name));
    const timed = files.map((name) => {
        const fromName = meetingFrameTime(name);
        return {
            path: join(path, name),
            ms: fromName?.ms ?? statSync(join(path, name)).mtimeMs,
            displayId: fromName?.displayId,
        };
    });
    timed.sort((a, b) => a.ms - b.ms || a.path.localeCompare(b.path));
    const first = timed[0]?.ms ?? 0;
    return timed.map((frame) => ({
        path: frame.path,
        atUs: Math.round((frame.ms - first) * 1000),
        displayId: frame.displayId,
    }));
}

export async function loadSource(located: LocatedSource, signal?: AbortSignal): Promise<LoadedSource> {
    if (located.kind === "video") {
        return { kind: "video", path: located.path, info: await probeVideo({ input: located.path, signal }) };
    }

    const frames = readFrameFolder(located.path);

    if (frames.length === 0) {
        throw new Error(`${located.path} holds no frames`);
    }

    const manifest = readRecordingManifest(located.path);
    const lastUs = frames[frames.length - 1].atUs;
    const durationUs = framesDurationUs({ lastUs, startedAt: manifest?.startedAt, endedAt: manifest?.endedAt });
    return {
        kind: "frames",
        path: located.path,
        frames,
        durationUs,
        displays: [...new Set(frames.map((frame) => frame.displayId).filter((id) => id !== undefined))],
    };
}
