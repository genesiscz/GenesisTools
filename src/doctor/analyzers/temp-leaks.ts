import { type Dirent, existsSync, lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { devRoots } from "@app/doctor/lib/dev-roots";
import { ageDaysOf, allocatedOf, type MeasureBudget, measurePath, measurePaths } from "@app/doctor/lib/fs-measure";
import {
    type CwdReader,
    findRunning,
    listProcesses,
    othersOnly,
    PROCESS_LIST_UNAVAILABLE,
    type ProcessLister,
    type ProcInfo,
    readCwds,
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
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { captureSync } from "@genesiscz/utils/process/ps";

export const TEMP_LEAKS_ANALYZER_ID = "temp-leaks";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const GIB = 1024 * 1024 * 1024;

/** A clone born up to 5 s before or 60 s after a running main process started belongs to it. Measured on
 *  2026-10-13: Chrome started 17:17:55 and its clone was born 17:17:59; Brave 13:08:00 and 13:08:03. */
export const CLONE_OWNER_BEFORE_MS = 5_000;
export const CLONE_OWNER_AFTER_MS = 60_000;
/** A clone younger than this is never called a leak: its browser may still be starting. */
export const CLONE_YOUNG_MS = 10 * 60_000;
/** With this many leaked clones the delete needs the typed phrase. */
export const CLONE_TYPED_THRESHOLD = 5;
export const SCRATCH_STALE_MS = 3 * DAY_MS;
export const SCRATCH_TYPED_BYTES = 5 * GIB;
const SCRATCH_MIN_BYTES = 10 * 1024 * 1024;
/** macOS's own cleaner (`com.apple.bsd.dirhelper`, `CLEAN_FILES_OLDER_THAN_DAYS=3`) uses 3 days, so an unknown
 *  owner's entry waits that long. Entries under a GenesisTools-owned prefix are test fixtures: 1 day. */
export const TMPDIR_STALE_MS = 3 * DAY_MS;
export const TMPDIR_OWNED_STALE_MS = DAY_MS;
const TMPDIR_GROUP_MIN_BYTES = 20 * 1024 * 1024;
const TMPDIR_GROUP_MIN_ENTRIES = 100;
const TMPDIR_MAX_GROUPS = 30;
/** Total time the `$TMPDIR` rule may spend sizing old folders; the rest of the folders wait for the next run. */
const TMPDIR_MEASURE_BUDGET_MS = 4_000;
export const SWIFTPM_STALE_MS = 2 * DAY_MS;
const SWIFT_PROCESS_NAMES = ["swift-build", "swift-frontend", "swift-test", "swift-package", "xctest"];
const SWIFTPM_SEARCH_DEPTH = 6;
const SWIFTPM_DIR_BUDGET = 50_000;
const SKIP_WALK = new Set(["node_modules", ".git", ".build", "DerivedData", "Pods", "removals"]);

/** `$TMPDIR` name prefixes written by GenesisTools and the GenesisKit tests: safe to delete once they are old. */
export const TMPDIR_OWNED_PREFIXES = [
    "md-",
    "scroll-session",
    "session-details-fixture",
    "hub-",
    "monitor-alerts",
    "titlebar-drop",
    "genesis-",
    "gt-",
];

export function isOwnedTmpPrefix(prefix: string): boolean {
    return TMPDIR_OWNED_PREFIXES.some((owner) => prefix.startsWith(owner));
}

const WORKTREE_REMOVE_HINT = toolCommand("hub worktrees remove", "<path>", "--yes", "--json");

export const CODESIGN_CLONE_PREVENTION = {
    chromeFlag: "--disable-features=MacAppCodeSignClone",
    close: "Close automation Chrome through its CDP Browser.close method, never a kill signal",
};

export interface TempLeaksOptions {
    /** `dirname($(getconf DARWIN_USER_TEMP_DIR))/X`, where macOS keeps `code_sign_clone` app copies. */
    xDir?: string | null;
    /** `$(getconf DARWIN_USER_TEMP_DIR)`. */
    tmpDir?: string | null;
    /** The agents' scratch root; default `GENESIS_TOOLS_AGENT_SCRATCH_ROOT`, and none when that is unset. */
    ccRoot?: string;
    /** Extra moved-aside folder names under `/tmp` (globs); default `GENESIS_TOOLS_MOVED_ASIDE_GLOBS`. */
    movedAsideGlobs?: string[];
    /** `/tmp`, for the moved-aside folders. */
    tmpRoot?: string;
    /** Checkout roots whose `<repo>/.worktrees/*` hold SwiftPM copies. */
    repoRoots?: string[];
    home?: string;
    now?: () => number;
    processes?: ProcessLister;
    cwds?: CwdReader;
    gate?: ScanGateReader;
    budget?: MeasureBudget;
    /** Size floors below which a stale item is not worth a row (tests lower them). */
    thresholds?: { scratchMinBytes?: number; tmpdirGroupMinBytes?: number; tmpdirGroupMinEntries?: number };
}

interface ResolvedDirs {
    xDir: string | null;
    tmpDir: string | null;
    ccRoot: string | null;
    tmpRoot: string | null;
    movedAsideGlobs: string[];
    repoRoots: string[];
}

type RuleKind =
    | "codesign-clone"
    | "tmp-cc-session"
    | "tmp-cc-worktree"
    | "moved-aside"
    | "tmpdir"
    | "tmp-sibling"
    | "swiftpm-build";

interface Ctx {
    dirs: ResolvedDirs;
    gate: ScanGateState;
    /** Other processes (this run and its ancestors left out); empty when the table could not be read. */
    procs: ProcInfo[];
    /** False when `ps` failed: no owner can be ruled out, so the owner checks turn into blockers. */
    procsOk: boolean;
    now: number;
}

/** A moved-aside folder younger than this is left alone: whoever moved it may still restore from it. */
export const MOVED_ASIDE_MIN_AGE_MS = DAY_MS;

function safeReaddir(path: string): string[] {
    try {
        return readdirSync(path);
    } catch {
        return [];
    }
}

function safeReaddirEntries(path: string): Dirent[] {
    try {
        return readdirSync(path, { withFileTypes: true });
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

/** A `*` glob against one folder name, whole-name match. */
function globMatches(glob: string, name: string): boolean {
    const pattern = glob
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${pattern}$`).test(name);
}

function realOrNull(path: string | null | undefined): string | null {
    if (!path) {
        return null;
    }

    try {
        return realpathSync(path);
    } catch {
        return null;
    }
}

function isUuid(name: string): boolean {
    return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(name);
}

/** The stable part of a `$TMPDIR` entry name: tokens up to the first one that looks generated (has a digit, is long
 *  hex, or is a mixed-case run of six or more letters). */
export function tmpPrefix(name: string): string {
    const parts = name.split(/([-_.])/);
    let prefix = "";

    for (const part of parts) {
        if (part === "-" || part === "_" || part === ".") {
            prefix += part;
            continue;
        }

        const generated =
            /\d/.test(part) ||
            /^[0-9a-f]{6,}$/i.test(part) ||
            (part.length >= 6 && /[a-z]/.test(part) && /[A-Z]/.test(part) && !/[a-z]{3}/.test(part));

        if (generated) {
            break;
        }

        prefix += part;
    }

    const trimmed = prefix.replace(/[-_.]+$/, "");
    return trimmed.length > 0 ? trimmed : "(unnamed)";
}

function displayPath(path: string, home: string): string {
    // lint-rules-ignore: deliberate /tmp — shows macOS's /private/tmp under the name users know, display only
    return path.replace(/^\/private\/tmp\//, "/tmp/").replace(home, "~");
}

function metadata(base: ReclaimMetadataInput): ReclaimMetadata {
    return { owner: null, ...base };
}

export class TempLeaksAnalyzer extends Analyzer {
    readonly id = TEMP_LEAKS_ANALYZER_ID;
    readonly name = "Temp & Leaks";
    readonly icon = "T";
    readonly category: AnalyzerCategory = "disk";
    readonly cacheTtlMs = 0;
    private resolved: ResolvedDirs | null = null;

    constructor(private readonly options: TempLeaksOptions = {}) {
        super();
    }

    private get home(): string {
        return this.options.home ?? homedir();
    }

    private now(): number {
        return this.options.now ? this.options.now() : Date.now();
    }

    private async dirs(): Promise<ResolvedDirs> {
        if (this.resolved) {
            return this.resolved;
        }

        let tmpDir = this.options.tmpDir;
        let xDir = this.options.xDir;

        if (tmpDir === undefined || xDir === undefined) {
            const res = await run("getconf", ["DARWIN_USER_TEMP_DIR"], { timeoutMs: 5_000 });
            const darwinTemp = res.status === 0 ? res.stdout.trim().replace(/\/$/, "") : "";
            tmpDir = tmpDir === undefined ? (darwinTemp ? darwinTemp : null) : tmpDir;
            xDir = xDir === undefined ? (darwinTemp ? join(dirname(darwinTemp), "X") : null) : xDir;
        }

        this.resolved = {
            xDir: realOrNull(xDir),
            tmpDir: realOrNull(tmpDir),
            ccRoot: realOrNull(this.options.ccRoot ?? env.doctor.getAgentScratchRoot()),
            tmpRoot: realOrNull(this.options.tmpRoot ?? "/tmp"),
            movedAsideGlobs: this.options.movedAsideGlobs ?? env.doctor.getMovedAsideGlobs(),
            repoRoots: (this.options.repoRoots ?? devRoots(this.home))
                .map((root) => realOrNull(root))
                .filter((root): root is string => root !== null),
        };
        return this.resolved;
    }

    override allowRoots(): string[] {
        const dirs = this.resolved;

        if (!dirs) {
            return [];
        }

        // Narrow on purpose: never all of /tmp. Globs are matched against real paths.
        const roots = [dirs.tmpDir, dirs.ccRoot].filter((root): root is string => !!root);

        if (dirs.xDir) {
            roots.push(join(dirs.xDir, "*.code_sign_clone"));
        }

        if (dirs.tmpRoot) {
            const tmpRoot = dirs.tmpRoot;
            roots.push(
                join(tmpRoot, "*-agents-removals"),
                ...dirs.movedAsideGlobs.map((glob) => join(tmpRoot, glob)),
                join(tmpRoot, "GenesisTools", "ChromeDevtools")
            );
        }

        for (const repoRoot of dirs.repoRoots) {
            for (const repo of safeReaddir(repoRoot)) {
                const worktrees = join(repoRoot, repo, ".worktrees");

                if (existsSync(worktrees)) {
                    roots.push(worktrees);
                }
            }
        }

        return roots;
    }

    private async context(): Promise<Ctx> {
        const [dirs, gate, snapshot] = await Promise.all([
            this.dirs(),
            (this.options.gate ?? readScanGate)(),
            snapshotProcesses(this.options.processes ?? listProcesses),
        ]);
        const procs = snapshot.ok ? othersOnly(snapshot.procs) : [];
        return { dirs, gate, procs, procsOk: snapshot.ok, now: this.now() };
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
        const c = await this.context();
        const want = (kind: RuleKind): boolean => kinds === null || kinds.has(kind);
        const stage = (item: string): void =>
            ctx.emit({ type: "progress", analyzerId: this.id, phase: "scanning", currentItem: item, findingsCount: 0 });

        if (want("codesign-clone")) {
            stage("code_sign_clone copies");
            yield* this.codesignClones(c);
        }

        if (want("moved-aside")) {
            stage("moved-aside folders");
            yield* this.movedAside(c);
        }

        if (want("tmpdir")) {
            stage("$TMPDIR");
            yield* this.tmpdirGroups(c);
        }

        if (want("tmp-sibling")) {
            yield* this.siblings(c);
        }

        if (c.gate.gated) {
            return;
        }

        if (want("tmp-cc-session") || want("tmp-cc-worktree")) {
            // lint-rules-ignore: deliberate /tmp — a progress label naming the macOS scratch root
            stage("/tmp/cc scratch");
            yield* this.scratch(c, want("tmp-cc-session"), want("tmp-cc-worktree"));
        }

        if (want("swiftpm-build")) {
            stage("SwiftPM .build copies");
            yield* this.swiftpmBuilds(c);
        }
    }

    private remover(id: string, label: string, opts: { typed?: boolean } = {}) {
        return removePathsAction({
            id,
            label,
            confirm: opts.typed ? "typed" : "yesno",
            ...(opts.typed ? { confirmPhrase: "DELETE" } : {}),
            analyzerId: this.id,
            home: this.home,
            allowRoots: () => this.allowRoots(),
        });
    }

    private budget(extra: MeasureBudget = {}): MeasureBudget {
        return { ...this.options.budget, ...extra };
    }

    private *codesignClones(c: Ctx): Iterable<Finding> {
        const xDir = c.dirs.xDir;

        // Without the process table a running browser's own copy cannot be told from a leak, so nothing is listed.
        if (!xDir || !c.procsOk) {
            return;
        }

        const leaks: Array<{
            bundleId: string;
            tag: string;
            path: string;
            bornMs: number;
            appName: string | null;
            running: number;
        }> = [];

        for (const bundleDirName of safeReaddir(xDir)) {
            if (!bundleDirName.endsWith(".code_sign_clone")) {
                continue;
            }

            const bundleId = bundleDirName.slice(0, -".code_sign_clone".length);
            const bundleDir = join(xDir, bundleDirName);

            for (const cloneName of safeReaddir(bundleDir)) {
                if (!cloneName.startsWith("code_sign_clone.")) {
                    continue;
                }

                const path = join(bundleDir, cloneName);
                const stat = safeLstat(path);

                if (!stat?.isDirectory()) {
                    continue;
                }

                // The earlier of birth and modification: a clone is finished seconds after it is born, and where the
                // filesystem reports no birth time the modification time stands in.
                const bornMs = stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs;
                const appBundle = safeReaddir(path).find((name) => /\.app(\.bundle)?$/.test(name));
                const appName = appBundle ? appBundle.replace(/\.bundle$/, "").replace(/\.app$/, "") : null;
                const mains = appName
                    ? c.procs.filter(
                          (proc) =>
                              proc.command.includes(`/${appName}.app/Contents/MacOS/`) &&
                              !proc.command.includes("--type=")
                      )
                    : [];
                const owned = mains.some((proc) => {
                    const started = proc.startedAt?.getTime();
                    return (
                        started !== undefined &&
                        bornMs >= started - CLONE_OWNER_BEFORE_MS &&
                        bornMs <= started + CLONE_OWNER_AFTER_MS
                    );
                });

                if (owned || c.now - bornMs < CLONE_YOUNG_MS) {
                    continue;
                }

                leaks.push({
                    bundleId,
                    tag: cloneName.slice("code_sign_clone.".length),
                    path,
                    bornMs,
                    appName,
                    running: mains.length,
                });
            }
        }

        const typed = leaks.length >= CLONE_TYPED_THRESHOLD;

        for (const leak of leaks) {
            const size = c.gate.gated ? null : measurePath(leak.path, this.budget());
            const app = leak.appName ?? leak.bundleId;
            const reclaimable = size ? (size.freeableFloorBytes ?? size.allocatedBytes) : undefined;
            const ownerText =
                leak.running > 0
                    ? `${leak.running} running ${app} started at another time`
                    : `no running ${app} owns it`;
            const sizeText = size
                ? `${formatBytes(size.allocatedBytes)} allocated${size.freeableFloorBytes !== null ? `, at least ${formatBytes(size.freeableFloorBytes)} freed` : ""}`
                : "size not measured (scan gate)";

            yield {
                id: `${this.id}:codesign-clone:${leak.bundleId}:${leak.tag}`,
                analyzerId: this.id,
                title: `Leaked ${app} app copy (code_sign_clone.${leak.tag})`,
                detail:
                    `${sizeText} · born ${ageDaysOf(leak.bornMs, c.now)}d ago, ${ownerText}. ` +
                    `Prevent new copies: start automation Chrome with ${CODESIGN_CLONE_PREVENTION.chromeFlag}, ` +
                    "and close it through its CDP Browser.close method, never a kill signal.",
                severity: "cautious",
                ...(reclaimable !== undefined ? { reclaimableBytes: reclaimable } : {}),
                actions: [this.remover("delete-clone", "Delete the leaked app copy", { typed })],
                metadata: metadata({
                    kind: "codesign-clone",
                    paths: [leak.path],
                    allocatedBytes: size?.allocatedBytes ?? null,
                    apparentBytes: size?.apparentBytes ?? null,
                    ...(size?.freeableFloorBytes != null ? { freeableFloorBytes: size.freeableFloorBytes } : {}),
                    ageDays: ageDaysOf(leak.bornMs, c.now),
                    regenerates: false,
                    sizeKnown: size?.complete ?? false,
                    ...(size ? { fileCount: size.entries } : {}),
                    bundleId: leak.bundleId,
                    appName: leak.appName,
                    bornAt: new Date(leak.bornMs).toISOString(),
                    prevention: CODESIGN_CLONE_PREVENTION,
                }),
            };
        }
    }

    private *movedAside(c: Ctx): Iterable<Finding> {
        const items: Array<{ path: string; container: string }> = [];
        const tmpRoot = c.dirs.tmpRoot;

        if (tmpRoot) {
            for (const name of safeReaddir(tmpRoot)) {
                const path = join(tmpRoot, name);

                if (/^\d{8}-agents-removals$/.test(name)) {
                    for (const context of safeReaddir(path)) {
                        items.push({ path: join(path, context), container: path });
                    }
                } else if (c.dirs.movedAsideGlobs.some((glob) => globMatches(glob, name))) {
                    items.push({ path, container: tmpRoot });
                }
            }

            const cdp = join(tmpRoot, "GenesisTools", "ChromeDevtools");

            for (const name of safeReaddir(cdp)) {
                if (name.startsWith("trash-")) {
                    items.push({ path: join(cdp, name), container: cdp });
                }
            }
        }

        const ccRoot = c.dirs.ccRoot;

        if (ccRoot) {
            for (const project of safeReaddir(ccRoot)) {
                for (const session of safeReaddir(join(ccRoot, project))) {
                    const removals = join(ccRoot, project, session, "removals");

                    for (const context of safeReaddir(removals)) {
                        items.push({ path: join(removals, context), container: removals });
                    }
                }
            }
        }

        for (const item of items) {
            const stat = safeLstat(item.path);

            // A rename moves ctime, not mtime: the later of the two is when it was moved aside (or last touched).
            if (
                !stat ||
                stat.isSymbolicLink() ||
                c.now - Math.max(stat.ctimeMs, stat.mtimeMs) < MOVED_ASIDE_MIN_AGE_MS
            ) {
                continue;
            }

            const size = c.gate.gated ? null : measurePath(item.path, this.budget());
            const restoreScript = [join(item.path, "RESTORE.sh"), join(item.container, "RESTORE.sh")].find(existsSync);
            const restoreHint = restoreScript
                ? `Restore with ${restoreScript} before deleting if anything is still needed`
                : "Moved aside earlier; move it back to where it came from if it is still needed (the move printed a restore line)";

            yield {
                id: `${this.id}:moved-aside:${item.path}`,
                analyzerId: this.id,
                title: `Moved-aside leftovers ${displayPath(item.path, this.home)}`,
                detail: `${size ? formatBytes(size.allocatedBytes) : "size not measured"} · a move on the same volume freed nothing; only a delete does`,
                severity: "cautious",
                ...(size ? { reclaimableBytes: size.freeableFloorBytes ?? size.allocatedBytes } : {}),
                actions: [this.remover("delete-moved-aside", "Delete the moved-aside folder")],
                metadata: metadata({
                    kind: "moved-aside",
                    paths: [item.path],
                    allocatedBytes: size?.allocatedBytes ?? null,
                    apparentBytes: size?.apparentBytes ?? null,
                    ...(size?.freeableFloorBytes != null ? { freeableFloorBytes: size.freeableFloorBytes } : {}),
                    ageDays: ageDaysOf(size?.newestMtimeMs ?? stat.mtimeMs, c.now),
                    regenerates: false,
                    restoreHint,
                    sizeKnown: size?.complete ?? false,
                    ...(size ? { fileCount: size.entries } : {}),
                }),
            };
        }
    }

    private *tmpdirGroups(c: Ctx): Iterable<Finding> {
        const tmpDir = c.dirs.tmpDir;

        if (!tmpDir) {
            return;
        }

        const groups = new Map<
            string,
            { paths: string[]; allocated: number; apparent: number; newestMs: number; oldestMs: number; dirs: number }
        >();
        const measureUntil = Date.now() + TMPDIR_MEASURE_BUDGET_MS;

        for (const entry of safeReaddirEntries(tmpDir)) {
            const name = entry.name;

            if (name.startsWith(".") || name.startsWith("com.apple.")) {
                continue;
            }

            const path = join(tmpDir, name);
            const stat = safeLstat(path);

            if (!stat || c.now - stat.mtimeMs < HOUR_MS) {
                continue;
            }

            // Only plain files and folders: a socket or FIFO belongs to a live process however old its mtime is, and
            // a symbolic link is never removed (the Trash would take its target).
            if (!stat.isFile() && !stat.isDirectory()) {
                continue;
            }

            if (stat.isFile() && stat.size === 0 && name.endsWith(".lock")) {
                continue;
            }

            const prefix = tmpPrefix(name);
            const staleMs = isOwnedTmpPrefix(prefix) ? TMPDIR_OWNED_STALE_MS : TMPDIR_STALE_MS;
            let allocated = allocatedOf(stat);
            let apparent = stat.size;
            let newest = stat.mtimeMs;

            if (stat.isDirectory()) {
                if (c.gate.gated || c.now - stat.mtimeMs < staleMs || Date.now() > measureUntil) {
                    continue;
                }

                const size = measurePath(path, this.budget({ maxEntries: 20_000, deadlineMs: 1_000 }));

                if (!size?.complete) {
                    continue;
                }

                allocated = size.allocatedBytes;
                apparent = size.apparentBytes;
                newest = size.newestMtimeMs;
            }

            if (c.now - newest < staleMs) {
                continue;
            }

            const group = groups.get(prefix) ?? {
                paths: [],
                allocated: 0,
                apparent: 0,
                newestMs: 0,
                oldestMs: Number.POSITIVE_INFINITY,
                dirs: 0,
            };
            group.paths.push(path);
            group.allocated += allocated;
            group.apparent += apparent;
            group.newestMs = Math.max(group.newestMs, newest);
            group.oldestMs = Math.min(group.oldestMs, newest);
            group.dirs += stat.isDirectory() ? 1 : 0;
            groups.set(prefix, group);
        }

        const ranked = [...groups.entries()]
            .filter(
                ([, g]) =>
                    g.allocated >= (this.options.thresholds?.tmpdirGroupMinBytes ?? TMPDIR_GROUP_MIN_BYTES) ||
                    g.paths.length >= (this.options.thresholds?.tmpdirGroupMinEntries ?? TMPDIR_GROUP_MIN_ENTRIES)
            )
            .sort((a, b) => b[1].allocated - a[1].allocated)
            .slice(0, TMPDIR_MAX_GROUPS);

        for (const [prefix, group] of ranked) {
            const owned = isOwnedTmpPrefix(prefix);
            const severity: Severity = owned ? "safe" : "cautious";
            group.paths.sort();

            yield {
                id: `${this.id}:tmpdir:${prefix}`,
                analyzerId: this.id,
                title: `$TMPDIR ${prefix}* · ${group.paths.length} entries older than ${owned ? "1 day" : "3 days"}`,
                detail: `${formatBytes(group.allocated)} allocated · oldest ${ageDaysOf(group.oldestMs, c.now)}d, newest ${ageDaysOf(group.newestMs, c.now)}d${owned ? "" : " · owner not known: check before deleting"}`,
                severity,
                reclaimableBytes: group.allocated,
                actions: [this.remover("delete-tmp-group", "Delete these old temp entries")],
                metadata: metadata({
                    kind: "tmpdir-group",
                    paths: group.paths,
                    allocatedBytes: group.allocated,
                    apparentBytes: group.apparent,
                    ageDays: ageDaysOf(group.newestMs, c.now),
                    regenerates: true,
                    sizeKnown: true,
                    prefix,
                    entries: group.paths.length,
                    oldestAgeDays: ageDaysOf(group.oldestMs, c.now),
                    ownedPrefix: owned,
                }),
            };
        }
    }

    private *siblings(c: Ctx): Iterable<Finding> {
        const xDir = c.dirs.xDir;

        if (!xDir) {
            return;
        }

        for (const name of safeReaddir(xDir)) {
            if (!isUuid(name)) {
                continue;
            }

            const path = join(xDir, name);
            const stat = safeLstat(path);

            if (!stat?.isDirectory()) {
                continue;
            }

            yield {
                id: `${this.id}:tmp-sibling:X:${name}`,
                analyzerId: this.id,
                title: `System folder ${displayPath(path, this.home)}`,
                detail: "Owned by the system; macOS manages it. Listed so it is not mistaken for a leak.",
                severity: "blocked",
                blacklistReason:
                    "System-owned folder (root). macOS manages it; listing it fails with fts_read: Result too large.",
                actions: [],
                metadata: metadata({
                    kind: "tmp-sibling",
                    paths: [path],
                    allocatedBytes: null,
                    apparentBytes: null,
                    ageDays: ageDaysOf(stat.mtimeMs, c.now),
                    regenerates: false,
                    sizeKnown: false,
                }),
            };
        }
    }

    private *scratch(c: Ctx, sessions: boolean, worktrees: boolean): Iterable<Finding> {
        const ccRoot = c.dirs.ccRoot;

        if (!ccRoot) {
            return;
        }

        const cwdList = [...(this.options.cwds ?? readCwds)(c.procs.map((proc) => proc.pid)).entries()];

        for (const project of safeReaddirEntries(ccRoot)) {
            if (!project.isDirectory()) {
                continue;
            }

            const projectDir = join(ccRoot, project.name);

            for (const session of safeReaddirEntries(projectDir)) {
                if (!session.isDirectory()) {
                    continue;
                }

                const sessionDir = join(projectDir, session.name);
                const sessionStat = safeLstat(sessionDir);
                const paths: string[] = [];
                const excluded: Array<{ path: string; reason: string }> = [];
                const foundWorktrees: string[] = [];

                for (const child of safeReaddirEntries(sessionDir)) {
                    const childPath = join(sessionDir, child.name);

                    if (child.isSymbolicLink()) {
                        excluded.push({
                            path: childPath,
                            reason: "a symbolic link: never removed (the Trash would take its target)",
                        });
                    } else if (child.name === "removals") {
                        excluded.push({ path: childPath, reason: "moved-aside leftovers: listed on their own" });
                    } else if (child.name === "worktrees" && child.isDirectory()) {
                        for (const wt of safeReaddir(childPath)) {
                            foundWorktrees.push(join(childPath, wt));
                        }

                        excluded.push({
                            path: childPath,
                            reason: `git worktrees: remove them with ${WORKTREE_REMOVE_HINT}`,
                        });
                    } else if (child.isDirectory() && safeLstat(join(childPath, ".git"))?.isFile()) {
                        foundWorktrees.push(childPath);
                        excluded.push({
                            path: childPath,
                            reason: `a git worktree: remove it with ${WORKTREE_REMOVE_HINT}`,
                        });
                    } else {
                        paths.push(childPath);
                    }
                }

                if (worktrees) {
                    yield* this.scratchWorktrees(c, foundWorktrees);
                }

                if (!sessions || paths.length === 0) {
                    continue;
                }

                // Cheap pre-check before any walk: a session with a recent top-level change is live, whatever its
                // deeper files say. Only the ones that look old are walked to confirm and size them.
                const quickNewest = Math.max(
                    sessionStat?.mtimeMs ?? 0,
                    ...paths.map((path) => safeLstat(path)?.mtimeMs ?? 0)
                );

                if (c.now - quickNewest < SCRATCH_STALE_MS) {
                    continue;
                }

                const kept: string[] = [];
                let allocated = 0;
                let apparent = 0;
                let floor = 0;
                let floorKnown = true;
                let newest = sessionStat?.mtimeMs ?? 0;
                let complete = true;

                for (const path of paths) {
                    let nestedRepo = false;
                    const size = measurePath(
                        path,
                        this.budget({
                            maxEntries: 200_000,
                            deadlineMs: 4_000,
                            onFile: (file) => {
                                if (basename(file) === ".git" || file.includes("/.git/")) {
                                    nestedRepo = true;
                                }
                            },
                        })
                    );

                    if (nestedRepo) {
                        excluded.push({
                            path,
                            reason: "holds a git checkout or worktree (it may have local commits): remove it through git",
                        });
                        continue;
                    }

                    kept.push(path);

                    if (!size) {
                        complete = false;
                        floorKnown = false;
                        continue;
                    }

                    allocated += size.allocatedBytes;
                    apparent += size.apparentBytes;
                    newest = Math.max(newest, size.newestMtimeMs);
                    complete = complete && size.complete;

                    if (size.freeableFloorBytes === null) {
                        floorKnown = false;
                    } else {
                        floor += size.freeableFloorBytes;
                    }
                }

                if (
                    kept.length === 0 ||
                    c.now - newest < SCRATCH_STALE_MS ||
                    allocated < (this.options.thresholds?.scratchMinBytes ?? SCRATCH_MIN_BYTES)
                ) {
                    continue;
                }

                const blockers: string[] = [];
                const inside = cwdList.filter(([, cwd]) => cwd === sessionDir || cwd.startsWith(`${sessionDir}/`));

                if (inside.length > 0) {
                    blockers.push(`a process works inside (pid ${inside.map(([pid]) => pid).join(", ")})`);
                }

                if (!c.procsOk) {
                    blockers.push(PROCESS_LIST_UNAVAILABLE);
                }

                if (!complete) {
                    blockers.push("the size walk stopped early, so a nested git worktree cannot be ruled out");
                }

                const typed = allocated > SCRATCH_TYPED_BYTES;
                const reclaimable = floorKnown ? floor : allocated;

                yield {
                    id: `${this.id}:tmp-cc-session:${project.name}:${session.name}`,
                    analyzerId: this.id,
                    title: `Agent scratch ${displayPath(sessionDir, this.home)}`,
                    detail:
                        `${formatBytes(allocated)} allocated${floorKnown ? `, at least ${formatBytes(floor)} freed` : ""} · last change ${ageDaysOf(newest, c.now)}d ago` +
                        (excluded.length > 0 ? ` · ${excluded.map((e) => basename(e.path)).join(", ")} left out` : ""),
                    severity: "cautious",
                    reclaimableBytes: reclaimable,
                    actions: [this.remover("delete-scratch", "Delete the stale scratch entries", { typed })],
                    metadata: metadata({
                        kind: "tmp-cc-session",
                        paths: kept,
                        allocatedBytes: allocated,
                        apparentBytes: apparent,
                        ...(floorKnown ? { freeableFloorBytes: floor } : {}),
                        ageDays: ageDaysOf(newest, c.now),
                        regenerates: false,
                        sizeKnown: complete,
                        ...(blockers.length > 0 ? { blockers } : {}),
                        project: project.name,
                        session: session.name,
                        excluded,
                    }),
                };
            }
        }
    }

    private *scratchWorktrees(c: Ctx, paths: string[]): Iterable<Finding> {
        for (const path of paths) {
            const stat = safeLstat(path);
            const gitFile = safeLstat(join(path, ".git"));

            if (!stat?.isDirectory()) {
                continue;
            }

            const lastMs = Math.max(stat.mtimeMs, gitFile?.mtimeMs ?? 0);

            if (c.now - lastMs < SCRATCH_STALE_MS) {
                continue;
            }

            yield {
                id: `${this.id}:tmp-cc-worktree:${path}`,
                analyzerId: this.id,
                title: `Git worktree in scratch ${displayPath(path, this.home)}`,
                detail: `Remove it through git, never as a folder: ${WORKTREE_REMOVE_HINT}`,
                severity: "cautious",
                actions: [],
                metadata: metadata({
                    kind: "tmp-cc-worktree",
                    paths: [path],
                    allocatedBytes: null,
                    apparentBytes: null,
                    ageDays: ageDaysOf(lastMs, c.now),
                    regenerates: false,
                    sizeKnown: false,
                    command: toolCommand("hub worktrees remove", path, "--yes", "--json"),
                    sizeCommand: toolCommand("hub worktrees size", path, "--json"),
                }),
            };
        }
    }

    private findSwiftBuilds(c: Ctx): string[] {
        const found: string[] = [];
        let budget = SWIFTPM_DIR_BUDGET;

        const walk = (dir: string, depth: number): void => {
            if (depth > SWIFTPM_SEARCH_DEPTH || budget <= 0) {
                return;
            }

            budget -= 1;
            const entries = safeReaddirEntries(dir);

            // A checkout or worktree: its index names every Package.swift, so one `git ls-files` replaces walking
            // its (often thousands of) folders. Measured on 2026-10-13: the walk of /tmp/cc cost 2 s of CPU.
            if (entries.some((e) => e.name === ".git")) {
                for (const pkg of gitPackageDirs(dir)) {
                    if (safeLstat(join(pkg, ".build"))?.isDirectory()) {
                        found.push(join(pkg, ".build"));
                    }
                }

                return;
            }

            if (entries.some((e) => e.name === "Package.swift" && e.isFile())) {
                const build = entries.find((e) => e.name === ".build" && e.isDirectory());

                if (build) {
                    found.push(join(dir, ".build"));
                }
            }

            for (const entry of entries) {
                if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_WALK.has(entry.name)) {
                    walk(join(dir, entry.name), depth + 1);
                }
            }
        };

        if (c.dirs.ccRoot) {
            walk(c.dirs.ccRoot, 0);
        }

        for (const repoRoot of c.dirs.repoRoots) {
            for (const repo of safeReaddir(repoRoot)) {
                const worktrees = join(repoRoot, repo, ".worktrees");

                for (const wt of safeReaddir(worktrees)) {
                    walk(join(worktrees, wt), 0);
                }
            }
        }

        return [...new Set(found)];
    }

    private *swiftpmBuilds(c: Ctx): Iterable<Finding> {
        const builds = this.findSwiftBuilds(c);

        if (builds.length === 0) {
            return;
        }

        const swiftProcs = findRunning(c.procs, SWIFT_PROCESS_NAMES);
        const swiftCwds = [...(this.options.cwds ?? readCwds)(swiftProcs.map((proc) => proc.pid)).entries()];

        for (const build of builds) {
            const lastMs = swiftBuildLastUse(build);

            if (c.now - lastMs < SWIFTPM_STALE_MS) {
                continue;
            }

            const pkg = dirname(build);
            const inside = swiftCwds.filter(([, cwd]) => cwd === pkg || cwd.startsWith(`${pkg}/`));
            const blockers =
                inside.length > 0 ? [`a swift process works here (pid ${inside.map(([pid]) => pid).join(", ")})`] : [];

            if (!c.procsOk) {
                blockers.push(PROCESS_LIST_UNAVAILABLE);
            }
            const size = measurePaths([build], this.budget({ maxEntries: 400_000, deadlineMs: 8_000 }));

            yield {
                id: `${this.id}:swiftpm-build:${build}`,
                analyzerId: this.id,
                title: `SwiftPM .build copy in ${displayPath(pkg, this.home)}`,
                detail: `${formatBytes(size.allocatedBytes)} allocated · last build ${ageDaysOf(lastMs, c.now)}d ago · rebuilt by the next swift build`,
                severity: "safe",
                reclaimableBytes: size.freeableFloorBytes ?? size.allocatedBytes,
                actions: [this.remover("delete-swiftpm-build", "Delete the whole .build folder")],
                metadata: metadata({
                    kind: "swiftpm-build",
                    paths: [build],
                    allocatedBytes: size.allocatedBytes,
                    apparentBytes: size.apparentBytes,
                    ...(size.freeableFloorBytes !== null ? { freeableFloorBytes: size.freeableFloorBytes } : {}),
                    ageDays: ageDaysOf(lastMs, c.now),
                    requires: { absentProcesses: SWIFT_PROCESS_NAMES },
                    regenerates: true,
                    sizeKnown: size.complete,
                    ...(blockers.length > 0 ? { blockers } : {}),
                    fileCount: size.entries,
                    packagePath: join(pkg, "Package.swift"),
                }),
            };
        }
    }
}

/** Folders holding a tracked `Package.swift` in the git checkout at `dir`, from its index. Empty when git fails. */
export function gitPackageDirs(dir: string): string[] {
    const res = captureSync("git", ["-C", dir, "ls-files", "-z", "--", "Package.swift", "*/Package.swift"], {
        timeoutMs: 5_000,
    });

    if (res.status !== 0) {
        return [];
    }

    return res.stdout
        .split("\0")
        .filter((rel) => rel.endsWith("Package.swift"))
        .map((rel) => dirname(join(dir, rel)));
}

/** The newest of the cheap markers a SwiftPM build touches: the folder, its workspace state, and the per-triple
 *  `debug`/`release` folders and plan. No walk of the (often 100k-file) tree. */
export function swiftBuildLastUse(build: string): number {
    const probes = [build, join(build, "workspace-state.json")];

    for (const triple of safeReaddir(build)) {
        for (const config of ["debug", "release"]) {
            probes.push(join(build, triple, config), join(build, triple, config, "description.json"));
        }
    }

    let newest = 0;

    for (const probe of probes) {
        const stat = safeLstat(probe);

        if (stat) {
            newest = Math.max(newest, stat.mtimeMs);
        }
    }

    return newest;
}
