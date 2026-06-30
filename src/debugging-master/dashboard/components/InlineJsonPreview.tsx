import { SafeJSON } from "@app/utils/json";
import { memo, type ReactNode } from "react";

interface Props {
    value: unknown;
    /** Soft cap on rendered chars; further content is truncated with an ellipsis. */
    maxChars?: number;
    /** When true, render the full JSON without a char cap. */
    unlimited?: boolean;
}

interface RenderCtx {
    out: ReactNode[];
    remaining: number;
    key: number;
}

/**
 * Single-line, syntax-highlighted JSON preview using the same `.json-*`
 * classes as the expanded view. Caps total rendered chars to keep the DOM
 * small even when `data` is huge — the row is `truncate-mono` anyway, so
 * anything past the visible width gets ellipsised by CSS too.
 *
 * Memoized: with virtualized rows whose `entry` reference is stable across
 * scroll, this skips re-rendering the JSON span tree entirely on the common
 * "row remounts at a different scroll offset" path.
 */
function InlineJsonPreviewImpl({ value, maxChars = 800, unlimited = false }: Props): ReactNode {
    const ctx: RenderCtx = { out: [], remaining: unlimited ? Number.MAX_SAFE_INTEGER : maxChars, key: 0 };
    render(value, ctx);
    return <>{ctx.out}</>;
}

export const InlineJsonPreview = memo(InlineJsonPreviewImpl);

function render(value: unknown, ctx: RenderCtx): void {
    if (ctx.remaining <= 0) {
        return;
    }
    if (value === null) {
        push(ctx, "null", "json-null");
        return;
    }
    if (value === undefined) {
        push(ctx, "undefined", "json-null");
        return;
    }
    if (typeof value === "string") {
        push(ctx, SafeJSON.stringify(value), "json-string");
        return;
    }
    if (typeof value === "number") {
        push(ctx, String(value), "json-number");
        return;
    }
    if (typeof value === "boolean") {
        push(ctx, String(value), "json-boolean");
        return;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            push(ctx, "[]", "json-bracket");
            return;
        }
        push(ctx, "[ ", "json-bracket");
        for (let i = 0; i < value.length; i++) {
            if (i > 0) {
                push(ctx, ", ", "json-bracket");
            }
            render(value[i], ctx);
            if (ctx.remaining <= 0) {
                push(ctx, "…", "json-bracket");
                return;
            }
        }
        push(ctx, " ]", "json-bracket");
        return;
    }
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) {
            push(ctx, "{}", "json-bracket");
            return;
        }
        push(ctx, "{ ", "json-bracket");
        for (let i = 0; i < entries.length; i++) {
            if (i > 0) {
                push(ctx, ", ", "json-bracket");
            }
            const [k, v] = entries[i];
            push(ctx, SafeJSON.stringify(k), "json-key");
            push(ctx, ": ", "json-bracket");
            render(v, ctx);
            if (ctx.remaining <= 0) {
                push(ctx, "…", "json-bracket");
                return;
            }
        }
        push(ctx, " }", "json-bracket");
        return;
    }
    push(ctx, String(value), "json-null");
}

function push(ctx: RenderCtx, text: string, cls: string): void {
    let segment = text;
    if (segment.length > ctx.remaining) {
        segment = `${segment.slice(0, Math.max(0, ctx.remaining - 1))}…`;
        ctx.remaining = 0;
    } else {
        ctx.remaining -= segment.length;
    }
    ctx.out.push(
        <span key={ctx.key++} className={cls}>
            {segment}
        </span>
    );
}
