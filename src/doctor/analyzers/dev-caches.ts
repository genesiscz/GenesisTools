import type { Dirent } from "node:fs";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { devRoots } from "@app/doctor/lib/dev-roots";
import {
    listGlobalPackages,
    type PackageManager,
    reinstallCommand,
    writeSnapshot,
} from "@app/doctor/lib/global-packages";
import { guardPaths } from "@app/doctor/lib/path-guard";
import { run, runInherit } from "@app/doctor/lib/run";
import { readScanGate, type ScanGateReader } from "@app/doctor/lib/scan-gate";
import { duBytes, formatBytes } from "@app/doctor/lib/size";
import type { Action, AnalyzerCategory, AnalyzerContext, ExecutorContext, Finding } from "@app/doctor/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import pLimit from "p-limit";

const DU_CONCURRENCY = 8;

const NODE_MODULES_MIN_BYTES = 500 * 1024 * 1024;
const NODE_MODULES_SCAN_DEPTH = 6;

interface SimDeviceInput {
    udid: string;
    name: string;
    deviceTypeIdentifier: string;
    state: string;
    dataPath: string;
    logPath: string;
    isAvailable: boolean;
}

interface SimctlDevicesJson {
    devices: Record<string, SimDeviceInput[]>;
}

export interface SimDevice {
    udid: string;
    name: string;
    runtime: string;
    deviceType: string;
    state: string;
    dataPath: string;
    logPath: string;
    isAvailable: boolean;
}

export interface DockerDfSummary {
    type: string;
    totalCount: number;
    active: number;
    size: string;
    reclaimable: string;
}

interface DockerDfJsonLine {
    Type?: string;
    TotalCount?: string;
    Active?: string;
    Size?: string;
    Reclaimable?: string;
}

export interface DevCachesOptions {
    home?: string;
    /** Checkout roots for the `node_modules` search (default: the generic roots plus `GENESIS_TOOLS_DEV_CACHE_ROOTS`). */
    roots?: string[];
    gate?: ScanGateReader;
    /** Smallest `node_modules` listed (default 500 MB; tests lower it). */
    nodeModulesMinBytes?: number;
}

export class DevCachesAnalyzer extends Analyzer {
    readonly id = "dev-caches";
    readonly name = "Dev Caches";
    readonly icon = "D";
    readonly category: AnalyzerCategory = "disk";
    readonly cacheTtlMs = 24 * 60 * 60 * 1000;

    constructor(private readonly options: DevCachesOptions = {}) {
        super();
    }

    private get home(): string {
        return this.options.home ?? homedir();
    }

    private roots(): string[] {
        return (this.options.roots ?? devRoots(this.home)).filter(existsSync);
    }

    override allowRoots(): string[] {
        return [...this.roots(), join(this.home, "Library", "Developer", "Xcode")];
    }

    override async recheck(ids: string[], ctx: AnalyzerContext): Promise<Finding[]> {
        const wanted = new Set(ids);
        const found: Finding[] = [];
        const keep = (finding: Finding): void => {
            if (wanted.has(finding.id)) {
                found.push(finding);
            }
        };
        // Each group re-runs the whole rule that produces its ids (the node_modules search runs its walk, sizes and
        // top-20 cut again). A path is never read out of an id: before 2026-10-13 a crafted
        // `dev-node-modules-<repo>` id deleted the repository itself.
        const groups: Array<[(id: string) => boolean, () => AsyncIterable<Finding>]> = [
            [(id) => id.startsWith("dev-node-modules-"), () => this.scanNodeModules(ctx)],
            [(id) => id === "dev-xcode-derived", () => this.scanXcodeDerivedData()],
            [(id) => id.startsWith("dev-sim-"), () => this.scanSimulators()],
            [(id) => id.startsWith("dev-docker-unused-images"), () => this.scanDocker()],
            [(id) => id.startsWith("dev-cache-"), () => this.scanGlobalPackageCaches(ctx)],
            [(id) => id === "dev-brew-cache", () => this.scanBrewCache()],
        ];

        for (const [matches, generate] of groups) {
            if (ids.some(matches)) {
                for await (const finding of generate()) {
                    keep(finding);
                }
            }
        }

        return found;
    }

