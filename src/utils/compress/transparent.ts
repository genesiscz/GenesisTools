/**
 * Verified APFS transparent compression. tools compress owns the writing command;
 * tools du supplies native listings and reads the shared plan and sample functions.
 */
import {
    closeSync,
    existsSync,
    fstatSync,
    linkSync,
    lstatSync,
    openSync,
    readSync,
    renameSync,
    type Stats,
    unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileFlags } from "@genesiscz/utils/fs/cloud-placeholder";
import { logger } from "@genesiscz/utils/logger";
import { cloneFile, getPrivateSize } from "@genesiscz/utils/macos/apfs";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import {
    encodedSampleBytes,
    restoreFileTimes,
    storedCompressionAlgorithm,
    type TransparentAlgorithm,
} from "./transparent-native";

export const TMP_PREFIX = ".cold-";
/** The original of a swapped file, kept under this name until `settle` proved that no writer still used it. */
export const OLD_PREFIX = ".cold-old-";
/** A file whose blocks cover less than this share of its size is already compressed or sparse. */
const COMPACT = 0.6;
/** A compressed copy must be at most this share of the original's blocks, else the file stays as it is. */
const WORTH = 0.9;
/**
 * `ditto --hfsCompression` stores a file above 512 MiB plain, without an error. Measured 2026-11-10 with one
 * transcript cut to four lengths: 500 MB and 520 MB came out compressed (30 MB), 540 MB and 600 MB did not.
 */
export const DITTO_MAX_BYTES = 512 * 1024 ** 2;
export const UF_COMPRESSED = 0x20;

export interface NativeCompressionEntry {
    path: string;
    size: number;
    allocated: number;
    flags: number;
    ino: number;
    mtimeMs: number;
    nlink: number;
    cloneId?: string;
    mtimeNs?: string;
}

export type Candidate = {
    path: string;
    size: number;
    alloc: number;
    mtimeMs: number;
    ino: number;
    cloneId?: string;
    mtimeNs?: string;
    partners?: string[];
    privateBytes?: number;
};
export type Outcome = {
    path: string;
    status: "compressed" | "no gain" | "changed" | "failed" | "restored" | "conflict";
    before: number;
    after: number;
    note?: string;
    /** Kernel private bytes of the old inode immediately before its unlink. Unknown earns zero saving. */
    releasedBytes?: number;
    /** The original stays until settlement proves no writer can still use it. */
    old?: {
        path: string;
        ino: number;
        size: number;
        mtimeMs: number;
        mtimeNs: string;
        ctimeNs: string;
        newIno: number;
        newCtimeNs: string;
    };
};
export type Skips = Record<"young" | "small" | "too-big" | "open" | "compact" | "linked" | "other-type", number>;

/**
 * The paths that carry the UF_COMPRESSED flag (0x20), read through getattrlist. A file that compressed
 * only a little (a transcript full of base64 images keeps 70% of its blocks) is told from a plain one by this
 * flag alone: its block count is not small enough to show it.
 */
export function compressedPaths(paths: string[]): Set<string> {
    return new Set(paths.filter((path) => ((fileFlags(path) ?? 0) & UF_COMPRESSED) !== 0));
}

/** Pure filtering of one native getattrlistbulk listing. No subprocess or filesystem writes. */
export function plan(
    entries: NativeCompressionEntry[],
    o: {
        olderThanMs: number;
        minBytes: number;
        exts: Set<string>;
        open: Set<string>;
        now: number;
        maxBytes?: number;
    }
): { candidates: Candidate[]; compact: string[]; skips: Skips; stale: string[]; tooBigBytes: number } {
    const candidates: Candidate[] = [];
    const compact: string[] = [];
    const skips: Skips = { young: 0, small: 0, "too-big": 0, open: 0, compact: 0, linked: 0, "other-type": 0 };
    const stale: string[] = [];
    let tooBigBytes = 0;

    for (const e of entries) {
        const name = basename(e.path);
        if (name.startsWith(TMP_PREFIX)) {
            stale.push(e.path);
            continue;
        }

        const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(name) || !o.exts.has(ext)) {
            skips["other-type"]++;
        } else if (e.size < o.minBytes) {
            skips.small++;
        } else if (o.now - e.mtimeMs < o.olderThanMs) {
            skips.young++;
        } else if (e.size > (o.maxBytes ?? DITTO_MAX_BYTES)) {
            skips["too-big"]++;
            tooBigBytes += e.size;
        } else if (e.nlink !== 1) {
            skips.linked++;
        } else if ((e.flags & UF_COMPRESSED) !== 0 || e.allocated < e.size * COMPACT) {
            skips.compact++;
            compact.push(e.path);
        } else if ((e.flags & 0x40000000) !== 0) {
            skips["other-type"]++;
        } else if (o.open.has(e.path)) {
            skips.open++;
        } else {
            candidates.push({
                path: e.path,
                size: e.size,
                alloc: e.allocated,
                mtimeMs: e.mtimeMs,
                ino: e.ino,
                cloneId: e.cloneId,
                mtimeNs: e.mtimeNs,
            });
        }
    }

    return { candidates: candidates.sort((a, b) => b.alloc - a.alloc), compact, skips, stale, tooBigBytes };
}

