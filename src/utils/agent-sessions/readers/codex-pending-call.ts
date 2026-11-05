import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";
import { type PendingCallShape, pendingCallDetail } from "../pending-call";
import type { PendingToolCall } from "../types";

/** Codex function names by the shape of their input. */
const CODEX_CALL_SHAPES: Readonly<Record<string, PendingCallShape>> = {
    exec_command: "command",
    shell: "command",
    shell_command: "command",
    local_shell: "command",
    apply_patch: "patch",
};

/** A string literal field of a code-mode script (`cmd:"touch x"`), unescaped through JSON. */
function scriptField(script: string, field: string): string | undefined {
    const match = new RegExp(`\\b${field}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(script);

    if (!match) {
        return undefined;
    }

    const parsed = SafeJSON.parse(`"${match[1]}"`, { strict: true });
    return typeof parsed === "string" ? parsed : match[1];
}

/**
 * A code-mode `exec` call: a script that calls `tools.exec_command({ cmd, … })` or `tools.apply_patch(…)`. Measured on
 * Codex 0.166.0 (2026-11-04 15:02): an escalated command was written as `custom_tool_call` name `exec` with the input
 * `tools.exec_command({cmd:"touch codex-probe.txt",sandbox_permissions:"require_escalated",justification:"…"})`.
 */
function codeModeDetail(script: string, cwd: string | undefined): PendingToolCall["detail"] {
    const cmd = scriptField(script, "cmd");

    // Only a script that is one exec_command call (its result may be assigned) shows as that command; any other code
    // in it shows as the whole script, so an approval never hides what else would run.
    const singleCall =
        /^\s*(?:(?:const|let|var)\s+\w+\s*=\s*)?(?:await\s+)?tools\.exec_command\(\s*\{\s*(?:\w+\s*:\s*"(?:[^"\\]|\\.)*"\s*,?\s*)+\}\s*\)\s*;?\s*$/.test(
            script
        );
    const fields = [...script.matchAll(/(?:\{|,)\s*(\w+)\s*:/g)].map((match) => match[1]);
    if (singleCall && new Set(fields).size === fields.length && cmd) {
        const justification = scriptField(script, "justification");
        const workdir = scriptField(script, "workdir");
        return pendingCallDetail("command", { cmd, justification, workdir }, cwd);
    }

    return pendingCallDetail("tool", script);
}

function parsedArguments(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }

    try {
        return SafeJSON.parse(value, { strict: true });
    } catch {
        return value;
    }
}

/**
 * The newest `function_call` or `custom_tool_call` of a rollout tail that no `*_output` record answers. The folder is
 * the newest `turn_context` cwd. Codex writes the call before it asks for approval, so with an open approval this is
 * what the approval is for.
 */
export function codexPendingCall(records: readonly Record<string, unknown>[]): PendingToolCall | null {
    const open = new Map<string, PendingToolCall>();
    let cwd: string | undefined;

    for (const record of records) {
        const payload = isObject(record.payload) ? record.payload : null;

        if (!payload) {
            continue;
        }

        if (record.type === "turn_context" && typeof payload.cwd === "string") {
            cwd = payload.cwd;
            continue;
        }

        if (record.type !== "response_item" || typeof payload.call_id !== "string") {
            continue;
        }

        const at = typeof record.timestamp === "string" ? record.timestamp : undefined;
        const name = typeof payload.name === "string" ? payload.name : "tool";

        if (payload.type === "function_call") {
            open.delete(payload.call_id);
            open.set(payload.call_id, {
                callId: payload.call_id,
                tool: name,
                ...(at ? { at } : {}),
                detail: pendingCallDetail(CODEX_CALL_SHAPES[name] ?? "tool", parsedArguments(payload.arguments), cwd),
            });
        } else if (payload.type === "custom_tool_call") {
            const input = typeof payload.input === "string" ? payload.input : "";
            open.delete(payload.call_id);
            open.set(payload.call_id, {
                callId: payload.call_id,
                tool: name,
                ...(at ? { at } : {}),
                detail:
                    name === "exec"
                        ? codeModeDetail(input, cwd)
                        : pendingCallDetail(CODEX_CALL_SHAPES[name] ?? "tool", input, cwd),
            });
        } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
            open.delete(payload.call_id);
        }
    }

    return [...open.values()].at(-1) ?? null;
}
