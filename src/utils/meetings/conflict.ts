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
