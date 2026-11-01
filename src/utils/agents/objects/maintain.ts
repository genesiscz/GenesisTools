import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { guardStoreAgainstGc, maintenanceDir, objectsDir, writeBlobs } from "./store";

const log = logger.child({ component: "agents/objects-maintain" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a blob stays once no change-log row names it any more. The longest reader window is `tools agents blame`'s
 * default (`blame.ts` takes this constant), so a default blame finds every blob its rows name. A reader that asks for
 * older rows (`blame --since`, `changes` of an old session) gets the row without its diff, which every reader already
 * shows ("missing-blob", a skipped blame event).
 */
export const OBJECT_RETENTION_DAYS = 30;

/**
 * The wait between moving dropped objects aside and reading the rows written meanwhile. Longer than a hook's own
 * 15 s budget, so a hook that re-hashed a dropped blob before it moved has written its row by then.
 */
const SETTLE_MS = 20_000;
/** A `tmp_obj_*` or `tmp_pack_*` file this old belongs to a writer that died (a hook past its timeout). */
const GARBAGE_AGE_MS = DAY_MS;
/** The first pack of the 1.14 GiB loose store took 152 s at nice 19 (2026-11-01); a rewrite reuses its deltas. */
const PACK_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The index first: a reader that lists packs stops finding the pack, and one that has it open keeps reading it. */
const PACK_EXTENSIONS = [".idx", ".pack", ".rev", ".bitmap", ".mtimes", ".promisor"];
const RETIRED = /^retired-(\d+)-(\d+)$/;

/** `git count-objects -v`, in its own units (sizes in KiB). */
export interface StoreCount {
    loose: number;
    looseKiB: number;
    packs: number;
    packed: number;
    packKiB: number;
    garbage: number;
    garbageKiB: number;
}

export interface MaintenanceReport {
    root: string;
    dryRun: boolean;
    retentionDays: number;
    cutoff: string;
    before: StoreCount | null;
    after: StoreCount | null;
    /** Objects a change-log row of the window names: (to be) in the one pack. */
    packed: number;
    /** Loose objects no row names, younger than the window: they stay loose (a hook's blob before its row, `--store-blobs`). */
    keptLoose: number;
    /** Objects older than the window that no row of the window names. */
    dropped: { loose: number; packed: number };
    /** Named by a row of the window, but in the store nowhere (a write that failed). */
    missing: number;
    /** Dropped objects that a row written during the pass (or after a pass that died) names, put back. */
    restored: number;
    packsRetired: number;
    garbageRemoved: number;
    /** Why the pass did nothing: no store, or another pass holds the lock. */
    skipped?: "locked" | "no-store";
    elapsedMs: number;
}

export interface MaintainOptions {
    now?: Date;
    root?: string;
    /** The folder holding `<session>/changes.jsonl`; the store's parent by default. */
    logsDir?: string;
    retentionDays?: number;
    /** Read and report only: no lock, no pack, no move, no config. */
    dryRun?: boolean;
    /** The wait before the rows written during the pass are read; tests replace it. */
    settle?: () => Promise<void>;
}

export function countObjects(root: string): StoreCount | null {
    const run = spawnSync("git", ["--git-dir", root, "count-objects", "-v"], {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
    });

    if (run.status !== 0) {
        log.debug({ root, status: run.status, error: run.error, stderr: run.stderr }, "count-objects failed");
        return null;
    }

    const field = (name: string): number => Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(run.stdout)?.[1] ?? 0);
    return {
        loose: field("count"),
        looseKiB: field("size"),
        packs: field("packs"),
        packed: field("in-pack"),
        packKiB: field("size-pack"),
        garbage: field("garbage"),
        garbageKiB: field("size-garbage"),
    };
}

export interface NamedOids {
    /** oid → the path of a row naming it, the delta hint for `pack-objects`. */
    oids: Map<string, string>;
    /** How far each log was read (the end of its last complete row), for a later read of what it gained. */
    offsets: Map<string, number>;
    logs: number;
    rows: number;
}

/**
 * The oids change-log rows name. `since` skips logs untouched since then and rows older than it. With `offsets`,
 * each log is read only past its offset and a log not listed from its start: the rows written after an earlier read.
 */
export function namedOids({
    logsDir,
    since,
    offsets,
}: {
    logsDir: string;
    since: number;
    offsets?: ReadonlyMap<string, number>;
}): NamedOids {
    const named: NamedOids = { oids: new Map(), offsets: new Map(), logs: 0, rows: 0 };
    let names: string[];

    try {
        names = readdirSync(logsDir).filter((name) => !name.startsWith("_"));
    } catch (error) {
        log.debug({ error, logsDir }, "no change logs");
        return named;
    }

    const sinceIso = new Date(since).toISOString();

    for (const name of names) {
        const path = join(logsDir, name, "changes.jsonl");
        const from = offsets?.get(path) ?? 0;
        let body: Buffer;

        try {
            const stat = statSync(path);

            if (stat.mtimeMs < since || stat.size <= from) {
                // Untouched since `since`: none of its rows count, and a later read starts at its end.
                named.offsets.set(path, Math.max(from, stat.mtimeMs < since ? stat.size : from));
                continue;
            }

            body = readFileSync(path);
        } catch {
            continue;
        }

        const end = body.lastIndexOf(0x0a) + 1;
        named.offsets.set(path, Math.max(from, end));
        named.logs++;

        if (end <= from) {
            continue;
        }

        for (const line of body.subarray(from, end).toString("utf8").split("\n")) {
            if (!line.includes('Oid":"')) {
                continue;
            }

            let row: { ts?: unknown; path?: unknown; beforeOid?: unknown; afterOid?: unknown };

            try {
                row = SafeJSON.parse(line, { strict: true });
            } catch (error) {
                log.debug({ error, path }, "bad change-log row");
                continue;
            }

            if (typeof row.ts !== "string" || row.ts < sinceIso) {
                continue;
            }

            named.rows++;
            const hint = typeof row.path === "string" ? row.path.replaceAll("\n", " ") : "";

            for (const oid of [row.beforeOid, row.afterOid]) {
                if (typeof oid === "string" && OID.test(oid)) {
                    named.oids.set(oid, hint);
                }
            }
        }
    }

    return named;
}

interface LooseObject {
    oid: string;
    path: string;
    mtimeMs: number;
}

function listLoose(root: string, now: number): { objects: LooseObject[]; garbage: string[] } {
    const objectsRoot = join(root, "objects");
    const objects: LooseObject[] = [];
    const garbage: string[] = [];

    for (const fan of readdirSync(objectsRoot)) {
        if (!/^[0-9a-f]{2}$/.test(fan)) {
            continue;
        }

        for (const rest of readdirSync(join(objectsRoot, fan))) {
            const path = join(objectsRoot, fan, rest);

            try {
                const mtimeMs = statSync(path).mtimeMs;

                if (OID.test(fan + rest)) {
                    objects.push({ oid: fan + rest, path, mtimeMs });
                } else if (rest.startsWith("tmp_obj_") && now - mtimeMs > GARBAGE_AGE_MS) {
                    garbage.push(path);
                }
            } catch {
                // Gone between the listing and the stat: a writer's rename of its temp file.
            }
        }
    }

    return { objects, garbage };
}

interface PackFile {
    /** The path without its extension: `<root>/objects/pack/pack-<hash>`. */
    base: string;
    /** A `.keep` file: git's own "never repack this", honoured here too. */
    keep: boolean;
}

function listPacks(root: string, now: number): { packs: PackFile[]; garbage: string[] } {
    const dir = join(root, "objects", "pack");
    const packs: PackFile[] = [];
    const garbage: string[] = [];
    let names: string[];

    try {
        names = readdirSync(dir);
    } catch {
        return { packs, garbage };
    }

    for (const name of names) {
        if (name.startsWith("pack-") && name.endsWith(".idx")) {
            const base = join(dir, name.slice(0, -".idx".length));
            packs.push({ base, keep: existsSync(`${base}.keep`) });
        } else if (name.startsWith("tmp_")) {
            try {
                if (now - statSync(join(dir, name)).mtimeMs > GARBAGE_AGE_MS) {
                    garbage.push(join(dir, name));
                }
            } catch {
                // A pack-objects run finished and renamed it.
            }
        }
    }

    return { packs, garbage };
}

/** Every object the store holds, loose and packed. */
function presentOids(root: string): Set<string> {
    const run = spawnSync(
        "git",
        ["--git-dir", root, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)", "--unordered"],
        { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 1024 }
    );

    if (run.status !== 0) {
        throw new Error(`git cat-file --batch-all-objects failed: ${run.stderr || run.error?.message || run.status}`);
    }

    return new Set(run.stdout.split("\n").filter((line) => OID.test(line)));
}

/** The oids one pack's index lists. */
function packIndexOids(idx: string): Set<string> {
    const bytes = readFileSync(idx);
    const run = spawnSync("git", ["show-index"], {
        input: bytes,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        // One `<offset> <oid> (<crc>)` line (under 96 bytes) per entry of at least 28 index bytes.
        maxBuffer: (Math.ceil(bytes.length / 28) + 1) * 96,
    });

    if (run.status !== 0) {
        throw new Error(`git show-index ${idx} failed: ${run.stderr || run.error?.message || run.status}`);
    }

    return new Set(
        run.stdout
            .split("\n")
            .map((line) => line.split(" ")[1])
            .filter((oid): oid is string => oid !== undefined && OID.test(oid))
    );
}

/**
 * One pack of these objects. Each oid goes in with its file's path, so `pack-objects` sorts versions of one file side
 * by side for the delta search: 227 MB against 557 MB without the paths, for the same 138,500 blobs (2026-11-01).
 */
function writePack(root: string, objects: ReadonlyMap<string, string>): string {
    const input = `${[...objects].map(([oid, hint]) => (hint ? `${oid} ${hint}` : oid)).join("\n")}\n`;
    const run = spawnSync(
        "git",
        [
            "--git-dir",
            root,
            "pack-objects",
            "-q",
            "--delta-base-offset",
            "--window-memory=256m",
            join(root, "objects", "pack", "pack"),
        ],
        { input, encoding: "utf8", timeout: PACK_TIMEOUT_MS }
    );
    const hash = run.stdout?.trim();

    if (run.status !== 0 || !hash || !/^[0-9a-f]+$/.test(hash)) {
        throw new Error(`git pack-objects failed: ${run.stderr || run.error?.message || run.status}`);
    }

    return join(root, "objects", "pack", `pack-${hash}`);
}

/** Moves `path` to the same place under `retired`: readers stop finding it, and its bytes can still come back. */
function retire(root: string, retired: string, path: string): boolean {
    const target = join(retired, path.slice(root.length + 1));

    try {
        mkdirSync(dirname(target), { recursive: true });
        renameSync(path, target);
        return true;
    } catch (error) {
        log.debug({ error, path }, "could not move an object aside");
        return false;
    }
}

function retirePack(root: string, retired: string, pack: PackFile): void {
    for (const extension of PACK_EXTENSIONS) {
        if (existsSync(`${pack.base}${extension}`)) {
            retire(root, retired, `${pack.base}${extension}`);
        }
    }
}

/**
 * Of these oids, the ones the store no longer holds, read from the moved-aside objects and written again. Throws
 * when it cannot tell, so the caller keeps the moved-aside objects for the next pass.
 */
function restoreFrom({ root, retired, oids }: { root: string; retired: string; oids: Iterable<string> }): number {
    const wanted = [...oids];

    if (wanted.length === 0) {
        return 0;
    }

    const check = spawnSync("git", ["--git-dir", root, "cat-file", "--batch-check=%(objectname)"], {
        input: `${wanted.join("\n")}\n`,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: (wanted.length + 1) * 96,
    });

    if (check.status !== 0) {
        throw new Error(`git cat-file --batch-check failed: ${check.stderr || check.error?.message || check.status}`);
    }

    const absent = check.stdout
        .split("\n")
        .filter((line) => line.endsWith(" missing"))
        .map((line) => line.slice(0, -" missing".length));

    if (absent.length === 0) {
        return 0;
    }

    const read = spawnSync("git", ["--git-dir", root, "cat-file", "--batch"], {
        input: `${absent.join("\n")}\n`,
        env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(retired, "objects") },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 1024,
    });

    if (read.status !== 0 || !read.stdout) {
        throw new Error(
            `git cat-file --batch failed: ${read.stderr?.toString() || read.error?.message || read.status}`
        );
    }

    const blobs: Buffer[] = [];
    let at = 0;

    while (at < read.stdout.length) {
        const newline = read.stdout.indexOf(0x0a, at);

        if (newline === -1) {
            break;
        }

        const header = read.stdout.subarray(at, newline).toString("utf8").split(" ");
        at = newline + 1;

        if (header.length < 3) {
            // `<oid> missing`: not among the moved-aside objects either (named before, dropped by an earlier pass).
            continue;
        }

        const size = Number(header[2]);
        blobs.push(read.stdout.subarray(at, at + size));
        at += size + 1;
    }

    if (blobs.length > 0) {
        writeBlobs(root, blobs);
    }

    log.info({ root, absent: absent.length, restored: blobs.length }, "put back dropped objects that new rows name");
    return blobs.length;
}

