import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";

const REQUIRED_SOURCES = ["Package.swift", "Sources", "SnapshotSupport"] as const;
const prof = profiler.scope("control-native");
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
    atomicWriteFileSync(receiptPath(binary), SafeJSON.stringify(receipt));
    markBuildKept(binary);
}

/**
 * The marker the disk-reclaim skill's build-purge honours (`.purge-keep`, GenesisClaude
 * user/skills/disk-reclaim/scripts/build-purge.ts): a tool runs this build's product at any moment, so purging the
 * build folder only forced a 30 s, ~1 GB rebuild at the next use. On 2026-11-11 the daemon's purge deleted
 * native/ax-tool/.build about every 45 minutes, and the 17:35 purge stopped a meeting recording mid-call.
 */
function markBuildKept(binary: string): void {
    const buildRoot = dirname(dirname(binary));

    if (basename(buildRoot) !== ".build") {
        return;
    }

    atomicWriteFileSync(
        join(buildRoot, ".purge-keep"),
        "A tool runs this build's product (GenesisTools native binary); build-purge keeps this folder.\n"
    );
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

/** What one compile cost: the build process with every child it waited for (swift-frontend, ld). */
export interface NativeBuildStats {
    exitCode: number | null;
    /** User plus system CPU, children included. */
    cpuMs: number;
    /** The largest resident set of the build or one of its children. */
    peakRssBytes: number;
}

/** A compile that exited with an error, with what it cost. */
export class NativeBuildFailed extends Error {
    constructor(
        message: string,
        readonly stats: NativeBuildStats
    ) {
        super(message);
        this.name = "NativeBuildFailed";
    }
}

/** One rebuild as the day log and the profiling log keep it, so a slow or heavy rebuild can be found later. */
export interface NativeBuildReport {
    /** Who asked: `first-use`, `recording-start`, `recorder-service-start`, `recorder-service-check`. */
    trigger: string;
    /** The native sources the build compiled (`captureNativeSources`). */
    fingerprint: string;
    ms: number;
    exitCode: number | null;
    cpuMs?: number;
    peakRssMb?: number;
}

function reportOf({
    trigger,
    fingerprint,
    ms,
    stats,
}: {
    trigger: string;
    fingerprint: string;
    ms: number;
    stats?: NativeBuildStats;
}): NativeBuildReport {
    return {
        trigger,
        fingerprint,
        ms: Math.round(ms),
        exitCode: stats?.exitCode ?? null,
        ...(stats ? { cpuMs: stats.cpuMs, peakRssMb: Math.round(stats.peakRssBytes / (1024 * 1024)) } : {}),
    };
}

/** `[profile:control-native] ax-tool build <trigger> … <ms>`, the `[profile:cli]` line's shape. */
function recordBuild(report: NativeBuildReport): void {
    prof.record(
        `ax-tool build ${report.trigger}`,
        report.ms,
        `exit=${report.exitCode ?? "none"} cpu=${report.cpuMs ?? "?"}ms rss=${report.peakRssMb ?? "?"}MB fp=${report.fingerprint.slice(0, 12)}`
    );
}

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
    trigger = "unknown",
    timeoutMs = NATIVE_BUILD_LOCK_WAIT_MS,
}: {
    binary: string;
    sourceDir: string;
    lockPath: string;
    build: () => Promise<NativeBuildStats | undefined>;
    /** Who asked for the build; it goes into the rebuild's log line. */
    trigger?: string;
    timeoutMs?: number;
}): Promise<{ built: boolean; report?: NativeBuildReport }> {
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
            const started = performance.now();
            let stats: NativeBuildStats | undefined;

            try {
                stats = await build();
            } catch (error) {
                const report = reportOf({
                    trigger,
                    fingerprint: before.fingerprint,
                    ms: performance.now() - started,
                    stats: error instanceof NativeBuildFailed ? error.stats : undefined,
                });
                logger.warn({ ...report, error, sourceDir }, "ax-tool rebuild failed");
                recordBuild(report);
                throw error;
            }

            recordNativeBuild({ binary, sourceDir, before });
            const report = reportOf({
                trigger,
                fingerprint: before.fingerprint,
                ms: performance.now() - started,
                stats,
            });
            logger.info({ ...report, sourceDir }, "ax-tool rebuilt");
            recordBuild(report);
            return { built: true, report };
        },
        timeoutMs
    );
}

const SWIFT_RELEASE_BUILD = ["swift", "build", "-c", "release"];

/**
 * `swift build -c release` in `sourceDir` (`command` for a test), with its cost; throws `NativeBuildFailed` with the
 * compiler's last words on failure.
 */
export async function swiftReleaseBuild(
    sourceDir: string,
    command: readonly string[] = SWIFT_RELEASE_BUILD
): Promise<NativeBuildStats> {
    logger.debug({ command, cwd: sourceDir }, "swift build started");
    const proc = Bun.spawn([...command], {
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

    // The kernel adds each reaped child's usage to its parent's, so this covers the compiler processes too.
    const usage = proc.resourceUsage();
    const stats: NativeBuildStats = {
        exitCode,
        cpuMs: usage ? Math.round(Number(usage.cpuTime.total) / 1000) : 0,
        peakRssBytes: usage?.maxRSS ?? 0,
    };

    if (exitCode !== 0) {
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        throw new NativeBuildFailed(
            `swift build exited ${exitCode ?? proc.signalCode}:\n${details.slice(-4000)}`,
            stats
        );
    }

    return stats;
}