    protected async *run(ctx: AnalyzerContext): AsyncIterable<Finding> {
        yield* this.scanNodeModules(ctx);

        this.emitStage(ctx, "Xcode DerivedData");
        yield* this.scanXcodeDerivedData();

        this.emitStage(ctx, "simulators");
        yield* this.scanSimulators();

        this.emitStage(ctx, "docker");
        yield* this.scanDocker();

        this.emitStage(ctx, "package caches");
        yield* this.scanGlobalPackageCaches(ctx);

        this.emitStage(ctx, "brew cache");
        yield* this.scanBrewCache();
    }

    private emitStage(ctx: AnalyzerContext, currentItem: string): void {
        ctx.emit({
            type: "progress",
            analyzerId: this.id,
            phase: "scanning",
            currentItem,
            findingsCount: 0,
        });
    }

    private async *scanNodeModules(ctx: AnalyzerContext): AsyncIterable<Finding> {
        const expandedRoots = this.roots();

        if (expandedRoots.length === 0) {
            return;
        }

        if ((await (this.options.gate ?? readScanGate)()).gated) {
            return;
        }

        const paths = expandedRoots.flatMap((root) => findNodeModulesDirs(root, NODE_MODULES_SCAN_DEPTH));
        const total = paths.length;
        const sized: Array<{ path: string; bytes: number }> = [];
        let scanned = 0;

        const limit = pLimit(DU_CONCURRENCY);

        await Promise.all(
            paths.map((path) =>
                limit(async () => {
                    const bytes = await duBytes(path);
                    scanned++;
                    ctx.emit({
                        type: "progress",
                        analyzerId: this.id,
                        phase: "scanning",
                        percent: total === 0 ? 100 : (scanned / total) * 100,
                        currentItem: `node_modules ${scanned}/${total}`,
                        findingsCount: sized.length,
                    });

                    if (bytes >= (this.options.nodeModulesMinBytes ?? NODE_MODULES_MIN_BYTES)) {
                        sized.push({ path, bytes });
                    }
                })
            )
        );

        sized.sort((left, right) => right.bytes - left.bytes);

        for (const item of sized.slice(0, 20)) {
            yield this.nodeModulesFinding(item.path, item.bytes);
        }
    }

    private nodeModulesFinding(path: string, bytes: number): Finding {
        return {
            id: `dev-node-modules-${path}`,
            analyzerId: this.id,
            title: path.replace(this.home, "~"),
            detail: `node_modules · ${formatBytes(bytes)}`,
            severity: "cautious",
            reclaimableBytes: bytes,
            actions: [
                deleteDirectoryAction(
                    "delete-node-modules",
                    "Delete (you can reinstall dependencies later)",
                    path,
                    bytes
                ),
            ],
            metadata: { path, paths: [path], bytes, allocatedBytes: bytes },
        };
    }

    private async *scanXcodeDerivedData(): AsyncIterable<Finding> {
        const path = join(this.home, "Library", "Developer", "Xcode", "DerivedData");

        if (!existsSync(path)) {
            return;
        }

        const bytes = await duBytes(path);
        if (bytes < 500 * 1024 * 1024) {
            return;
        }

        yield {
            id: "dev-xcode-derived",
            analyzerId: this.id,
            title: "Xcode DerivedData",
            detail: `${formatBytes(bytes)} · regenerated on next build`,
            severity: "cautious",
            reclaimableBytes: bytes,
            actions: [deleteDirectoryAction("clear-derived-data", "Clear DerivedData", path, bytes)],
            metadata: { path, paths: [path], bytes, allocatedBytes: bytes },
        };
    }

    private async *scanSimulators(): AsyncIterable<Finding> {
        yield* scanSimulators();
    }

    private async *scanDocker(): AsyncIterable<Finding> {
        yield* scanDocker();
    }

    private async *scanGlobalPackageCaches(ctx: AnalyzerContext): AsyncIterable<Finding> {
        yield* scanGlobalPackageCaches(ctx, this.id, this.home);
    }

    private async *scanBrewCache(): AsyncIterable<Finding> {
        const res = await run("brew", ["--cache"]);

        if (res.status !== 0) {
            return;
        }

        const path = res.stdout.trim();
        if (!existsSync(path)) {
            return;
        }

        const bytes = await duBytes(path);
        if (bytes < 200 * 1024 * 1024) {
            return;
        }

        yield {
            id: "dev-brew-cache",
            analyzerId: this.id,
            title: "Homebrew download cache",
            detail: `${formatBytes(bytes)} · safely removable`,
            severity: "safe",
            reclaimableBytes: bytes,
            actions: [
                {
                    id: "brew-cleanup",
                    label: "Run brew cleanup -s",
                    confirm: "none",
                    kind: "command",
                    execute: async (_ctx, finding) => {
                        const result = await run("brew", ["cleanup", "-s"], { timeoutMs: 120_000 });

                        return {
                            findingId: finding.id,
                            actionId: "brew-cleanup",
                            status: result.status === 0 && !result.timedOut ? "ok" : "failed",
                            ...(result.status !== 0 || result.timedOut
                                ? { error: result.timedOut ? "brew cleanup timed out" : result.stderr }
                                : {}),
                            actualReclaimedBytes: result.status === 0 && !result.timedOut ? bytes : 0,
                        };
                    },
                },
            ],
            metadata: { path, bytes },
        };
    }
}

