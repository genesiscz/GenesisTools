import { SafeJSON } from "@genesiscz/utils/json";
import type { Dims, DimValue, StoredEvent } from "./types";

/**
 * The one check between a dim name and SQL text: the query builder writes a dim name into a JSON path and an index
 * name, so every door (ingest, define, query, events) passes each name through `assertDimName`. Values are always
 * bound parameters and never reach this check.
 */
const DIM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** A project or metric name: bound as a parameter, but kept short and printable for the CLI. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** The largest context kept with one event, as JSON text. */
export const MAX_CONTEXT_CHARS = 16_384;

export class MetricsInputError extends Error {}

export function isDimName(name: string): boolean {
    return DIM_NAME.test(name);
}

export function assertDimName(name: string): string {
    if (!isDimName(name)) {
        throw new MetricsInputError(
            `dim name ${SafeJSON.stringify(name)} is not a letter followed by up to 39 letters, digits or underscores`
        );
    }

    return name;
}

export function assertName(kind: "project" | "metric", name: string): string {
    if (!NAME.test(name)) {
        throw new MetricsInputError(
            `${kind} name ${SafeJSON.stringify(name)} must start with a letter or digit and use only letters, digits, ".", "_", ":" or "-" (100 at most)`
        );
    }

    return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDimValue(value: unknown): value is DimValue {
    return (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    );
}

function atOf(raw: unknown, now: number): number | undefined {
    if (raw === undefined) {
        return now;
    }

    if (typeof raw === "number") {
        return Number.isFinite(raw) ? Math.round(raw) : undefined;
    }

    if (typeof raw === "string") {
        const parsed = Date.parse(raw);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    return undefined;
}

export type EventCheck = { ok: true; event: StoredEvent } | { ok: false; reason: string };

/** An untrusted event (a spool line, an `ingest` element) as the store takes it, or why it is refused. */
export function checkEvent(raw: unknown, now: number): EventCheck {
    if (!isRecord(raw)) {
        return { ok: false, reason: "an event is a JSON object" };
    }

    const { project, metric, value } = raw;

    if (typeof project !== "string" || typeof metric !== "string") {
        return { ok: false, reason: "project and metric are strings" };
    }

    if (!NAME.test(project) || !NAME.test(metric)) {
        return { ok: false, reason: `project or metric name not allowed: ${project} / ${metric}` };
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: "value is a finite number" };
    }

    const at = atOf(raw.at, now);

    if (at === undefined) {
        return { ok: false, reason: "at is epoch ms or an ISO time" };
    }

    const dims: Dims = {};

    if (raw.dims !== undefined && raw.dims !== null) {
        if (!isRecord(raw.dims)) {
            return { ok: false, reason: "dims is an object" };
        }

        for (const [name, dim] of Object.entries(raw.dims)) {
            if (!isDimName(name)) {
                return { ok: false, reason: `dim name not allowed: ${name}` };
            }

            if (dim === undefined) {
                continue;
            }

            if (!isDimValue(dim)) {
                return { ok: false, reason: `dim ${name} is a string, number, boolean or null` };
            }

            dims[name] = dim;
        }
    }

    const event: StoredEvent = { project, metric, at, value, dims };

    if (raw.context !== undefined) {
        const text = SafeJSON.stringify(raw.context, { strict: true });

        if (text.length > MAX_CONTEXT_CHARS) {
            return {
                ok: false,
                reason: `context is ${text.length} characters of JSON, more than ${MAX_CONTEXT_CHARS}`,
            };
        }

        event.context = raw.context;
        event.contextJson = text;
    }

    return { ok: true, event };
}
