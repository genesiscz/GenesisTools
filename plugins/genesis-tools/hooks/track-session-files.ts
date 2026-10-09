#!/usr/bin/env bun
import { dlopen, FFIType } from "bun:ffi";
import {
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
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
        // Temp-then-rename, the way `recordFiles` below already writes: a hook killed mid-write
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
const LOCK_RETRY_MS = 100;
const LOCK_EX = 2;
const LOCK_NB = 4;

/** The edit cannot take the session lock (deadline, or no kernel lock here), so it is spooled. */
class LockNotTaken extends Error {}

/**
 * How long an edit waits for the session lock before it is spooled instead. It was 1 s, and twelve
 * hooks racing on a loaded 4-core CI runner outlasted that: the loser threw, exited 1 and its edit
 * was never written. A command hook may run for 60 s, so 10 s costs nothing in the normal case.
 * `GENESIS_TOOLS_SESSION_LOCK_WAIT_MS` lets a test reach the deadline without waiting for it.
 */
function lockWaitMs(): number {
    const override = Number(process.env.GENESIS_TOOLS_SESSION_LOCK_WAIT_MS);

    return Number.isFinite(override) && override >= 0 ? override : 10_000;
}

function ensureDir() {
    if (!existsSync(STORAGE_DIR)) {
        mkdirSync(STORAGE_DIR, { recursive: true });
    }
}

function errorCode(error: unknown): unknown {
    return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

type Flock = (fd: number, operation: number) => number;
let loadedFlock: Flock | null | undefined;

/**
 * The session lock is a kernel `flock`. The kernel drops it the moment its holder exits, however it
 * exits, so there is no stale lock to detect and nothing to break. The pid-in-a-file lock it replaces
 * needed a recovery step, and each recovery step was itself a check-then-unlink that a paused or
 * killed recoverer could race into removing a live lock (PR #480 review, threads t10 and t11).
 * Elsewhere (no libc to load) the edit is spooled, which loses nothing.
 */
function loadFlock(): Flock | null {
    if (loadedFlock !== undefined) {
        return loadedFlock;
    }

    loadedFlock = null;
    const library =
        process.platform === "darwin" ? "libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : null;
    if (!library) {
        return null;
    }

    try {
        const { symbols } = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
        loadedFlock = (fd, operation) => symbols.flock(fd, operation);
    } catch (error) {
        console.warn(`[track-session-files] flock is unavailable from ${library}; edits will be spooled`, error);
    }

    return loadedFlock;
}

/** Cleanup may unlink an idle lock file between our open and our flock; a lock on that orphan guards nothing. */
function isCurrentFile(fd: number, path: string): boolean {
    try {
        const held = fstatSync(fd);
        const named = statSync(path);

        return held.ino === named.ino && held.dev === named.dev;
    } catch {
        return false;
    }
}

async function withBoundedLock<T>(lockPath: string, fn: () => T | Promise<T>, waitMs: number): Promise<T> {
    const flock = loadFlock();
    if (!flock) {
        throw new LockNotTaken(`No kernel file lock on ${process.platform}: ${lockPath}`);
    }

    const deadline = Date.now() + waitMs;
    let fd = openSync(lockPath, "a", 0o600);
    try {
        while (true) {
            if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
                if (isCurrentFile(fd, lockPath)) {
                    break;
                }

                closeSync(fd);
                fd = -1;
                fd = openSync(lockPath, "a", 0o600);
                continue;
            }

            if (Date.now() >= deadline) {
                throw new LockNotTaken(`Timed out waiting for session tracker lock: ${lockPath}`);
            }

            await Bun.sleep(Math.min(LOCK_RETRY_MS, Math.max(0, deadline - Date.now())));
        }

        return await fn();
    } finally {
        if (fd >= 0) {
            // Closing the descriptor is what releases the flock.
            closeSync(fd);
        }
    }
}

/** Removes a file or empty directory that a concurrent hook or cleanup may already have removed. */
function removeIfPresent(path: string, kind: "file" | "emptyDir" = "file"): void {
    try {
        if (kind === "file") {
            unlinkSync(path);
        } else {
            rmdirSync(path);
        }
    } catch (error) {
        const code = errorCode(error);
        // ENOTEMPTY / EEXIST: a spool writer just added an entry, so the directory is in use again.
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
            throw error;
        }
    }
}

/** Drops spooled edits past the retention window, then the directory if nothing is left in it. */
function pruneSpool(dir: string, cutoff: number): void {
    for (const name of readdirSync(dir)) {
        const entry = join(dir, name);
        try {
            if (statSync(entry).mtimeMs < cutoff) {
                removeIfPresent(entry);
            }
        } catch (error) {
            console.warn(`[track-session-files] Failed to inspect spooled edit: ${entry}`, error);
        }
    }

    removeIfPresent(dir, "emptyDir");
}

