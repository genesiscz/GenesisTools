import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type OpenFilesQuery, type OpenFilesResult, openFiles } from "@genesiscz/utils/process/open-files";
import { codexHomesIn } from "@genesiscz/utils/providers/session-paths";
import { Storage } from "@genesiscz/utils/storage";

const { log } = logger.scoped("codex-migrate-home");

/** Per-home databases and locks a running Codex holds; moving a home under them corrupts both. */
export const HOME_LOCK_FILES = ["logs_2.sqlite", "queue_1.sqlite", "goals_1.sqlite"] as const;
const SQLITE_SIDECARS = ["", "-wal", "-shm"] as const;
export const GLOBAL_STATE_FILE = ".codex-global-state.json";
export const REINDEX_COMMAND = "tools codex history index sync";
export const PROVENANCE_NOTE =
    "AILaunchers/Verify-CodexAccountProvenance.md in the notes vault holds the per-rollout home mapping; " +
    "after the move `session_metadata.source_home` is re-keyed to the destination and that attribution is gone.";

const ROLLOUT_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface RolloutFile {
    /** Absolute path of the rollout. */
    path: string;
    /** Path below `<home>/sessions`, reused verbatim so the date tree survives the copy. */
    relativePath: string;
    /** The uuid at the end of the filename, which is the native session id. */
    nativeId: string;
    size: number;
}

export interface RolloutMetaIds {
    /** `session_meta.payload.id`, the identity the readiness note compared on. */
    id?: string;
    /** `session_meta.payload.session_id`, which repeats across a fork chain. */
    sessionId?: string;
    cwd?: string;
}

export interface CollisionReport {
    nativeId: string;
    sourcePath: string;
    destinationPath: string;
    sourceMeta: RolloutMetaIds;
    destinationMeta: RolloutMetaIds;
}

export interface SkippedRollout {
    nativeId: string;
    path: string;
    holders: ProcessHolder[];
}

export interface SourceReport {
    home: string;
    sessionsDir: string;
    rollouts: number;
    toCopy: number;
    alreadyPresent: number;
    collisions: CollisionReport[];
    copied: number;
    /** Rollouts a live process still writes: left for a later run, never copied half-written. */
    skippedLive: SkippedRollout[];
    archivedTo?: string;
}

export interface ProcessHolder {
    pid: number;
    command: string;
    path: string;
}

export interface BusyReport {
    home: string;
    status: "clear" | "busy" | "unknown";
    holders: ProcessHolder[];
}

export interface LocalProject {
    id?: string;
    name?: string;
    rootPaths?: string[];
    createdAt?: number;
    updatedAt?: number;
}

export interface ThreadAssignment {
    projectKind?: string;
    projectId?: string;
}

export interface DesktopState {
    "local-projects"?: Record<string, LocalProject>;
    "project-order"?: string[];
    "thread-project-assignments"?: Record<string, ThreadAssignment>;
    [key: string]: unknown;
}

export interface DesktopMergeReport {
    projectsAdded: Array<{ id: string; name?: string; rootPaths: string[] }>;
    duplicatesAvoided: Array<{ rootPath: string; sourceId: string; destinationId: string }>;
    orderAppended: string[];
    assignmentsAdded: number;
    assignmentsRemapped: number;
    assignmentsKept: number;
}

export interface DesktopReport extends DesktopMergeReport {
    home: string;
    sourceStatePath: string;
    destinationStatePath: string;
    written: boolean;
}

export type RefusalReason = "busy" | "collision" | "no-sources" | "missing-destination";

export interface Refusal {
    reason: RefusalReason;
    detail: string;
}

export interface MigrateHomeReport {
    destination: string;
    stamp: string;
    applied: boolean;
    desktopRequested: boolean;
    archiveSourceRequested: boolean;
    busy: BusyReport[];
    sources: SourceReport[];
    totals: {
        rollouts: number;
        toCopy: number;
        alreadyPresent: number;
        collisions: number;
        copied: number;
        skippedLive: number;
    };
    backups: { sessions?: string; globalState?: string };
    desktop: DesktopReport[];
    refusals: Refusal[];
    reindexCommand: string;
    provenanceNote: string;
}

