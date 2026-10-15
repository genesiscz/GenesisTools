import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { ageDaysOf, allocatedOf, type MeasureBudget, measurePath, type PathSize } from "@app/doctor/lib/fs-measure";
import {
    findRunning,
    listProcesses,
    othersOnly,
    PROCESS_LIST_UNAVAILABLE,
    type ProcessLister,
    type ProcInfo,
    runsExecutable,
    runsFrom,
    snapshotProcesses,
} from "@app/doctor/lib/processes";
import { removePathsAction } from "@app/doctor/lib/remove-action";
import { run } from "@app/doctor/lib/run";
import { readScanGate, type ScanGateReader, type ScanGateState } from "@app/doctor/lib/scan-gate";
import { formatBytes } from "@app/doctor/lib/size";
import type {
    AnalyzerCategory,
    AnalyzerContext,
    Finding,
    ReclaimMetadata,
    ReclaimMetadataInput,
    Severity,
} from "@app/doctor/lib/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { openFiles, pidsOf } from "@genesiscz/utils/process/open-files";

export const APP_BLOAT_ANALYZER_ID = "app-bloat";

const MB = 1024 * 1024;
const GIB = 1024 * MB;
const DAY_MS = 86_400_000;
const CACHE_MIN_BYTES = 50 * MB;
const BIG_LOG_BYTES = GIB;

type RuleKind =
    | "claude-vm-bundles"
    | "claude-cache"
    | "cursor-agent-versions"
    | "cursor-workspace-storage-dead"
    | "cursor-cacheddata"
    | "cursor-state-vscdb"
    | "shipit-update"
    | "playwright-cache"
    | "android-avd"
    | "jsonl-over-1gb"
    | "docker-sparse";

/** The pids writing `path`; null when that could not be learned (the delete is then blocked). */
export type OpenWriterReader = (path: string) => Promise<number[] | null>;
export type PlistReader = (path: string) => Promise<Record<string, unknown> | null>;

export interface AppBloatOptions {
    home?: string;
    /** Folder holding `.genesis-tools` (the tools home). */
    toolsHome?: string;
    now?: () => number;
    processes?: ProcessLister;
    gate?: ScanGateReader;
    openWriters?: OpenWriterReader;
    readPlist?: PlistReader;
    budget?: MeasureBudget;
    /** Smallest app cache worth a row (default 50 MB; tests lower it). */
    cacheMinBytes?: number;
    /** Smallest allocated size of a log the big-log rule lists (default 1 GiB; tests lower it). */
    bigLogMinBytes?: number;
}

interface Ctx {
    gate: ScanGateState;
    /** Other processes (this run and its ancestors left out); empty when the table could not be read. */
    procs: ProcInfo[];
    /** False when `ps` failed: every "quit the app first" check then blocks instead of passing. */
    procsOk: boolean;
    now: number;
}

/** A Playwright test runner or CLI (not an idle MCP server, which only starts a browser on demand). */
const PLAYWRIGHT_CLI =
    /\/(?:playwright|playwright-core|@playwright\/test)\/(?:cli|index)\.(?:js|mjs)\b|\/\.bin\/playwright(?:\s|$)/;

/**
 * Why a workspace's project folder is NOT positively gone, or null when it is: only ENOENT counts, the volume it sits on
 * must be mounted (`/Volumes/<name>` exists), and any other error (EACCES, EPERM under privacy controls) means "unknown".
 */
export function folderGoneUnknown(target: string): string | null {
    const volume = target.match(/^\/Volumes\/[^/]+/)?.[0];

    if (volume) {
        try {
            lstatSync(volume);
        } catch {
            return `${volume} is not mounted`;
        }
    }

    try {
        lstatSync(target);
        return "the folder exists";
    } catch (err) {
        const code = err instanceof Error && "code" in err ? String(err.code) : "";
        return code === "ENOENT" ? null : `the folder cannot be checked (${code || "unknown error"})`;
    }
}

function safeReaddir(path: string): string[] {
    try {
        return readdirSync(path);
    } catch {
        return [];
    }
}

