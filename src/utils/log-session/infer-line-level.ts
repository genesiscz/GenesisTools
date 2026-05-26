import { stripAnsi } from "@app/utils/string";
import type { JsonlLineLevel, StreamOut } from "./types";

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

export function inferLineLevel(_out: StreamOut, text: string): JsonlLineLevel {
    return inferLevelFromText(text) ?? "info";
}