/** A clone mirror: every file under `from` may have a clone at the same relative path under `to`. */
export type Mirror = { from: string; to: string };
export type MirrorOutcome = {
    path: string;
    status: "re-cloned" | "absent" | "already compact" | "differs" | "failed";
    freed: number;
    note?: string;
};

/**
 * Bring the mirror copy of a compressed file to the compressed blocks.
 *
 * A clone mirror (`cp -c`, as ~/backupClaude.ts makes in ~/.claude.bkp) shares the blocks of the plain file. After
 * the original is compressed, the mirror copy alone still holds every plain block, so no space is free yet and
 * the compressed copy came on top. A clone of a compressed file is compressed too and shares its blocks
 * (measured 2026-11-10), so the mirror copy is replaced by a clone of the compressed original, and only then
 * are the plain blocks free. It is replaced only when it holds the same bytes.
 */
/** Refuse metadata differences rather than replacing a partner's access policy or attributes. */
async function samePartnerMetadata(source: string, partner: string): Promise<boolean> {
    const a = lstatSync(source);
    const b = lstatSync(partner);
    if (
        a.mode !== b.mode ||
        a.uid !== b.uid ||
        a.gid !== b.gid ||
        ((fileFlags(source) ?? -1) & ~UF_COMPRESSED) !== ((fileFlags(partner) ?? -2) & ~UF_COMPRESSED)
    ) {
        return false;
    }
    for (const command of [
        ["/usr/bin/xattr", "-lx"],
        ["/bin/ls", "-lde"],
    ]) {
        const results = await Promise.all(
            [source, partner].map((file) =>
                boundedCommand({
                    command: [...command, file],
                    timeoutMs: 5000,
                    maxBufferBytes: 1024 * 1024,
                })
            )
        );
        if (results.some((result) => result.status !== 0 || result.error)) {
            return false;
        }
        // A single-file ls header contains the name; subsequent lines contain the ACL.
        const values = results.map((result) =>
            command[0] === "/bin/ls" ? result.stdout.split("\n").slice(1).join("\n") : result.stdout
        );
        if (values[0] !== values[1]) {
            return false;
        }
    }
    return true;
}

/** Refresh a partner with the same transaction and held-descriptor settlement as an original. */
export async function clonePartner(
    source: string,
    candidate: Candidate,
    algorithm: TransparentAlgorithm
): Promise<Outcome> {
    const compared = await exec(["/usr/bin/cmp", "-s", source, candidate.path]);
    if (compared.code !== 0) {
        return {
            path: candidate.path,
            status: "changed",
            before: candidate.alloc,
            after: candidate.alloc,
            note: "clone partner has other bytes; no saving is claimed",
        };
    }

    return compressOne(candidate, {
        name: "clonefile",
        algorithm,
        maxBytes: Number.MAX_SAFE_INTEGER,
        write: async ({ target }) => {
            if (!(await samePartnerMetadata(source, candidate.path))) {
                return { code: 1, err: "clone partner metadata differs or could not be verified; partner preserved" };
            }
            cloneFile(source, target);
            restoreFileTimes(candidate.path, target);
            if (!(await samePartnerMetadata(target, candidate.path))) {
                return { code: 1, err: "clone partner metadata changed during copy; partner preserved" };
            }
            return { code: 0, err: "" };
        },
    });
}

async function exec(cmd: string[]): Promise<{ code: number; err: string }> {
    const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 600_000);
    try {
        const err = await new Response(p.stderr).text();
        return { code: await p.exited, err: err.trim() };
    } finally {
        clearTimeout(timer);
    }
}

