import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { isCommandAvailable, run, runInherit } from "@app/doctor/lib/run";
import { duBytes, formatBytes } from "@app/doctor/lib/size";
import type {
    Action,
    ActionResult,
    AnalyzerCategory,
    AnalyzerContext,
    ExecutorContext,
    Finding,
} from "@app/doctor/lib/types";

interface SizedPath {
    path: string;
    size: number;
    mtime: Date;
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

function stageTrashAction(path: string): Action {
    return {
        id: "stage-trash",
        label: "Move to Trash (staged - can be recovered)",
        confirm: "none",
        staged: true,
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

function statSizedPath(path: string): SizedPath | null {
    try {
        const stat = statSync(path);

        return { path, size: stat.size, mtime: stat.mtime };
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

    protected async *run(ctx: AnalyzerContext): AsyncIterable<Finding> {
        const home = homedir();

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
            const entry = statSizedPath(path);

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
                    execute: async (_ctx, finding): Promise<ActionResult> => {
                        const res = await run("osascript", ["-e", 'tell application "Finder" to empty trash']);

                        return {
                            findingId: finding.id,
                            actionId: "empty-trash",
                            status: res.status === 0 ? "ok" : "failed",
                            actualReclaimedBytes: finding.reclaimableBytes,
                        };
                    },
                },
            ],
            metadata: { path: trash },
        };
    }

    private async *findTimeMachineSnapshots(): AsyncIterable<Finding> {
        const tmRes = await run("tmutil", ["listlocalsnapshots", "/"]);
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
                    execute: async (_ctx, finding): Promise<ActionResult> => {
                        for (const snapshot of snapshots) {
                            await run("tmutil", ["deletelocalsnapshots", localSnapshotName(snapshot)]);
                        }

                        return {
                            findingId: finding.id,
                            actionId: "delete-snapshots",
                            status: "ok",
                            metadata: { count: snapshots.length },
                        };
                    },
                },
            ],
            metadata: { snapshots },
        };
    }

    private async *findLargeFiles(ctx: AnalyzerContext, home: string): AsyncIterable<Finding> {
        const useFd = await isFdAvailable();
        const cmd = useFd ? "fd" : "find";
        const args = useFd
            ? ["-H", "-t", "f", "-S", "+500m", "--max-depth", "6", "--", ".", home]
            : [home, "-type", "f", "-size", "+500M", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"];

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
            .map((path) => statSizedPath(path))
            .filter((entry): entry is SizedPath => entry !== null)
            .sort((a, b) => b.size - a.size)
            .slice(0, 20);

        for (const entry of sized) {
            yield this.buildFileFinding({ prefix: "disk-large", entry });
        }
    }

    private buildFileFinding(opts: { prefix: string; entry: SizedPath }): Finding {
        return {
            id: `${opts.prefix}-${opts.entry.path}`,
            analyzerId: this.id,
            title: opts.entry.path.replace(homedir(), "~"),
            detail: `${formatBytes(opts.entry.size)} - modified ${daysSince(opts.entry.mtime)}d ago`,
            severity: "cautious",
            reclaimableBytes: opts.entry.size,
            actions: [
                stageTrashAction(opts.entry.path),
                directDeleteAction(opts.entry.path),
                revealInFinderAction(opts.entry.path),
            ],
            metadata: {
                path: opts.entry.path,
                size: opts.entry.size,
                mtime: opts.entry.mtime.toISOString(),
            },
        };
    }
}