function unlinkQuietly(path: string): boolean {
    try {
        unlinkSync(path);
        return true;
    } catch {
        return false;
    }
}

/** A store made before the guard existed gets it here; `ensureRepo` sets it on a new one. */
function guardAgainstGc(root: string): void {
    const failed = guardStoreAgainstGc(root);

    if (failed.length > 0) {
        log.warn({ root, failed }, "could not set the store's gc guard");
    }
}

/**
 * Moved-aside folders of a pass that died before it read the late rows: the objects rows from a day before that pass
 * on name go back, then the folder goes. A live pass never leaves one behind, and the lock keeps passes apart.
 */
function recoverLeftovers(root: string, logsDir: string): number {
    const dir = maintenanceDir(root);
    let restored = 0;

    for (const name of readdirSync(dir)) {
        const started = Number(RETIRED.exec(name)?.[2]);

        if (!Number.isFinite(started)) {
            continue;
        }

        const retired = join(dir, name);
        restored += restoreFrom({ root, retired, oids: namedOids({ logsDir, since: started - DAY_MS }).oids.keys() });
        rmSync(retired, { recursive: true, force: true });
        log.info({ root, retired }, "recovered the moved-aside objects of a pass that did not finish");
    }

    return restored;
}

/**
 * Keeps the change-log object store small: the `agents-objects` step of the daily pass (`runDailyCompression` in
 * `compress/daily.ts`, started once a day by the logger). The store has no refs: a blob is needed while a change-log
 * row names it, so what stays comes from the rows, never from git's reachability (`git gc`, `git prune` or
 * `git repack -a -d` would drop or skip everything). No such command runs here.
 *
 * - Every object a row of the last `retentionDays` names goes into ONE pack, with the row's path as the delta hint.
 *   Later passes reuse its deltas, so a pass costs seconds once the backlog is packed.
 * - A loose object no row names stays loose while it is younger than the window (a hook writes the blob before its
 *   row; `--store-blobs` writes blobs a reader then asks for by oid). Older, it goes. A re-hash refreshes its mtime.
 * - A packed object no row of the window names goes with the old pack.
 * - What goes is moved aside first. After `settle`, the rows written during the pass are read, and every object they
 *   name that is gone comes back, so a hook that re-hashed a dropped blob just before it moved never names a missing one.
 *
 * One pass at a time (a lock in the store). `dryRun` only reads.
 */