/** Removes an expired lock file only while holding it, so no live holder ever loses its lock. */
function pruneLockFile(lockPath: string, cutoff: number): void {
    const flock = loadFlock();
    if (!flock || statSync(lockPath).mtimeMs >= cutoff) {
        return;
    }

    const fd = openSync(lockPath, "a", 0o600);
    try {
        if (flock(fd, LOCK_EX | LOCK_NB) === 0 && isCurrentFile(fd, lockPath)) {
            unlinkSync(lockPath);
        }
    } finally {
        closeSync(fd);
    }
}

/** Leftovers of the pid-in-a-file lock this hook used before the flock; nothing reads them now. */
const LEGACY_LOCK_SUFFIXES = [".json.lock", ".json.lock.takeover"];

function cleanupEntry(entry: string, cutoff: number): void {
    if (entry.endsWith(".json.pending")) {
        pruneSpool(entry, cutoff);
        return;
    }

    if (entry.endsWith(".json.flock")) {
        pruneLockFile(entry, cutoff);
        return;
    }

    if (
        (entry.endsWith(".json") || LEGACY_LOCK_SUFFIXES.some((suffix) => entry.endsWith(suffix))) &&
        statSync(entry).mtimeMs < cutoff
    ) {
        removeIfPresent(entry);
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
            `${stamp}.flock`,
            () => {
                if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < CLEANUP_INTERVAL_MS) {
                    return;
                }

                const cutoff = Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000;
                for (const name of readdirSync(STORAGE_DIR)) {
                    const entry = join(STORAGE_DIR, name);
                    try {
                        cleanupEntry(entry, cutoff);
                    } catch (error) {
                        console.warn(`[track-session-files] Failed to inspect cleanup candidate: ${entry}`, error);
                    }
                }

                writeFileSync(stamp, new Date().toISOString());
            },
            0
        );
    } catch (error) {
        if (!(error instanceof LockNotTaken)) {
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

/**
 * Edits that could not get the lock before the deadline. Each spool file has a unique name and is
 * renamed into place whole, so writing one needs no lock; the next lock holder merges them.
 */
function spoolEdits(sessionFile: string, filePaths: string[]): void {
    const dir = `${sessionFile}.pending`;
    const name = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const draft = join(dir, `.${name}.draft`);

    // A merge or cleanup removes the directory once it is empty, possibly between our mkdir and our
    // write. After the write it holds our draft, so it cannot be removed before the rename.
    for (let attempt = 1; ; attempt++) {
        mkdirSync(dir, { recursive: true });
        try {
            writeFileSync(draft, SafeJSON.stringify(filePaths));
            break;
        } catch (error) {
            if (errorCode(error) !== "ENOENT" || attempt >= 3) {
                throw error;
            }
        }
    }

    renameSync(draft, join(dir, `${name}.json`));
}

function readSpool(sessionFile: string): { filePaths: string[]; spoolFiles: string[] } {
    const dir = `${sessionFile}.pending`;
    const filePaths: string[] = [];
    const spoolFiles: string[] = [];
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return { filePaths, spoolFiles };
    }

    for (const name of names) {
        if (!name.endsWith(".json")) {
            continue;
        }

        const spoolFile = join(dir, name);
        try {
            const parsed: unknown = SafeJSON.parse(readFileSync(spoolFile, "utf8"));
            if (Array.isArray(parsed)) {
                filePaths.push(...parsed.filter((path): path is string => typeof path === "string"));
                spoolFiles.push(spoolFile);
            }
        } catch (error) {
            console.warn(`[track-session-files] Unreadable spooled edit, left in place: ${spoolFile}`, error);
        }
    }

    return { filePaths, spoolFiles };
}

async function trackFiles(sessionId: string, filePaths: string[]) {
    ensureDir();

    const sessionFile = join(STORAGE_DIR, `${sessionId}.json`);
    try {
        await withBoundedLock(
            `${sessionFile}.flock`,
            () => recordFiles(sessionId, sessionFile, filePaths),
            lockWaitMs()
        );
    } catch (error) {
        if (!(error instanceof LockNotTaken)) {
            throw error;
        }

        spoolEdits(sessionFile, filePaths);
        console.warn(`[track-session-files] ${error.message}; edit spooled for the next holder`);
    }
}

function recordFiles(sessionId: string, sessionFile: string, filePaths: string[]) {
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

    const spool = readSpool(sessionFile);
    for (const filePath of [...spool.filePaths, ...filePaths]) {
        if (!sessionData.files.includes(filePath)) {
            sessionData.files.push(filePath);
        }
    }
    sessionData.last_updated = new Date().toISOString();

    // Atomic write: write to temp file then rename (avoids torn JSON).
    const tempFile = `${sessionFile}.tmp.${process.pid}`;
    writeFileSync(tempFile, SafeJSON.stringify(sessionData, null, 2));
    renameSync(tempFile, sessionFile);

    // Only after the session file holds them; a crash before this merges them again, harmlessly.
    for (const spoolFile of spool.spoolFiles) {
        removeIfPresent(spoolFile);
    }

    if (spool.spoolFiles.length > 0) {
        removeIfPresent(`${sessionFile}.pending`, "emptyDir");
    }
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

        await trackFiles(session_id, filePaths);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error(`[track-session-files hook] Unexpected error:`, err);
    process.exit(1);
});
