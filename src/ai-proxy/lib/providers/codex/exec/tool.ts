import { join } from "node:path";
import { execBashInput, parseExecBashCommand } from "@app/ai-proxy/lib/providers/codex/exec/bash-command";
import { EXEC_DESCRIPTION, EXEC_GRAMMAR } from "@app/ai-proxy/lib/providers/codex/exec/description";
import type { CustomToolMapping } from "@app/ai-proxy/lib/translators/formats/anthropic/grok-responses-to-anthropic";
import type { SessionsInConfig } from "@app/ai-proxy/lib/types";
import { isObject } from "@genesiscz/utils/object";

type JsonRecord = Record<string, unknown>;

export const EXEC_TOOL_NAME = "exec";
/** Claude Code's shell tool: an `exec` call runs as one of its calls, and only a client that has it gets `exec`. */
export const EXEC_CLIENT_TOOL = "Bash";
/** The runner, by absolute path in this checkout: the Bash command runs it wherever Claude Code's shell is. */
export const EXEC_RUNNER_PATH = join(import.meta.dir, "runner.ts");

/** Codex's `exec` as a custom (free-form) tool, the way codex-rs offers it. No `strict`: WHAM's custom tools have none. */
export function execToolDefinition(): JsonRecord {
    return {
        type: "custom",
        name: EXEC_TOOL_NAME,
        description: EXEC_DESCRIPTION,
        format: { type: "grammar", syntax: "lark", definition: EXEC_GRAMMAR },
    };
}

/** What `exec` changes in one request of a Claude Code session on a Codex model. */
export interface ExecToolBridge {
    /** The tool to append to `tools`. */
    readonly definition: JsonRecord;
    /** A Bash `tool_use` of the history as the `custom_tool_call` the model made, or undefined for any other call. */
    replayItem(toolUse: JsonRecord): JsonRecord | undefined;
    /** The model's `exec` call as the Bash call Claude Code runs: the runner, fed the script verbatim. */
    clientCall(name: string): CustomToolMapping | undefined;
}

/**
 * `exec` for a request, or undefined when the request does not get it. It depends only on the setting and on `Bash`
 * being among the client's tools, both the same on every request of a conversation: any change of `tools` reads 0%
 * of WHAM's prompt cache.
 */
export function execToolBridge({
    tools,
    sessionsIn,
    sessionId,
}: {
    tools: unknown;
    sessionsIn: SessionsInConfig | undefined;
    /** The Claude Code session, whose `store` and `load` its scripts share. */
    sessionId?: string;
}): ExecToolBridge | undefined {
    if (sessionsIn?.claude?.providers?.codex?.execTool === false) {
        return undefined;
    }

    const hasBash =
        Array.isArray(tools) &&
        tools.some((tool) => isObject(tool) && tool.name === EXEC_CLIENT_TOOL && tool.defer_loading !== true);

    if (!hasBash) {
        return undefined;
    }

    return {
        definition: execToolDefinition(),
        replayItem: (toolUse) => {
            const input = isObject(toolUse.input) ? toolUse.input : undefined;
            const js =
                toolUse.name === EXEC_CLIENT_TOOL && typeof input?.command === "string"
                    ? parseExecBashCommand(input.command)
                    : undefined;

            return js === undefined
                ? undefined
                : { type: "custom_tool_call", call_id: toolUse.id, name: EXEC_TOOL_NAME, input: js };
        },
        clientCall: (name) =>
            name === EXEC_TOOL_NAME
                ? {
                      name: EXEC_CLIENT_TOOL,
                      input: (js) => execBashInput({ js, bun: process.execPath, runner: EXEC_RUNNER_PATH, sessionId }),
                  }
                : undefined,
    };
}
