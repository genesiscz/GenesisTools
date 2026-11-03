import type { AccountKey } from "./envelope";

export type UsageQueryErrorCode =
    | "bad-window"
    | "bad-zone"
    | "bad-step"
    | "bad-value"
    | "reserved"
    | "unknown-provider"
    | "unknown-account"
    | "ambiguous-account"
    | "pseudo-account";

export interface UsageQueryErrorDetails {
    /** The text the user typed, so a help line can quote it back. */
    given?: string;
    /** Accounts an ambiguous or unknown `--account` value could have meant. */
    candidates?: readonly AccountKey[];
    /** A closed-set flag that got no value or a wrong one: the door prints its value list. */
    enumFlag?: { flag: string; values: readonly string[] };
}

/**
 * Every refusal of the shared usage flags. A door prints `message` and exits 1; `code` lets a
 * test or an MCP tool tell the cases apart without matching prose.
 */
export class UsageQueryError extends Error {
    readonly code: UsageQueryErrorCode;
    readonly details: UsageQueryErrorDetails;

    constructor(code: UsageQueryErrorCode, message: string, details: UsageQueryErrorDetails = {}) {
        super(message);
        this.name = "UsageQueryError";
        this.code = code;
        this.details = details;
    }
}
