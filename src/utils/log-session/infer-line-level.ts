import { stripAnsi } from "@app/utils/string";
import type { JsonlLineLevel, StreamOut } from "./types";

const SEVERITY: Record<JsonlLineLevel, number> = {
    info: 0,
    warn: 1,
    error: 2,
};

const ERROR_LINE =
    /^(?:Error|ERROR|Fatal|FATAL|Exception|Unhandled|Uncaught)\b|\bError:\s|^ERR!|^npm ERR!|\[error\]|^✖|^■/i;
const ERROR_STACK = /^\s+at (?:[\w./<>[\]$]+|\(.+\))/;
const WARN_LINE = /\bWARN(?:ING)?\b|\[warn(?:ing)?\]|^▲|^⚠|\bwarning:\s/i;

function normalizeLine(text: string): string {
    return stripAnsi(text).replace(/\r/g, "");
}

function inferLevelFromText(text: string): JsonlLineLevel | null {
    const line = normalizeLine(text);
    const trimmed = line.trim();

    if (!trimmed) {
        return null;
    }

    if (ERROR_LINE.test(trimmed) || ERROR_LINE.test(line) || ERROR_STACK.test(line)) {
        return "error";
    }

    if (WARN_LINE.test(trimmed) || WARN_LINE.test(line)) {
        return "warn";
    }

    return null;
}

function streamBaseline(out: StreamOut): JsonlLineLevel {
    if (out === "stderr") {
        return "error";
    }

    return "info";
}

function maxLevel(a: JsonlLineLevel, b: JsonlLineLevel): JsonlLineLevel {
    if (SEVERITY[a] >= SEVERITY[b]) {
        return a;
    }

    return b;
}

export function inferLineLevel(out: StreamOut, text: string): JsonlLineLevel {
    const baseline = streamBaseline(out);
    const fromText = inferLevelFromText(text);

    if (!fromText) {
        return baseline;
    }

    return maxLevel(baseline, fromText);
}
