import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { currentPlatform, tmpRoot } from "./platform.ts";

const { log } = logger.scoped("chrome-devtools:paths");

/**
 * Capture layout: <tmp>/GenesisTools/ChromeDevtools/<port>/{seg-*.jsonl, meta.json, recorder.pid}.
 * POSIX <tmp> is /tmp by contract (clears on reboot — captures are sensitive); win32 uses %TEMP%.
 */
export const CAPTURE_ROOT = join(tmpRoot(), "GenesisTools", "ChromeDevtools");

export function captureDir(port: number): string {
    return join(CAPTURE_ROOT, String(port));
}

export function ensureCaptureDir(port: number): string {
    const dir = captureDir(port);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Captures hold live cookies/tokens; on a multi-user POSIX box the shared
    // /tmp root must not leak them. chmod covers dirs that already existed
    // (mkdirSync mode only applies on creation, and is umask-filtered).
    try {
        chmodSync(CAPTURE_ROOT, 0o700);
        chmodSync(dir, 0o700);
    } catch (err) {
        // win32 has no POSIX modes; elsewhere a failed chmod is worth a trace.
        log.debug({ err, dir }, "capture dir chmod failed");
    }

    return dir;
}

export function metaPath(port: number): string {
    return join(captureDir(port), "meta.json");
}

export function recorderPidPath(port: number): string {
    return join(captureDir(port), "recorder.pid");
}

/** Ports that have a capture dir on disk (live or leftover). */
export function knownCapturePorts(): number[] {
    if (!existsSync(CAPTURE_ROOT)) {
        return [];
    }

    return readdirSync(CAPTURE_ROOT)
        .map((name) => Number(name))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);
}

/**
 * The old skill's on-disk contract (it only ever ran on macOS, so these stay
 * literal /tmp); doctor detects them, cleanup removes them. On win32 the dir
 * does not exist and both helpers are no-ops.
 */
export function legacyArmPaths(port: number): { jsonl: string; pid: string } {
    return {
        // lint-rules-ignore: deliberate /tmp — the OLD macOS-only skill's fixed paths, detection only
        jsonl: `/tmp/cdp-arm-${port}.jsonl`,
        // lint-rules-ignore: deliberate /tmp — the OLD macOS-only skill's fixed paths, detection only
        pid: `/tmp/cdp-arm-${port}.pid`,
    };
}

export function listLegacyArmFiles(): string[] {
    // Git Bash / MSYS can give a Windows host a real /tmp — files there are
    // never the old macOS skill's leftovers, so win32 is a hard no-op.
    if (currentPlatform() === "win32") {
        return [];
    }

    const found: string[] = [];
    // lint-rules-ignore: deliberate /tmp — the OLD macOS-only skill's fixed paths, detection only
    const legacyRoot = "/tmp";
    for (const name of existsSync(legacyRoot) ? readdirSync(legacyRoot) : []) {
        if (/^cdp-arm-\d+\.(jsonl|pid)$/.test(name)) {
            found.push(join(legacyRoot, name));
        }
    }

    return found.sort();
}
