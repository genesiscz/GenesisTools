import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import {
    appendFileSync,
    chmodSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    byKeys,
    type ContractShapeOptions,
    contractShapeMismatches,
    ndjsonShapeMismatches,
    readKitFixture,
    readKitFixtureJson,
    readKitFixtureLines,
} from "@app/macos/lib/kit-fixtures";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { scanWithC } from "../engine";
import {
    applySnapshotRetention,
    buildIndex,
    defaultMinFreeBytes,
    INDEX_DEFAULTS,
    progressEvent,
    sweepOrphanTempFiles,
} from "./build";
import { indexTaskStatus } from "./daemon-task";
import { openIndexDbForWrite, setMeta, sweepDeadScans } from "./db";
import { attributeToLeaves, diffIndex } from "./diff";
import { queryInfo, queryLargest, queryPath } from "./query";
import { schemaSqlText } from "./schema";
import { withIndexLock } from "./store";
import type { DiffRowOut, DirRow, IndexEvent } from "./types";
import { errorEvent, IndexError } from "./types";
import { updateIndex } from "./update";
import * as indexWalk from "./walk";
import { runIndexWalk, type WalkOptions } from "./walk";

const KB = 1024;
const CUTOFF = 100 * KB;
const OPTS = { minDirBytes: CUTOFF, bigFileFloor: 150 * KB, snapshotFloor: CUTOFF, minFreeBytes: 0 } as const;

const BUILD_NDJSON = "contract-du-index-build.ndjson";
/** `meta` is an open key-value map, so only its presence is compared. */
const SHAPE: ContractShapeOptions = { openMaps: ["$.meta"] };

/** Real output has the keys and nesting of the kit's contract fixture `contract-<name>.json`. */
function expectContract(actual: unknown, name: string): void {
    expect(contractShapeMismatches(actual, readKitFixtureJson(`contract-${name}.json`), SHAPE)).toEqual([]);
}

/** Build events of these types have the shape of the contract stream's line of the same type. */
function expectBuildEvents(events: unknown[], types: string[]): void {
    expect(ndjsonShapeMismatches(events, readKitFixtureLines(BUILD_NDJSON), { ...SHAPE, types })).toEqual([]);
}

function write(path: string, bytes: number, fill = 7): void {
    writeFileSync(path, Buffer.alloc(bytes, fill));
}

interface Totals {
    alloc: number;
    logical: number;
    files: number;
    dirs: number;
    maxFile: number;
    newest: number;
}

/** The slow, obviously correct answer: a recursive lstat walk that never follows a symlink. */
function oracle(dir: string): Totals {
    const t: Totals = { alloc: 0, logical: 0, files: 0, dirs: 0, maxFile: 0, newest: 0 };
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return t;
    }

    for (const name of names) {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isDirectory()) {
            const sub = oracle(p);
            t.alloc += sub.alloc;
            t.logical += sub.logical;
            t.files += sub.files;
            t.dirs += sub.dirs + 1;
            t.maxFile = Math.max(t.maxFile, sub.maxFile);
            t.newest = Math.max(t.newest, sub.newest);
        } else if (st.isFile()) {
            t.alloc += st.blocks * 512;
            t.logical += st.size;
            t.files += 1;
            t.maxFile = Math.max(t.maxFile, st.size);
            t.newest = Math.max(t.newest, Math.floor(st.mtimeMs / 1000));
        }
    }

    return t;
}

function liveRows(dbPath: string): Map<string, DirRow> {
    const db = new Database(dbPath, { readonly: true });
    try {
        const rows = db.query<DirRow, []>("SELECT * FROM dirs WHERE (flags & 16) = 0 ORDER BY id").all();
        const byId = new Map(rows.map((r) => [r.id, r]));
        const pathOf = (r: DirRow): string => {
            const parent = byId.get(r.parent_id);
            return parent ? join(pathOf(parent), r.name) : r.name;
        };
        return new Map(rows.map((r) => [pathOf(r), r]));
    } finally {
        db.close();
    }
}

function expectMatchesOracle(rows: Map<string, DirRow>, exactMaxima: boolean): void {
    for (const [path, row] of rows) {
        const o = oracle(path);
        const label = `${path} (flags ${row.flags})`;
        expect({
            path: label,
            alloc: row.alloc_bytes,
            logical: row.logical_bytes,
            files: row.files,
            dirs: row.dirs,
        }).toEqual({
            path: label,
            alloc: o.alloc,
            logical: o.logical,
            files: o.files,
            dirs: o.dirs,
        });
        if (exactMaxima) {
            expect([label, row.max_file_bytes, row.newest_mtime_s]).toEqual([label, o.maxFile, o.newest]);
        } else {
            expect(row.max_file_bytes).toBeGreaterThanOrEqual(o.maxFile);
            expect(row.newest_mtime_s).toBeGreaterThanOrEqual(o.newest);
        }
    }
}

const describeOnDarwin = process.platform === "darwin" ? describe : describe.skip;