/** Only transaction-owned scratch and aside names may be unlinked. */
export function drop(path: string): void {
    if (!/^\.cold-(?:old-)?[0-9]+-.+/.test(basename(path))) {
        throw new Error(`Refusing to unlink a non-transaction file: ${path}`);
    }

    try {
        unlinkSync(path);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
    }
}

/** A file whose sample packs to more than this share is not worth a full pass. */
const SAMPLE_SKIP = 0.75;

/**
 * Encoded/raw ratio of the first and middle 1 MiB using the selected libcompression codec.
 * A smaller file is sampled whole. Media-like JSONL can be rejected before a full temporary copy.
 */
export function sampleRatio(path: string, size: number, algorithm: TransparentAlgorithm = "lzfse"): number {
    const chunk = Math.min(size, 1024 ** 2);
    if (chunk === 0) {
        return 1;
    }

    const fd = openSync(path, "r");
    const buf = Buffer.alloc(chunk);
    let raw = 0;
    let packed = 0;
    const positions = size <= chunk ? [0] : [0, Math.floor((size - chunk) / 2)];
    try {
        for (const position of positions) {
            const n = readSync(fd, buf, 0, chunk, position);
            raw += n;
            packed += encodedSampleBytes(buf.subarray(0, n), algorithm);
        }
    } finally {
        closeSync(fd);
    }

    return raw ? packed / raw : 1;
}

/** Replace one file with its compressed copy, or leave it exactly as it was. */
export async function compressOne(c: Candidate, writer: TransparentWriter = DITTO_WRITER): Promise<Outcome> {
    if (c.size > writer.maxBytes) {
        return {
            path: c.path,
            status: "failed",
            before: c.alloc,
            after: c.alloc,
            note: "too-big: exceeds writer limit",
        };
    }
    const tmp = join(dirname(c.path), `${TMP_PREFIX}${process.pid}-${basename(c.path)}`);
    const fail = (status: Outcome["status"], note: string): Outcome => {
        drop(tmp);
        return { path: c.path, status, before: c.alloc, after: c.alloc, note };
    };
    if (existsSync(tmp)) {
        throw new Error(`Transaction scratch already exists: ${tmp}`);
    }

    const header = Buffer.alloc(16);
    const descriptor = openSync(c.path, "r");
    try {
        readSync(descriptor, header, 0, header.length, 0);
    } finally {
        closeSync(descriptor);
    }

    if (header.toString("binary") === "SQLite format 3\0") {
        return fail("failed", "SQLite files are never transparent-compression candidates");
    }

    const est = sampleRatio(c.path, c.size, writer.algorithm);

    if (est > SAMPLE_SKIP) {
        return {
            path: c.path,
            status: "no gain",
            before: c.alloc,
            after: c.alloc,
            note: `a sample packs to ${Math.round(est * 100)}%; no full pass`,
        };
    }

    const startingCtime = lstatSync(c.path, { bigint: true }).ctimeNs;
    const copy = await writer.write({ source: c.path, target: tmp });

    if (copy.code !== 0) {
        return fail("failed", `ditto: ${copy.err.split("\n")[0]}`);
    }

    const t = lstatSync(tmp);

    if (t.size !== c.size) {
        return fail("changed", `the file changed after the plan (the copy has ${t.size} bytes, the plan ${c.size})`);
    }

    if (lstatSync(tmp, { bigint: true }).mtimeNs !== lstatSync(c.path, { bigint: true }).mtimeNs) {
        return fail("failed", "the compressed copy did not preserve the mtime");
    }

    const after = t.blocks * 512;
    if (((fileFlags(tmp) ?? 0) & UF_COMPRESSED) !== 0 && storedCompressionAlgorithm(tmp) !== writer.algorithm) {
        return fail("failed", "the stored kernel codec does not match the selected algorithm");
    }

    if (((fileFlags(tmp) ?? 0) & UF_COMPRESSED) === 0 || after > c.alloc * WORTH) {
        return fail("no gain", "the content does not compress");
    }

    const same = await exec(["/usr/bin/cmp", "-s", c.path, tmp]);

    if (same.code !== 0) {
        return fail(
            same.code === 1 ? "changed" : "failed",
            same.code === 1 ? "the file changed during the copy" : `cmp: ${same.err}`
        );
    }

    // Last look before the swap: a writer that appended after the compare changed the size or the mtime.
    const now = lstatSync(c.path);
    const precise = lstatSync(c.path, { bigint: true });
    const mtimeChanged = c.mtimeNs === undefined ? now.mtimeMs !== c.mtimeMs : precise.mtimeNs.toString() !== c.mtimeNs;
    if (
        !now.isFile() ||
        now.nlink !== 1 ||
        now.ino !== c.ino ||
        now.size !== c.size ||
        mtimeChanged ||
        precise.ctimeNs !== startingCtime
    ) {
        return fail("changed", "the file changed during the copy");
    }

    // Keep the original under a second name, then put the copy in its place in one atomic rename: the path
    // never points at nothing, and the original inode lives on until `settle` has looked at it.
    const old = join(dirname(c.path), `${OLD_PREFIX}${process.pid}-${basename(c.path)}`);
    linkSync(c.path, old);
    renameSync(tmp, c.path);
    return {
        path: c.path,
        status: "compressed",
        before: c.alloc,
        after,
        old: {
            path: old,
            ino: c.ino,
            size: c.size,
            mtimeMs: now.mtimeMs,
            mtimeNs: precise.mtimeNs.toString(),
            ctimeNs: lstatSync(old, { bigint: true }).ctimeNs.toString(),
            newIno: t.ino,
            newCtimeNs: lstatSync(c.path, { bigint: true }).ctimeNs.toString(),
        },
    };
}

