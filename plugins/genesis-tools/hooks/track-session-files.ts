#!/usr/bin/env bun
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
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
 * `Edit` / `Write` / `MultiEdit` with `tool_input.file_path`; Codex sends `apply_patch`.
 * Grok 1.0.44 sends `search_replace` and `write` (tool-name tally, 2026-09-29). Its envelope
 * is camelCase (`sessionId`, `toolName`, `toolInput`) and also carries Claude's snake aliases.
 * `normalize` folds those into the snake fields the rest of this file already reads.
 */

interface ToolBody {
    file_path?: string;
    /** Codex `apply_patch`, and some edit tools, name the file here instead of `file_path`. */
    path?: string;
    filePath?: string;
    command?: string;
}

interface HookInput {
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
};

function normalize(input: HookInput): HookInput {
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
const EDIT_TOOLS = new Set([
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
 *
 * Grok 1.0.44's installed guide says SessionStart stdout is ignored. Rechecked 2026-09-29: the
 * sentence is in that binary, and a 1.0.44 system prompt did not contain this line. Codex 0.155
 * still takes `additionalContext` as developer context. Claude does too.
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
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 1000;

function ensureDir() {
    if (!existsSync(STORAGE_DIR)) {
        mkdirSync(STORAGE_DIR, { recursive: true });
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function withBoundedLock<T>(lockPath: string, fn: () => T | Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
    const deadline = Date.now() + waitMs;

    while (true) {
        try {
            const fd = openSync(lockPath, "wx", 0o600);
            writeFileSync(fd, SafeJSON.stringify({ pid: process.pid, at: Date.now() }));
            closeSync(fd);
            break;
        } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
            if (code !== "EEXIST") {
                throw error;
            }

            try {
                const holder: unknown = SafeJSON.parse(readFileSync(lockPath, "utf8"));
                const pid =
                    holder && typeof holder === "object" && "pid" in holder && typeof holder.pid === "number"
                        ? holder.pid
                        : 0;
                const age = Date.now() - statSync(lockPath).mtimeMs;
                if (age > LOCK_STALE_MS || (pid > 0 && !processIsAlive(pid))) {
                    unlinkSync(lockPath);
                    continue;
                }
            } catch {
                try {
                    if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
                        unlinkSync(lockPath);
                        continue;
                    }
                } catch {
                    continue;
                }
            }

            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for session tracker lock: ${lockPath}`);
            }

            await Bun.sleep(20);
        }
    }

    try {
        return await fn();
    } finally {
        try {
            const holder: unknown = SafeJSON.parse(readFileSync(lockPath, "utf8"));
            if (holder && typeof holder === "object" && "pid" in holder && holder.pid === process.pid) {
                unlinkSync(lockPath);
            }
        } catch {
            // A stale-lock recovery may already have replaced it; never remove another owner's lock.
        }
    }
}

async function cleanupOldSessions() {
    if (!existsSync(STORAGE_DIR)) {
        return;
    }

    const stamp = join(STORAGE_DIR, ".cleanup-stamp");
    if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < CLEANUP_INTERVAL_MS) {
        return;
    }

    try {
        await withBoundedLock(
            `${stamp}.lock`,
            () => {
                if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < CLEANUP_INTERVAL_MS) {
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
                    } catch (error) {
                        console.warn(`[track-session-files] Failed to inspect cleanup candidate: ${filePath}`, error);
                    }
                }

                writeFileSync(stamp, new Date().toISOString());
            },
            0
        );
    } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Timed out waiting for session tracker lock:")) {
            console.warn("[track-session-files] Session cleanup failed", error);
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

async function trackFile(sessionId: string, filePath: string) {
    ensureDir();

    const sessionFile = join(STORAGE_DIR, `${sessionId}.json`);
    await withBoundedLock(`${sessionFile}.lock`, () => {
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

        // Atomic write: write to temp file then rename (avoids torn JSON).
        const tempFile = `${sessionFile}.tmp.${process.pid}`;
        writeFileSync(tempFile, SafeJSON.stringify(sessionData, null, 2));
        renameSync(tempFile, sessionFile);
    });
}

async function main() {
    const input = normalize(SafeJSON.parse(await Bun.stdin.text()) as HookInput);
    const { session_id, hook_event_name, tool_response } = input;

    if (!session_id) {
        process.exit(0);
    }

    // On SessionStart, output session ID and clean up old sessions.
    if (hook_event_name === "SessionStart") {
        console.log(SafeJSON.stringify({ hookSpecificOutput: sessionStartOutput(input) }));
        await cleanupOldSessions();
        process.exit(0);
    }

    // The matcher narrows all three harnesses. The payload still uses the harness's own
    // tool name, so the set above decides what is recorded. Codex 0.155 reports `apply_patch`
    // for a call the matcher accepted as Edit|Write. Grok 1.0.44 maps Edit|Write|MultiEdit
    // onto `search_replace` and also delivered `write`; the tool-name tally that day held
    // only those two Grok names, so the other tools were filtered out.
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
            await trackFile(session_id, filePath);
        }
    }

    process.exit(0);
}

main().catch((err) => {
    console.error(`[track-session-files hook] Unexpected error:`, err);
    process.exit(1);
});