describe("du index: schema and pure parts", () => {
    it("attributes through sibling names that sort between a parent and its children", () => {
        const rows: DiffRowOut[] = ["/root/a", "/root/a-backup", "/root/a/child"].map((path) => ({
            path,
            before: 0,
            after: 100,
            delta: 100,
            status: "grown",
            files_delta: 1,
            approx: false,
        }));
        expect(attributeToLeaves(rows).map((row) => row.path)).toEqual(["/root/a-backup", "/root/a/child"]);
    });

    it("the schema fixture the Swift reader uses is the migration's DDL", () => {
        expect(readKitFixture("contract-du-index-schema.sql")).toBe(schemaSqlText());
    });

    it("keeps the newest snapshot of the last 14 days and 8 weeks", () => {
        const db = new Database(":memory:");
        db.run("CREATE TABLE snapshots (id INTEGER PRIMARY KEY, taken_at_ms INTEGER NOT NULL)");
        db.run("CREATE TABLE snapshot_dirs (snapshot_id INTEGER NOT NULL, dir_id INTEGER NOT NULL)");
        const day = 86_400_000;
        const start = new Date(2026, 0, 1, 12).getTime();
        // Two snapshots a day for 90 days.
        for (let i = 0; i < 180; i++) {
            db.run("INSERT INTO snapshots (id, taken_at_ms) VALUES (?, ?)", [i + 1, start + (i * day) / 2]);
            db.run("INSERT INTO snapshot_dirs (snapshot_id, dir_id) VALUES (?, 1)", [i + 1]);
        }

        applySnapshotRetention(db, { keepDaily: 14, keepWeekly: 8, now: start + 90 * day });
        const kept = db
            .query<{ id: number }, []>("SELECT id FROM snapshots ORDER BY id DESC")
            .all()
            .map((r) => r.id);
        // 14 daily (the newest of each day) plus up to 8 weekly, some of which coincide with the daily ones.
        expect(kept[0]).toBe(180);
        expect(kept.length).toBeGreaterThanOrEqual(14);
        expect(kept.length).toBeLessThanOrEqual(22);
        // The newest of each day is its 12:00 snapshot (odd ids); 180 is alone on the last day.
        expect(kept.filter((id) => id % 2 === 0)).toEqual([180]);
        expect(db.query("SELECT COUNT(*) AS n FROM snapshot_dirs").get()).toEqual({ n: kept.length });
    });

    it("a progress line and an error object have the fixture's shape", () => {
        // The stream's other types come from real builds below: start, phase and result from the fixture tree,
        // blocked from a folder whose listing never answers. A new type in the contract needs a check there too.
        expect([...new Set(readKitFixtureLines(BUILD_NDJSON).map(byKeys("type")))].sort()).toEqual([
            "blocked",
            "phase",
            "progress",
            "result",
            "start",
        ]);
        expectBuildEvents([progressEvent({ files: 1, dirs: 1, bytes: 1, elapsed_ms: 500, dir: "/x" })], ["progress"]);
        expectContract(errorEvent("build", new IndexError("locked", "x")), "du-index-error");
        expect(errorEvent("build", new IndexError("locked", "x")).exit_code).toBe(3);
        expect(new IndexError("schema_newer", "x").exitCode).toBe(4);
    });
});

