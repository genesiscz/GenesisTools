import { spawnSync } from "node:child_process";
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

export function escapeJxa(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/** `text` as an AppleScript string literal: `"…"` with backslashes, quotes and newlines escaped. */
export function appleScriptString(text: string): string {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
