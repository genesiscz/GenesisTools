import { SafeJSON } from "@app/utils/json";
import { logger } from "@app/utils/logger";
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
    const kinds = new Set(
        (options.kinds ?? "")
            .split(",")
            .map((kind) => kind.trim())
            .filter(Boolean)
    );
    const expressionFilter = options.expression ? compileExpression(options.expression) : null;

    return (event) => {
        if (kinds.size > 0) {
            const body = messageBody(event);
            const bodyKind =
                typeof body?.op === "string" ? body.op : typeof body?.event === "string" ? body.event : null;
            if (!kinds.has(event.type) && (!bodyKind || !kinds.has(bodyKind))) {
                return false;
            }
        }

        return expressionFilter ? expressionFilter(event) : true;
    };
}