describeOnDarwin("du index: build, update, query and diff on a fixture tree", () => {
    let base: string;
    let root: string;
    let db: string;
    let built: Awaited<ReturnType<typeof buildIndex>>;
    const events: IndexEvent[] = [];

    beforeAll(async () => {
        // Real path: the index stores canonical paths, and the temp folder sits behind the /var symlink.
        base = realpathSync(mkdtempSync(join(tmpdir(), "gt-du-index-")));
        root = join(base, "tree");
        db = join(base, "db", "index.db");
        mkdirSync(join(root, "a", "a1"), { recursive: true });
        mkdirSync(join(root, "a", "a2"), { recursive: true });
        write(join(root, "a", "big.bin"), 200 * KB);
        write(join(root, "a", "a1", "f.txt"), 20 * KB);
        write(join(root, "a", "a2", "g.bin"), 120 * KB);
        mkdirSync(join(root, "b"));
        write(join(root, "b", "h.bin"), 50 * KB);
        mkdirSync(join(root, 'quote"name'));
        write(join(root, 'quote"name', "q.bin"), 150 * KB);
        mkdirSync(join(root, "new\nline"));
        write(join(root, "new\nline", "n.bin"), 5 * KB);
        mkdirSync(join(root, "čeština ünï"));
        write(join(root, "čeština ünï", "c.bin"), 110 * KB);
        let deep = join(root, "deep");
        for (let i = 1; i <= 20; i++) {
            deep = join(deep, `d${i}`);
        }

        mkdirSync(deep, { recursive: true });
        write(join(deep, "leaf.bin"), 130 * KB);
        mkdirSync(join(root, "many"));
        for (let i = 0; i < 600; i++) {
            writeFileSync(join(root, "many", `empty-${i}.txt`), "");
        }

        mkdirSync(join(root, "links"));
        linkSync(join(root, "a", "big.bin"), join(root, "links", "hard.bin"));
        symlinkSync(join(root, "a"), join(root, "links", "to-a"));
        mkdirSync(join(root, "sparse"));
        writeFileSync(join(root, "sparse", "sparse.bin"), "");
        truncateSync(join(root, "sparse", "sparse.bin"), 10 * 1024 * KB);
        mkdirSync(join(root, "empty"));
        mkdirSync(join(root, "denied"));
        write(join(root, "denied", "secret.bin"), 10 * KB);
        chmodSync(join(root, "denied"), 0o000);

        built = await buildIndex({ db, root, ...OPTS, emit: (e) => events.push(e) });
    });

    afterAll(() => {
        chmodSync(join(root, "denied"), 0o755);
        rmSync(base, { recursive: true, force: true });
    });

    it("stores every directory at or above the cutoff, each equal to a recursive lstat walk", () => {
        const rows = liveRows(db);
        const paths = [...rows.keys()].map((p) => p.slice(root.length) || "/");
        expect(paths).toContain("/a");
        expect(paths).toContain("/a/a2");
        expect(paths).toContain('/quote"name');
        expect(paths).toContain("/čeština ünï");
        expect(paths).toContain("/deep/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/d13/d14/d15/d16/d17/d18/d19/d20");
        // Folded: below the cutoff, and nothing flagged inside.
        for (const folded of ["/a/a1", "/b", "/new\nline", "/many", "/sparse", "/empty"]) {
            expect(paths).not.toContain(folded);
        }

        // A denied folder is always stored, flagged, so the report can name it.
        expect(rows.get(join(root, "denied"))?.flags).toBe(1);
        expectMatchesOracle(new Map([...rows].filter(([p]) => !p.endsWith("/denied"))), true);
        expect(built.denied_dirs).toBe(1);
        expect(built.stored_dirs + built.folded_dirs).toBe(built.dirs + 1);
        expect(built.stored_dirs).toBe(rows.size);
    });

    it("the root's allocated bytes equal clonesize's naive bytes for the same tree", () => {
        const naive = scanWithC({ path: root }).naive_bytes;
        expect(built.alloc_bytes).toBe(naive);
        // Hard links count per entry, like clonesize: big.bin appears twice.
        expect(oracle(root).alloc).toBe(naive);
    });

    it("records big files by logical size and owns them by their stored folder", () => {
        const r = queryLargest({ db, largest: "files", limit: 10 });
        const paths = r.rows.map((f) => f.path.slice(root.length));
        expect(paths).toContain("/sparse/sparse.bin");
        expect(paths).toContain("/a/big.bin");
        expect(paths).toContain("/links/hard.bin");
        expect(paths).not.toContain("/a/a2/g.bin");
    });

    it("emits start, ingest, commit, checkpoint and a result with the fixture shapes", () => {
        expect(events.map((e) => (e.type === "phase" ? `phase:${e.phase}` : e.type))).toEqual([
            "start",
            "phase:ingest",
            "phase:commit",
            "phase:checkpoint",
        ]);
        expectBuildEvents([...events, built], ["start", "phase", "result"]);
        expectContract(built, "du-index-build-result");
    });

    it("query answers a stored folder with children, local bytes and top files; a folded one with its owner", () => {
        const top = queryPath({ db });
        if (!top.found) {
            throw new Error("root not found");
        }

        expectContract(top, "du-index-query-children");
        const childSum = top.children.reduce((s, c) => s + c.alloc_bytes, 0);
        expect(top.local.alloc_bytes).toBe(top.node.alloc_bytes - childSum);
        expect(top.children[0]?.share).toBeGreaterThan(0);

        const folded = queryPath({ db, path: join(root, "a", "a1") });
        expectContract(folded, "du-index-query-folded");
        expect(folded).toMatchObject({ found: false, reason: "folded", folded_in: join(root, "a") });
        expect(queryPath({ db, path: join(root, "nope") })).toMatchObject({ found: false, reason: "missing" });
        expect(queryPath({ db, path: base })).toMatchObject({ found: false, reason: "outside_root", folded_in: null });

        expectContract(queryInfo({ db }), "du-index-query-info");
        expectContract(queryLargest({ db, largest: "dirs" }), "du-index-query-largest");
    });

    it("refuses a second writer, and an update queues its paths for the next one", async () => {
        let release = () => {};
        let held: Promise<void> = Promise.resolve();
        // Wait until the holder really owns the lock: an attempt during its acquisition is a different case.
        await new Promise<void>((acquired) => {
            held = withIndexLock(
                db,
                () =>
                    new Promise<void>((r) => {
                        release = r;
                        acquired();
                    })
            );
        });
        try {
            await expect(buildIndex({ db, root, ...OPTS, lockWaitMs: 0 })).rejects.toMatchObject({
                code: "locked",
                exitCode: 3,
            });
            const queued = await updateIndex({ db, paths: [join(root, "b")], lockWaitMs: 0, minFreeBytes: 0 });
            expect(queued).toMatchObject({ deferred: true, queued: 1, scan_id: null });
            expectContract(queued, "du-index-update-queued");
        } finally {
            release();
            await held;
        }

        const drained = await updateIndex({ db, paths: [], fromQueue: true, minFreeBytes: 0 });
        expect(drained.regions.map((r) => r.owner)).toEqual([root]);
        expect(queryInfo({ db }).counts.dirty_queue).toBe(0);
    });

    it("update after add, grow, delete, rename, promote and demote matches a fresh build", async () => {
        write(join(root, "b", "added.bin"), 30 * KB);
        appendFileSync(join(root, "a", "a2", "g.bin"), Buffer.alloc(100 * KB, 1));
        rmSync(join(root, 'quote"name'), { recursive: true });
        renameSync(join(root, "a", "a1"), join(root, "renamed-a1"));
        write(join(root, "new\nline", "grown.bin"), 120 * KB);
        truncateSync(join(root, "čeština ünï", "c.bin"), 10 * KB);

        const result = await updateIndex({
            db,
            minFreeBytes: 0,
            paths: [
                join(root, "b", "added.bin"),
                join(root, "a", "a2"),
                join(root, 'quote"name'),
                join(root, "a", "a1"),
                join(root, "renamed-a1"),
                join(root, "new\nline"),
                join(root, "čeština ünï"),
            ],
        });
        expectContract(result, "du-index-update-result");
        expect(result.removed).toBe(1);
        expect(result.promoted).toBe(1);

        const updated = liveRows(db);
        const freshDb = join(base, "db", "fresh.db");
        await buildIndex({ db: freshDb, root, ...OPTS });
        const fresh = liveRows(freshDb);
        for (const [path, row] of fresh) {
            const u = updated.get(path);
            expect([path, u?.alloc_bytes, u?.logical_bytes, u?.private_bytes, u?.files, u?.dirs]).toEqual([
                path,
                row.alloc_bytes,
                row.logical_bytes,
                row.private_bytes,
                row.files,
                row.dirs,
            ]);
        }

        // Hysteresis: a stored folder that shrank below the cutoff stays stored until the next build.
        expect([...updated.keys()].filter((p) => !fresh.has(p))).toEqual([join(root, "čeština ünï")]);
        expectMatchesOracle(new Map([...updated].filter(([p]) => !p.endsWith("/denied"))), false);
    });

    it("refuses a database written by a newer schema", async () => {
        const newer = join(base, "db", "newer.db");
        const handle = openIndexDbForWrite(newer);
        setMeta(handle, "schema_version", "2");
        handle.close();
        await expect(buildIndex({ db: newer, root, ...OPTS })).rejects.toMatchObject({
            code: "schema_newer",
            exitCode: 4,
        });
        expect(() => queryPath({ db: newer })).toThrow(IndexError);
    });

    it("stops before walking when the volume is short of space", async () => {
        await expect(
            buildIndex({ db: join(base, "db", "low.db"), root, ...OPTS, minFreeBytes: Number.MAX_SAFE_INTEGER })
        ).rejects.toMatchObject({ code: "disk_low" });
    });

    it("a cancelled build leaves the previous index in place and records the scan as aborted", async () => {
        const before = queryPath({ db });
        const ac = new AbortController();
        ac.abort(new Error("stop"));
        await expect(buildIndex({ db, root, ...OPTS, signal: ac.signal })).rejects.toMatchObject({ code: "aborted" });
        expect({ ...queryPath({ db }), as_of: null }).toEqual({ ...before, as_of: null });
        expect(queryInfo({ db }).scans[0]?.status).toBe("aborted");
    });

    it("gives up a folder whose listing never answers, flags it blocked, and still finishes", async () => {
        const stuck = join(root, "b");
        const seen: IndexEvent[] = [];
        const r = await buildIndex({
            db: join(base, "db", "blocked.db"),
            root,
            ...OPTS,
            stallSeconds: 1,
            // The C test hook parks open() of this folder forever, as a privacy prompt does.
            walkEnv: { CLONESIZE_TEST_BLOCK_DIR: stuck },
            emit: (e) => seen.push(e),
        });
        expect(r.blocked_dirs).toBe(1);
        expect(r.blocked_paths).toEqual([stuck]);
        const event = seen.find((e) => e.type === "blocked");
        expect(event).toMatchObject({ type: "blocked", path: stuck });
        expectBuildEvents([event], ["blocked"]);
        const row = liveRows(join(base, "db", "blocked.db")).get(stuck);
        expect(row).toMatchObject({ flags: 32, alloc_bytes: 0, files: 0 });
    });

    it("keeps a folder whose listing is slow but busy: CPU time that still grows is progress, not a prompt", async () => {
        const slow = join(root, "b");
        const seen: IndexEvent[] = [];
        const r = await buildIndex({
            db: join(base, "db", "busy.db"),
            root,
            ...OPTS,
            stallSeconds: 1,
            // The C test hook spends 2.5 s of CPU before listing this folder, over twice the stall limit.
            walkEnv: { CLONESIZE_TEST_BUSY_DIR: slow },
            emit: (e) => seen.push(e),
        });
        expect(r.blocked_dirs).toBe(0);
        expect(seen.filter((e) => e.type === "blocked")).toEqual([]);
        // Its 50 KB file still counts: the root's total matches an ordinary build of the same tree.
        const plain = await buildIndex({ db: join(base, "db", "busy-plain.db"), root, ...OPTS });
        expect(liveRows(join(base, "db", "busy.db")).get(root)?.files).toBe(
            liveRows(join(base, "db", "busy-plain.db")).get(root)?.files
        );
        expect(plain.blocked_dirs).toBe(0);
    });

    it("the schedule status has the fixture's shape", async () => {
        expectContract(await indexTaskStatus(), "du-index-schedule-status");
    });
});

