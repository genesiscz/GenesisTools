import { spawnSync } from "node:child_process";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";

export function ensureMacOS(): void {
    if (process.platform !== "darwin") {
        throw new Error("This feature is only available on macOS");
    }
}

/** Drives real applications through osascript (Notes, Reminders, Finder, System Settings), so a test is refused. */
export function runJxa(script: string, timeout = 15_000): string {
    refuseHostEffectInTest("runJxa", "Fake the script result; do not drive a real application.");
    const proc = spawnSync("osascript", ["-l", "JavaScript", "-e", script], {
        encoding: "utf-8",
        timeout,
    });

    if (proc.status !== 0) {
        throw new Error(`JXA error: ${proc.stderr?.trim() || "unknown error"}`);
    }

    return proc.stdout.trim();
}

/**
 * `runJxa` without blocking the event loop: for a resident server, where a synchronous osascript start (about 80 ms,
 * up to its deadline) holds every other request.
 */
export async function runJxaAsync(script: string, timeoutMs = 15_000): Promise<string> {
    refuseHostEffectInTest("runJxaAsync", "Fake the script result; do not drive a real application.");
    const result = await boundedCommand({ command: ["osascript", "-l", "JavaScript", "-e", script], timeoutMs });

    // A recorded error (the output budget, a broken stream, the deadline) fails the run even when osascript exited 0:
    // its stdout is then partial.
    if (result.status !== 0 || result.error) {
        throw new Error(`JXA error: ${result.error?.message || result.stderr.trim() || "unknown error"}`);
    }

    return result.stdout.trim();
}

export function escapeJxa(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/** `text` as an AppleScript string literal: `"…"` with backslashes, quotes and newlines escaped. */
export function appleScriptString(text: string): string {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
