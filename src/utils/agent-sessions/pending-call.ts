import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";
import type { PendingCallDetail, PendingCallFileChange } from "./types";

/**
 * Provider-neutral shapes of a pending call's input (`NativeSessionReader.dialog.pendingCall`). Each reader decides
 * which shape its own tool names have (Claude `Bash`, Grok `run_terminal_command`, Codex `exec_command`) and hands
 * the parsed input here, so this file names no harness tool and no record field of a transcript format.
 */
export type PendingCallShape = "command" | "replace" | "write" | "plan" | "patch" | "tool";

/** A detail text longer than this is cut, with a marker that says how much was left out. */
const DETAIL_MAX_CHARS = 8000;

function cut(text: string): string {
    return text.length <= DETAIL_MAX_CHARS
        ? text
        : `${text.slice(0, DETAIL_MAX_CHARS)}\n… (${text.length - DETAIL_MAX_CHARS} more characters)`;
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = input[key];

        if (typeof value === "string" && value !== "") {
            return value;
        }

        if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) {
            return value.join(" ");
        }
    }

    return undefined;
}

function prefixed(text: string, mark: "-" | "+"): string[] {
    return text === "" ? [] : text.split("\n").map((line) => `${mark}${line}`);
}

function replacement(input: Record<string, unknown>): string {
    return [...prefixed(String(input.old_string ?? ""), "-"), ...prefixed(String(input.new_string ?? ""), "+")].join(
        "\n"
    );
}

/** `*** Add File:`, `*** Update File:`, `*** Delete File:` sections of a patch, each as one change with its lines. */
export function patchChanges(patch: string): PendingCallFileChange[] {
    const changes: PendingCallFileChange[] = [];
    let current: { path: string; lines: string[] } | null = null;

    for (const line of patch.split("\n")) {
        const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);

        if (header) {
            if (current) {
                changes.push({ path: current.path, diff: cut(current.lines.join("\n")) });
            }

            current = { path: header[1].trim(), lines: [] };
        } else if (current && !line.startsWith("*** ")) {
            current.lines.push(line);
        }
    }

    if (current) {
        changes.push({ path: current.path, diff: cut(current.lines.join("\n")) });
    }

    return changes;
}

function toolInput(input: unknown): string {
    return cut(typeof input === "string" ? input : (SafeJSON.stringify(input) ?? ""));
}

/**
 * The normalized detail of one pending call. `cwd` is the folder the transcript says the session runs in, used when
 * the command input names none. An input that does not fit its shape falls back to the raw tool input, so the user
 * still sees exactly what the agent asked.
 */
export function pendingCallDetail(shape: PendingCallShape, input: unknown, cwd?: string): PendingCallDetail {
    if (shape === "patch" && typeof input === "string") {
        const changes = patchChanges(input);
        return changes.length > 0 ? { kind: "file-change", changes } : { kind: "tool", input: toolInput(input) };
    }

    if (!isObject(input)) {
        return { kind: "tool", input: toolInput(input) };
    }

    if (shape === "command") {
        const command = stringField(input, "command", "cmd");

        if (command) {
            const folder = stringField(input, "workdir", "cwd") ?? cwd;
            const description = stringField(input, "description", "justification");
            return {
                kind: "command",
                command: cut(command),
                ...(folder ? { cwd: folder } : {}),
                ...(description ? { description } : {}),
            };
        }
    }

    if (shape === "replace") {
        const path = stringField(input, "file_path", "path");
        const edits = Array.isArray(input.edits) ? input.edits.filter(isObject) : null;

        if (path && edits && edits.length > 0) {
            return { kind: "file-change", changes: [{ path, diff: cut(edits.map(replacement).join("\n…\n")) }] };
        }

        if (path) {
            return { kind: "file-change", changes: [{ path, diff: cut(replacement(input)) }] };
        }
    }

    if (shape === "write") {
        const path = stringField(input, "file_path", "path");

        if (path) {
            return { kind: "file-change", changes: [{ path, content: cut(String(input.content ?? "")) }] };
        }
    }

    if (shape === "plan") {
        const plan = stringField(input, "plan");

        if (plan) {
            return { kind: "plan", plan: cut(plan) };
        }
    }

    return { kind: "tool", input: toolInput(input) };
}