describeOnDarwin("du index: snapshots, tombstones and diff", () => {
    let base: string;
    let root: string;
    let db: string;

    beforeAll(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), "gt-du-index-diff-")));
        root = join(base, "tree");
        db = join(base, "index.db");
        for (const [dir, size] of [
            ["grow", 150],
            ["gone", 150],
            ["shrink", 300],
            ["stable", 150],
        ] as const) {
            mkdirSync(join(root, dir), { recursive: true });
            write(join(root, dir, "data.bin"), size * KB);
        }
    });

    afterAll(() => {
        rmSync(base, { recursive: true, force: true });
    });

    it("labels grown, shrunk, new and gone folders between two builds, and keeps the gone row as a tombstone", async () => {
        const first = await buildIndex({ db, root, ...OPTS });
        appendFileSync(join(root, "grow", "data.bin"), Buffer.alloc(200 * KB, 1));
        rmSync(join(root, "gone"), { recursive: true });
        truncateSync(join(root, "shrink", "data.bin"), 120 * KB);
        mkdirSync(join(root, "new"));
        write(join(root, "new", "data.bin"), 200 * KB);
        const second = await buildIndex({ db, root, ...OPTS });

        const all = diffIndex({ db, from: String(first.scan_id), to: String(second.scan_id), attribute: "all" });
        expectContract(diffIndex({ db, from: String(first.scan_id), to: "now", attribute: "all" }), "du-index-diff");
        const status = Object.fromEntries(all.rows.map((r) => [r.path.slice(root.length) || "/", r.status]));
        expect(status).toEqual({
            "/": "grown",
            "/grow": "grown",
            "/gone": "shrunk",
            "/shrink": "shrunk",
            "/new": "new",
        });
        expect(all.rows.filter((r) => r.approx).map((r) => r.path)).toEqual([join(root, "gone")]);
        expect(all.rows.find((r) => r.path === join(root, "gone"))?.after).toBeNull();
        expect(all.total_delta.alloc_bytes).toBe(second.alloc_bytes - first.alloc_bytes);

        // Leaf attribution: /grow alone explains more than 80% of the root's growth.
        const leaf = diffIndex({ db, from: String(first.scan_id), to: String(second.scan_id) });
        expect(leaf.rows.map((r) => r.path)).not.toContain(root);

        const raw = new Database(db, { readonly: true });
        const gone = raw.query<{ flags: number }, [string]>("SELECT flags FROM dirs WHERE name = ?").get("gone");
        raw.close();
        expect(gone?.flags).toBe(16);
        const top = queryPath({ db });
        expect(top.found && top.children.map((c) => c.name)).not.toContain("gone");
    });

    it("diffs the live index against the last snapshot after an update", async () => {
        appendFileSync(join(root, "grow", "data.bin"), Buffer.alloc(100 * KB, 2));
        await updateIndex({ db, paths: [join(root, "grow")], minFreeBytes: 0 });
        const live = diffIndex({ db, attribute: "all" });
        expect(live.to.live).toBe(true);
        const grow = live.rows.find((r) => r.path === join(root, "grow"));
        expect(grow).toMatchObject({ status: "grown", delta: 100 * KB, approx: false });
    });

    it("a query of a missing database is not_built, as JSON with exit code 1 from the CLI", async () => {
        const proc = Bun.spawn(
            [
                "bun",
                join(import.meta.dir, "..", "..", "index.ts"),
                "index",
                "query",
                "--db",
                join(base, "none.db"),
                "--format",
                "json",
            ],
            { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv() }
        );
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        expect(code).toBe(1);
        const err = SafeJSON.parse(stdout, { strict: true });
        expect(err).toMatchObject({ type: "error", command: "query", code: "not_built", exit_code: 1 });
        expectContract(err, "du-index-error");
    });
});

