/**
 * The hook envelope of the three harnesses, and the files an edit tool names in it.
 *
 * Shared by `track-session-files.ts` (the session's edit list) and `worktree-lock.ts` (the
 * worktrees a session works in), so both read the same paths from the same tool names.
 */
import { isAbsolute, resolve } from "node:path";

interface ToolBody {
    file_path?: string;
    /** Codex `apply_patch`, and some edit tools, name the file here instead of `file_path`. */
    path?: string;
    filePath?: string;
    /** Claude's NotebookEdit. */
    notebook_path?: string;
    command?: string;
}

export interface HookInput {
    session_id?: string;
    sessionId?: string;
    hook_event_name?: string;
    /** Grok's own event name, snake_case (`post_tool_use`). `hook_event_name` is PascalCase. */
    hookEventName?: string;
    tool_name?: string;
    toolName?: string;
    transcript_path?: string;
    transcriptPath?: string;
    /** Where the tool ran; an apply_patch path is relative to it. */
    cwd?: string;
    tool_input?: ToolBody;
    toolInput?: ToolBody;
    tool_response?:
        | string
        | {
              success?: boolean;
              filePath?: string;
              path?: string;
          };
    /** Grok's name for `tool_response`. The snake alias is a copy; either one is enough. */
    toolResult?: HookInput["tool_response"];
}

const GROK_EVENT_NAMES: Record<string, string> = {
    session_start: "SessionStart",
    post_tool_use: "PostToolUse",
    session_end: "SessionEnd",
};

export function normalize(input: HookInput): HookInput {
    const grokEvent = input.hookEventName ? GROK_EVENT_NAMES[input.hookEventName] : undefined;
    // The payload is untrusted JSON: a non-string id must become "" (skipped), never a fake id.
    const rawSessionId: unknown = input.session_id ?? input.sessionId;

    return {
        ...input,
        session_id: typeof rawSessionId === "string" ? rawSessionId.trim() : "",
        hook_event_name: input.hook_event_name || grokEvent || "",
        tool_name: input.tool_name ?? input.toolName,
        transcript_path: input.transcript_path ?? input.transcriptPath,
        tool_input: input.tool_input ?? input.toolInput,
        tool_response: input.tool_response ?? input.toolResult,
    };
}

/**
 * Edit-tool names across the three harnesses. A name this does not know is simply not
 * tracked; the hook never guesses from arguments, because a shell call that happens to carry
 * a path is usually reading it.
 *
 * Codex 0.155 keeps `apply_patch` as the payload name and matches it as `apply_patch`, `Edit`,
 * or `Write`, so the Claude-shaped matcher selects this hook without running it for every tool.
 * Rechecked 2026-09-29: current Codex hook docs still say that, and two sessions that day left
 * tracked files. The installed binary's schema names `tool_name` as a string, not the alias.
 * Codex carries every affected path inside `tool_input.command`; `filePathsOf` parses that patch.
 * Unknown names are still tallied so later harness vocabulary changes remain observable.
 */
export const EDIT_TOOLS = new Set([
    // Claude Code — verified, and the matcher in hooks.json uses the first three.
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    // Codex — candidates.
    "apply_patch",
    "edit_file",
    // Grok 1.0.44 sends `search_replace` and `write` (tool-name tally, 2026-09-29).
    // The others stay so an older build that still uses them keeps tracking.
    "search_replace",
    "write",
    "create_file",
    "write_file",
    "str_replace",
]);

function applyPatchFilePaths(command: string): string[] {
    const paths = new Set<string>();

    for (const line of command.split(/\r?\n/)) {
        const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line);
        const path = match?.[1]?.trim();

        if (path) {
            paths.add(path);
        }
    }

    return [...paths];
}

/**
 * Every path an edit tool names, in whichever field its harness puts it, made absolute against
 * the payload's `cwd`. Claude sends an absolute `file_path`; an apply_patch path is relative to
 * where Codex ran, and a bare `src/a.ts` beside absolute entries names nothing. A payload with
 * no `cwd` keeps the path as given rather than guessing from this process's directory.
 */
export function filePathsOf(input: HookInput): string[] {
    const response = typeof input.tool_response === "object" ? input.tool_response : undefined;
    const explicitPath =
        input.tool_input?.file_path ??
        input.tool_input?.path ??
        input.tool_input?.filePath ??
        input.tool_input?.notebook_path ??
        response?.filePath ??
        response?.path;
    let named: string[] = [];

    if (explicitPath) {
        named = [explicitPath];
    } else if (input.tool_name === "apply_patch" && typeof input.tool_input?.command === "string") {
        named = applyPatchFilePaths(input.tool_input.command);
    }

    const cwd = input.cwd;

    return cwd ? named.map((path) => (isAbsolute(path) ? path : resolve(cwd, path))) : named;
}

/**
 * Whether the edit did not happen. An object response says so in `success`; Codex's string
 * response leads with the patch's exit code, and a rejected patch touched nothing.
 */
export function writeFailed(response: HookInput["tool_response"]): boolean {
    if (typeof response === "string") {
        const exitCode = /^Exit code: (\d+)/.exec(response);

        return exitCode !== null && exitCode[1] !== "0";
    }

    return response?.success === false;
}
