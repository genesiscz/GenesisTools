import { existsSync, lstatSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { allocatedOf, isSparseOrCompressed } from "@app/doctor/lib/fs-measure";
import { vmDataReason } from "@app/doctor/lib/path-guard";
import { isCommandAvailable, run, runInherit } from "@app/doctor/lib/run";
import { readScanGate, type ScanGateReader } from "@app/doctor/lib/scan-gate";
import { duBytes, formatBytes } from "@app/doctor/lib/size";
import type {
    Action,
    ActionResult,
    AnalyzerCategory,
    AnalyzerContext,
    ExecutorContext,
    Finding,
} from "@app/doctor/lib/types";
import { openFiles, pidsByPath } from "@genesiscz/utils/process/open-files";

interface SizedPath {
    path: string;
    /** Allocated bytes (`st_blocks * 512`): what a delete can free. */
    size: number;
    /** `st_size`. A sparse VM disk reads 926 GiB here while it holds 20 GiB. */
    apparent: number;
    mtime: Date;
    /** Set when the file must never be offered for removal (VM disk, sparse or compressed file). */
    blockedReason: string | null;
}

export interface DiskSpaceOptions {
    home?: string;
    gate?: ScanGateReader;
    /** Smallest allocated size the large-file rule lists (default 500 MB; tests lower it). */
    largeFileMinBytes?: number;
    /** Which candidate files a process holds open (default: the process layer; tests inject it). */
    openFiles?: OpenFilesReader;
}

const LARGE_FILE_BYTES = 500 * 1024 * 1024;

/** Why a large file must not be removed: a VM or container disk by path or name, or a file whose allocated size is far
 *  below its apparent size (sparse or compressed, which is how VM disks look). Null when removal is fine. */
export function largeFileBlockReason(
    entry: { path: string; size: number; apparent: number },
    home: string
): string | null {
    const byPath = vmDataReason(entry.path, home);

    if (byPath) {
        return byPath;
    }

    if (isSparseOrCompressed({ blocks: entry.size / 512, size: entry.apparent })) {
        return "Allocated size is far below the apparent size (a sparse or compressed file, typically a VM disk): it is not what it looks like";
    }

    if (insideTresor(entry.path, home)) {
        return "Inside a Tresorit synced folder: a delete reaches the server and every device. Use the Tresorit ignore filter instead";
    }

    return null;
}

/** True when a folder between `path` and the home folder holds `.tresorit` (the root of a synced tresor). */
export function insideTresor(path: string, home: string): boolean {
    let dir = dirname(path);

    while (dir.length > home.length && dir.startsWith(home)) {
        if (existsSync(join(dir, ".tresorit"))) {
            return true;
        }

        dir = dirname(dir);
    }

    return false;
}

export type CloudSync = "icloud" | "cloudstorage";

/** iCloud Drive and File Provider (Google Drive, Dropbox, OneDrive, Box) folders: a delete there reaches every device. */
export function cloudSyncOf(path: string, home: string): CloudSync | null {
    if (path.startsWith(`${home}/Library/Mobile Documents/`)) {
        return "icloud";
    }

    if (path.startsWith(`${home}/Library/CloudStorage/`)) {
        return "cloudstorage";
    }

    return null;
}

/** Which of the paths a process holds open; null when that could not be learned (every path then counts as open). */
export type OpenFilesReader = (paths: string[]) => Promise<Map<string, number[]> | null>;

/** Finder can sit on a prompt. The act lock must not wait forever. */
const EMPTY_TRASH_TIMEOUT_MS = 120_000;

/** Empty the Finder Trash. A timeout is a failed item, never a success. */
export async function emptyFinderTrash(finding: Pick<Finding, "id" | "reclaimableBytes">): Promise<ActionResult> {
    const res = await run("osascript", ["-e", 'tell application "Finder" to empty trash'], {
        timeoutMs: EMPTY_TRASH_TIMEOUT_MS,
    });
    const failed = res.timedOut || res.status !== 0;

    return {
        findingId: finding.id,
        actionId: "empty-trash",
        status: failed ? "failed" : "ok",
        ...(res.timedOut ? { error: "timed out" } : {}),
        // A Trash that was not emptied freed nothing.
        actualReclaimedBytes: failed ? 0 : finding.reclaimableBytes,
    };
}

/** Which of these files a process holds open. Null when the answer is unknown (a delete then stays blocked). */
async function lsofOpenFiles(paths: string[]): Promise<Map<string, number[]> | null> {
    return pidsByPath(openFiles({ files: paths, timeoutMs: 15_000 }));
}

export function parseTmutilOutput(raw: string): string[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("Snapshots for disk"));
}

