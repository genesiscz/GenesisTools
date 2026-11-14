import { closeSync, openSync, readSync } from "node:fs";
import { parseTranscriptLine } from "@genesiscz/utils/ai/transcripts/parse-line";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";
import { nonEmptyString as text } from "@genesiscz/utils/string";
import type { NativeSourceIssue, NativeToolCall, ToolCallsRead } from "../types";
import { readToolCallLines } from "./tool-calls";

/** A rollout's first row (`session_meta`) carries the base instructions too, so its cwd is looked for this far. */
const HEAD_BYTES = 256 * 1024;
/** The windows before a read in which its turn's `turn_context` is looked for, each wider than the last. */
const TURN_LOOKBACK_BYTES = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024];
const TURN_CONTEXT = Buffer.from('"turn_context"');
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const SHELLS = new Set(["bash", "zsh", "sh"]);

/**
 * The cwd of the latest `turn_context` row before `offset` (a row start), so a read that starts mid-session gives its
 * calls the cwd a read from the file start gives them. `capped`: the widest window ended before the file start.
 */
function turnCwdBefore(path: string, offset: number): { cwd?: string; capped: boolean } {
    let fd: number;

    try {
        fd = openSync(path, "r");
    } catch {
        return { capped: false };
    }

    try {
        for (const size of TURN_LOOKBACK_BYTES) {
            const start = Math.max(0, offset - size);
            const buf = Buffer.allocUnsafe(offset - start);
            const data = buf.subarray(0, readSync(fd, buf, 0, buf.length, start));
            let hit = data.lastIndexOf(TURN_CONTEXT);

            while (hit !== -1) {
                const lineStart = data.lastIndexOf(0x0a, hit) + 1;

                // The row began before this window: the next, wider one reads it whole.
                if (lineStart === 0 && start > 0) {
                    break;
                }

                const lineEnd = data.indexOf(0x0a, hit);
                const row = parseTranscriptLine(
                    data.subarray(lineStart, lineEnd === -1 ? undefined : lineEnd).toString("utf8")
                );
                const payload = row?.type === "turn_context" && isObject(row.payload) ? row.payload : null;
                const cwd = text(payload?.cwd);

                if (cwd) {
                    return { cwd, capped: false };
                }

                hit = lineStart === 0 ? -1 : data.lastIndexOf(TURN_CONTEXT, lineStart - 1);
            }

            if (start === 0) {
                return { capped: false };
            }
        }

        return { capped: true };
    } finally {
        closeSync(fd);
    }
}

/** The cwd the rollout's first row (`session_meta`) names, for calls made before any `turn_context`. */
function headCwd(path: string): string | undefined {
    let fd: number;

    try {
        fd = openSync(path, "r");
    } catch {
        return undefined;
    }

    try {
        const buf = Buffer.allocUnsafe(HEAD_BYTES);
        const data = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0));
        const end = data.indexOf(0x0a);
        const row = end === -1 ? null : parseTranscriptLine(data.subarray(0, end).toString("utf8"));
        const payload = row && isObject(row.payload) ? row.payload : null;

        return text(payload?.cwd) ?? undefined;
    } finally {
        closeSync(fd);
    }
}

/** A shell call's command as one string: the script of `bash -lc <script>`, else the words joined. */
function commandText(command: unknown): string | undefined {
    if (typeof command === "string") {
        return command;
    }

    if (!Array.isArray(command) || !command.every((word) => typeof word === "string")) {
        return undefined;
    }

    const [shell, flag, script] = command;

    return SHELLS.has(shell?.split("/").pop() ?? "") && (flag === "-lc" || flag === "-c") && script !== undefined
        ? script
        : command.join(" ");
}

function argumentsOf(value: unknown): Record<string, unknown> {
    if (isObject(value)) {
        return value;
    }

    if (typeof value !== "string") {
        return {};
    }

    try {
        const parsed: unknown = SafeJSON.parse(value, { strict: true });
        return isObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Codex's `readToolCalls`: the calls a rollout gained since `fromOffset`, timed by their row's `timestamp`, in the
 * shape the shared readers of tool inputs use. A shell call (`shell`, `exec_command`) arrives as `shell` with
 * `{ command }` (the script of `bash -lc`) and runs in its `workdir`, else the latest `turn_context` cwd before it
 * (looked for before the read when the read has none yet, so an incremental read agrees with a full one), else the
 * `session_meta` cwd. An `apply_patch` arrives as one `apply_patch` call per file it names, with `{ file_path }`.
 */
export function codexToolCalls(transcriptPath: string, fromOffset: number): ToolCallsRead {
    let cwd: string | undefined;
    let recovered = false;
    const currentCwd = (lineOffset: number, issues: NativeSourceIssue[]): string | undefined => {
        if (cwd === undefined && !recovered) {
            recovered = true;
            const before = turnCwdBefore(transcriptPath, lineOffset);

            if (before.capped) {
                issues.push({
                    path: transcriptPath,
                    message: `no turn_context in the ${TURN_LOOKBACK_BYTES.at(-1)} bytes before offset ${lineOffset}; its calls take the session_meta cwd`,
                });
            }

            cwd = before.cwd ?? headCwd(transcriptPath);
        }

        return cwd;
    };

    const parse = (line: string, into: NativeToolCall[], issues: NativeSourceIssue[], lineOffset: number): void => {
        const row = parseTranscriptLine(line);
        const payload = row && isObject(row.payload) ? row.payload : null;

        if (!row || !payload) {
            issues.push({
                path: transcriptPath,
                message: `skipped a rollout line that is not a JSON row (${line.length} bytes)`,
            });
            return;
        }

        if (row.type === "turn_context") {
            cwd = text(payload.cwd) ?? cwd;
            return;
        }

        if (payload.type !== "function_call" && payload.type !== "custom_tool_call") {
            return;
        }

        const name = text(payload.name);
        const stamp = Date.parse(text(row.timestamp) ?? "");
        const at = Number.isFinite(stamp) ? { at: stamp } : {};
        const args = argumentsOf(payload.arguments ?? payload.input);
        const base = text(args.workdir) ?? currentCwd(lineOffset, issues);

        if (!name || !base) {
            return;
        }

        if (name === "shell" || name === "exec_command") {
            const command = commandText(args.command ?? args.cmd);

            if (command) {
                into.push({ tool: "shell", input: { command }, cwd: base, ...at });
            }

            return;
        }

        if (name === "apply_patch") {
            const patch = typeof payload.input === "string" ? payload.input : text(args.input);

            for (const match of (patch ?? "").matchAll(PATCH_FILE)) {
                into.push({ tool: "apply_patch", input: { file_path: match[1].trim() }, cwd: base, ...at });
            }

            return;
        }

        into.push({ tool: name, input: args, cwd: base, ...at });
    };

    return readToolCallLines({
        path: transcriptPath,
        from: fromOffset,
        markers: ['"turn_context"', '"function_call"', '"custom_tool_call"'],
        parse,
    });
}