// Include the native walker in a fixture harness so its logical root can be "/"
// without reading the real filesystem root, and its retained capacity is observable.
const INDEX_HARNESS = `
#include <fcntl.h>
#include <stdarg.h>
#include <string.h>
static const char *fixture_root;
static int fixture_open(const char *path, int flags, ...);
#define open fixture_open
#define main clonesize_main
#include ${SafeJSON.stringify(join(import.meta.dir, "../../native/clonesize.c"))}
#undef main
#undef open
static int fixture_open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args; va_start(args, flags); mode = va_arg(args, int); va_end(args);
    }
    return open(strcmp(path, "/") == 0 ? fixture_root : path, flags, mode);
}
static int mount_listed(const char *mp) {
    for (int i = 0; i < g_nforeign; i++)
        if (strcmp(g_foreign_mounts[i], mp) == 0) return 1;
    return 0;
}

/** Exit 0 when a root of "/" registers every foreign mount and a scratch dir registers none outside itself. */
static int foreign_mounts_cover_root(const char *scratch) {
    struct statfs rootfs;
    if (statfs("/", &rootfs) < 0) return 2;
    reset_foreign_mounts();
    add_foreign_mounts("/");
    struct statfs *mnts = NULL;
    int n = getmntinfo(&mnts, MNT_NOWAIT);
    if (n <= 0) return 2;
    int foreign = 0, missing = 0;
    for (int i = 0; i < n; i++) {
        const char *mp = mnts[i].f_mntonname;
        if (mnts[i].f_fsid.val[0] == rootfs.f_fsid.val[0] &&
            mnts[i].f_fsid.val[1] == rootfs.f_fsid.val[1]) continue;
        if (strcmp(mp, "/") == 0) continue;
        foreign++;
        if (foreign <= MAX_FOREIGN_MOUNTS && !mount_listed(mp)) missing++;
    }
    reset_foreign_mounts();
    add_foreign_mounts(scratch);
    size_t slen = strlen(scratch);
    int leaked = 0;
    for (int i = 0; i < g_nforeign; i++) {
        const char *mp = g_foreign_mounts[i];
        if (!(strncmp(mp, scratch, slen) == 0 && mp[slen] == '/')) leaked++;
    }
    printf("foreign=%d missing=%d leaked=%d\\n", foreign, missing, leaked);
    return (foreign > 0 && missing == 0 && leaked == 0) ? 0 : 4;
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[2], "foreign") == 0) return foreign_mounts_cover_root(argv[1]);
    if (argc != 4) return 2;
    fixture_root = argv[1];
    int root_mode = strcmp(argv[2], "root") == 0;
    const char *logical_root = root_mode ? "/" : fixture_root;
    g_idx_private = 0;
    g_idx_big_floor = 0;
    g_idx_big_limit = strtoull(argv[3], NULL, 10);
    if (root_mode) {
        g_excludes[g_nexcludes++] = "/excluded";
        g_foreign_mounts[g_nforeign++] = "/mounted";
    }
    idx_setup_attrlist();
    idx_intern(-1, logical_root, 1, 0, 0);
    IdxOut worker = { .mtx = PTHREAD_MUTEX_INITIALIZER, .state = 1 };
    if (idx_process_dir(&worker, logical_root, 0)) return 3;
    printf("retained=%zu capacity=%zu\\n", worker.nbig, worker.capbig);
    for (int i = 1; i < g_inn; i++) printf("node=%s flags=%u\\n", inode(i)->name, inode(i)->flags);
    for (int i = 0; i < g_qn; i++) printf("queued=%s\\n", g_q[i].path);
    for (size_t i = 0; i < worker.nbig; i++) printf("file=%s\\n", worker.big[i].path);
    return 0;
}
`;