export interface MigrateHomeOptions {
    /** Source homes. Empty means "discover every `~/.codex-*` sibling that holds sessions". */
    from?: string[];
    to?: string;
    apply?: boolean;
    desktop?: boolean;
    archiveSource?: boolean;
    /** Where the destination backup is cloned. Defaults to `~/.genesis-tools/codex/migrate-home`. */
    backupRoot?: string;
    stamp?: string;
    /** Injected by tests so a fixture can pretend a home is held open, or unanswerable. */
    inspectOpenFiles?: (query: OpenFilesQuery) => OpenFilesResult;
    /** Injected by tests to resolve symlinked fixture roots consistently. */
    realpath?: (path: string) => string;
}

export function migrationStamp(date = new Date()): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "-",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join("");
}

function defaultRealpath(path: string): string {
    try {
        return realpathSync(path);
    } catch (err) {
        log.debug({ path, error: err }, "realpath failed; falling back to the resolved path");
        return resolve(path);
    }
}

export function normaliseRootPath(path: string, realpath: (value: string) => string = defaultRealpath): string {
    const resolved = realpath(path);
    const trimmed = resolved.replace(/[/\\]+$/, "");
    return trimmed.length > 0 ? trimmed : resolved;
}

export function sessionsDirOf(home: string): string {
    return join(home, "sessions");
}

/**
 * Every `~/.codex-*` sibling that actually holds transcripts. `codexHomesIn` already refuses
 * `~/.codex.bak-…` because the separator is a dot rather than a hyphen; a home written as
 * `~/.codex-bak-…` would pass that filter, so the name is checked here too.
 */
export function discoverSourceHomes(destination: string, root = homedir()): string[] {
    const destinationKey = normaliseRootPath(destination);

    return codexHomesIn(root).filter((home) => {
        if (normaliseRootPath(home) === destinationKey) {
            return false;
        }

        if (/[.-]bak-/.test(basename(home))) {
            return false;
        }

        return existsSync(sessionsDirOf(home));
    });
}

export function enumerateRollouts(sessionsDir: string): RolloutFile[] {
    if (!existsSync(sessionsDir)) {
        return [];
    }

    const found: RolloutFile[] = [];

    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
        )) {
            const path = join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(path);
                continue;
            }

            if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
                continue;
            }

            found.push({
                path,
                relativePath: relative(sessionsDir, path),
                nativeId: ROLLOUT_ID.exec(entry.name)?.[1]?.toLowerCase() ?? entry.name,
                size: statSync(path).size,
            });
        }
    };

    walk(sessionsDir);
    return found;
}

export async function readRolloutMetaIds(path: string): Promise<RolloutMetaIds> {
    try {
        const head = await Bun.file(path).slice(0, 16_384).text();
        const firstLine = head.split("\n", 1)[0];

        if (!firstLine) {
            return {};
        }

        const record = SafeJSON.parse(firstLine) as { payload?: { id?: string; session_id?: string; cwd?: string } };
        return { id: record.payload?.id, sessionId: record.payload?.session_id, cwd: record.payload?.cwd };
    } catch (err) {
        log.debug({ path, error: err }, "could not read the rollout header");
        return {};
    }
}

async function sha256(path: string): Promise<string> {
    return createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
}

async function sameContent(left: RolloutFile, right: RolloutFile): Promise<boolean> {
    if (left.size !== right.size) {
        return false;
    }

    return (await sha256(left.path)) === (await sha256(right.path));
}