export function parseSimctlJson(raw: string): SimDevice[] {
    try {
        const parsed = SafeJSON.parse(raw, { strict: true }) as SimctlDevicesJson;
        const devices: SimDevice[] = [];

        for (const [runtime, list] of Object.entries(parsed.devices)) {
            for (const dev of list) {
                devices.push({
                    udid: dev.udid,
                    name: dev.name,
                    runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-/g, " "),
                    deviceType: dev.deviceTypeIdentifier.replace("com.apple.CoreSimulator.SimDeviceType.", ""),
                    state: dev.state,
                    dataPath: dev.dataPath,
                    logPath: dev.logPath,
                    isAvailable: dev.isAvailable,
                });
            }
        }

        return devices;
    } catch (err) {
        logger.debug({ err }, "[doctor] failed to parse command output");
        return [];
    }
}

export function parseDockerSystemDfJson(raw: string): DockerDfSummary[] {
    const summaries: DockerDfSummary[] = [];

    for (const line of raw.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            const parsed = SafeJSON.parse(line, { strict: true }) as DockerDfJsonLine;
            if (parsed.Type) {
                summaries.push({
                    type: parsed.Type,
                    totalCount: Number.parseInt(parsed.TotalCount ?? "0", 10),
                    active: Number.parseInt(parsed.Active ?? "0", 10),
                    size: parsed.Size ?? "",
                    reclaimable: parsed.Reclaimable ?? "",
                });
            }
        } catch {}
    }

    return summaries;
}

function deleteDirectoryAction(id: string, label: string, path: string, bytes: number): Action {
    return {
        id,
        label,
        confirm: "yesno",
        kind: "remove-path",
        method: "delete",
        execute: async (_ctx: ExecutorContext, finding) => {
            try {
                await rm(path, { recursive: true, force: true });

                return {
                    findingId: finding.id,
                    actionId: id,
                    status: "ok",
                    actualReclaimedBytes: bytes,
                    metadata: { path },
                };
            } catch (err) {
                return {
                    findingId: finding.id,
                    actionId: id,
                    status: "failed",
                    error: err instanceof Error ? err.message : "Failed to delete directory",
                    metadata: { path },
                };
            }
        },
    };
}

export function findNodeModulesDirs(root: string, maxDepth: number): string[] {
    const found: string[] = [];
    walkNodeModules({ dir: root, depth: 0, maxDepth, found });
    return found;
}

function walkNodeModules(args: { dir: string; depth: number; maxDepth: number; found: string[] }): void {
    if (args.depth > args.maxDepth) {
        return;
    }

    let entries: Dirent[];
    try {
        entries = readdirSync(args.dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
            continue;
        }

        const path = join(args.dir, entry.name);
        if (entry.name === "node_modules") {
            args.found.push(path);
            continue;
        }

        walkNodeModules({ dir: path, depth: args.depth + 1, maxDepth: args.maxDepth, found: args.found });
    }
}

function lastUsedAt(logPath: string): Date | null {
    if (!existsSync(logPath)) {
        return null;
    }

    try {
        return statSync(logPath).mtime;
    } catch {
        return null;
    }
}