export async function maintainObjectStore(options: MaintainOptions = {}): Promise<MaintenanceReport> {
    const started = Date.now();
    const now = options.now ?? new Date();
    const root = options.root ?? objectsDir();
    const logsDir = options.logsDir ?? dirname(root);
    const retentionDays = options.retentionDays ?? OBJECT_RETENTION_DAYS;
    const cutoff = now.getTime() - retentionDays * DAY_MS;
    const report: MaintenanceReport = {
        root,
        dryRun: options.dryRun === true,
        retentionDays,
        cutoff: new Date(cutoff).toISOString(),
        before: null,
        after: null,
        packed: 0,
        keptLoose: 0,
        dropped: { loose: 0, packed: 0 },
        missing: 0,
        restored: 0,
        packsRetired: 0,
        garbageRemoved: 0,
        elapsedMs: 0,
    };

    if (!existsSync(join(root, "HEAD"))) {
        report.skipped = "no-store";
    } else if (report.dryRun) {
        await pass({ root, logsDir, cutoff, now, report, settle: async () => undefined });
    } else {
        const dir = maintenanceDir(root);
        mkdirSync(dir, { recursive: true });

        try {
            await withFileLock(
                join(dir, "lock"),
                async () => {
                    report.restored += recoverLeftovers(root, logsDir);
                    await pass({ root, logsDir, cutoff, now, report, settle: options.settle ?? defaultSettle });
                },
                0
            );
        } catch (error) {
            if (!(error instanceof LockTimeoutError)) {
                throw error;
            }

            report.skipped = "locked";
        }
    }

    report.elapsedMs = Date.now() - started;
    // Every field into the day log; the daily pass writes the one info line (`summaryLine`).
    log.debug({ ...report }, summaryLine(report));
    return report;
}

