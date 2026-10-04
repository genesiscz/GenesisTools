import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";

const REQUIRED_SOURCES = ["Package.swift", "Sources", "SnapshotSupport"] as const;
const RECEIPT_VERSION = 1;

interface NativeSourceFile {
    path: string;
    hash: string;
}

export interface NativeSourceSnapshot {
    files: NativeSourceFile[];
    fingerprint: string;
}

interface NativeBuildReceipt {
    version: number;
    sources: NativeSourceSnapshot;
    binary: string;
}

function hash(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

function receiptPath(binary: string): string {
    return join(dirname(binary), ".native-build-receipt.json");
}

function sourceFiles(sourceDir: string): string[] {
    const roots = REQUIRED_SOURCES.map((path) => join(sourceDir, path));
    if (
        !existsSync(roots[0]!) ||
        !statSync(roots[0]!).isFile() ||
        roots.slice(1).some((path) => !existsSync(path) || !statSync(path).isDirectory())
    ) {
        throw new Error("native source roots are missing");
    }

    const files = [roots[0]!];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                visit(path);
            } else if (path.endsWith(".swift") || relative(sourceDir, path).includes("/Resources/")) {
                files.push(path);
            }
        }
    };
    visit(roots[1]!);
    visit(roots[2]!);
    return files.sort();
}

function binarySignature(binary: string): string {
    if (!existsSync(binary) || !statSync(binary).isFile()) {
        throw new Error("native binary is missing");
    }
    return hash(readFileSync(binary));
}

function isReceipt(value: unknown): value is NativeBuildReceipt {
    if (!value || typeof value !== "object") {
        return false;
    }
    const receipt = value as Partial<NativeBuildReceipt>;
    return (
        receipt.version === RECEIPT_VERSION &&
        typeof receipt.binary === "string" &&
        !!receipt.sources &&
        typeof receipt.sources.fingerprint === "string" &&
        Array.isArray(receipt.sources.files)
    );
}

export function captureNativeSources(sourceDir: string): NativeSourceSnapshot {
    const files = sourceFiles(sourceDir).map((path) => ({
        path: relative(sourceDir, path),
        hash: hash(readFileSync(path)),
    }));
    return { files, fingerprint: hash(SafeJSON.stringify(files)) };
}

export function recordNativeBuild({
    binary,
    sourceDir,
    before,
}: {
    binary: string;
    sourceDir: string;
    before: NativeSourceSnapshot;
}): void {
    const after = captureNativeSources(sourceDir);
    if (after.fingerprint !== before.fingerprint) {
        throw new Error("native sources changed during build; receipt not recorded");
    }
    const receipt: NativeBuildReceipt = { version: RECEIPT_VERSION, sources: after, binary: binarySignature(binary) };
    const path = receiptPath(binary);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, SafeJSON.stringify(receipt));
    renameSync(temporary, path);
}

export function nativeNeedsBuild({ binary, sourceDir }: { binary: string; sourceDir: string }): boolean {
    try {
        const sources = captureNativeSources(sourceDir);
        const path = receiptPath(binary);
        if (!existsSync(path)) {
            return true;
        }
        const receipt = SafeJSON.parse(readFileSync(path, "utf-8")) as unknown;
        return (
            !isReceipt(receipt) ||
            receipt.sources.fingerprint !== sources.fingerprint ||
            receipt.binary !== binarySignature(binary)
        );
    } catch (error) {
        logger.debug({ error, sourceDir }, "native build receipt is unavailable or stale");
        return true;
    }
}

/**
 * A cold `swift build` of ax-tool took 68 s on a fresh Mac. Slower machines and first-time package
 * resolution take longer, and a build cut off here makes every waiter retry and time out in turn.
 */
export const NATIVE_BUILD_TIMEOUT_MS = 300_000;

/** A waiter must outlast one full-length build by the process that holds the lock. */
export const NATIVE_BUILD_LOCK_WAIT_MS = NATIVE_BUILD_TIMEOUT_MS + 60_000;

/**
 * The runner's bound on the whole build worker: a full lock wait, then this process's own build
 * when the holder's failed, plus the worker's startup.
 */
export const NATIVE_BUILD_WORKER_TIMEOUT_MS = NATIVE_BUILD_LOCK_WAIT_MS + NATIVE_BUILD_TIMEOUT_MS + 30_000;

/**
 * Compiles the native CLI unless it is already fresh, and records the receipt, one process at a
 * time. Agents start several `tools control` commands at once, and on a fresh checkout each of
 * them used to compile its own copy. Freshness is checked again INSIDE the lock, so a process that
 * waited reuses the binary the first one built. `build` is the compiler boundary.
 */
export async function buildNativeOnce({
    binary,
    sourceDir,
    lockPath,
    build,
    timeoutMs = NATIVE_BUILD_LOCK_WAIT_MS,
}: {
    binary: string;
    sourceDir: string;
    lockPath: string;
    build: () => Promise<void>;
    timeoutMs?: number;
}): Promise<{ built: boolean }> {
    if (existsSync(lockPath)) {
        logger.info({ lockPath }, "another process is compiling ax-tool; waiting for it");
    }

    return withFileLock(
        lockPath,
        async () => {
            if (!nativeNeedsBuild({ binary, sourceDir })) {
                return { built: false };
            }

            const before = captureNativeSources(sourceDir);
            await build();
            recordNativeBuild({ binary, sourceDir, before });
            return { built: true };
        },
        timeoutMs
    );
}

/** `swift build -c release` in `sourceDir`; throws with the compiler's last words on failure. */
export async function swiftReleaseBuild(sourceDir: string): Promise<void> {
    const command = ["swift", "build", "-c", "release"];
    logger.debug({ command, cwd: sourceDir }, "swift build started");
    const proc = Bun.spawn(command, {
        cwd: sourceDir,
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(NATIVE_BUILD_TIMEOUT_MS),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        throw new Error(`swift build exited ${exitCode ?? proc.signalCode}:\n${details.slice(-4000)}`);
    }
}