async function* scanSimulators(): AsyncIterable<Finding> {
    const res = await run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 10_000 });

    if (res.status !== 0) {
        return;
    }

    const devices = parseSimctlJson(res.stdout);
    const byRuntime = new Map<string, SimDevice[]>();

    for (const dev of devices) {
        const bucket = byRuntime.get(dev.runtime) ?? [];
        bucket.push(dev);
        byRuntime.set(dev.runtime, bucket);
    }

    const limit = pLimit(DU_CONCURRENCY);

    for (const [runtime, group] of byRuntime) {
        const sizes = await Promise.all(group.map((device) => limit(() => duBytes(device.dataPath))));
        const totalBytes = sizes.reduce((acc, size) => acc + size, 0);

        const unavailable = group.filter((device) => !device.isAvailable);
        const stale = group.filter((device) => {
            const last = lastUsedAt(device.logPath);
            if (!last) {
                return true;
            }

            const daysSince = (Date.now() - last.getTime()) / (86400 * 1000);
            return daysSince > 90;
        });
        const actions = simulatorActions({ runtime, group, unavailable, stale });

        yield {
            id: `dev-sim-${runtime}`,
            analyzerId: "dev-caches",
            title: `Simulators: ${runtime} x ${group.length}`,
            detail: `${formatBytes(totalBytes)} · ${unavailable.length} unavailable · ${stale.length} stale`,
            severity: "cautious",
            reclaimableBytes: totalBytes,
            actions,
            metadata: { runtime, count: group.length, totalBytes },
        };
    }
}

function simulatorActions(args: {
    runtime: string;
    group: SimDevice[];
    unavailable: SimDevice[];
    stale: SimDevice[];
}): Action[] {
    const actions: Action[] = [];

    if (args.unavailable.length > 0) {
        actions.push(
            deleteSimulatorsAction(
                "delete-unavailable",
                `Delete ${args.unavailable.length} unavailable simulator(s)`,
                args.unavailable
            )
        );
    }

    if (args.stale.length > 0) {
        actions.push(
            deleteSimulatorsAction(
                "delete-stale",
                `Delete ${args.stale.length} simulator(s) not used in 90+ days`,
                args.stale
            )
        );
    }

    actions.push({
        ...deleteSimulatorsAction(
            "delete-all-for-runtime",
            `Delete all ${args.group.length} simulator(s) for ${args.runtime}`,
            args.group
        ),
        confirm: "typed",
        confirmPhrase: args.runtime,
    });

    return actions;
}

function deleteSimulatorsAction(id: string, label: string, devices: SimDevice[]): Action {
    return {
        id,
        label,
        confirm: "yesno",
        kind: "command",
        execute: async (_ctx, finding) => {
            let failed = 0;

            for (const dev of devices) {
                const res = await run("xcrun", ["simctl", "delete", dev.udid]);
                if (res.status !== 0) {
                    failed++;
                }
            }

            return {
                findingId: finding.id,
                actionId: id,
                status: failed === 0 ? "ok" : "failed",
                metadata: { count: devices.length, failed },
            };
        },
    };
}

/**
 * The Docker context every call of this run is pinned to: the one `docker context show` names now. A bare `docker`
 * follows whichever engine is current, which changed under a running cleanup on 2026-07-27, so two bare readings may
 * describe two engines. Null when docker is missing.
 */
export async function currentDockerContext(): Promise<string | null> {
    const res = await run("docker", ["context", "show"], { timeoutMs: 5_000 });
    const name = res.stdout.trim();
    return res.status === 0 && name.length > 0 ? name : null;
}

/** The id names the pinned context, so an act after the current context changed re-derives nothing instead of pruning
 *  the other engine. */
export function dockerFindingId(context: string): string {
    return `dev-docker-unused-images:${context}`;
}

async function* scanDocker(): AsyncIterable<Finding> {
    const context = await currentDockerContext();

    if (context === null) {
        return;
    }

    const res = await run("docker", ["--context", context, "system", "df", "--format", "json"], { timeoutMs: 5_000 });

    if (res.status !== 0) {
        return;
    }

    const summaries = parseDockerSystemDfJson(res.stdout);
    const imageSummary = summaries.find((summary) => summary.type === "Images");

    if (imageSummary && imageSummary.totalCount > imageSummary.active) {
        yield {
            id: dockerFindingId(context),
            analyzerId: "dev-caches",
            title: `Docker (${context}): ${imageSummary.totalCount - imageSummary.active} unused image group(s)`,
            detail: `Reclaimable: ${imageSummary.reclaimable} · the prune removes dangling images only; the VM disk shrinks on the host only after TRIM`,
            severity: "cautious",
            actions: [
                {
                    id: "prune-images",
                    label: `Run docker --context ${context} image prune -f (dangling images)`,
                    confirm: "yesno",
                    kind: "command",
                    execute: async (_ctx, finding) => {
                        const result = await run("docker", ["--context", context, "image", "prune", "-f"], {
                            timeoutMs: 120_000,
                        });

                        return {
                            findingId: finding.id,
                            actionId: "prune-images",
                            status: result.status === 0 && !result.timedOut ? "ok" : "failed",
                            ...(result.status !== 0 || result.timedOut
                                ? { error: result.timedOut ? "docker prune timed out" : result.stderr }
                                : {}),
                        };
                    },
                },
            ],
            metadata: { summary: imageSummary, context },
        };
    }
}

