#!/usr/bin/env bun
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { harnessOf } from "./harness";

const SafeJSON = JSON;

/**
 * PostToolUse + SessionStart hook: the list of files this session edited.
 *
 * ⚠️ All three harnesses run this, and they name their edit tools differently. Claude sends
 * `Edit` / `Write` / `MultiEdit` with `tool_input.file_path`; Codex sends `apply_patch` and
 * `shell`; Grok sends `edit_file` / `create_file`. `EDIT_TOOLS` and `filePathsOf` below are
 * the whole of that difference — everything else is shared.
 */

interface HookInput {
    session_id: string;
    hook_event_name: string;
    tool_name?: string;
    transcript_path?: string;
    /** Where the tool ran; an apply_patch path is relative to it. */
    cwd?: string;
    tool_input?: {
        file_path?: string;
        /** Codex `apply_patch`, Grok `edit_file` / `create_file`. */
        path?: string;
        filePath?: string;
        command?: string;
    };
    tool_response?:
        | string
        | {
              success?: boolean;
              filePath?: string;
              path?: string;
          };
}

/**
 * Edit-tool names across the three harnesses. A name this does not know is simply not
 * tracked; the hook never guesses from arguments, because a shell call that happens to carry
 * a path is usually reading it.
 *
 * Codex 0.154 keeps `apply_patch` as the payload name but exposes `Write` and `Edit` as matcher
 * aliases, so the Claude-shaped matcher selects this hook without running it for every tool.
 * Codex carries every affected path inside `tool_input.command`; `filePathsOf` parses that patch.
 * Unknown names are still tallied so later harness vocabulary changes remain observable.
 */
const EDIT_TOOLS = new Set([
    // Claude Code — verified, and the matcher in hooks.json uses the first three.
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    // Codex — candidates.
    "apply_patch",
    "edit_file",
    // Grok — candidates.
    "create_file",
    "write_file",
    "str_replace",
]);

/** At most this many distinct names are tallied; a runaway must not grow the file forever. */
const MAX_TOOL_NAMES = 60;

/**
 * Tally a PostToolUse name this hook does not recognise, so the unknown becomes knowable.
 *
 * Name and harness only, never arguments: this file is a vocabulary, not a transcript. It is
 * how the Codex and Grok candidates above get confirmed or replaced without another round of
 * guessing.
 */
function recordUnknownTool(harness: string, toolName: string): void {
    const path = join(HOME, ".genesis-tools", "claude-code", "hook-tool-names.json");

    try {
        ensureDir();
        let seen: Record<string, number> = {};

        if (existsSync(path)) {
            try {
                const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf-8"));

                // A parse that SUCCEEDS with the wrong shape (null, a string, an array) is not
                // caught by the `catch` below, and reading it as `Record<string, number>` threw
                // further down — landing in the outer `catch {}` with nothing logged, on every
                // later run, exactly the "dead forever" failure this recovery exists to remove.
                if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                    seen = parsed as Record<string, number>;
                } else {
                    console.warn(`[track-session-files] Tool-name tally was not an object, recreating: ${path}`);
                }
            } catch (err) {
                // A torn file used to kill this tally FOREVER: the parse threw on every later
                // run and the outer catch swallowed it, with nothing in any log. Start again
                // rather than stay dead — the whole point of the file is to replace guesswork.
                console.warn(`[track-session-files] Corrupted tool-name tally, recreating: ${path}`, err);
            }
        }

        const key = `${harness}:${toolName}`;

        if (seen[key] === undefined && Object.keys(seen).length >= MAX_TOOL_NAMES) {
            return;
        }

        seen[key] = (seen[key] ?? 0) + 1;
        // Temp-then-rename, the way `trackFile` below already writes: a hook killed mid-write
        // (they have timeouts) leaves the rename never reached rather than a truncated file this
        // could not recover from. It does NOT serialize concurrent hooks' read-modify-write —
        // two PostToolUse calls that overlap can still both read the same count and one
        // increment is lost. Left as-is: this file is a vocabulary, not a ledger, and a slightly
        // undercounted tool name is still enough to notice it exists.
        const tempFile = `${path}.tmp.${process.pid}`;
        writeFileSync(tempFile, SafeJSON.stringify(seen, null, 2));
        renameSync(tempFile, path);
    } catch {
        // A vocabulary note is never worth failing a tool call over.
    }
}

/**
 * What SessionStart tells the model, which is not the same sentence on every harness.
 *
 * 🛑 A SessionStart `additionalContext` reaches Codex as a DEVELOPER message, which outranks
 * AGENTS.md. Promising "all files you modify are tracked" remains false outside Claude: Codex
 * `apply_patch` calls are tracked, but shell commands can also modify files without hitting this
 * edit-only matcher. Codex and Grok transcripts remain the complete record consumed by
 * `tools codex history` / `tools grok history`. So say the session id and stop.
 */