export async function isFdAvailable(): Promise<boolean> {
    return isCommandAvailable("fd");
}

export async function isBrewAvailable(): Promise<boolean> {
    return isCommandAvailable("brew");
}

/** A large file is user data, never a cache: both removals need a typed phrase (the TUI and `doctor act` alike). */
function stageTrashAction(path: string): Action {
    return {
        id: "stage-trash",
        label: "Move to Trash (staged - can be recovered)",
        confirm: "typed",
        confirmPhrase: "yes, trash",
        staged: true,
        kind: "remove-path",
        method: "trash",
        execute: async (_ctx: ExecutorContext, finding): Promise<ActionResult> => ({
            findingId: finding.id,
            actionId: "stage-trash",
            status: "staged",
            actualReclaimedBytes: finding.reclaimableBytes,
            metadata: { path },
        }),
    };
}

function directDeleteAction(path: string): Action {
    return {
        id: "direct-delete",
        label: "Delete directly (skip Trash)",
        confirm: "typed",
        confirmPhrase: "yes, delete",
        kind: "remove-path",
        method: "delete",
        execute: async (_ctx, finding): Promise<ActionResult> => {
            try {
                await rm(path, { recursive: true, force: true });

                return {
                    findingId: finding.id,
                    actionId: "direct-delete",
                    status: "ok",
                    actualReclaimedBytes: finding.reclaimableBytes,
                    metadata: { path },
                };
            } catch (err) {
                return {
                    findingId: finding.id,
                    actionId: "direct-delete",
                    status: "failed",
                    error: err instanceof Error ? err.message : String(err),
                    metadata: { path },
                };
            }
        },
    };
}

function revealInFinderAction(path: string): Action {
    return {
        id: "reveal",
        label: "Reveal in Finder",
        confirm: "none",
        execute: async (_ctx, finding): Promise<ActionResult> => {
            await run("open", ["-R", path]);

            return { findingId: finding.id, actionId: "reveal", status: "ok" };
        },
    };
}

function installFdAction(): Action {
    return {
        id: "install-fd",
        label: "Install fd via Homebrew (optional, faster scans)",
        confirm: "yesno",
        execute: async (_ctx, finding): Promise<ActionResult> => {
            const status = await runInherit("brew", ["install", "fd"]);

            return {
                findingId: finding.id,
                actionId: "install-fd",
                status: status === 0 ? "ok" : "failed",
                error: status !== 0 ? "brew install failed" : undefined,
            };
        },
    };
}

function localSnapshotName(snapshot: string): string {
    return snapshot.replace(/^com\.apple\.TimeMachine\./, "").replace(/\.local$/, "");
}

function statSizedPath(path: string, home: string): SizedPath | null {
    try {
        const stat = lstatSync(path);

        if (!stat.isFile()) {
            return null;
        }

        const entry = { path, size: allocatedOf(stat), apparent: stat.size, mtime: stat.mtime };
        return { ...entry, blockedReason: largeFileBlockReason(entry, home) };
    } catch {
        return null;
    }
}

function daysSince(date: Date): number {
    return Math.floor((Date.now() - date.getTime()) / (86400 * 1000));
}

