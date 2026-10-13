import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { FeedEvent } from "./types";

const log = logger.child({ component: "agents:listener-filter" });

interface ListenerFilterOptions {
    kinds?: string;
    expression?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageBody(event: FeedEvent): Record<string, unknown> | null {
    if (event.type !== "message" || !event.body.trim().startsWith("{")) {
        return null;
    }

    try {
        const parsed = SafeJSON.parse(event.body, { strict: true });
        return isRecord(parsed) ? parsed : null;
    } catch (err) {
        log.debug({ err, messageId: event.message_id }, "structured listener filter skipped invalid JSON body");
        return null;
    }
}

function valueAtPath(record: Record<string, unknown>, path: string[]): unknown {
    let value: unknown = record;

    for (const segment of path) {
        if (!isRecord(value)) {
            return undefined;
        }

        value = value[segment];
    }

    return value;
}

function compileExpression(expression: string): (event: FeedEvent) => boolean {
    const match = expression.match(/^\.([A-Za-z_][\w.]*)\s*(==|!=)\s*"([^"]*)"$/);
    if (!match?.[1] || !match[2]) {
        throw new Error(
            `Unsupported --filter expression: ${expression}. Supported form: .field=="value" or .field!="value"`
        );
    }

    const path = match[1].split(".");
    const operator = match[2];
    const expected = match[3] ?? "";

    return (event) => {
        const source = messageBody(event) ?? (event as unknown as Record<string, unknown>);
        const actual = valueAtPath(source, path);
        return operator === "==" ? actual === expected : actual !== expected;
    };
}

export function createListenerFilter(options: ListenerFilterOptions): (event: FeedEvent) => boolean {
    const entries = (options.kinds ?? "")
        .split(",")
        .map((kind) => kind.trim())
        .filter(Boolean);
    // `-item` excludes a kind and wins over any inclusion, so `--kinds message,-item` keeps a Codex worker's
    // mail and approvals while dropping the item events its bridge publishes to the lead for every step.
    const kinds = new Set(entries.filter((kind) => !kind.startsWith("-")));
    const excluded = new Set(entries.filter((kind) => kind.startsWith("-")).map((kind) => kind.slice(1)));
    const expressionFilter = options.expression ? compileExpression(options.expression) : null;

    return (event) => {
        // A join or a leave opens or closes the channel: one event each, so `--kinds message` (meant to hide
        // per-login noise) must not hide the moment a peer starts or stops listening.
        const presence = event.type === "agent_joined" || event.type === "agent_left";

        if ((kinds.size > 0 || excluded.size > 0) && !presence) {
            const body = messageBody(event);
            const bodyKind =
                typeof body?.op === "string" ? body.op : typeof body?.event === "string" ? body.event : null;

            if (excluded.has(event.type) || (bodyKind && excluded.has(bodyKind))) {
                return false;
            }

            if (kinds.size > 0 && !kinds.has(event.type) && (!bodyKind || !kinds.has(bodyKind))) {
                return false;
            }
        }

        return expressionFilter ? expressionFilter(event) : true;
    };
}