export function inspectHome(home: string, inspect: (query: OpenFilesQuery) => OpenFilesResult = openFiles): BusyReport {
    const files: string[] = [];

    for (const name of HOME_LOCK_FILES) {
        for (const sidecar of SQLITE_SIDECARS) {
            files.push(join(home, `${name}${sidecar}`));
        }
    }

    const locks = join(home, "thread-writer-locks");

    if (existsSync(locks)) {
        for (const entry of readdirSync(locks)) {
            if (entry.endsWith(".lock")) {
                files.push(join(locks, entry));
            }
        }
    }

    files.push(join(home, GLOBAL_STATE_FILE));

    const result = inspect({ files, directories: [sessionsDirOf(home)] });

    if (result === "unknown") {
        return { home, status: "unknown", holders: [] };
    }

    return { home, status: result.length > 0 ? "busy" : "clear", holders: result };
}

type HeldPathIndex = Map<string, ProcessHolder[]>;

function comparablePath(path: string, realpath: (value: string) => string): string {
    try {
        return realpath(path);
    } catch (error) {
        // `lsof` may name a path that is gone by the time we look; the string still compares.
        log.debug({ path, error }, "path has no realpath, comparing it as written");
        return resolve(path);
    }
}

/** Every open handle from every inspected home, keyed by comparable path. */
function heldPathIndex(reports: BusyReport[], realpath: (value: string) => string): HeldPathIndex {
    const index: HeldPathIndex = new Map();

    for (const report of reports) {
        for (const holder of report.holders) {
            const key = comparablePath(holder.path, realpath);
            index.set(key, [...(index.get(key) ?? []), holder]);
        }
    }

    return index;
}

function holdersOfPath(index: HeldPathIndex, path: string, realpath: (value: string) => string): ProcessHolder[] {
    return index.get(comparablePath(path, realpath)) ?? [];
}

function describeHolders(holders: ProcessHolder[]): string {
    return [...new Set(holders.map((holder) => `${holder.command}(${holder.pid})`))].join(", ");
}

export function mergeDesktopState(
    destination: DesktopState,
    source: DesktopState,
    realpath: (value: string) => string = defaultRealpath
): { merged: DesktopState; report: DesktopMergeReport } {
    const destinationProjects = { ...(destination["local-projects"] ?? {}) };
    const sourceProjects = source["local-projects"] ?? {};
    const report: DesktopMergeReport = {
        projectsAdded: [],
        duplicatesAvoided: [],
        orderAppended: [],
        assignmentsAdded: 0,
        assignmentsRemapped: 0,
        assignmentsKept: 0,
    };

    // Keyed by root path, never by id: the destination already carries one project under a raw
    // uuid and nine under `local-<md5>`, and the source uses the uuid shape. Keying on id adds a
    // second entry for the same directory, and a re-run adds a third.
    const byRootPath = new Map<string, string>();

    for (const [id, project] of Object.entries(destinationProjects)) {
        for (const rootPath of project.rootPaths ?? []) {
            byRootPath.set(normaliseRootPath(rootPath, realpath), id);
        }
    }

    const remapped = new Map<string, string>();

    for (const [sourceId, project] of Object.entries(sourceProjects)) {
        const rootPaths = project.rootPaths ?? [];
        const claimed = rootPaths
            .map((rootPath) => ({ rootPath: normaliseRootPath(rootPath, realpath) }))
            .map((entry) => ({ ...entry, destinationId: byRootPath.get(entry.rootPath) }))
            .find((entry) => entry.destinationId !== undefined);

        if (claimed?.destinationId) {
            report.duplicatesAvoided.push({
                rootPath: claimed.rootPath,
                sourceId,
                destinationId: claimed.destinationId,
            });
            remapped.set(sourceId, claimed.destinationId);
            continue;
        }

        destinationProjects[sourceId] = project;
        report.projectsAdded.push({ id: sourceId, name: project.name, rootPaths });

        for (const rootPath of rootPaths) {
            byRootPath.set(normaliseRootPath(rootPath, realpath), sourceId);
        }
    }

    const order = [...(destination["project-order"] ?? [])];

    for (const added of report.projectsAdded) {
        if (!order.includes(added.id)) {
            order.push(added.id);
            report.orderAppended.push(added.id);
        }
    }

    const assignments = { ...(destination["thread-project-assignments"] ?? {}) };

    for (const [threadId, assignment] of Object.entries(source["thread-project-assignments"] ?? {})) {
        if (assignments[threadId]) {
            report.assignmentsKept += 1;
            continue;
        }

        const projectId = assignment.projectId;
        const target = projectId ? remapped.get(projectId) : undefined;

        if (target) {
            report.assignmentsRemapped += 1;
        }

        assignments[threadId] = target ? { ...assignment, projectId: target } : assignment;
        report.assignmentsAdded += 1;
    }

    const merged: DesktopState = {
        ...destination,
        "local-projects": destinationProjects,
        "project-order": order,
        "thread-project-assignments": assignments,
    };

    return { merged, report };
}