function defaultSettle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

/** One line: the object count and the size before and after, or why nothing ran. */
export function summaryLine(report: MaintenanceReport): string {
    if (report.skipped) {
        return `agents objects maintenance skipped (${report.skipped}): ${report.root}`;
    }

    const size = (count: StoreCount | null) =>
        count
            ? `${count.loose + count.packed} objects (${count.loose} loose, ${count.packs} packs), ${formatBytes((count.looseKiB + count.packKiB) * 1024)}`
            : "?";
    const [keep, drop] = report.dryRun ? ["would keep", "would drop"] : ["kept", "dropped"];
    return [
        `agents objects maintenance${report.dryRun ? " (dry run)" : ""}: ${size(report.before)}`,
        report.dryRun ? "" : ` → ${size(report.after)}`,
        `; ${keep} ${report.packed} named objects in one pack and ${report.keptLoose} young loose ones,`,
        ` ${drop} ${report.dropped.loose} loose and ${report.dropped.packed} packed ones older than ${report.retentionDays} days`,
        report.restored ? `, put back ${report.restored}` : "",
        report.missing ? `, ${report.missing} named but missing` : "",
        ` in ${report.elapsedMs} ms`,
    ].join("");
}

async function pass({
    root,
    logsDir,
    cutoff,
    now,
    report,
    settle,
}: {
    root: string;
    logsDir: string;
    cutoff: number;
    now: Date;
    report: MaintenanceReport;
    settle: () => Promise<void>;
}): Promise<void> {
    report.before = countObjects(root);
    const named = namedOids({ logsDir, since: cutoff });
    // Every object, then the loose ones: a hook's write in between is loose and young, never taken for a packed one.
    const present = presentOids(root);
    const loose = listLoose(root, now.getTime());
    const packs = listPacks(root, now.getTime());
    const looseOids = new Set(loose.objects.map((object) => object.oid));
    const keep = new Map([...named.oids].filter(([oid]) => present.has(oid)));
    const oldLoose = loose.objects.filter((object) => !keep.has(object.oid) && object.mtimeMs < cutoff);
    const retirable = packs.packs.filter((pack) => !pack.keep);
    const namedLoose = loose.objects.filter((object) => keep.has(object.oid)).length;

    report.packed = keep.size;
    report.keptLoose = loose.objects.filter((object) => !keep.has(object.oid) && object.mtimeMs >= cutoff).length;
    report.missing = named.oids.size - keep.size;
    report.dropped.loose = oldLoose.length;
    report.dropped.packed = [...present].filter((oid) => !looseOids.has(oid) && !keep.has(oid)).length;

    // Already one pack of exactly the named objects: rewriting it would change nothing.
    const rewrite = namedLoose > 0 || report.dropped.packed > 0 || retirable.length > 1;

    if (report.dryRun) {
        report.packsRetired = rewrite ? retirable.length : 0;
        report.garbageRemoved = loose.garbage.length + packs.garbage.length;
        return;
    }

    guardAgainstGc(root);
    const retired = join(maintenanceDir(root), `retired-${process.pid}-${now.getTime()}`);

    if (rewrite) {
        const base = keep.size > 0 ? writePack(root, keep) : null;

        if (base) {
            const inPack = packIndexOids(`${base}.idx`);
            const lost = [...keep.keys()].filter((oid) => !inPack.has(oid));

            if (lost.length > 0) {
                throw new Error(
                    `the new pack ${base} lacks ${lost.length} of ${keep.size} objects; nothing was removed`
                );
            }

            for (const object of loose.objects) {
                if (inPack.has(object.oid)) {
                    unlinkQuietly(object.path);
                }
            }
        }

        for (const pack of retirable.filter((pack) => pack.base !== base)) {
            retirePack(root, retired, pack);
            report.packsRetired++;
        }
    }

    let movedLoose = 0;

    for (const object of oldLoose) {
        try {
            // A hook that re-hashed it since the listing refreshed its mtime: it is no longer old.
            if (statSync(object.path).mtimeMs >= cutoff) {
                continue;
            }
        } catch {
            continue;
        }

        if (retire(root, retired, object.path)) {
            movedLoose++;
        }
    }

    report.dropped.loose = movedLoose;

    if (existsSync(retired)) {
        await settle();
        const late = namedOids({ logsDir, since: 0, offsets: named.offsets });
        report.restored += restoreFrom({ root, retired, oids: late.oids.keys() });
        rmSync(retired, { recursive: true, force: true });
    }

    for (const path of [...loose.garbage, ...packs.garbage]) {
        if (unlinkQuietly(path)) {
            report.garbageRemoved++;
        }
    }

    report.after = countObjects(root);
}
