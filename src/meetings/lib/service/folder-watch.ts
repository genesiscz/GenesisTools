import { join, relative } from "node:path";
import { type FileIdentity, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { createWatcher, type WatcherOptions, type WatcherSubscription } from "@genesiscz/utils/fs/watcher";
import { logger } from "@genesiscz/utils/logger";
import { PEOPLE_FILE } from "@genesiscz/utils/meetings/people-book";
import { MEETING_FILE, MOMENTS_FOLDER } from "@genesiscz/utils/meetings/record";
import { MEETING_PARTS } from "./api";

const { log } = logger.scoped("meetings-service");

type MeetingPart = (typeof MEETING_PARTS)[number];

/** Writes this close together are one change: a recorder's frame and its OCR line, a record and its journal line. */
export const FOLDER_WATCH_COALESCE_MS = 300;

/**
 * What a write in the meetings folder changes, as the window parts of `meeting.revisions` name them: the record is
 * read by every part; the screen recording (OCR lines, frames, the recorder's own files) by the timeline. The decision
 * journal, the answer log, comments, clips, the channel energy and exports are no window part (a decision through the
 * service tells `decision.applied` itself), so they change nothing here.
 */
export function partsOfPath(relativePath: string): { meeting: string; parts: MeetingPart[] } | undefined {
    const [meeting, first, ...rest] = relativePath.split(/[/\\]/);

    if (!meeting || !first || meeting.startsWith(".")) {
        return undefined;
    }

    if (first === MEETING_FILE && rest.length === 0) {
        return { meeting, parts: [...MEETING_PARTS] };
    }

    if (
        first === "ocr.jsonl" ||
        first === "frames.jsonl" ||
        first === "frames" ||
        first === "recording.json" ||
        first === "recorder-last.json"
    ) {
        return { meeting, parts: ["timeline"] };
    }

    return undefined;
}

/** Comment and listener writes live together in this one journal. */
function commentMeeting(relativePath: string): string | undefined {
    const [meeting, file, ...rest] = relativePath.split(/[/\\]/);
    return meeting && !meeting.startsWith(".") && file === "comments.ndjson" && rest.length === 0 ? meeting : undefined;
}

export interface FolderWatchOptions {
    /** The meetings store's folder (one folder per meeting below it). */
    root: string;
    /** Tells the subscribers of a meeting what changed. */
    emit: (meeting: string, parts: MeetingPart[]) => void;
    peopleChanged?: () => void;
    commentsChanged?: (meeting: string) => void;
    /** The event source; @parcel/watcher's when absent (tests pass a fake, as createWatcher allows). */
    subscribe?: WatcherOptions["subscribe"];
    coalesceMs?: number;
}

/**
 * The service's watch on the meetings folder: a write by anyone but the service (the recorder, an import, a hand
 * edit, a command that answered in its own process) becomes `meeting.changed { parts }`, one per meeting per burst.
 * The service's own record writes are left out: `ownWrite` records the record file as the service left it, and an
 * event that finds it still so is the service's own.
 */
export class MeetingsFolderWatch {
    private readonly own = new Map<string, FileIdentity>();
    private subscription?: WatcherSubscription;

    constructor(private readonly options: FolderWatchOptions) {}

    async start(): Promise<void> {
        this.subscription = await createWatcher(this.options.root, (events) => this.heard(events), {
            debounceMs: this.options.coalesceMs ?? FOLDER_WATCH_COALESCE_MS,
            ignorePatterns: [`**/${MOMENTS_FOLDER}/**`, "**/evidence/**", "**/.*"],
            filter: (event) => {
                const path = relative(this.options.root, event.path);
                return path === PEOPLE_FILE || commentMeeting(path) !== undefined || partsOfPath(path) !== undefined;
            },
            ...(this.options.subscribe ? { subscribe: this.options.subscribe } : {}),
        });
        log.debug({ root: this.options.root }, "meetings folder watched");
    }

    /** The service wrote this meeting's record: the record as it is now is its own, not an outside change. */
    ownWrite(meeting: string): void {
        const identity = fileIdentity(join(this.options.root, meeting, MEETING_FILE));

        if (identity) {
            this.own.set(meeting, identity);
        }
    }

    async stop(): Promise<void> {
        await this.subscription?.unsubscribe();
    }

    private heard(events: Array<{ path: string }>): void {
        const changed = new Map<string, Set<MeetingPart>>();
        let peopleChanged = false;
        const commentMeetings = new Set<string>();

        for (const event of events) {
            const relativePath = relative(this.options.root, event.path);
            if (relativePath === PEOPLE_FILE) {
                peopleChanged = true;
                continue;
            }
            const comments = commentMeeting(relativePath);
            if (comments) {
                commentMeetings.add(comments);
                continue;
            }
            const found = partsOfPath(relativePath);

            if (!found || (found.parts.length === MEETING_PARTS.length && this.isOwn(found.meeting))) {
                continue;
            }

            const parts = changed.get(found.meeting) ?? new Set<MeetingPart>();

            for (const part of found.parts) {
                parts.add(part);
            }

            changed.set(found.meeting, parts);
        }

        if (peopleChanged) {
            this.options.peopleChanged?.();
        }

        for (const meeting of commentMeetings) {
            this.options.commentsChanged?.(meeting);
        }
        for (const [meeting, parts] of changed) {
            log.debug({ meeting, parts: [...parts] }, "a meeting changed outside the service");
            this.options.emit(
                meeting,
                MEETING_PARTS.filter((part) => parts.has(part))
            );
        }
    }

    private isOwn(meeting: string): boolean {
        const own = this.own.get(meeting);
        const now = fileIdentity(join(this.options.root, meeting, MEETING_FILE));
        return (
            own !== undefined &&
            now !== null &&
            own.ino === now.ino &&
            own.size === now.size &&
            own.mtimeMs === now.mtimeMs &&
            own.ctimeMs === now.ctimeMs
        );
    }
}
