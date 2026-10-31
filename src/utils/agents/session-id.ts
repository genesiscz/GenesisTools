import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The one test for an agent session id (or a tool call id, an agent id, a bus session name) that becomes a file or
 * folder name. It replaced four checks that each guarded some of the same files:
 * - hook state `/^[A-Za-z0-9_-]{1,80}$/`, the dialog records `/^[A-Za-z0-9._-]{1,128}$/`,
 * - the hook capture folders `/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/`,
 * - the agents bus (no separator, not `.` or `..`, no control character, at most 128, no outer whitespace).
 *
 * It accepts every id any of them accepted for the files it guards (the bus check is the widest, and every narrower
 * one is inside it, except the dialog check's bare `.` and `..`, which no harness issues), so no existing state file,
 * dialog record or bus folder becomes unreadable. What it refuses is
 * what makes a segment unsafe or unusable: a separator or `.`/`..` (a path traversal, and the capture folders end in
 * a recursive delete), a control character (captured terminal output passed as an id made unlistable folders), more
 * than 128 characters (a whole command output) and outer whitespace.
 */

export const MAX_SESSION_ID_LENGTH = 128;

export type SessionIdProblem = "not-a-string" | "empty" | "path" | "control-character" | "too-long" | "whitespace";

const SEPARATOR_OR_DOT_SEGMENT = /[/\\]|^\.\.?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

/** Why `value` cannot be a session id segment, or null when it can. */
export function sessionIdProblem(value: unknown): SessionIdProblem | null {
    if (typeof value !== "string") {
        return "not-a-string";
    }

    if (value.length === 0) {
        return "empty";
    }

    if (SEPARATOR_OR_DOT_SEGMENT.test(value)) {
        return "path";
    }

    if (CONTROL_CHARACTER.test(value)) {
        return "control-character";
    }

    if (value.length > MAX_SESSION_ID_LENGTH) {
        return "too-long";
    }

    if (value !== value.trim()) {
        return "whitespace";
    }

    return null;
}

/** `value` when it is safe to use as one path segment, else null. */
export function safeSessionId(value: unknown): string | null {
    return sessionIdProblem(value) === null && typeof value === "string" ? value : null;
}

/** `value` when it is safe to use as one path segment; throws naming `label` and the problem otherwise. */
export function assertSafeSessionId(value: unknown, label = "session id"): string {
    const problem = sessionIdProblem(value);

    if (problem === null && typeof value === "string") {
        return value;
    }

    throw new Error(`unsafe ${label} (${problem}): ${SafeJSON.stringify(value)}`);
}
