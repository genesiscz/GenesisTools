import { SafeJSON } from "@app/utils/json";

/** HH:MM:SS.mmm */
export function formatTime(ts: number): string {
    if (!ts) {
        return "--:--:--";
    }
    const d = new Date(ts);
    const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatRelativeTime(ts: number): string {
    if (!ts) {
        return "never";
    }
    const delta = Date.now() - ts;
    if (delta < 60_000) {
        return "just now";
    }
    if (delta < 3_600_000) {
        return `${Math.floor(delta / 60_000)}m ago`;
    }
    if (delta < 86_400_000) {
        return `${Math.floor(delta / 3_600_000)}h ago`;
    }
    return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function formatDurationMs(ms: number): string {
    if (ms < 1) {
        return `${(ms * 1000).toFixed(0)}µs`;
    }
    if (ms < 1000) {
        return `${ms.toFixed(1)}ms`;
    }
    return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Compact, single-line preview of arbitrary entry data — used in collapsed rows.
 * Truncates aggressively; full data is shown when the row is expanded.
 */
export function previewData(value: unknown, maxLen = 80): string {
    if (value === undefined || value === null) {
        return "";
    }
    let s: string;
    if (typeof value === "string") {
        s = value;
    } else {
        try {
            s = SafeJSON.stringify(value);
        } catch {
            s = String(value);
        }
    }
    s = s.replace(/\s+/g, " ");
    return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

/** Compact stringified preview of a vars object: `key=val, key=val`. */
export function previewVars(vars: Record<string, unknown>, maxLen = 80): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(vars)) {
        let val: string;
        if (typeof v === "string") {
            val = v.length > 20 ? `"${v.slice(0, 19)}…"` : `"${v}"`;
        } else if (v === null) {
            val = "null";
        } else if (typeof v === "object") {
            val = Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v as object).length}}`;
        } else {
            val = String(v);
        }
        parts.push(`${k}=${val}`);
    }
    const joined = parts.join(", ");
    return joined.length > maxLen ? `${joined.slice(0, maxLen - 1)}…` : joined;
}
