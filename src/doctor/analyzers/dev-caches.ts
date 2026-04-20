import type { Dirent } from "node:fs";
import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Analyzer } from "@app/doctor/lib/analyzer";
import {
    listGlobalPackages,
    type PackageManager,
    reinstallCommand,
    writeSnapshot,
} from "@app/doctor/lib/global-packages";
import { run, runInherit } from "@app/doctor/lib/run";
import { duBytes, formatBytes } from "@app/doctor/lib/size";
import type { Action, AnalyzerCategory, AnalyzerContext, ExecutorContext, Finding } from "@app/doctor/lib/types";
import { SafeJSON } from "@app/utils/json";
import pLimit from "p-limit";

const DU_CONCURRENCY = 8;

const ROOTS = ["~/Tresors", "~/Projects", "~/Developer", "~/dev", "~/code", "~/src"];
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

export class DevCachesAnalyzer extends Analyzer {
    readonly id = "dev-caches";
    readonly name = "Dev Caches";
    readonly icon = "D";
    readonly category: AnalyzerCategory = "disk";
    readonly cacheTtlMs = 24 * 60 * 60 * 1000;

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
        const home = homedir();
        const expandedRoots = ROOTS.map((root) => root.replace(/^~/, home)).filter(existsSync);

        if (expandedRoots.length === 0) {
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

                    if (bytes >= NODE_MODULES_MIN_BYTES) {
                        sized.push({ path, bytes });
                    }
                })
            )
        );

        sized.sort((left, right) => right.bytes - left.bytes);

        for (const item of sized.slice(0, 20)) {
            yield {
                id: `dev-node-modules-${item.path}`,
                analyzerId: this.id,
                title: item.path.replace(home, "~"),
                detail: `node_modules · ${formatBytes(item.bytes)}`,
                severity: "cautious",
                reclaimableBytes: item.bytes,
                actions: [
                    deleteDirectoryAction(
                        "delete-node-modules",
                        "Delete (you can reinstall dependencies later)",
                        item.path,
                        item.bytes
                    ),
                ],
                metadata: { path: item.path, bytes: item.bytes },
            };
        }
    }

    private async *scanXcodeDerivedData(): AsyncIterable<Finding> {
        const path = join(homedir(), "Library", "Developer", "Xcode", "DerivedData");

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
            metadata: { path, bytes },
        };
    }

    private async *scanSimulators(): AsyncIterable<Finding> {
        yield* scanSimulators();
    }

    private async *scanDocker(): AsyncIterable<Finding> {
        yield* scanDocker();
    }

    private async *scanGlobalPackageCaches(ctx: AnalyzerContext): AsyncIterable<Finding> {
        yield* scanGlobalPackageCaches(ctx, this.id);
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
                    execute: async (_ctx, finding) => {
                        const status = await runInherit("brew", ["cleanup", "-s"]);

                        return {
                            findingId: finding.id,
                            actionId: "brew-cleanup",
                            status: status === 0 ? "ok" : "failed",
                            actualReclaimedBytes: bytes,
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
    } catch {
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

function findNodeModulesDirs(root: string, maxDepth: number): string[] {
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

async function* scanDocker(): AsyncIterable<Finding> {
    const res = await run("docker", ["system", "df", "--format", "json"], { timeoutMs: 5_000 });

    if (res.status !== 0) {
        return;
    }

    const summaries = parseDockerSystemDfJson(res.stdout);
    const imageSummary = summaries.find((summary) => summary.type === "Images");

    if (imageSummary && imageSummary.totalCount > imageSummary.active) {
        yield {
            id: "dev-docker-unused-images",
            analyzerId: "dev-caches",
            title: `Docker: ${imageSummary.totalCount - imageSummary.active} unused image group(s)`,
            detail: `Reclaimable: ${imageSummary.reclaimable}`,
            severity: "cautious",
            actions: [
                {
                    id: "prune-images",
                    label: "Run docker image prune -a",
                    confirm: "yesno",
                    execute: async (_ctx, finding) => {
                        const status = await runInherit("docker", ["image", "prune", "-af"]);

                        return {
                            findingId: finding.id,
                            actionId: "prune-images",
                            status: status === 0 ? "ok" : "failed",
                        };
                    },
                },
            ],
            metadata: { summary: imageSummary },
        };
    }
}

async function* scanGlobalPackageCaches(ctx: AnalyzerContext, analyzerId: string): AsyncIterable<Finding> {
    const cases: Array<{ manager: PackageManager; path: string; minBytes: number }> = [
        { manager: "bun", path: join(homedir(), ".bun", "install", "cache"), minBytes: 1024 * 1024 * 1024 },
        { manager: "npm", path: join(homedir(), ".npm"), minBytes: 1024 * 1024 * 1024 },
        { manager: "pnpm", path: join(homedir(), "Library", "pnpm", "store", "v10"), minBytes: 1024 * 1024 * 1024 },
        { manager: "yarn", path: join(homedir(), ".yarn", "berry", "cache"), minBytes: 500 * 1024 * 1024 },
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
            actions: [cleanPackageCacheAction({ ctx, manager: item.manager, path: item.path, bytes, globals, cmd })],
            metadata: { manager: item.manager, path: item.path, bytes, globalsCount: globals.length },
        };
    }
}

function cleanPackageCacheAction(args: {
    ctx: AnalyzerContext;
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
        execute: async (ctx2, finding) => {
            await writeSnapshot(ctx2.runId || args.ctx.runId, {
                manager: args.manager,
                packages: args.globals,
                capturedAt: new Date().toISOString(),
            });
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
