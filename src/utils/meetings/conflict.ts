/**
 * Why a meetings write was refused because the data on disk is not what the caller saw or may overwrite. The code
 * reaches the CLI's `✗ [code] sentence` line, so the window can tell a conflict from a plain failure.
 */
export const MEETINGS_CONFLICT_CODES = [
    /** A config value changed since the caller read it (`config set --expect`). */
    "config-stale",
    /** The export target holds edits the last export did not write. */
    "export-edited",
    /** The export target is a symlink or not a plain file inside the chosen folder. */
    "export-unsafe-path",
    /** An item was decided again since the decision an Undo names (`reopen --token`). */
    "item-changed",
    /** A dictionary entry with that value exists already in the level (`dictionary add --if-absent`). */
    "dictionary-exists",
] as const;
export type MeetingsConflictCode = (typeof MEETINGS_CONFLICT_CODES)[number];

export class MeetingsConflictError extends Error {
    readonly code: MeetingsConflictCode;

    constructor(code: MeetingsConflictCode, message: string) {
        super(message);
        this.name = "MeetingsConflictError";
        this.code = code;
    }
}

/**
 * Why a meetings read cannot answer for one meeting: a state of that meeting, not a failure. The code leads the CLI's
 * `✗ [code] sentence` line like a conflict's, so the Meetings window shows its empty state instead of an error.
 */
export const MEETINGS_STATE_CODES = [
    /** The meeting has no linked source with a transcript (a screen recording only). */
    "no-transcript-source",
] as const;
export type MeetingsStateCode = (typeof MEETINGS_STATE_CODES)[number];

export class MeetingsStateError extends Error {
    readonly code: MeetingsStateCode;

    constructor(code: MeetingsStateCode, message: string) {
        super(message);
        this.name = "MeetingsStateError";
        this.code = code;
    }
}
