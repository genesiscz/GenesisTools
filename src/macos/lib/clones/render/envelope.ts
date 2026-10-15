import { printLn } from "@genesiscz/utils/cli/stdout";
import { SafeJSON } from "@genesiscz/utils/json";
import { resolveFormat } from "./index";

export type ClonesErrorKind =
    | "integrity"
    | "clone-unsupported"
    | "rollback-space"
    | "unknown-process"
    | "missing-process"
    | "confirm-required"
    | "unknown-preset"
    | "no-roots"
    | "invalid-arguments"
    | "repo-not-found";

/**
 * What a machine-readable clones verb prints on stdout when it fails: `{"error": {...}}`, never mixed with a report.
 * `kind` is the stable switch for a decoder; `message` is the same sentence stderr gets; other fields are per kind
 * (`required` and `available` bytes for `rollback-space`, `closest` ids for `unknown-process`, `known` presets).
 */
export interface ClonesErrorEnvelope {
    error: {
        kind: ClonesErrorKind;
        message: string;
        /** The verb that failed, e.g. "optimize --rollback", "reclaim apply". */
        command: string;
        [extra: string]: unknown;
    };
}

export function clonesErrorEnvelope(
    kind: ClonesErrorKind,
    message: string,
    command: string,
    extra: Record<string, unknown> = {}
): ClonesErrorEnvelope {
    return { error: { kind, message, command, ...extra } };
}

/** True when `--format` resolves to a machine format (json, jsonl, or auto without a TTY). */
export function isMachineFormat(format: string | undefined): boolean {
    return resolveFormat(format) !== "table";
}

/** Print the error envelope on stdout when the caller asked for JSON (or piped `auto`); a table run prints nothing
 *  here, so humans keep the stderr lines alone. Callers still write their stderr text and set the exit code. */
export async function emitClonesError(args: {
    format: string | undefined;
    kind: ClonesErrorKind;
    message: string;
    command: string;
    extra?: Record<string, unknown>;
}): Promise<void> {
    if (!isMachineFormat(args.format)) {
        return;
    }

    const envelope = clonesErrorEnvelope(args.kind, args.message, args.command, args.extra);
    const compact = resolveFormat(args.format) === "jsonl";
    await printLn(compact ? SafeJSON.stringify(envelope) : SafeJSON.stringify(envelope, null, 2));
}
