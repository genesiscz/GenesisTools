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
import { join } from "node:path";
import { harnessOf } from "./harness";

// biome-ignore lint/style/noRestrictedGlobals: standalone hook script — cannot import @app/utils/json
const SafeJSON = JSON;

/**
 * PostToolUse + SessionStart hook: the list of files this session edited.
 *
 * ⚠️ All three harnesses run this, and they name their edit tools differently. Claude sends
 * `Edit` / `Write` / `MultiEdit` with `tool_input.file_path`; Codex sends `apply_patch` and
 * `shell`; Grok sends `edit_file` / `create_file`. `EDIT_TOOLS` and `filePathOf` below are
 * the whole of that difference — everything else is shared.
 */

interface HookInput {
    session_id: string;
    hook_event_name: string;
    tool_name?: string;
    transcript_path?: string;
    tool_input?: {
        file_path?: string;
        /** Codex `apply_patch`, Grok `edit_file` / `create_file`. */
        path?: string;
        filePath?: string;
    };
    tool_response?: {
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
 * ⚠️ Only the Claude names are VERIFIED (they are the ones `hooks.json` matches on). The
 * others are candidates read off Codex rollouts and Grok transcripts, where the item type is
 * not necessarily the hook's `tool_name`. `recordUnknownTool` below is what settles it: every
 * unrecognised PostToolUse name is tallied to `hook-tool-names.json`, so one real edit in a
 * harness names its tool permanently. Move a name up here once the tally shows it.
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
        const seen: Record<string, number> = existsSync(path)
            ? (SafeJSON.parse(readFileSync(path, "utf-8")) as Record<string, number>)
            : {};
        const key = `${harness}:${toolName}`;

        if (seen[key] === undefined && Object.keys(seen).length >= MAX_TOOL_NAMES) {
            return;
        }

        seen[key] = (seen[key] ?? 0) + 1;
        writeFileSync(path, SafeJSON.stringify(seen, null, 2));
    } catch {
        // A vocabulary note is never worth failing a tool call over.
    }
}

/** The path an edit tool names, in whichever field its harness puts it. */
function filePathOf(input: HookInput): string | undefined {
    return (
        input.tool_input?.file_path ??
        input.tool_input?.path ??
        input.tool_input?.filePath ??
        input.tool_response?.filePath ??
        input.tool_response?.path
    );
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

    // On SessionStart, output session ID and clean up old sessions
    if (hook_event_name === "SessionStart") {
        console.log(
            SafeJSON.stringify({
                hookSpecificOutput: {
                    hookEventName: "SessionStart",
                    additionalContext: `📌 Session ID: ${session_id}\n\n**Modified files tracking:** All files you modify are tracked in ~/.genesis-tools/claude-code/sessions/${session_id}.json`,
                },
            })
        );
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

        const filePath = filePathOf(input);
        if (!filePath) {
            process.exit(0);
        }

        // Skip if write failed
        if (tool_response && tool_response.success === false) {
            process.exit(0);
        }

        trackFile(session_id, filePath);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error(`[track-session-files hook] Unexpected error:`, err);
    process.exit(1);
});