/** Compare through owned descriptors and reject changes during the read, including a replaced path. */
function equalStableFiles(left: string, right: string, leftInode: number, rightInode: number): boolean {
    const descriptors: number[] = [];
    try {
        descriptors.push(openSync(left, "r"));
        descriptors.push(openSync(right, "r"));
        const before = descriptors.map((fd) => fstatSync(fd, { bigint: true }));
        if (
            before[0].ino !== BigInt(leftInode) ||
            before[1].ino !== BigInt(rightInode) ||
            before[0].size !== before[1].size
        ) {
            return false;
        }
        const buffers = [Buffer.alloc(128 * 1024), Buffer.alloc(128 * 1024)];
        let position = 0;
        while (true) {
            const length = readSync(descriptors[0], buffers[0], 0, buffers[0].length, position);
            const other = readSync(descriptors[1], buffers[1], 0, buffers[1].length, position);
            if (length !== other || !buffers[0].subarray(0, length).equals(buffers[1].subarray(0, other))) {
                return false;
            }
            if (length === 0) {
                break;
            }
            position += length;
        }
        return descriptors.every((fd, i) => {
            const after = fstatSync(fd, { bigint: true });
            const named = lstatSync(i === 0 ? left : right, { bigint: true });
            return (
                after.ino === before[i].ino &&
                after.size === before[i].size &&
                after.ctimeNs === before[i].ctimeNs &&
                named.ino === after.ino &&
                named.ctimeNs === after.ctimeNs
            );
        });
    } catch (error) {
        logger.debug({ error }, "transparent compression final byte comparison could not be verified");
        return false;
    } finally {
        for (const fd of descriptors) {
            closeSync(fd);
        }
    }
}

/**
 * Retire an unchanged original only after open-inode, timestamp and byte checks. A changed old inode goes back
 * when the new one is untouched; otherwise both versions survive under a unique .cold-conflict-* name.
 */
export function settle(o: Outcome, openInodes: Set<number>): Outcome {
    if (o.status !== "compressed" || !o.old) {
        return o;
    }

    const { old } = o;
    let st: Stats;

    try {
        st = lstatSync(old.path);
    } catch (error) {
        logger.error({ error, path: old.path }, "transparent compression original could not be inspected");
        return { ...o, status: "failed", note: "original aside could not be inspected", after: o.before };
    }

    if (st.ino !== old.ino || !st.isFile()) {
        return { ...o, status: "failed", after: o.before, note: "original aside identity changed; preserving it" };
    }

    const preciseOld = lstatSync(old.path, { bigint: true });
    const written =
        st.size !== old.size ||
        preciseOld.mtimeNs.toString() !== old.mtimeNs ||
        preciseOld.ctimeNs.toString() !== old.ctimeNs;

    if (!written && !openInodes.has(old.ino)) {
        // Own link/rename operations also change ctime. Compare actual bytes to cover a writer finishing in that window.
        if (!equalStableFiles(old.path, o.path, old.ino, old.newIno)) {
            const kept = preserveConflict(old.path, o.path);
            return {
                ...o,
                old: undefined,
                status: "conflict",
                after: o.before,
                note: `final bytes or identity changed; original preserved as ${kept}`,
            };
        }
        const releasedBytes = getPrivateSize(old.path) ?? 0;
        drop(old.path);
        return { ...o, old: undefined, releasedBytes };
    }

    const why = written ? "a writer changed the original after the swap" : "a process still holds the original open";
    let cur: Stats | null = null;

    try {
        cur = lstatSync(o.path);
    } catch (error) {
        logger.debug({ error, path: o.path }, "transparent compressed path missing during settlement");
    }

    if (
        !cur ||
        (cur.ino === old.newIno &&
            !openInodes.has(cur.ino) &&
            cur.size === old.size &&
            lstatSync(o.path, { bigint: true }).mtimeNs.toString() === old.mtimeNs &&
            lstatSync(o.path, { bigint: true }).ctimeNs.toString() === old.newCtimeNs)
    ) {
        renameSync(old.path, o.path);
        return {
            path: o.path,
            status: "restored",
            before: o.before,
            after: o.before,
            note: `${why}; the original is back, uncompressed`,
        };
    }

    const kept = preserveConflict(old.path, o.path);
    return {
        path: o.path,
        status: "conflict",
        before: o.before,
        after: o.before,
        note: `${why}, and the compressed file changed too; the original is kept as ${kept}`,
    };
}

