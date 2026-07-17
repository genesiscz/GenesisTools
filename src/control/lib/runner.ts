import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";

const GT_ROOT = join(import.meta.dir, "..", "..", "..");
const BINARY_PATH = join(GT_ROOT, "native", "ax-tool", ".build", "release", "ax-tool");
const SWIFT_SOURCE = join(GT_ROOT, "native", "ax-tool");

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
        return { ok: false, error: r.stderr?.trim() || `ax-tool exited ${r.status} with no output` };
    }

    try {
        return SafeJSON.parse(stdout) as AxResult;
    } catch {
        return { ok: false, error: `invalid JSON: ${stdout.slice(0, 200)}` };
    }
}

export function getBinaryPath(): string {
    return BINARY_PATH;
}
