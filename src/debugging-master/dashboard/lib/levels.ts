import type { LogLevel } from "@app/debugging-master/types";

export interface LevelMeta {
    label: string;
    /** Single-char prefix used to construct ref ids (d, e, s, t). */
    refPrefix?: string;
    /** Whether this level has rich payload worth expanding. */
    expandable: boolean;
    /** Plain-language description for tooltips — what it is, when to use it. */
    description: string;
}

export const LEVELS: readonly LogLevel[] = [
    "dump",
    "info",
    "warn",
    "error",
    "timer-start",
    "timer-end",
    "checkpoint",
    "assert",
    "snapshot",
    "trace",
    "raw",
] as const;

export const LEVEL_META: Record<LogLevel, LevelMeta> = {
    dump: {
        label: "DUMP",
        refPrefix: "d",
        expandable: true,
        description:
            "DUMP — full data snapshot at one point in code. Use `dbg.dump(label, data)` for rich payloads (config, response bodies). Click a row to expand; ref id format: d<index>.",
    },
    info: {
        label: "INFO",
        expandable: false,
        description:
            "INFO — lightweight informational note. Use `dbg.info(msg, data?)` for general progress / state messages. Stack and any optional `data` are visible when expanded.",
    },
    warn: {
        label: "WARN",
        expandable: false,
        description:
            "WARN — something looks suspicious but execution continues. Use `dbg.warn(msg, data?)` to flag soft issues. Auto-captures the call stack.",
    },
    error: {
        label: "ERR",
        refPrefix: "e",
        expandable: true,
        description:
            "ERROR — failure or thrown exception. Use `dbg.error(msg, err?)`. Passing an Error preserves its stack; otherwise the call stack is auto-captured. Ref id format: e<index>.",
    },
    "timer-start": {
        label: "T▸",
        expandable: false,
        description:
            "TIMER-START — beginning of a timed operation. Use `dbg.timerStart(label)`, then `dbg.timerEnd(label)` to record durationMs.",
    },
    "timer-end": {
        label: "T◂",
        expandable: false,
        description:
            "TIMER-END — end of a timed operation. Shows `durationMs` next to the label. Pair with a prior `dbg.timerStart(label)`.",
    },
    checkpoint: {
        label: "CKPT",
        expandable: false,
        description:
            "CHECKPOINT — named point in execution flow. Use `dbg.checkpoint(label)` to assert “got here”; great for verifying a code path was reached.",
    },
    assert: {
        label: "ASSERT",
        expandable: false,
        description:
            "ASSERT — boolean condition check. Use `dbg.assert(cond, label, ctx?)`. Failed asserts get a red border + glitch animation; ctx contains the diagnostic payload.",
    },
    snapshot: {
        label: "SNAP",
        refPrefix: "s",
        expandable: true,
        description:
            "SNAPSHOT — multi-variable state capture. Use `dbg.snapshot(label, { x, y, z })`. Each var renders as a JSON tree when expanded. Ref id format: s<index>.",
    },
    trace: {
        label: "TRACE",
        refPrefix: "t",
        expandable: true,
        description:
            "TRACE — detailed flow / sequence info. Use `dbg.trace(label, data?)` for fine-grained ordering or middleware chains. Ref id format: t<index>.",
    },
    raw: {
        label: "RAW",
        expandable: true,
        description:
            "RAW — unparseable POST body. Ingest fell back here because the JSON couldn't be parsed strictly. The original payload is in `data`.",
    },
};

/** Display order in the filter bar. */
export const FILTER_ORDER: readonly LogLevel[] = [
    "error",
    "warn",
    "info",
    "dump",
    "snapshot",
    "checkpoint",
    "assert",
    "timer-start",
    "timer-end",
    "trace",
    "raw",
] as const;