function safeLstat(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch {
        return null;
    }
}

function metadata(base: ReclaimMetadataInput): ReclaimMetadata {
    return { owner: null, ...base };
}

/** The pids holding `path` open. Null when that could not be learned (a timeout or any other failed read). */
async function lsofWriters(path: string): Promise<number[] | null> {
    return pidsOf(openFiles({ files: [path], timeoutMs: 10_000 }));
}

async function plutilJson(path: string): Promise<Record<string, unknown> | null> {
    const res = await run("plutil", ["-convert", "json", "-o", "-", "--", path], { timeoutMs: 5_000 });

    if (res.status !== 0) {
        return null;
    }

    try {
        return SafeJSON.parse(res.stdout, { strict: true }) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function fileUrlToPath(url: string): string | null {
    if (!url.startsWith("file://")) {
        return null;
    }

    try {
        return decodeURIComponent(new URL(url).pathname).replace(/\/$/, "");
    } catch {
        return null;
    }
}

function runningBlocker(c: Ctx, procs: ProcInfo[], app: string): string[] {
    if (!c.procsOk) {
        return [PROCESS_LIST_UNAVAILABLE];
    }

    if (procs.length === 0) {
        return [];
    }

    return [
        `${app} is running (pid ${procs
            .map((proc) => proc.pid)
            .slice(0, 3)
            .join(", ")}): quit it first`,
    ];
}

export class AppBloatAnalyzer extends Analyzer {
    readonly id = APP_BLOAT_ANALYZER_ID;
    readonly name = "App Bloat";
    readonly icon = "A";
    readonly category: AnalyzerCategory = "disk";
    readonly cacheTtlMs = 5 * 60 * 1000;

    constructor(private readonly options: AppBloatOptions = {}) {
        super();
    }

    private get home(): string {
        return this.options.home ?? homedir();
    }

    private get toolsHome(): string {
        return this.options.toolsHome ?? this.options.home ?? env.tools.getHome();
    }

    private p(...parts: string[]): string {
        return join(this.home, ...parts);
    }

    private get claudeDir(): string {
        return this.p("Library", "Application Support", "Claude");
    }

    private get cursorDir(): string {
        return this.p("Library", "Application Support", "Cursor");
    }

    override allowRoots(): string[] {
        return [
            this.claudeDir,
            this.cursorDir,
            this.p(".local", "share", "cursor-agent"),
            this.p("Library", "Caches"),
            this.p(".cache"),
            this.p(".android", "avd"),
            join(this.toolsHome, ".genesis-tools", "logs"),
        ];
    }

    protected async *run(ctx: AnalyzerContext): AsyncIterable<Finding> {
        yield* this.runKinds(ctx, null);
    }

    override async recheck(ids: string[], ctx: AnalyzerContext): Promise<Finding[]> {
        const kinds = new Set(ids.map((id) => id.split(":")[1] as RuleKind));
        const wanted = new Set(ids);
        const found: Finding[] = [];

        for await (const finding of this.runKinds(ctx, kinds)) {
            if (wanted.has(finding.id)) {
                found.push(finding);
            }
        }

        return found;
    }

    private async *runKinds(ctx: AnalyzerContext, kinds: Set<RuleKind> | null): AsyncIterable<Finding> {
        const [gate, snapshot] = await Promise.all([
            (this.options.gate ?? readScanGate)(),
            snapshotProcesses(this.options.processes ?? listProcesses),
        ]);
        const c: Ctx = {
            gate,
            procs: snapshot.ok ? othersOnly(snapshot.procs) : [],
            procsOk: snapshot.ok,
            now: this.options.now ? this.options.now() : Date.now(),
        };
        const want = (kind: RuleKind): boolean => kinds === null || kinds.has(kind);
        const stage = (item: string): void =>
            ctx.emit({ type: "progress", analyzerId: this.id, phase: "scanning", currentItem: item, findingsCount: 0 });

        stage("Claude Desktop");

        if (want("claude-vm-bundles")) {
            yield* this.claudeVmBundles(c);
        }

        if (want("claude-cache")) {
            yield* this.claudeCaches(c);
        }

        stage("Cursor");

        if (want("cursor-agent-versions")) {
            yield* this.cursorAgentVersions(c);
        }

        if (want("cursor-workspace-storage-dead") && !c.gate.gated) {
            yield* this.cursorDeadWorkspaces(c);
        }

        if (want("cursor-cacheddata")) {
            yield* this.cursorCachedData(c);
        }

        if (want("cursor-state-vscdb")) {
            yield* this.cursorState(c);
        }

        stage("update downloads and browsers");

        if (want("shipit-update")) {
            yield* this.shipItUpdates(c);
        }

        if (want("playwright-cache")) {
            yield* this.playwright(c);
        }

        if (want("android-avd")) {
            yield* this.androidAvd(c);
        }

        stage("logs and VM disks");

        if (want("jsonl-over-1gb")) {
            yield* this.bigLogs(c);
        }

        if (want("docker-sparse")) {
            yield* this.dockerSparse(c);
        }
    }

    /** `typed` for user data (a Cowork workspace, chat history): never a plain yes. */
    private remover(label: string, opts: { recreateEmpty?: boolean; id?: string; typed?: boolean } = {}) {
        return removePathsAction({
            id: opts.id ?? "delete-app-cache",
            label,
            confirm: opts.typed ? "typed" : "yesno",
            ...(opts.typed ? { confirmPhrase: "DELETE" } : {}),
            ...(opts.recreateEmpty ? { recreateEmpty: true } : {}),
            analyzerId: this.id,
            home: this.home,
            allowRoots: () => this.allowRoots(),
        });
    }

    private measure(c: Ctx, path: string): PathSize | null {
        return c.gate.gated ? null : measurePath(path, this.options.budget);
    }

    private dirFinding(
        c: Ctx,
        args: {
            id: string;
            kind: string;
            path: string;
            title: string;
            detail: string;
            severity: Severity;
            regenerates: boolean;
            requires?: string[];
            blockers: string[];
            recreateEmpty?: boolean;
            minBytes?: number;
            label: string;
            extra?: Record<string, unknown>;
        }
    ): Finding | null {
        const stat = safeLstat(args.path);

        if (!stat) {
            return null;
        }

        const size = this.measure(c, args.path);

        if (size && size.allocatedBytes < (args.minBytes ?? 0)) {
            return null;
        }

        const reclaimable = size ? (size.freeableFloorBytes ?? size.allocatedBytes) : undefined;
        return {
            id: args.id,
            analyzerId: this.id,
            title: size ? `${args.title} · ${formatBytes(size.allocatedBytes)}` : args.title,
            detail: args.detail,
            severity: args.severity,
            ...(reclaimable !== undefined ? { reclaimableBytes: reclaimable } : {}),
            actions: [this.remover(args.label, { recreateEmpty: args.recreateEmpty })],
            metadata: metadata({
                kind: args.kind,
                paths: [args.path],
                allocatedBytes: size?.allocatedBytes ?? null,
                apparentBytes: size?.apparentBytes ?? null,
                ...(size?.freeableFloorBytes != null ? { freeableFloorBytes: size.freeableFloorBytes } : {}),
                ageDays: ageDaysOf(size?.newestMtimeMs ?? stat.mtimeMs, c.now),
                ...(args.requires ? { requires: { absentProcesses: args.requires } } : {}),
                regenerates: args.regenerates,
                sizeKnown: size?.complete ?? false,
                ...(args.blockers.length > 0 ? { blockers: args.blockers } : {}),
                ...(size ? { fileCount: size.entries } : {}),
                ...args.extra,
            }),
        };
    }

    private *claudeVmBundles(c: Ctx): Iterable<Finding> {
        const bundle = join(this.claudeDir, "vm_bundles", "claudevm.bundle");
        const names = safeReaddir(bundle);

        if (names.length === 0) {
            return;
        }

        const targets = ["rootfs.img", "sessiondata.img"].map((name) => join(bundle, name)).filter(existsSync);
        const kept = names.filter((name) => name.endsWith(".zst")).map((name) => join(bundle, name));

        if (targets.length === 0) {
            return;
        }

        let allocated = 0;
        let apparent = 0;
        let newest = 0;

        for (const path of targets) {
            const stat = safeLstat(path);

            if (stat) {
                allocated += allocatedOf(stat);
                apparent += stat.size;
                newest = Math.max(newest, stat.mtimeMs);
            }
        }

        const running = findRunning(c.procs, ["Claude", "Claude Helper"]);
        const blockers = runningBlocker(c, running, "Claude Desktop");

        if (c.now - newest < DAY_MS) {
            blockers.push("the VM was used less than a day ago");
        }

        yield {
            id: `${this.id}:claude-vm-bundles`,
            analyzerId: this.id,
            title: `Claude Desktop VM bundle · ${formatBytes(allocated)}`,
            detail: `${targets.map((path) => basename(path)).join(" and ")}${kept.length > 0 ? `; ${kept.map((path) => basename(path)).join(", ")} (the seed) stays` : ""}. Claude Desktop rebuilds the VM on the next Cowork start.`,
            severity: "cautious",
            reclaimableBytes: allocated,
            actions: [this.remover("Delete the VM disk images", { typed: true })],
            metadata: metadata({
                kind: "claude-vm-bundles",
                paths: targets,
                allocatedBytes: allocated,
                apparentBytes: apparent,
                ageDays: ageDaysOf(newest, c.now),
                requires: { absentProcesses: ["Claude", "Claude Helper"] },
                regenerates: true,
                restoreHint:
                    "Claude Desktop re-creates the VM from rootfs.img.zst on the next Cowork start. The built-in path is Developer > Troubleshooting > Delete VM Bundle and Restart.",
                sizeKnown: true,
                ...(blockers.length > 0 ? { blockers } : {}),
                kept,
            }),
        };
    }

    private *claudeCaches(c: Ctx): Iterable<Finding> {
        const blockers = runningBlocker(c, findRunning(c.procs, ["Claude", "Claude Helper"]), "Claude Desktop");

        for (const name of ["Cache", "Code Cache", "claude-code-vm"]) {
            const finding = this.dirFinding(c, {
                id: `${this.id}:claude-cache:${name}`,
                kind: "claude-cache",
                path: join(this.claudeDir, name),
                title: `Claude Desktop ${name}`,
                detail: "Regenerated by Claude Desktop. The folder is re-created empty.",
                severity: "safe",
                regenerates: true,
                requires: ["Claude", "Claude Helper"],
                blockers,
                recreateEmpty: true,
                minBytes: this.options.cacheMinBytes ?? CACHE_MIN_BYTES,
                label: `Empty Claude Desktop ${name}`,
            });

            if (finding) {
                yield finding;
            }
        }
    }

    private *cursorAgentVersions(c: Ctx): Iterable<Finding> {
        const stores: Array<{ key: string; dir: string }> = [
            {
                key: "worker",
                dir: join(
                    this.cursorDir,
                    "User",
                    "globalStorage",
                    "anysphere.cursor-agent-worker",
                    "agent-cli",
                    ".local",
                    "share",
                    "cursor-agent",
                    "versions"
                ),
            },
            { key: "cli", dir: this.p(".local", "share", "cursor-agent", "versions") },
        ];
        let linked: string | null = null;

        try {
            linked = readlinkSync(this.p(".local", "bin", "cursor-agent"));
        } catch {
            linked = null;
        }

        const running = c.procs.filter(
            (proc) =>
                stores.some((store) => runsFrom(proc, store.dir)) ||
                runsExecutable(proc, "cursor-agent") ||
                runsExecutable(proc, "cursor-agent-worker")
        );
        const blockers = runningBlocker(c, running, "cursor-agent");

        for (const store of stores) {
            const versions = safeReaddir(store.dir)
                .map((name) => ({ name, path: join(store.dir, name), stat: safeLstat(join(store.dir, name)) }))
                .filter((v): v is { name: string; path: string; stat: Stats } => v.stat?.isDirectory() === true);
            const real = versions.filter((v) => !v.name.startsWith(".tmp-"));
            const newest = [...real].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
            const keep = new Set<string>();

            if (newest) {
                keep.add(newest.name);
            }

            for (const v of real) {
                if (linked?.includes(`/versions/${v.name}/`) || linked?.endsWith(`/versions/${v.name}`)) {
                    keep.add(v.name);
                }
            }

            const old = versions.filter((v) => !keep.has(v.name));

            if (old.length === 0) {
                continue;
            }

            let allocated = 0;
            let apparent = 0;
            let complete = !c.gate.gated;

            for (const v of old) {
                const size = this.measure(c, v.path);

                if (size) {
                    allocated += size.allocatedBytes;
                    apparent += size.apparentBytes;
                    complete = complete && size.complete;
                } else {
                    complete = false;
                }
            }

            yield {
                id: `${this.id}:cursor-agent-versions:${store.key}`,
                analyzerId: this.id,
                title: `Old cursor-agent versions (${store.key} store) · ${old.length}`,
                detail: `${complete ? formatBytes(allocated) : "size not measured"} · keeps ${[...keep].join(", ") || "nothing"} (the linked and the newest version)`,
                severity: "safe",
                ...(complete ? { reclaimableBytes: allocated } : {}),
                actions: [this.remover("Delete the old versions")],
                metadata: metadata({
                    kind: "cursor-agent-versions",
                    paths: old.map((v) => v.path),
                    allocatedBytes: complete ? allocated : null,
                    apparentBytes: complete ? apparent : null,
                    ageDays: ageDaysOf(Math.max(...old.map((v) => v.stat.mtimeMs)), c.now),
                    requires: { absentProcesses: ["cursor-agent"] },
                    regenerates: false,
                    sizeKnown: complete,
                    ...(blockers.length > 0 ? { blockers } : {}),
                    kept: [...keep],
                }),
            };
        }
    }

    private *cursorDeadWorkspaces(c: Ctx): Iterable<Finding> {
        const storage = join(this.cursorDir, "User", "workspaceStorage");
        const dead: string[] = [];
        const targets: Array<{ path: string; folder: string }> = [];

        for (const hash of safeReaddir(storage)) {
            const dir = join(storage, hash);
            let target: string | null = null;

            try {
                const json = SafeJSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"), { strict: true }) as {
                    folder?: string;
                    workspace?: string;
                };
                target = fileUrlToPath(json.folder ?? json.workspace ?? "");
            } catch {
                target = null;
            }

            if (target !== null && folderGoneUnknown(target) === null) {
                dead.push(dir);
                targets.push({ path: dir, folder: target });
            }
        }

        if (dead.length === 0) {
            return;
        }

        let allocated = 0;
        let apparent = 0;
        let newest = 0;
        let complete = true;

        for (const dir of dead) {
            const size = measurePath(dir, this.options.budget);
            complete = complete && size?.complete === true;

            if (size) {
                allocated += size.allocatedBytes;
                apparent += size.apparentBytes;
                newest = Math.max(newest, size.newestMtimeMs);
            }
        }

        const blockers = runningBlocker(c, findRunning(c.procs, ["Cursor"]), "Cursor");

        yield {
            id: `${this.id}:cursor-workspace-storage-dead`,
            analyzerId: this.id,
            title: `Cursor state of ${dead.length} deleted project(s) · ${complete ? formatBytes(allocated) : "size not measured"}`,
            detail: `Chat state of projects whose folder is gone: ${targets.map((t) => basename(t.folder)).join(", ")}. It does not come back.`,
            severity: "cautious",
            ...(complete ? { reclaimableBytes: allocated } : {}),
            actions: [this.remover("Delete the dead workspace state", { typed: true })],
            metadata: metadata({
                kind: "cursor-workspace-storage-dead",
                paths: dead,
                allocatedBytes: complete ? allocated : null,
                apparentBytes: complete ? apparent : null,
                ageDays: complete ? ageDaysOf(newest, c.now) : null,
                requires: { absentProcesses: ["Cursor"] },
                regenerates: false,
                sizeKnown: complete,
                ...(blockers.length > 0 ? { blockers } : {}),
                targets,
            }),
        };
    }

    private *cursorCachedData(c: Ctx): Iterable<Finding> {
        const finding = this.dirFinding(c, {
            id: `${this.id}:cursor-cacheddata`,
            kind: "cursor-cacheddata",
            path: join(this.cursorDir, "CachedData"),
            title: "Cursor CachedData (V8 code cache)",
            detail: "Regenerated by Cursor. The folder is re-created empty.",
            severity: "safe",
            regenerates: true,
            requires: ["Cursor"],
            blockers: runningBlocker(c, findRunning(c.procs, ["Cursor"]), "Cursor"),
            recreateEmpty: true,
            minBytes: this.options.cacheMinBytes ?? CACHE_MIN_BYTES,
            label: "Empty Cursor CachedData",
        });

        if (finding) {
            yield finding;
        }
    }

    private *cursorState(c: Ctx): Iterable<Finding> {
        const base = join(this.cursorDir, "User", "globalStorage", "state.vscdb");
        const files = [base, `${base}-wal`, `${base}-shm`].filter(existsSync);

        if (files.length === 0) {
            return;
        }

        let allocated = 0;
        let apparent = 0;
        let newest = 0;

        for (const path of files) {
            const stat = safeLstat(path);

            if (stat) {
                allocated += allocatedOf(stat);
                apparent += stat.size;
                newest = Math.max(newest, stat.mtimeMs);
            }
        }

        if (allocated < GIB) {
            return;
        }

        yield {
            id: `${this.id}:cursor-state-vscdb`,
            analyzerId: this.id,
            title: `Cursor chat and agent history (state.vscdb) · ${formatBytes(allocated)}`,
            detail: "Live database. Never edit, wipe or VACUUM it while Cursor runs.",
            severity: "blocked",
            blacklistReason: "Cursor's live chat and agent history database: deleting it loses every conversation.",
            actions: [],
            metadata: metadata({
                kind: "cursor-state-vscdb",
                paths: files,
                allocatedBytes: allocated,
                apparentBytes: apparent,
                ageDays: ageDaysOf(newest, c.now),
                regenerates: false,
                sizeKnown: true,
            }),
        };
    }

    private async *shipItUpdates(c: Ctx): AsyncIterable<Finding> {
        const caches = this.p("Library", "Caches");
        const readPlist = this.options.readPlist ?? plutilJson;

        for (const folderName of safeReaddir(caches)) {
            if (!folderName.endsWith(".ShipIt")) {
                continue;
            }

            const folder = join(caches, folderName);
            const updates = safeReaddir(folder).filter((name) => name.startsWith("update."));

            if (updates.length === 0) {
                continue;
            }

            const plistPath = join(folder, "ShipItState.plist");
            let staged: string | null = null;

            if (existsSync(plistPath)) {
                const plist = await readPlist(plistPath);

                if (plist === null) {
                    continue;
                }

                const url = plist.updateBundleURL;
                const stagedBundle = typeof url === "string" ? fileUrlToPath(url) : null;
                staged = stagedBundle
                    ? (updates
                          .map((name) => join(folder, name))
                          .find((dir) => stagedBundle === dir || stagedBundle.startsWith(`${dir}/`)) ?? null)
                    : null;
            }

            for (const name of updates) {
                const path = join(folder, name);

                if (path === staged) {
                    continue;
                }

                const finding = this.dirFinding(c, {
                    id: `${this.id}:shipit-update:${folderName}:${name}`,
                    kind: "shipit-update",
                    path,
                    title: `Superseded update download ~/Library/Caches/${folderName}/${name}`,
                    detail: staged
                        ? `ShipItState.plist stages ${basename(staged)}, so this one is dead`
                        : "No update is staged, so this download is dead",
                    severity: "safe",
                    regenerates: false,
                    blockers: [],
                    label: "Delete the dead update download",
                    extra: { shipItFolder: folder, stagedUpdate: staged },
                });

                if (finding) {
                    yield finding;
                }
            }
        }
    }

    private *playwright(c: Ctx): Iterable<Finding> {
        const caches = this.p("Library", "Caches");
        const paths = safeReaddir(caches)
            .filter((name) => name.startsWith("ms-playwright"))
            .map((name) => join(caches, name));
        const xdg = this.p(".cache", "ms-playwright");

        if (existsSync(xdg)) {
            paths.push(xdg);
        }

        const running = c.procs.filter(
            (proc) => paths.some((path) => runsFrom(proc, path)) || PLAYWRIGHT_CLI.test(proc.command)
        );
        const blockers = runningBlocker(c, running, "A Playwright process");

        for (const path of paths) {
            const finding = this.dirFinding(c, {
                id: `${this.id}:playwright-cache:${path}`,
                kind: "playwright-cache",
                path,
                title: `Playwright browsers ${path.replace(this.home, "~")}`,
                detail: "Playwright downloads them again on its next run",
                severity: "safe",
                regenerates: true,
                requires: ["playwright"],
                blockers,
                minBytes: this.options.cacheMinBytes ?? CACHE_MIN_BYTES,
                label: "Delete the Playwright browsers",
            });

            if (finding) {
                yield finding;
            }
        }
    }

    private *androidAvd(c: Ctx): Iterable<Finding> {
        const avdRoot = this.p(".android", "avd");
        const avds = safeReaddir(avdRoot)
            .filter((name) => name.endsWith(".avd"))
            .map((name) => {
                const disk = join(avdRoot, name, "userdata-qemu.img.qcow2");
                return { name, disk, stat: safeLstat(disk) };
            })
            .filter((avd): avd is { name: string; disk: string; stat: Stats } => avd.stat !== null);

        if (avds.length < 2) {
            return;
        }

        const newest = [...avds].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]!;
        const running = c.procs.filter(
            (proc) => proc.command.includes("qemu-system") || findRunning([proc], ["emulator"]).length > 0
        );
        const blockers = runningBlocker(c, running, "The Android emulator");

        for (const avd of avds) {
            if (avd.name === newest.name) {
                continue;
            }

            const allocated = allocatedOf(avd.stat);

            yield {
                id: `${this.id}:android-avd:${avd.name}`,
                analyzerId: this.id,
                title: `Android emulator data ${avd.name} · ${formatBytes(allocated)}`,
                detail: "Deletes the user-data disk only; the AVD definition stays and boots fresh.",
                severity: "cautious",
                reclaimableBytes: allocated,
                actions: [this.remover("Delete the emulator user data", { typed: true })],
                metadata: metadata({
                    kind: "android-avd",
                    paths: [avd.disk],
                    allocatedBytes: allocated,
                    apparentBytes: avd.stat.size,
                    ageDays: ageDaysOf(avd.stat.mtimeMs, c.now),
                    requires: { absentProcesses: ["emulator", "qemu-system-aarch64", "qemu-system-x86_64"] },
                    regenerates: false,
                    sizeKnown: true,
                    ...(blockers.length > 0 ? { blockers } : {}),
                    keptAvd: newest.name,
                }),
            };
        }
    }

    private async *bigLogs(c: Ctx): AsyncIterable<Finding> {
        const logsDir = join(this.toolsHome, ".genesis-tools", "logs");
        const roots: Array<{ dir: string; match: RegExp }> = [
            { dir: this.p(".claude"), match: /\.jsonl$/ },
            { dir: logsDir, match: /\.(log|ndjson|jsonl)$/ },
        ];
        const openWriters = this.options.openWriters ?? lsofWriters;
        const today = new Date(c.now).toISOString().slice(0, 10);

        for (const root of roots) {
            for (const name of safeReaddir(root.dir)) {
                if (!root.match.test(name)) {
                    continue;
                }

                const path = join(root.dir, name);
                const stat = safeLstat(path);

                if (!stat?.isFile() || allocatedOf(stat) < (this.options.bigLogMinBytes ?? BIG_LOG_BYTES)) {
                    continue;
                }

                const dated = name.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
                const deletable = root.dir === logsDir && dated !== undefined && dated < today;
                // `lsof` costs seconds; only a log that gets a delete action needs the open-writer proof.
                const writers = deletable ? await openWriters(path) : [];
                const blockers: string[] = [];

                if (writers === null) {
                    blockers.push("lsof could not tell whether a process still writes it: not deleted");
                } else if (writers.length > 0) {
                    blockers.push(
                        `open for writing (pid ${writers.slice(0, 3).join(", ")}): a delete would free nothing`
                    );
                }

                if (c.now - stat.mtimeMs < 5 * 60_000) {
                    blockers.push("written in the last 5 minutes");
                }

                const allocated = allocatedOf(stat);

                yield {
                    id: `${this.id}:jsonl-over-1gb:${path}`,
                    analyzerId: this.id,
                    title: `Runaway log ${path.replace(this.home, "~")} · ${formatBytes(allocated)}`,
                    detail: deletable
                        ? "A finished day log of GenesisTools: nothing writes to it any more."
                        : "Trim it with the program that writes it. Renaming or deleting an open log frees nothing.",
                    severity: "cautious",
                    reclaimableBytes: allocated,
                    actions: deletable ? [this.remover("Delete the finished day log", { id: "delete-log" })] : [],
                    metadata: metadata({
                        kind: "big-log",
                        paths: [path],
                        allocatedBytes: allocated,
                        apparentBytes: stat.size,
                        ageDays: ageDaysOf(stat.mtimeMs, c.now),
                        regenerates: false,
                        sizeKnown: true,
                        ...(blockers.length > 0 ? { blockers } : {}),
                    }),
                };
            }
        }
    }

    private *dockerSparse(c: Ctx): Iterable<Finding> {
        const engines: Array<{ engine: string; context: string; label: string; paths: string[] }> = [];
        const desktop = this.p("Library", "Containers", "com.docker.docker", "Data", "vms", "0", "data", "Docker.raw");

        if (existsSync(desktop)) {
            engines.push({
                engine: "docker-desktop",
                context: "desktop-linux",
                label: "Docker Desktop",
                paths: [desktop],
            });
        }

        const groups = this.p("Library", "Group Containers");

        for (const name of safeReaddir(groups)) {
            if (!name.endsWith(".dev.orbstack")) {
                continue;
            }

            const data = join(groups, name, "data");
            const paths = ["data.img.raw", "swap.img"].map((file) => join(data, file)).filter(existsSync);

            if (paths.length > 0) {
                engines.push({ engine: "orbstack", context: "orbstack", label: "OrbStack", paths });
            }
        }

        for (const item of engines) {
            let allocated = 0;
            let apparent = 0;
            let newest = 0;

            for (const path of item.paths) {
                const stat = safeLstat(path);

                if (stat) {
                    allocated += allocatedOf(stat);
                    apparent += stat.size;
                    newest = Math.max(newest, stat.mtimeMs);
                }
            }

            yield {
                id: `${this.id}:docker-sparse:${item.engine}`,
                analyzerId: this.id,
                title: `${item.label} VM disk · ${formatBytes(allocated)} allocated (${formatBytes(apparent)} apparent)`,
                detail: "Sparse VM disk. Never delete it; prune inside the guest with a pinned context.",
                severity: "blocked",
                blacklistReason:
                    "Sparse VM disk: deleting it destroys every container, image and volume. Prune inside the guest instead.",
                actions: [],
                metadata: metadata({
                    kind: "docker-sparse",
                    paths: item.paths,
                    allocatedBytes: allocated,
                    apparentBytes: apparent,
                    ageDays: ageDaysOf(newest, c.now),
                    regenerates: false,
                    sizeKnown: true,
                    engine: item.engine,
                    context: item.context,
                    guestCommands: [
                        `docker --context ${item.context} system df`,
                        `docker --context ${item.context} builder prune -af`,
                        `docker --context ${item.context} image prune -f`,
                    ],
                }),
            };
        }
    }
}
