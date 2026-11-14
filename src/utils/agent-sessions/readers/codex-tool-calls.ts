import { closeSync, openSync, readSync } from "node:fs";
import { parseTranscriptLine } from "@genesiscz/utils/ai/transcripts/parse-line";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";
import { nonEmptyString as text } from "@genesiscz/utils/string";
import type { NativeSourceIssue, NativeToolCall, ToolCallsRead } from "../types";
import { readToolCallLines } from "./tool-calls";

/** A rollout's first row (`session_meta`) carries the base instructions too, so its cwd is looked for this far. */
const HEAD_BYTES = 256 * 1024;
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const SHELLS = new Set(["bash", "zsh", "sh"]);

/** The cwd the rollout's first row (`session_meta`) names, for calls made before any `turn_context` in a read. */
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
 * `{ command }` (the script of `bash -lc`) and runs in its `workdir`, else the latest `turn_context` cwd, else the
 * `session_meta` cwd. An `apply_patch` arrives as one `apply_patch` call per file it names, with `{ file_path }`.
 */
export function codexToolCalls(transcriptPath: string, fromOffset: number): ToolCallsRead {
    let cwd: string | undefined;
    let headRead = false;
    const currentCwd = (): string | undefined => {
        if (cwd === undefined && !headRead) {
            headRead = true;
            cwd = headCwd(transcriptPath);
        }

        return cwd;
    };

    const parse = (line: string, into: NativeToolCall[], issues: NativeSourceIssue[]): void => {
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
        const base = text(args.workdir) ?? currentCwd();

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