function splitPaths(raw: string): string[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

export class DiskSpaceAnalyzer extends Analyzer {
    readonly id = "disk-space";
    readonly name = "Disk Space";
    readonly icon = "D";
    readonly category: AnalyzerCategory = "disk";
    readonly cacheTtlMs = 60 * 60 * 1000;

    constructor(private readonly options: DiskSpaceOptions = {}) {
        super();
    }

    private get home(): string {
        return this.options.home ?? homedir();
    }

    private get largeFileMinBytes(): number {
        return this.options.largeFileMinBytes ?? LARGE_FILE_BYTES;
    }

    private get largeFileMinMb(): number {
        return Math.max(0, Math.floor(this.largeFileMinBytes / (1024 * 1024)) - 1);
    }

    override allowRoots(): string[] {
        return [this.home];
    }

    /**
     * Re-derive by running the rule that produces each id, never by reading a path out of an id: a `disk-large-<path>`
     * id is accepted only when the large-file scan (same depth, top 20 and scan gate) lists it now. `disk-find-*` ids
     * come from the ad-hoc `doctor find` and are never produced here.
     */
    override async recheck(ids: string[], ctx: AnalyzerContext): Promise<Finding[]> {
        const wanted = new Set(ids);
        const found: Finding[] = [];
        const generators: Array<[(id: string) => boolean, () => AsyncIterable<Finding>]> = [
            [(id) => id.startsWith("disk-large-"), () => this.findLargeFiles(ctx, this.home)],
            [(id) => id === "disk-downloads", () => this.findDownloads(ctx, this.home)],
            [(id) => id === "disk-trash", () => this.findTrash(this.home)],
            [(id) => id === "disk-tm-snapshots", () => this.findTimeMachineSnapshots()],
        ];

        for (const [matches, generate] of generators) {
            if (!ids.some(matches)) {
                continue;
            }

            for await (const finding of generate()) {
                if (wanted.has(finding.id)) {
                    found.push(finding);
                }
            }
        }

        return found;
    }

    protected async *run(ctx: AnalyzerContext): AsyncIterable<Finding> {
        const home = this.home;

        if (!(await isFdAvailable()) && (await isBrewAvailable())) {
            yield {
                id: "disk-install-fd",
                analyzerId: this.id,
                title: "Install `fd` for faster file scans",
                detail: "Not a cleanup - a one-time install that makes future runs of doctor faster.",
                severity: "safe",
                actions: [installFdAction()],
            };
        }

        yield* this.findDownloads(ctx, home);
        yield* this.findTrash(home);
        yield* this.findTimeMachineSnapshots();
        yield* this.findLargeFiles(ctx, home);
    }

    async findAdhoc(opts: { root: string; minMB: number; maxDays: number }): Promise<Finding[]> {
        const useFd = await isFdAvailable();
        const cmd = useFd ? "fd" : "find";
        const args = useFd
            ? [
                  "-H",
                  "-t",
                  "f",
                  "-S",
                  `+${opts.minMB}m`,
                  "--changed-within",
                  `${opts.maxDays}d`,
                  "--max-depth",
                  "10",
                  "--",
                  ".",
                  opts.root,
              ]
            : [opts.root, "-type", "f", "-size", `+${opts.minMB}M`, "-mtime", `-${opts.maxDays}`];

        const res = await run(cmd, args, { timeoutMs: 30_000 });

        if (res.status !== 0) {
            return [];
        }

        const findings: Finding[] = [];

        for (const path of splitPaths(res.stdout)) {
            const entry = statSizedPath(path, this.home);

            if (!entry) {
                continue;
            }

            findings.push(this.buildFileFinding({ prefix: "disk-find", entry }));
        }

        findings.sort((a, b) => (b.reclaimableBytes ?? 0) - (a.reclaimableBytes ?? 0));
        return findings.slice(0, 50);
    }

    private async *findDownloads(ctx: AnalyzerContext, home: string): AsyncIterable<Finding> {
        const downloads = join(home, "Downloads");

        if (!existsSync(downloads)) {
            return;
        }

        ctx.emit({
            type: "progress",
            analyzerId: this.id,
            phase: "scanning",
            currentItem: "Downloads",
            findingsCount: 0,
        });

        const size = await duBytes(downloads);

        if (size <= 500 * 1024 * 1024) {
            return;
        }

        yield {
            id: "disk-downloads",
            analyzerId: this.id,
            title: `~/Downloads - ${formatBytes(size)}`,
            detail: "Downloads folder - often safe to clean old installers and archives.",
            severity: "cautious",
            reclaimableBytes: size,
            actions: [revealInFinderAction(downloads)],
            metadata: { path: downloads },
        };
    }

    private async *findTrash(home: string): AsyncIterable<Finding> {
        const trash = join(home, ".Trash");

        if (!existsSync(trash)) {
            return;
        }

        const size = await duBytes(trash);

        if (size <= 0) {
            return;
        }

        yield {
            id: "disk-trash",
            analyzerId: this.id,
            title: `~/.Trash - ${formatBytes(size)}`,
            detail: "Permanently empty the Trash.",
            severity: "safe",
            reclaimableBytes: size,
            actions: [
                {
                    id: "empty-trash",
                    label: "Empty Trash permanently",
                    confirm: "yesno",
                    kind: "command",
                    execute: async (_ctx, finding): Promise<ActionResult> => emptyFinderTrash(finding),
                },
            ],
            metadata: { path: trash },
        };
    }

    private async *findTimeMachineSnapshots(): AsyncIterable<Finding> {
        const tmRes = await run("tmutil", ["listlocalsnapshots", "/"], { timeoutMs: 15_000 });
        const snapshots = tmRes.status === 0 ? parseTmutilOutput(tmRes.stdout) : [];

        if (snapshots.length === 0) {
            return;
        }

        yield {
            id: "disk-tm-snapshots",
            analyzerId: this.id,
            title: `${snapshots.length} Time Machine local snapshot(s)`,
            detail: snapshots.join("\n"),
            severity: "cautious",
            actions: [
                {
                    id: "delete-snapshots",
                    label: "Delete all local snapshots",
                    confirm: "yesno",
                    kind: "command",
                    execute: async (_ctx, finding): Promise<ActionResult> => {
                        const failed: string[] = [];
                        for (const snapshot of snapshots) {
                            const result = await run("tmutil", ["deletelocalsnapshots", localSnapshotName(snapshot)], {
                                timeoutMs: 120_000,
                            });
                            if (result.timedOut || result.status !== 0) {
                                const reason = result.timedOut ? "timed out" : `exit ${result.status}`;
                                failed.push(
                                    `${snapshot}: ${reason}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`
                                );
                            }
                        }

                        return {
                            findingId: finding.id,
                            actionId: "delete-snapshots",
                            status: failed.length > 0 ? "failed" : "ok",
                            ...(failed.length > 0 ? { error: failed.join("; ") } : {}),
                            metadata: { count: snapshots.length, deleted: snapshots.length - failed.length, failed },
                        };
                    },
                },
            ],
            metadata: { snapshots },
        };
    }

    private async *findLargeFiles(ctx: AnalyzerContext, home: string): AsyncIterable<Finding> {
        const gate = await (this.options.gate ?? readScanGate)();

        if (gate.gated) {
            return;
        }

        const useFd = await isFdAvailable();
        const cmd = useFd ? "fd" : "find";
        const args = useFd
            ? ["-H", "-t", "f", "-S", `+${this.largeFileMinMb}m`, "--max-depth", "6", "--", ".", home]
            : [
                  home,
                  "-maxdepth",
                  "6",
                  "-type",
                  "f",
                  "-size",
                  `+${this.largeFileMinMb}M`,
                  "-not",
                  "-path",
                  "*/node_modules/*",
                  "-not",
                  "-path",
                  "*/.git/*",
              ];

        ctx.emit({
            type: "progress",
            analyzerId: this.id,
            phase: "scanning",
            currentItem: "large files",
            findingsCount: 0,
        });

        const res = await run(cmd, args, { timeoutMs: 15_000 });

        if (res.status !== 0) {
            return;
        }

        const sized = splitPaths(res.stdout)
            .map((path) => statSizedPath(path, home))
            .filter((entry): entry is SizedPath => entry !== null)
            .filter((entry) => entry.size >= this.largeFileMinBytes || entry.blockedReason !== null)
            .sort((a, b) => b.size - a.size)
            .slice(0, 20);
        const open = await (this.options.openFiles ?? lsofOpenFiles)(
            sized.filter((entry) => entry.blockedReason === null).map((entry) => entry.path)
        );

        for (const entry of sized) {
            const pids = open?.get(entry.path) ?? [];
            const blockers =
                open === null && entry.blockedReason === null
                    ? ["lsof could not tell whether a process holds it open: not offered until a scan can check"]
                    : pids.length > 0
                      ? [`open in a process (pid ${pids.slice(0, 3).join(", ")}): a delete would free nothing`]
                      : [];
            yield this.buildFileFinding({ prefix: "disk-large", entry, blockers });
        }
    }

    private buildFileFinding(opts: { prefix: string; entry: SizedPath; blockers?: string[] }): Finding {
        const entry = opts.entry;
        const blocked = entry.blockedReason !== null;
        const apparentNote = entry.apparent > entry.size * 2 ? ` (${formatBytes(entry.apparent)} apparent)` : "";
        const cloud = cloudSyncOf(entry.path, this.home);
        const cloudNote = cloud ? " · synced: a delete reaches every device" : "";

        return {
            id: `${opts.prefix}-${entry.path}`,
            analyzerId: this.id,
            title: entry.path.replace(this.home, "~"),
            detail: `${formatBytes(entry.size)} allocated${apparentNote} - modified ${daysSince(entry.mtime)}d ago${cloudNote}${blocked ? ` · ${entry.blockedReason}` : ""}`,
            severity: blocked ? "blocked" : "cautious",
            ...(blocked ? { blacklistReason: entry.blockedReason ?? undefined } : { reclaimableBytes: entry.size }),
            actions: blocked
                ? []
                : [stageTrashAction(entry.path), directDeleteAction(entry.path), revealInFinderAction(entry.path)],
            metadata: {
                path: entry.path,
                paths: [entry.path],
                size: entry.size,
                allocatedBytes: entry.size,
                apparentBytes: entry.apparent,
                mtime: entry.mtime.toISOString(),
                ...(cloud ? { cloudSync: cloud } : {}),
                ...(opts.blockers && opts.blockers.length > 0 ? { blockers: opts.blockers } : {}),
            },
        };
    }
}
