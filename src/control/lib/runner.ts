import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";

const GT_ROOT = join(import.meta.dir, "..", "..", "..");
const BINARY_PATH = join(GT_ROOT, "native", "ax-tool", ".build", "release", "ax-tool");
const SWIFT_SOURCE = join(GT_ROOT, "native", "ax-tool");

export const RECORD_DIR = join(homedir(), ".genesis-tools", "control", "record");
export const RECORD_SESSION = join(RECORD_DIR, "session.json");
const RECORDED_COMMANDS = new Set([
    "press",
    "click",
    "set",
    "type",
    "hotkey",
    "focus",
    "scroll",
    "perform",
    "screenshot",
    "window",
]);

/** When a record-plan session is active, log action commands for plan synthesis. */
function maybeRecord(args: string[], ok: boolean): void {
    if (!existsSync(RECORD_SESSION)) {
        return;
    }
    const cmd = args[0];
    if (!cmd || !RECORDED_COMMANDS.has(cmd)) {
        return;
    }
    try {
        const session = SafeJSON.parse(readFileSync(RECORD_SESSION, "utf-8")) as { mode?: string };
        if (session.mode !== "commands" && session.mode !== "all") {
            return;
        }
        appendFileSync(join(RECORD_DIR, "commands.jsonl"), `${SafeJSON.stringify({ ts: Date.now(), ok, args })}\n`);
    } catch {
        // recording must never break the command itself
    }
}

export interface AxResult {
    ok: boolean;
    error?: string;
    [key: string]: unknown;
}

export function ensureBinary(): string {
    if (existsSync(BINARY_PATH)) {
        return BINARY_PATH;
    }

    if (existsSync(join(SWIFT_SOURCE, "Package.swift"))) {
        console.error("ax-tool: native binary not found — compiling Swift CLI (first run only, ~3s)...");
        const r = spawnSync("swift", ["build", "-c", "release"], {
            cwd: SWIFT_SOURCE,
            timeout: 120_000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        if (r.status === 0 && existsSync(BINARY_PATH)) {
            console.error("ax-tool: built successfully");
            return BINARY_PATH;
        }
        throw new Error(`ax-tool build failed (requires Swift toolchain on macOS):\n${r.stderr?.slice(0, 500)}`);
    }

    throw new Error(
        `ax-tool native binary not found at ${BINARY_PATH}.\n` +
            `Build it with: bun run build:native  (or: cd ${SWIFT_SOURCE} && swift build -c release)\n` +
            `Requires: macOS with Swift toolchain (Xcode or swift.org toolchain)`
    );
}

export function runAx(args: string[], timeoutMs = 10_000): AxResult {
    const binary = ensureBinary();

    const r = spawnSync(binary, args, {
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });

    if (r.error) {
        return { ok: false, error: `spawn error: ${r.error.message}` };
    }

    const stdout = (r.stdout ?? "").trim();
    if (!stdout) {
        maybeRecord(args, false);
        return { ok: false, error: r.stderr?.trim() || `ax-tool exited ${r.status} with no output` };
    }

    try {
        const parsed = SafeJSON.parse(stdout) as AxResult;
        maybeRecord(args, parsed.ok);
        return parsed;
    } catch {
        maybeRecord(args, false);
        return { ok: false, error: `invalid JSON: ${stdout.slice(0, 200)}` };
    }
}

export function getBinaryPath(): string {
    return BINARY_PATH;
}