/** The identity and timestamps of a name, compared before and after a decision so a rewrite in between is seen. */
function nameState(path: string): { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint } {
    const st = lstatSync(path, { bigint: true });
    return { ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs };
}

function sameNameState(a: ReturnType<typeof nameState>, b: ReturnType<typeof nameState>): boolean {
    return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * Resolve what a killed run left: a half-written copy is dropped; an original kept aside is dropped when the file
 * at its path holds the same bytes, goes back when that file is missing, and is kept as a conflict otherwise. The
 * byte comparison is the settlement's own (`equalStableFiles`: owned descriptors, identity and ctime checked after
 * the read), and both names must still hold what was compared when the aside is removed, so a write or a replacement
 * during or after the comparison keeps both copies. `afterCompare` is for tests: it runs between the two.
 */
export async function resolveStale(
    path: string,
    alive: (pid: number) => boolean,
    held: Set<number>,
    options: { afterCompare?: () => void } = {}
): Promise<"dropped" | "restored" | "conflict" | "in use"> {
    const name = basename(path);
    const isOld = name.startsWith(OLD_PREFIX);
    const rest = name.slice((isOld ? OLD_PREFIX : TMP_PREFIX).length);
    const pid = Number(rest.split("-")[0]);

    if (!/^\.cold-(?:old-)?[0-9]+-.+/.test(name)) {
        return "in use";
    }

    if (pid && alive(pid)) {
        return "in use";
    }

    if (!isOld) {
        if (held.has(lstatSync(path).ino)) {
            return "in use";
        }

        drop(path);
        return "dropped";
    }

    const target = join(dirname(path), rest.slice(rest.indexOf("-") + 1));

    try {
        const stat = lstatSync(target);
        if (!stat.isFile()) {
            preserveConflict(path, target);
            return "conflict";
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }

        renameSync(path, target);
        return "restored";
    }

    const aside = nameState(path);
    const current = nameState(target);
    if (current.ino === aside.ino) {
        // One file under two names: removing the aside name loses no byte.
        drop(path);
        return "dropped";
    }

    if (!equalStableFiles(path, target, Number(aside.ino), Number(current.ino))) {
        preserveConflict(path, target);
        return "conflict";
    }

    // Same bytes is not the same file: a chmod, an owner, a flag, an extended attribute or an ACL the original got
    // after the swap would be lost with it. The settlement sees such a change in the original's ctime; a killed run
    // left no ctime to compare with, so the two names' metadata is compared instead.
    if (!(await samePartnerMetadata(path, target))) {
        preserveConflict(path, target);
        return "conflict";
    }

    options.afterCompare?.();
    let unchanged = false;
    try {
        unchanged = sameNameState(nameState(path), aside) && sameNameState(nameState(target), current);
    } catch (error) {
        logger.debug({ error, path, target }, "a stale aside or its target changed after the byte comparison");
    }

    if (!unchanged) {
        preserveConflict(path, target);
        return "conflict";
    }

    const originalInode = Number(aside.ino);
    const targetInode = Number(current.ino);
    if (held.has(originalInode)) {
        if (held.has(targetInode)) {
            preserveConflict(path, target);
            return "conflict";
        }

        renameSync(path, target);
        return "restored";
    }

    drop(path);
    return "dropped";
}