function sessionStartOutput(input: HookInput): { hookEventName: string; additionalContext: string } {
    const tracked =
        harnessOf(input) === "claude"
            ? `\n\n**Modified files tracking:** All files you modify are tracked in ~/.genesis-tools/claude-code/sessions/${input.session_id}.json`
            : "";

    return { hookEventName: "SessionStart", additionalContext: `📌 Session ID: ${input.session_id}${tracked}` };
}

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
function filePathsOf(input: HookInput): string[] {
    const response = typeof input.tool_response === "object" ? input.tool_response : undefined;
    const explicitPath =
        input.tool_input?.file_path ??
        input.tool_input?.path ??
        input.tool_input?.filePath ??
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
function writeFailed(response: HookInput["tool_response"]): boolean {
    if (typeof response === "string") {
        const exitCode = /^Exit code: (\d+)/.exec(response);

        return exitCode !== null && exitCode[1] !== "0";
    }

    return response?.success === false;
}

interface SessionData {
    session_id: string;
    started_at: string;
    last_updated: string;
    files: string[];
}

// Standalone hook script: no access to @genesiscz/utils/env, so process.env directly. The
// same override the other two hooks honour, so a test can redirect all three together.
const HOME = process.env.GENESIS_TOOLS_HOME || homedir();
const STORAGE_DIR = join(HOME, ".genesis-tools", "claude-code", "sessions");
const CLEANUP_DAYS = 30;

function ensureDir() {
    if (!existsSync(STORAGE_DIR)) {
        mkdirSync(STORAGE_DIR, { recursive: true });
    }
}

function cleanupOldSessions() {
    if (!existsSync(STORAGE_DIR)) {
        return;
    }

    const cutoff = Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000;
    const files = readdirSync(STORAGE_DIR);

    for (const file of files) {
        if (!file.endsWith(".json")) {
            continue;
        }
        const filePath = join(STORAGE_DIR, file);
        try {
            const stats = statSync(filePath);
            if (stats.mtimeMs < cutoff) {
                unlinkSync(filePath);
            }
        } catch {
            // Ignore transient fs errors (file deleted, permissions changed, etc.)
        }
    }
}

function createFreshSessionData(sessionId: string): SessionData {
    return {
        session_id: sessionId,
        started_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        files: [],
    };
}

function trackFile(sessionId: string, filePath: string) {
    ensureDir();

    const sessionFile = join(STORAGE_DIR, `${sessionId}.json`);

    let sessionData: SessionData;
    if (existsSync(sessionFile)) {
        try {
            sessionData = SafeJSON.parse(readFileSync(sessionFile, "utf-8")) as SessionData;
        } catch (_err) {
            // Corrupted JSON - backup and recreate
            console.warn(`[track-session-files] Corrupted session file, recreating: ${sessionFile}`);
            try {
                renameSync(sessionFile, `${sessionFile}.bak`);
            } catch {
                // Ignore backup failure
            }
            sessionData = createFreshSessionData(sessionId);
        }
    } else {
        sessionData = createFreshSessionData(sessionId);
    }

    // Add file if not already tracked
    if (!sessionData.files.includes(filePath)) {
        sessionData.files.push(filePath);
    }
    sessionData.last_updated = new Date().toISOString();

    // Atomic write: write to temp file then rename (avoids race conditions)
    const tempFile = `${sessionFile}.tmp.${Date.now()}`;
    writeFileSync(tempFile, SafeJSON.stringify(sessionData, null, 2));
    renameSync(tempFile, sessionFile);
}

async function main() {
    const input: HookInput = SafeJSON.parse(await Bun.stdin.text()) as HookInput;
    const { session_id, hook_event_name, tool_response } = input;

    // On SessionStart, output session ID and clean up old sessions.
    if (hook_event_name === "SessionStart") {
        console.log(SafeJSON.stringify({ hookSpecificOutput: sessionStartOutput(input) }));
        cleanupOldSessions();
        process.exit(0);
    }

    // For PostToolUse, track the file. The matcher in hooks.json narrows this for Claude;
    // Codex and Grok deliver every tool call, so the name is checked here too.
    if (hook_event_name === "PostToolUse") {
        const toolName = input.tool_name;

        if (!toolName) {
            process.exit(0);
        }

        if (!EDIT_TOOLS.has(toolName)) {
            recordUnknownTool(harnessOf(input), toolName);
            process.exit(0);
        }

        if (writeFailed(tool_response)) {
            process.exit(0);
        }

        const filePaths = filePathsOf(input);
        if (filePaths.length === 0) {
            process.exit(0);
        }

        for (const filePath of filePaths) {
            trackFile(session_id, filePath);
        }
    }

    process.exit(0);
}

main().catch((err) => {
    console.error(`[track-session-files hook] Unexpected error:`, err);
    process.exit(1);
});
