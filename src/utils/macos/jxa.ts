import { spawnSync } from "node:child_process";

export function ensureMacOS(): void {
    if (process.platform !== "darwin") {
        throw new Error("This feature is only available on macOS");
    }
}

export function runJxa(script: string, timeout = 15_000): string {
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