async function* scanGlobalPackageCaches(
    ctx: AnalyzerContext,
    analyzerId: string,
    home: string
): AsyncIterable<Finding> {
    const cases: Array<{ manager: PackageManager; path: string; minBytes: number }> = [
        { manager: "bun", path: join(home, ".bun", "install", "cache"), minBytes: 1024 * 1024 * 1024 },
        { manager: "npm", path: join(home, ".npm"), minBytes: 1024 * 1024 * 1024 },
        { manager: "pnpm", path: join(home, "Library", "pnpm", "store", "v10"), minBytes: 1024 * 1024 * 1024 },
        { manager: "yarn", path: join(home, ".yarn", "berry", "cache"), minBytes: 500 * 1024 * 1024 },
    ];

    const candidates = cases.filter((item) => existsSync(item.path));
    const limit = pLimit(DU_CONCURRENCY);
    const sized = await Promise.all(
        candidates.map((item) =>
            limit(async () => {
                ctx.emit({
                    type: "progress",
                    analyzerId,
                    phase: "scanning",
                    currentItem: `${item.manager} cache`,
                    findingsCount: 0,
                });

                return { item, bytes: await duBytes(item.path) };
            })
        )
    );

    for (const { item, bytes } of sized) {
        if (bytes < item.minBytes) {
            continue;
        }

        const globals = await listGlobalPackages(item.manager);
        const cmd = reinstallCommand(item.manager, globals);

        yield {
            id: `dev-cache-${item.manager}`,
            analyzerId,
            title: `${item.manager} cache · ${formatBytes(bytes)}`,
            detail: `${globals.length} global packages will be snapshotted before wipe.`,
            severity: "cautious",
            reclaimableBytes: bytes,
            actions: [
                cleanPackageCacheAction({ ctx, home, manager: item.manager, path: item.path, bytes, globals, cmd }),
            ],
            metadata: {
                manager: item.manager,
                path: item.path,
                paths: [item.path],
                bytes,
                allocatedBytes: bytes,
                globalsCount: globals.length,
            },
        };
    }
}

export function cleanPackageCacheAction(args: {
    ctx: AnalyzerContext;
    home: string;
    manager: PackageManager;
    path: string;
    bytes: number;
    globals: string[];
    cmd: { cmd: string; args: string[] };
}): Action {
    return {
        id: `clean-${args.manager}-cache`,
        label: `Snapshot globals + clean ${args.manager} cache`,
        confirm: "yesno",
        kind: "command",
        execute: async (ctx2, finding) => {
            await writeSnapshot(ctx2.runId || args.ctx.runId, {
                manager: args.manager,
                packages: args.globals,
                capturedAt: new Date().toISOString(),
            });
            // Globs retain the declared home paths: resolving a symlinked cache parent as an allow root would trust its target.
            const home = realpathSync(args.home);
            const guarded = guardPaths({
                paths: [args.path],
                allowRoots: [
                    join(home, ".bun", "install", "*"),
                    join(home, ".npm*"),
                    join(home, "Library", "pnpm", "store", "*"),
                    join(home, ".yarn", "berry", "*"),
                ],
                home,
                analyzerId: "dev-caches",
            });
            if (!guarded.ok) {
                return {
                    findingId: finding.id,
                    actionId: `clean-${args.manager}-cache`,
                    status: "failed",
                    error: guarded.error,
                };
            }
            await rm(args.path, { recursive: true, force: true });

            return {
                findingId: finding.id,
                actionId: `clean-${args.manager}-cache`,
                status: "ok",
                actualReclaimedBytes: args.bytes,
                metadata: { manager: args.manager, snapshotted: args.globals.length },
            };
        },
        followUp: (result) => {
            if (result.status !== "ok" || args.globals.length === 0) {
                return null;
            }

            return [
                {
                    id: `reinstall-${args.manager}`,
                    label: `Re-install ${args.globals.length} ${args.manager} globals`,
                    confirm: "yesno",
                    execute: async (_ctx, finding) => {
                        const status = await runInherit(args.cmd.cmd, args.cmd.args);

                        return {
                            findingId: finding.id,
                            actionId: `reinstall-${args.manager}`,
                            status: status === 0 ? "ok" : "failed",
                            metadata: { manager: args.manager, packageCount: args.globals.length },
                        };
                    },
                },
            ];
        },
    };
}