/** The inode numbers any process has open, from one lsof pass. A pass that lists nothing throws. */
export async function openInodes(): Promise<Set<number>> {
    const out = await readLsof(["-Fi"]);
    const set = new Set<number>();

    for (const line of out.split("\n")) {
        if (line.startsWith("i")) {
            set.add(Number(line.slice(1)));
        }
    }

    if (set.size === 0) {
        throw new Error("lsof listed no open inode; refusing to drop originals without the open-file check");
    }

    return set;
}

/**
 * Every path any process has open or mapped (lsof's `mem` rows too), from one lsof pass. A pass that fails, writes to
 * stderr or lists no path throws: a deletion guard that read "nothing is open" from it would remove files in use.
 */
export async function openPaths(options: { timeoutMs?: number } = {}): Promise<Set<string>> {
    const out = await readLsof(["-Fn"], options.timeoutMs);
    const set = new Set<string>();

    for (const line of out.split("\n")) {
        if (line.startsWith("n/")) {
            set.add(line.slice(1));
        }
    }

    if (set.size === 0) {
        throw new Error("lsof listing incomplete (no open path listed): refusing to judge what is open");
    }

    return set;
}

export interface TransparentWriter {
    name: string;
    algorithm: "zlib" | "lzvn" | "lzfse";
    maxBytes: number;
    write(options: { source: string; target: string }): Promise<{ code: number; err: string }>;
}

/** macOS 27 ditto emits LZVN, verified by afsctool on the copied corpus. */
export const DITTO_WRITER: TransparentWriter = {
    name: "ditto",
    algorithm: "lzvn",
    maxBytes: DITTO_MAX_BYTES,
    write: ({ source, target }) => exec(["/usr/bin/ditto", "--noclone", "--hfsCompression", source, target]),
};

/** One whole-system lsof pass. `-w` hides lsof's warnings, so anything left on stderr is an error: the pass throws. */
async function readLsof(fields: string[], timeoutMs = 60_000): Promise<string> {
    // lint-rules-ignore: a deletion guard needs every held inode or open and mapped path (renamed asides, mem rows); process.openFiles answers only for selected paths.
    const p = Bun.spawn(["/usr/sbin/lsof", "-nP", "-w", ...fields], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    try {
        const [out, error, code] = await Promise.all([
            new Response(p.stdout).text(),
            new Response(p.stderr).text(),
            p.exited,
        ]);
        const complaint = error.trim();
        if (code !== 0 || complaint !== "" || out.trim() === "") {
            throw new Error(
                `lsof listing incomplete (exit ${code})${complaint ? `: ${complaint}` : ""}; refusing to judge what is open`
            );
        }

        return out;
    } finally {
        clearTimeout(timer);
    }
}

function preserveConflict(source: string, target: string): string {
    const kept = `${target}.cold-conflict-${crypto.randomUUID()}`;
    linkSync(source, kept);
    drop(source);
    return kept;
}

/** The backup refresh decision uses the compressed flag, never a block-ratio guess. */
export function compressedSince(source: string, target: string): boolean {
    return ((fileFlags(source) ?? 0) & UF_COMPRESSED) !== 0 && ((fileFlags(target) ?? 0) & UF_COMPRESSED) === 0;
}

/** afsctool 1.7.3 conservatively checks this bound before encoding its resource-fork offsets. */
export const AFSCTOOL_MAX_BYTES = 2_147_188_457;

export function afsctoolWriter(algorithm: TransparentAlgorithm, binary: string): TransparentWriter {
    return {
        name: "afsctool",
        algorithm,
        maxBytes: AFSCTOOL_MAX_BYTES,
        write: async ({ source, target }) => {
            const copy = await exec(["/usr/bin/ditto", "--noclone", source, target]);
            if (copy.code !== 0) {
                return copy;
            }

            const packed = await exec([binary, "-c", "-T", algorithm.toUpperCase(), target]);
            if (packed.code === 0) {
                restoreFileTimes(source, target);
            }

            return packed;
        },
    };
}

export function availableTransparentWriter(algorithm?: TransparentAlgorithm): TransparentWriter {
    const binary = Bun.which("afsctool");
    if (binary) {
        return afsctoolWriter(algorithm ?? "lzfse", binary);
    }

    if (algorithm !== undefined && algorithm !== DITTO_WRITER.algorithm) {
        throw new Error(`${algorithm} requires afsctool; ditto fallback uses ${DITTO_WRITER.algorithm}`);
    }

    return DITTO_WRITER;
}