describeOnDarwin("du index: root paths and bounded collection", () => {
    let base: string;
    let harness: string;

    beforeAll(async () => {
        base = realpathSync(mkdtempSync(join(tmpdir(), "gt-index-collector-")));
        const source = join(base, "harness.c");
        harness = join(base, "harness");
        writeFileSync(source, INDEX_HARNESS);
        const compile = Bun.spawn(["clang", "-O2", "-pthread", source, "-o", harness], {
            stdout: "pipe",
            stderr: "pipe",
            env: env.getProcessEnv(),
        });
        const stderr = await new Response(compile.stderr).text();
        expect({ code: await compile.exited, stderr }).toEqual({ code: 0, stderr: "" });
    });

    afterAll(() => rmSync(base, { recursive: true, force: true }));

    async function inspect(root: string, mode: string, limit: number): Promise<string[]> {
        const proc = Bun.spawn([harness, root, mode, String(limit)], {
            stdout: "pipe",
            stderr: "pipe",
            env: env.getProcessEnv(),
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        return stdout.trim().split("\n");
    }

    it("canonicalizes root children before exclusions, mount guards, queueing and big-file storage", async () => {
        const root = join(base, "root");
        for (const name of ["excluded", "mounted", "kept"]) {
            mkdirSync(join(root, name), { recursive: true });
        }
        write(join(root, "big.bin"), 4096);
        const lines = await inspect(root, "root", 16);
        expect(lines.filter((line) => line.startsWith("node=")).sort()).toEqual([
            "node=kept flags=0",
            "node=mounted flags=8",
        ]);
        expect(lines.filter((line) => line.startsWith("queued="))).toEqual(["queued=/kept"]);
        expect(lines.filter((line) => line.startsWith("file="))).toEqual(["file=/big.bin"]);
    });

    it("registers every foreign mount for a scan rooted at / and none that sit outside a scratch dir", async () => {
        const scratch = join(base, "foreign-scratch");
        mkdirSync(scratch);
        const proc = Bun.spawn([harness, scratch, "foreign"], {
            stdout: "pipe",
            stderr: "pipe",
            env: env.getProcessEnv(),
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        expect({ code, stderr, stdout: stdout.trim() }).toEqual({
            code: 0,
            stderr: "",
            stdout: expect.stringMatching(/^foreign=[1-9]\d* missing=0 leaked=0$/),
        });
    });

    it.each([0, 1, 7, 80])("retains at most %i candidates even when every file qualifies", async (limit) => {
        const root = join(base, `bounded-${limit}`);
        mkdirSync(root);
        const paths = Array.from({ length: 128 }, (_, i) => join(root, `file-${String(i).padStart(3, "0")}.bin`));
        for (const [i, path] of paths.entries()) {
            write(path, 4096 * (1 + (i % 11)));
        }
        const lines = await inspect(root, "heap", limit);
        expect(lines[0]).toBe(`retained=${limit} capacity=${limit}`);
        const expected = paths
            .map((path) => ({ path, allocated: lstatSync(path).blocks * 512 }))
            .sort((a, b) => b.allocated - a.allocated || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
            .slice(0, limit)
            .map(({ path }) => `file=${path}`)
            .sort();
        expect(lines.filter((line) => line.startsWith("file=")).sort()).toEqual(expected);
    });

    it("merges workers into the exact global top K while preserving qualifying totals at limit zero", async () => {
        const root = join(base, "merge");
        const files: Array<{ path: string; allocated: number }> = [];
        for (let d = 0; d < 8; d++) {
            const dir = join(root, `dir-${d}`);
            mkdirSync(dir, { recursive: true });
            for (let i = 0; i < 20; i++) {
                const path = join(dir, `file-${i}.bin`);
                write(path, 4096 * (1 + ((d * 7 + i) % 13)));
                files.push({ path, allocated: lstatSync(path).blocks * 512 });
            }
        }
        const ranked = files.sort(
            (a, b) => b.allocated - a.allocated || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
        );
        for (const limit of [0, 1, 7, 200]) {
            const walk = await runIndexWalk({
                root,
                threads: 4,
                minDirBytes: 0,
                bigFileFloor: 0,
                bigFileLimit: limit,
                private: false,
                excludes: [],
                includeCloud: false,
            });
            expect(walk.big.map((file) => file.p)).toEqual(
                ranked
                    .slice(0, limit)
                    .map((file) => file.path)
                    .sort()
            );
            expect(walk.end.big_total).toBe(files.length);
            expect(walk.nodes[0].a).toBe(files.reduce((sum, file) => sum + file.allocated, 0));
        }
    });
});

describeOnDarwin("du index: review regressions (2026-10-13 CLI review)", () => {
    let base: string;

    beforeAll(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), "gt-du-index-review-")));
    });

    afterAll(() => {
        rmSync(base, { recursive: true, force: true });
    });

    function walkOpts(root: string, extra: Partial<WalkOptions>): WalkOptions {
        return {
            root,
            minDirBytes: 0,
            bigFileFloor: 1024 * 1024 * 1024,
            bigFileLimit: 0,
            private: false,
            excludes: [],
            includeCloud: false,
            ...extra,
        };
    }

    it.each([0, 2])("persists big-file limit %i through updates and the nightly task", async (limit) => {
        const toolsHome = join(base, `limit-${limit}`);
        const db = join(toolsHome, ".genesis-tools", "du", "index.db");
        const root = join(base, `limit-tree-${limit}`);
        for (const name of ["a", "b"]) {
            mkdirSync(join(root, name), { recursive: true });
            for (let i = 0; i < 4; i++) {
                write(join(root, name, `file-${i}`), (i + 1) * 4096);
            }
        }
        await buildIndex({ db, root, ...OPTS, minDirBytes: 0, bigFileFloor: 0, bigFileLimit: limit });
        const check = new Database(db);
        try {
            expect(check.query("SELECT value FROM meta WHERE key = 'big_file_limit'").get()).toEqual({
                value: String(limit),
            });
            for (const name of ["a", "b"]) {
                write(join(root, name, "new-big"), 64 * KB);
                await updateIndex({ db, paths: [join(root, name)], minFreeBytes: 0 });
                expect(check.query("SELECT COUNT(*) AS n FROM big_files").get()).toEqual({ n: limit });
            }
            const preload = join(toolsHome, "nightly-preload.ts");
            writeFileSync(
                preload,
                `import { mock } from "bun:test";
                mock.module(${SafeJSON.stringify(join(import.meta.dir, "build.ts"))}, () => ({
                    INDEX_DEFAULTS: ${SafeJSON.stringify(INDEX_DEFAULTS)},
                    buildIndex: async (opts) => ({ bigFileLimit: opts.bigFileLimit })
                }));`
            );
            const nightly = async () => {
                const proc = Bun.spawn(
                    [process.execPath, "--preload", preload, join(import.meta.dir, "index-daemon.ts")],
                    {
                        env: { ...env.getProcessEnv(), GENESIS_TOOLS_HOME: toolsHome },
                        stdout: "pipe",
                        stderr: "pipe",
                    }
                );
                const [stdout, stderr, code] = await Promise.all([
                    new Response(proc.stdout).text(),
                    new Response(proc.stderr).text(),
                    proc.exited,
                ]);
                expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
                return SafeJSON.parse(stdout, { strict: true });
            };
            expect(await nightly()).toEqual({ bigFileLimit: limit });
            // Databases built before this key existed retain the documented default.
            check.run("DELETE FROM meta WHERE key = 'big_file_limit'");
            expect(await nightly()).toEqual({ bigFileLimit: INDEX_DEFAULTS.bigFileLimit });
            await updateIndex({ db, paths: [root], recursive: true, minFreeBytes: 0 });
            expect(check.query("SELECT COUNT(*) AS n FROM big_files").get()).toEqual({ n: 10 });
        } finally {
            check.close();
        }
    });

    it("forwards update walk progress and blocked events", async () => {
        const root = join(base, "update-events");
        mkdirSync(root);
        write(join(root, "file"), 4096);
        const db = join(base, "update-events.db");
        await buildIndex({ db, root, ...OPTS });
        const events: IndexEvent[] = [];
        const progress = { files: 1, dirs: 1, bytes: 4096, elapsed_ms: 500, dir: root };
        const original = indexWalk.runIndexWalk;
        const walk = spyOn(indexWalk, "runIndexWalk").mockImplementation(async (options) => {
            options.onProgress?.(progress);
            options.onBlocked?.({ path: join(root, "unreadable"), waited_ms: 1000 });
            return original(options);
        });
        try {
            await updateIndex({ db, paths: [root], minFreeBytes: 0, emit: (event) => events.push(event) });
            expect(events).toContainEqual(progressEvent(progress));
            expect(events).toContainEqual({
                type: "blocked",
                phase: "walk",
                path: join(root, "unreadable"),
                waited_ms: 1000,
            });
            expectBuildEvents(
                events.filter((event) => event.type === "progress" || event.type === "blocked"),
                ["progress", "blocked"]
            );
        } finally {
            walk.mockRestore();
        }
    });

    it("reports a formerly stored directory folded by a rebuild as approximately shrunk", async () => {
        const root = join(base, "folded-live");
        mkdirSync(join(root, "shrunk"), { recursive: true });
        const file = join(root, "shrunk", "data.bin");
        write(file, 200 * KB);
        const db = join(base, "folded-live.db");
        const first = await buildIndex({ db, root, ...OPTS, snapshotFloor: 0 });
        truncateSync(file, 20 * KB);
        await buildIndex({ db, root, ...OPTS, snapshotFloor: 0 });
        const diff = diffIndex({ db, from: String(first.scan_id), attribute: "all" });
        expect(diff.rows.find((row) => row.path === join(root, "shrunk"))).toMatchObject({
            before: 200 * KB,
            after: null,
            delta: -100 * KB,
            status: "shrunk",
            approx: true,
        });
    });

    it("preserves recursive intent across a locked queue and a normal drain", async () => {
        const root = join(base, "queued-recursive");
        mkdirSync(join(root, "a", "child"), { recursive: true });
        write(join(root, "a", "child", "data.bin"), 200 * KB);
        const db = join(base, "queued-recursive.db");
        await buildIndex({ db, root, ...OPTS });
        appendFileSync(join(root, "a", "child", "data.bin"), Buffer.alloc(100 * KB));
        await withIndexLock(db, async () => {
            for (const recursive of [true, false]) {
                const result = await updateIndex({
                    db,
                    paths: [join(root, "a")],
                    recursive,
                    lockWaitMs: 0,
                    minFreeBytes: 0,
                });
                expect(result.deferred).toBe(true);
            }
        });
        await updateIndex({ db, paths: [], fromQueue: true, minFreeBytes: 0 });
        const current = queryPath({ db, path: join(root, "a", "child") });
        expect(current.found && current.node.logical_bytes).toBe(300 * KB);
        expect(queryInfo({ db }).counts.dirty_queue).toBe(0);
        const fresh = join(base, "queued-recursive-fresh.db");
        await buildIndex({ db: fresh, root, ...OPTS });
        expect(queryPath({ db }).found && liveRows(db).get(root)?.alloc_bytes).toBe(
            liveRows(fresh).get(root)?.alloc_bytes
        );
    });

    it("does not apply present-day tombstones to a historical below-floor diff", async () => {
        const root = join(base, "historical-floor");
        mkdirSync(join(root, "shrinking"), { recursive: true });
        const file = join(root, "shrinking", "data.bin");
        write(file, 200 * KB);
        const db = join(base, "historical-floor.db");
        const a = await buildIndex({ db, root, ...OPTS });
        truncateSync(file, 10 * KB);
        const b = await buildIndex({ db, root, ...OPTS });
        const options = { db, from: String(a.scan_id), to: String(b.scan_id), attribute: "all" as const };
        const beforeDelete = diffIndex(options);
        rmSync(join(root, "shrinking"), { recursive: true });
        await buildIndex({ db, root, ...OPTS });
        const afterDelete = diffIndex(options);
        expect(afterDelete.rows).toEqual(beforeDelete.rows);
        expect(afterDelete.rows.find((row) => row.path === join(root, "shrinking"))).toMatchObject({
            status: "shrunk",
            after: null,
            approx: true,
        });
    });

    it("reads query, largest, info and diff responses from one WAL snapshot", async () => {
        const root = join(base, "snapshot-read");
        mkdirSync(join(root, "child"), { recursive: true });
        write(join(root, "child", "data.bin"), 200 * KB);
        const db = join(base, "snapshot-read.db");
        await buildIndex({ db, root, ...OPTS });
        const writer = openIndexDbForWrite(db);
        try {
            for (const query of ["path", "largest", "info", "diff"]) {
                const beforePath = queryPath({ db });
                const beforeLargest = queryLargest({ db, largest: "dirs" });
                const beforeInfo = queryInfo({ db });
                const beforeDiff = diffIndex({ db, attribute: "all" });
                let commits = 0;
                const now = () => {
                    writer.transaction(() => {
                        writer.run("UPDATE dirs SET alloc_bytes = alloc_bytes * 2");
                        writer.run("DELETE FROM big_files");
                        writer.run("UPDATE scans SET finished_at_ms = finished_at_ms + 1000");
                    })();
                    commits++;
                    return Date.now();
                };
                if (query === "path") {
                    const result = queryPath({ db, now });
                    expect(result.found && result.node).toEqual(beforePath.found && beforePath.node);
                    expect(result.found && result.children).toEqual(beforePath.found && beforePath.children);
                    expect(result.found && result.top_files).toEqual(beforePath.found && beforePath.top_files);
                } else if (query === "largest") {
                    expect(queryLargest({ db, largest: "dirs", now }).rows).toEqual(beforeLargest.rows);
                } else if (query === "info") {
                    const result = queryInfo({ db, now });
                    expect(result.scans).toEqual(beforeInfo.scans);
                    expect(result.as_of?.finished_at_ms).toEqual(beforeInfo.as_of?.finished_at_ms);
                } else {
                    expect(diffIndex({ db, attribute: "all", now }).total_delta).toEqual(beforeDiff.total_delta);
                }
                expect(commits).toBe(1);
            }
        } finally {
            writer.close();
        }
    });

    it("H3: a recursive update of a folder and its own stored subfolder equals a fresh build", async () => {
        const root = join(base, "h3");
        mkdirSync(join(root, "a", "b", "c"), { recursive: true });
        write(join(root, "a", "x.bin"), 50 * KB);
        write(join(root, "a", "b", "y.bin"), 50 * KB);
        write(join(root, "a", "b", "c", "z.bin"), 300 * KB);
        write(join(root, "a", "b", "c", "z2.bin"), 100 * KB);
        const db = join(base, "h3.db");
        await buildIndex({ db, root, ...OPTS });
        // c drops below the cutoff, so the walk of `a` folds it while `c` is also asked for.
        truncateSync(join(root, "a", "b", "c", "z.bin"), 10 * KB);
        rmSync(join(root, "a", "b", "c", "z2.bin"));

        await updateIndex({
            db,
            paths: [join(root, "a"), join(root, "a", "b", "c")],
            recursive: true,
            minFreeBytes: 0,
        });
        const fresh = join(base, "h3-fresh.db");
        await buildIndex({ db: fresh, root, ...OPTS });
        const updated = liveRows(db);
        for (const [path, row] of liveRows(fresh)) {
            expect([path, updated.get(path)?.alloc_bytes, updated.get(path)?.files]).toEqual([
                path,
                row.alloc_bytes,
                row.files,
            ]);
        }

        expectMatchesOracle(updated, false);
    });

    it("H3: an update that would leave a parent smaller than its children fails and changes nothing", async () => {
        const root = join(base, "h3");
        const db = join(base, "h3.db");
        const raw = new Database(db);
        raw.run("UPDATE dirs SET alloc_bytes = 1 WHERE parent_id = 0");
        raw.close();
        await expect(updateIndex({ db, paths: [join(root, "a")], minFreeBytes: 0 })).rejects.toMatchObject({
            code: "inconsistent",
        });
        const check = new Database(db, { readonly: true });
        const rootRow = check
            .query<{ alloc_bytes: number }, []>("SELECT alloc_bytes FROM dirs WHERE parent_id = 0")
            .get();
        check.close();
        expect(rootRow?.alloc_bytes).toBe(1);
    });

    it("M1: a blocked folder gives up its queued siblings, so 100 blocked containers cost one stuck worker each round, not 100", async () => {
        const root = join(base, "m1-siblings");
        for (let i = 0; i < 100; i++) {
            mkdirSync(join(root, "Containers", `blk-${i}`), { recursive: true });
            writeFileSync(join(root, "Containers", `blk-${i}`, "f"), "x");
        }

        mkdirSync(join(root, "ok"));
        write(join(root, "ok", "f.bin"), 10 * KB);
        const walk = await runIndexWalk(
            walkOpts(root, { threads: 4, stallSeconds: 1, env: { CLONESIZE_TEST_BLOCK_NAME_PREFIX: "blk-" } })
        );
        expect(walk.end.blocked).toBe(100);
        expect(walk.end.workers).toBeLessThanOrEqual(8);
        expect(walk.nodes.find((n) => n.n === "ok")?.a).toBeGreaterThan(0);
    });

    it("M1: when every worker is stuck at the cap, the queued folders are given up and the walk still ends", async () => {
        const root = join(base, "m1-cap");
        for (let i = 0; i < 8; i++) {
            mkdirSync(join(root, `p${i}`, `blk-${i}`), { recursive: true });
            mkdirSync(join(root, `p${i}`, "plain"), { recursive: true });
        }

        const started = Date.now();
        const walk = await runIndexWalk(
            walkOpts(root, {
                threads: 2,
                stallSeconds: 1,
                env: { CLONESIZE_TEST_BLOCK_NAME_PREFIX: "blk-", CLONESIZE_TEST_MAX_STUCK: "2" },
            })
        );
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(walk.end.workers).toBeLessThanOrEqual(4);
        expect(walk.end.blocked).toBeGreaterThanOrEqual(2);
    });

    it("bounds flagged children by the remaining query limit without duplicates", async () => {
        const root = join(base, "flagged-limit");
        for (const name of [
            "a-match",
            "normal",
            ...Array.from({ length: 100 }, (_, i) => `flag-${String(i).padStart(3, "0")}`),
        ]) {
            mkdirSync(join(root, name), { recursive: true });
        }
        write(join(root, "a-match", "data.bin"), 200 * KB);
        write(join(root, "normal", "data.bin"), 200 * KB);
        const db = join(base, "flagged-limit.db");
        await buildIndex({ db, root, ...OPTS, minDirBytes: 0 });
        const writer = openIndexDbForWrite(db);
        try {
            writer.run("UPDATE dirs SET flags = 32 WHERE name LIKE 'flag-%' OR name = 'a-match'");
        } finally {
            writer.close();
        }
        for (const limit of [0, 1, 2, 4, 150]) {
            const result = queryPath({ db, minBytes: 100 * KB, limit });
            if (!result.found) {
                throw new Error("fixture root missing");
            }
            expect(result.children).toHaveLength(Math.min(limit, 102));
            expect(new Set(result.children.map((child) => child.name)).size).toBe(result.children.length);
            expect(result.truncated).toBe(limit < 102);
            if (limit === 4) {
                expect(result.children.map((child) => child.name)).toEqual([
                    "a-match",
                    "normal",
                    "flag-000",
                    "flag-001",
                ]);
            }
        }
        const onlyFlags = queryPath({ db, changedSince: Math.floor(Date.now() / 1000) + 60, limit: 1 });
        expect(onlyFlags.found && onlyFlags.children.map((child) => child.name)).toEqual(["a-match"]);
        expect(onlyFlags.found && onlyFlags.truncated).toBe(true);
    });

    it("M7: query and info report blocked folders, and a blocked child is listed even below --min-bytes", async () => {
        const root = join(base, "m7");
        mkdirSync(join(root, "stuck"), { recursive: true });
        mkdirSync(join(root, "big"), { recursive: true });
        write(join(root, "big", "f.bin"), 200 * KB);
        const db = join(base, "m7.db");
        await buildIndex({
            db,
            root,
            ...OPTS,
            stallSeconds: 1,
            walkEnv: { CLONESIZE_TEST_BLOCK_DIR: join(root, "stuck") },
        });
        expect(queryInfo({ db }).counts.blocked).toBe(1);
        const top = queryPath({ db, minBytes: 100 * KB });
        if (!top.found) {
            throw new Error("root not found");
        }

        expect(top.blocked_below).toBe(1);
        expect(top.children.map((c) => [c.name, c.flags])).toEqual([
            ["big", 0],
            ["stuck", 32],
        ]);
    });

    it("a running scan or temp file whose pid is gone or reused by another program is swept; a live du run is kept", async () => {
        const handle = openIndexDbForWrite(join(base, "sweep.db"));
        // A program that is not a du run holds this pid: a recycled pid must not keep a scan "running".
        const foreign = Bun.spawn(["sleep", "30"], { env: env.getProcessEnv() });
        const duRun = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { env: env.getProcessEnv() });
        const ended = Bun.spawn(["true"], { env: env.getProcessEnv() });
        await ended.exited;
        try {
            for (const pid of [foreign.pid, duRun.pid, ended.pid]) {
                handle.run(
                    "INSERT INTO scans (kind, root, started_at_ms, status, pid, options_json) VALUES ('build', '/x', 1, 'running', ?, '{}')",
                    [pid]
                );
            }

            expect(sweepDeadScans(handle, 2)).toBe(2);
            expect(handle.query("SELECT pid, status FROM scans ORDER BY id").all()).toEqual([
                { pid: foreign.pid, status: "aborted" },
                { pid: duRun.pid, status: "running" },
                { pid: ended.pid, status: "aborted" },
            ]);

            const cache = join(base, "sweep-cache");
            mkdirSync(cache);
            for (const pid of [foreign.pid, duRun.pid, ended.pid]) {
                writeFileSync(join(cache, `extents-1.bin.tmp.${pid}`), "x");
            }

            expect(sweepOrphanTempFiles(cache)).toBe(2);
            expect(readdirSync(cache)).toEqual([`extents-1.bin.tmp.${duRun.pid}`]);
        } finally {
            foreign.kill();
            duRun.kill();
            handle.close();
        }
    });

    it("M8: the free-space floor follows the database size, not a fixed 8 GiB", () => {
        const MiB = 1024 * 1024;
        expect(defaultMinFreeBytes(20 * MiB)).toBe(1024 * MiB);
        expect(defaultMinFreeBytes(1024 * MiB)).toBe(2 * 1024 * MiB + 256 * MiB);
    });

    it("L6: an exclude given through a symlink and with a trailing slash still excludes", async () => {
        const root = join(base, "l6");
        mkdirSync(join(root, "a", "d"), { recursive: true });
        write(join(root, "a", "d", "f.bin"), 300 * KB);
        write(join(root, "a", "e.bin"), 200 * KB);
        symlinkSync(root, join(base, "l6-link"));
        const r = await buildIndex({
            db: join(base, "l6.db"),
            root,
            ...OPTS,
            excludes: [`${join(base, "l6-link", "a", "d")}/`],
        });
        expect(r.alloc_bytes).toBe(oracle(join(root, "a")).alloc - oracle(join(root, "a", "d")).alloc);
    });
});