async function readDesktopState(path: string): Promise<DesktopState | undefined> {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        return SafeJSON.parse(await Bun.file(path).text()) as DesktopState;
    } catch (err) {
        log.warn({ path, error: err }, "could not parse the Codex Desktop state file");
        return undefined;
    }
}

async function writeDesktopState(path: string, state: DesktopState, stamp: string): Promise<void> {
    const temporary = `${path}.migrate-home-${stamp}.tmp`;
    await writeFile(temporary, SafeJSON.stringify(state));
    await rename(temporary, path);
}

async function clonePath(source: string, destination: string, recursive: boolean): Promise<void> {
    const args = recursive ? ["cp", "-c", "-R", source, destination] : ["cp", "-c", source, destination];
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;

    if (exitCode === 0) {
        return;
    }

    log.debug({ source, destination, exitCode, stderr }, "cp -c failed; falling back to a plain copy");

    if (recursive) {
        const plain = Bun.spawn(["cp", "-R", source, destination], { stdout: "pipe", stderr: "pipe" });
        const plainStderr = await new Response(plain.stderr).text();
        const plainExit = await plain.exited;

        if (plainExit !== 0) {
            throw new Error(`Copy of ${source} failed: ${plainStderr.trim() || `exit ${plainExit}`}`);
        }

        return;
    }

    await Bun.write(destination, Bun.file(source));
}

function defaultBackupRoot(): string {
    return join(new Storage("codex").getBaseDir(), "migrate-home");
}

interface PlannedCopy {
    source: SourceReport;
    file: RolloutFile;
    destination: string;
}

/**
 * Plans, and on `--apply` performs, the union of every source home's transcripts into the
 * destination. The copy never unlinks: the source stays byte-for-byte where it was until
 * `--archive-source` renames its `sessions/` directory, and even then nothing is deleted.
 */
