import { SafeJSON } from "@genesiscz/utils/json";
import { eventNameForType } from "./events";

/**
 * One eslogger JSON line, modelled after `es_message_t` (man eslogger: field names follow the C
 * headers, and the schema may change between releases). Shape checked against recorded lines from
 * macOS 13 to 26 (schema_version 1, message versions 9 to 11):
 *
 *   { "event_type": 9, "time": "…Z", "process": { "audit_token": …, "executable": { "path": … } },
 *     "event": { "exec": { "target": { "executable": { "path": … } }, "args": [...], "cwd": { "path": … } } } }
 *
 * `event` holds exactly one key, the event's short name. `audit_token` is an object on most message
 * versions and a positional array of 8 numbers on version 10. Nothing is trusted to be present: every
 * read goes through {@link valueAtPath} and a type check.
 */
export type EsMessage = Record<string, unknown>;

export type ParsedLine = { ok: true; message: EsMessage } | { ok: false; error: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEsloggerLine(line: string): ParsedLine {
    let value: unknown;

    try {
        value = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (!isRecord(value)) {
        return { ok: false, error: "the line is JSON but not an object" };
    }

    return { ok: true, message: value };
}

/** The short name: the single key under `event`, else the numeric `event_type` mapped through the SDK enum. */
export function eventNameOf(message: EsMessage): string {
    const keys = isRecord(message.event) ? Object.keys(message.event) : [];

    if (keys.length === 1) {
        return keys[0];
    }

    if (typeof message.event_type === "number") {
        return eventNameForType(message.event_type);
    }

    return "unknown";
}

/** The event-specific object, `message.event[<name>]`. */
export function eventPayload(message: EsMessage): Record<string, unknown> {
    const payload = isRecord(message.event) ? message.event[eventNameOf(message)] : undefined;
    return isRecord(payload) ? payload : {};
}

/** `audit_token_t` field order, as in libbsm's `audit_token_to_au32`. */
export const AUDIT_TOKEN_FIELDS = ["auid", "euid", "egid", "ruid", "rgid", "pid", "asid", "pidversion"] as const;
export type AuditTokenField = (typeof AUDIT_TOKEN_FIELDS)[number];

function isAuditTokenField(name: string): name is AuditTokenField {
    return (AUDIT_TOKEN_FIELDS as readonly string[]).includes(name);
}

function isPositionalAuditToken(value: unknown): value is number[] {
    return (
        Array.isArray(value) &&
        value.length === AUDIT_TOKEN_FIELDS.length &&
        value.every((item) => typeof item === "number")
    );
}

/** Reads one field of an audit token in either shape eslogger emits. */
export function auditTokenField(token: unknown, field: AuditTokenField): number | undefined {
    if (isPositionalAuditToken(token)) {
        return token[AUDIT_TOKEN_FIELDS.indexOf(field)];
    }

    if (isRecord(token)) {
        const value = token[field];
        return typeof value === "number" ? value : undefined;
    }

    return undefined;
}

/** `.event.exec.args[1]` → `["event", "exec", "args", "1"]`. The leading dot is optional. */
export function splitPath(path: string): string[] {
    return path
        .trim()
        .replace(/^\./, "")
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .filter((part) => part.length > 0);
}

/**
 * Walks a dot path (jq style, `.process.audit_token.pid`). Array items are reached by index
 * (`.event.exec.args.1` or `.event.exec.args[1]`), and audit-token field names work on the
 * positional form too, so one filter matches every eslogger version.
 */
export function valueAtPath(root: unknown, path: string): unknown {
    let current: unknown = root;

    for (const part of splitPath(path)) {
        if (isPositionalAuditToken(current) && isAuditTokenField(part)) {
            current = auditTokenField(current, part);
            continue;
        }

        if (Array.isArray(current) && /^\d+$/.test(part)) {
            current = current[Number(part)];
            continue;
        }

        if (!isRecord(current)) {
            return undefined;
        }

        current = current[part];
    }

    return current;
}

export function textAt(root: unknown, path: string): string | undefined {
    const value = valueAtPath(root, path);
    return typeof value === "string" ? value : undefined;
}

export function numberAt(root: unknown, path: string): number | undefined {
    const value = valueAtPath(root, path);
    return typeof value === "number" ? value : undefined;
}

export function booleanAt(root: unknown, path: string): boolean | undefined {
    const value = valueAtPath(root, path);
    return typeof value === "boolean" ? value : undefined;
}

/** A path's value as text for filters: arrays of scalars join with spaces, so `args =~ "--inspect"` works. */
export function valueAsText(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value === null) {
        return "";
    }

    if (Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null)) {
        return value.map((item) => (item === null ? "" : String(item))).join(" ");
    }

    if (typeof value === "object") {
        return SafeJSON.stringify(value, { strict: true });
    }

    return String(value);
}