export async function migrateHome(options: MigrateHomeOptions = {}): Promise<MigrateHomeReport> {
    const realpath = options.realpath ?? defaultRealpath;
    const inspect = options.inspectOpenFiles ?? openFiles;
    const stamp = options.stamp ?? migrationStamp();
    const destination = resolve(options.to ?? join(homedir(), ".codex"));
    const report: MigrateHomeReport = {
        destination,
        stamp,
        applied: false,
        desktopRequested: options.desktop === true,
        archiveSourceRequested: options.archiveSource === true,
        busy: [],
        sources: [],
        totals: { rollouts: 0, toCopy: 0, alreadyPresent: 0, collisions: 0, copied: 0, skippedLive: 0 },
        backups: {},
        desktop: [],
        refusals: [],
        reindexCommand: REINDEX_COMMAND,
        provenanceNote: PROVENANCE_NOTE,
    };

    if (!existsSync(destination)) {
        report.refusals.push({ reason: "missing-destination", detail: `Destination home ${destination} not found` });
        return report;
    }

    const requested = options.from?.length ? options.from : undefined;
    const sourceHomes = (requested ?? discoverSourceHomes(destination)).map((home) => resolve(home));
    const destinationKey = normaliseRootPath(destination, realpath);
    const usableSources: string[] = [];

    for (const home of sourceHomes) {
        if (normaliseRootPath(home, realpath) === destinationKey) {
            report.refusals.push({ reason: "no-sources", detail: `${home} is the destination home` });
            continue;
        }

        if (!existsSync(sessionsDirOf(home))) {
            report.refusals.push({ reason: "no-sources", detail: `${home} holds no sessions/ directory` });
            continue;
        }

        usableSources.push(home);
    }

    if (usableSources.length === 0) {
        report.refusals.push({ reason: "no-sources", detail: "No source home to migrate" });
        return report;
    }

    for (const home of [destination, ...usableSources]) {
        report.busy.push(inspectHome(home, inspect));
    }

    const heldPaths = heldPathIndex(report.busy, realpath);

    const destinationSessions = sessionsDirOf(destination);
    const destinationRollouts = new Map<string, RolloutFile>();

    for (const rollout of enumerateRollouts(destinationSessions)) {
        destinationRollouts.set(rollout.nativeId, rollout);
    }

    const planned: PlannedCopy[] = [];
    const claimedBySource = new Map<string, { home: string; file: RolloutFile }>();

    for (const home of usableSources) {
        const sessionsDir = sessionsDirOf(home);
        const rollouts = enumerateRollouts(sessionsDir);
        const source: SourceReport = {
            home,
            sessionsDir,
            rollouts: rollouts.length,
            toCopy: 0,
            alreadyPresent: 0,
            collisions: [],
            copied: 0,
            skippedLive: [],
        };

        for (const file of rollouts) {
            const existing = destinationRollouts.get(file.nativeId);
            const claimed = claimedBySource.get(file.nativeId);

            if (claimed) {
                source.collisions.push({
                    nativeId: file.nativeId,
                    sourcePath: file.path,
                    destinationPath: claimed.file.path,
                    sourceMeta: await readRolloutMetaIds(file.path),
                    destinationMeta: await readRolloutMetaIds(claimed.file.path),
                });
                continue;
            }

            if (existing) {
                // Same id at the same place with the same bytes is this command's own earlier run,
                // which is what makes a repeat a no-op. Anything else sharing an id is a genuine
                // clash and the whole run refuses rather than picking a winner.
                const migrated = existing.relativePath === file.relativePath && (await sameContent(existing, file));

                if (migrated) {
                    source.alreadyPresent += 1;
                    continue;
                }

                source.collisions.push({
                    nativeId: file.nativeId,
                    sourcePath: file.path,
                    destinationPath: existing.path,
                    sourceMeta: await readRolloutMetaIds(file.path),
                    destinationMeta: await readRolloutMetaIds(existing.path),
                });
                continue;
            }

            const holders = holdersOfPath(heldPaths, file.path, realpath);

            if (holders.length > 0) {
                // A rollout a live `codex` still appends to would copy half-written. Leave it for a
                // later run, which finds it again once the process is gone.
                source.skippedLive.push({ nativeId: file.nativeId, path: file.path, holders });
                continue;
            }

            source.toCopy += 1;
            claimedBySource.set(file.nativeId, { home, file });
            planned.push({ source, file, destination: join(destinationSessions, file.relativePath) });
        }

        report.sources.push(source);
        report.totals.rollouts += source.rollouts;
        report.totals.toCopy += source.toCopy;
        report.totals.alreadyPresent += source.alreadyPresent;
        report.totals.collisions += source.collisions.length;
        report.totals.skippedLive += source.skippedLive.length;
    }

    const destinationState = join(destination, GLOBAL_STATE_FILE);

    // A home in use is not a refusal by itself: the copy only adds files its holders never touch,
    // and a rollout still being written was skipped above. Only the two operations that would pull
    // something out from under a live process still refuse.
    for (const busy of report.busy) {
        if (busy.status === "unknown") {
            report.refusals.push({
                reason: "busy",
                detail: `Could not determine whether ${busy.home} is in use; refusing rather than guessing`,
            });
        } else if (busy.status === "busy" && options.archiveSource && busy.home !== destination) {
            report.refusals.push({
                reason: "busy",
                detail: `${busy.home} is open in ${describeHolders(busy.holders)}; --archive-source needs a source no process holds`,
            });
        }
    }

    if (options.desktop) {
        const holders = holdersOfPath(heldPaths, destinationState, realpath);

        if (holders.length > 0) {
            report.refusals.push({
                reason: "busy",
                detail: `Codex Desktop state ${destinationState} is open in ${describeHolders(holders)}; close the Desktop on that home or rerun without --desktop`,
            });
        }
    }

    if (report.totals.collisions > 0) {
        report.refusals.push({
            reason: "collision",
            detail: `${report.totals.collisions} rollout id(s) already exist in the destination with different content`,
        });
    }

    log.debug(
        { destination, sources: usableSources, totals: report.totals, refusals: report.refusals.length },
        "migrate-home plan"
    );

    if (!options.apply || report.refusals.length > 0) {
        return report;
    }

    const backupRoot = join(options.backupRoot ?? defaultBackupRoot(), stamp);
    mkdirSync(backupRoot, { recursive: true });

    if (existsSync(destinationSessions)) {
        const backup = join(backupRoot, "sessions");
        await clonePath(destinationSessions, backup, true);
        report.backups.sessions = backup;
    }

    if (existsSync(destinationState)) {
        const backup = join(backupRoot, GLOBAL_STATE_FILE);
        await clonePath(destinationState, backup, false);
        report.backups.globalState = backup;
    }

    for (const item of planned) {
        mkdirSync(dirname(item.destination), { recursive: true });
        await clonePath(item.file.path, item.destination, false);

        const copied = statSync(item.destination);

        if (copied.size !== item.file.size || (await sha256(item.destination)) !== (await sha256(item.file.path))) {
            throw new Error(`Copy of ${item.file.path} did not verify against ${item.destination}`);
        }

        item.source.copied += 1;
        report.totals.copied += 1;
    }

    report.applied = true;

    if (options.desktop) {
        const state = await readDesktopState(destinationState);

        for (const home of usableSources) {
            const sourceStatePath = join(home, GLOBAL_STATE_FILE);
            const sourceState = await readDesktopState(sourceStatePath);

            if (!state || !sourceState) {
                log.warn({ home, destinationState, sourceStatePath }, "skipping the Desktop merge: state file missing");
                continue;
            }

            const { merged, report: mergeReport } = mergeDesktopState(state, sourceState, realpath);
            await writeDesktopState(destinationState, merged, stamp);
            Object.assign(state, merged);
            report.desktop.push({
                ...mergeReport,
                home,
                sourceStatePath,
                destinationStatePath: destinationState,
                written: true,
            });
        }
    }

    if (options.archiveSource) {
        for (const source of report.sources) {
            const archived = `${source.sessionsDir}.migrated-${stamp}`;
            renameSync(source.sessionsDir, archived);
            source.archivedTo = archived;
            log.info({ from: source.sessionsDir, to: archived }, "archived the source sessions directory");
        }
    }

    return report;
}

export async function previewDesktopMerge(
    destination: string,
    sources: string[],
    realpath: (value: string) => string = defaultRealpath
): Promise<DesktopReport[]> {
    const destinationStatePath = join(destination, GLOBAL_STATE_FILE);
    const state = await readDesktopState(destinationStatePath);
    const previews: DesktopReport[] = [];

    if (!state) {
        return previews;
    }

    const running: DesktopState = { ...state };

    for (const home of sources) {
        const sourceStatePath = join(home, GLOBAL_STATE_FILE);
        const sourceState = await readDesktopState(sourceStatePath);

        if (!sourceState) {
            continue;
        }

        const { merged, report } = mergeDesktopState(running, sourceState, realpath);
        Object.assign(running, merged);
        previews.push({ ...report, home, sourceStatePath, destinationStatePath, written: false });
    }

    return previews;
}
