import { CString, dlopen, FFIType, ptr } from "bun:ffi";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDylib, listBigFiles } from "@app/du/lib/engine";
import { SafeJSON } from "@genesiscz/utils/json";
import { skip } from "@genesiscz/utils/test/skip";

const MB = 1 << 20;

describe.skipIf(skip.onWindows || process.platform !== "darwin")("listBigFiles (clonesize --bigfiles)", () => {
    it("lists files at or above the floor across roots, prunes by name, never follows symlinks", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-bigfiles-"));
        try {
            const a = join(outer, "a");
            const b = join(outer, "b");
            mkdirSync(join(a, "sub"), { recursive: true });
            mkdirSync(join(a, ".git"), { recursive: true });
            mkdirSync(b, { recursive: true });
            writeFileSync(join(a, "big.bin"), Buffer.alloc(2 * MB, 1));
            writeFileSync(join(a, "small.bin"), Buffer.alloc(MB - 1, 2));
            writeFileSync(join(a, "sub", "nested.bin"), Buffer.alloc(3 * MB, 3));
            writeFileSync(join(a, ".git", "pack.bin"), Buffer.alloc(4 * MB, 4));
            writeFileSync(join(b, "exact.bin"), Buffer.alloc(MB, 5));
            symlinkSync(join(a, "sub"), join(b, "link-to-sub"));

            const r = await listBigFiles({ roots: [a, b], minBytes: MB, pruneNames: [".git"] });

            expect(r.files.map((f) => f.path)).toEqual([
                join(a, "big.bin"),
                join(a, "sub", "nested.bin"),
                join(b, "exact.bin"),
            ]);
            expect(r.files[0]?.size).toBe(2 * MB);
            expect(r.files[0]?.mtimeNs).toBeGreaterThan(1_000_000_000_000_000_000n);
            expect(r.files[0]?.nlink).toBe(1);
            // small.bin, big.bin, nested.bin, exact.bin; the pruned pack.bin is never listed
            expect(r.filesListed).toBe(4);
            expect(r.dirs).toBe(3);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("an aborted signal kills the walk and rejects with the abort reason", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-bigfiles-abort-"));
        try {
            writeFileSync(join(dir, "x.bin"), Buffer.alloc(MB, 1));
            const ac = new AbortController();
            ac.abort(new Error("stop"));
            await expect(listBigFiles({ roots: [dir], minBytes: MB, signal: ac.signal })).rejects.toThrow("stop");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // 4100 roots because a fixed 4096 cap used to drop every root past it. The
    // count is the whole point; the file SIZES are not, so each root holds one
    // byte over a one-byte floor rather than one megabyte over a megabyte one —
    // the same "every root was walked" assertion, without writing 4.1 GB.
    it("reports the roots it accepted and no read errors", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-bigfiles-roots-"));
        try {
            const roots: string[] = [];
            for (let i = 0; i < 4_100; i++) {
                const dir = join(outer, `r${i}`);
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, "f.bin"), Buffer.alloc(1, 7));
                roots.push(dir);
            }

            const r = await listBigFiles({ roots, minBytes: 1 });
            expect(r.roots).toBe(4_100);
            expect(r.files.length).toBe(4_100);
            expect(r.readErrors).toBe(0);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    }, 120_000);

    it("a root it cannot open is a read error, not a silent empty listing", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-bigfiles-openfail-"));
        try {
            // ENOENT and ENOTDIR are the two open failures a test can produce
            // without a special mount. Both drop a whole subtree, so both must
            // reach the caller instead of reading as "that tree holds nothing".
            const missing = join(outer, "gone");
            await expect(listBigFiles({ roots: [missing], minBytes: MB })).rejects.toThrow(
                "clonesize --bigfiles exited with 1"
            );

            const file = join(outer, "plain.bin");
            writeFileSync(file, Buffer.alloc(MB, 1));
            await expect(listBigFiles({ roots: [file], minBytes: MB })).rejects.toThrow(
                "clonesize --bigfiles exited with 1"
            );
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it.skipIf(process.getuid?.() === 0)("a directory it may not open stays a denial and still succeeds", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-bigfiles-denied-"));
        try {
            const locked = join(outer, "locked");
            mkdirSync(locked, { recursive: true });
            writeFileSync(join(outer, "big.bin"), Buffer.alloc(2 * MB, 1));
            chmodSync(locked, 0o000);

            const r = await listBigFiles({ roots: [outer], minBytes: MB });
            expect(r.deniedDirs).toBe(1);
            expect(r.readErrors).toBe(0);
            expect(r.files.map((f) => f.path)).toEqual([join(outer, "big.bin")]);
        } finally {
            chmodSync(join(outer, "locked"), 0o755);
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("does not descend into a mount point that belongs to another volume", async () => {
        // The simulator runtime volumes are the only foreign mounts every dev
        // machine has; without the prune this walk lists a million files.
        const mounts = "/Library/Developer/CoreSimulator/Volumes";
        if (!existsSync(mounts) || readdirSync(mounts).length === 0) {
            return;
        }

        const r = await listBigFiles({ roots: [mounts], minBytes: 1 });
        expect(r.filesListed).toBe(0);
    }, 60_000);
});

// The CLI and big_run_json kept the first 64 prune names and dropped the rest without an error, so a 65th name was a
// folder the listing silently entered. Both now refuse it, and the 64th name must still prune: it is the only name
// that matches here, so a cap below 64 lists victim/.
describe.skipIf(skip.onWindows || process.platform !== "darwin")("prune names: 64 honored, 65 refused", () => {
    const MAX_PRUNE_NAMES = 64;
    type BigfilesFfiJson = { files_listed: number; files: { path: string }[] };
    let outer: string;
    const pruneNames = (n: number) => [...Array.from({ length: n - 1 }, (_, i) => `missing-${i}`), "victim"];

    beforeAll(() => {
        outer = mkdtempSync(join(tmpdir(), "gt-bigfiles-prune-"));
        mkdirSync(join(outer, "keep"));
        mkdirSync(join(outer, "victim"));
        writeFileSync(join(outer, "keep", "a.bin"), Buffer.alloc(2 * MB, 1));
        writeFileSync(join(outer, "victim", "b.bin"), Buffer.alloc(2 * MB, 2));
    });

    afterAll(() => {
        rmSync(outer, { recursive: true, force: true });
    });

    // clonesize_bigfiles_json is not bound in engine.ts (listBigFiles uses the subprocess), so the test binds it.
    let lib: ReturnType<typeof openBigfilesLib> | null = null;
    function openBigfilesLib() {
        return dlopen(ensureDylib(), {
            clonesize_bigfiles_json: {
                args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
                returns: FFIType.ptr,
            },
            clonesize_free: { args: [FFIType.ptr], returns: FFIType.void },
        });
    }

    function bigfilesFfi(names: string[]): BigfilesFfiJson | null {
        lib ??= openBigfilesLib();
        const rootBufs = [Buffer.from(`${outer}\0`, "utf8")];
        const nameBufs = names.map((n) => Buffer.from(`${n}\0`, "utf8"));
        const rootPtrs = new BigUint64Array(rootBufs.map((b) => BigInt(ptr(b))));
        const namePtrs = new BigUint64Array(nameBufs.map((b) => BigInt(ptr(b))));
        const res = lib.symbols.clonesize_bigfiles_json(
            ptr(rootPtrs),
            rootBufs.length,
            2,
            BigInt(MB),
            nameBufs.length > 0 ? ptr(namePtrs) : null,
            nameBufs.length
        );
        // keep the string buffers alive until the call returned
        void rootBufs;
        void nameBufs;
        if (!res) {
            return null;
        }

        const json = new CString(res).toString();
        lib.symbols.clonesize_free(res);
        return SafeJSON.parse(json, { strict: true });
    }

    it("the fixture lists victim/ when nothing is pruned", async () => {
        const r = await listBigFiles({ roots: [outer], minBytes: MB });
        expect(r.files.map((f) => f.path)).toEqual([join(outer, "keep", "a.bin"), join(outer, "victim", "b.bin")]);
    });

    it("CLI: the 64th --prune-name still prunes its folder", async () => {
        const r = await listBigFiles({ roots: [outer], minBytes: MB, pruneNames: pruneNames(MAX_PRUNE_NAMES) });
        expect(r.files.map((f) => f.path)).toEqual([join(outer, "keep", "a.bin")]);
        expect(r.filesListed).toBe(1);
    });

    it("CLI: a 65th --prune-name exits 2 with a diagnostic instead of being dropped", async () => {
        await expect(
            listBigFiles({ roots: [outer], minBytes: MB, pruneNames: pruneNames(MAX_PRUNE_NAMES + 1) })
        ).rejects.toThrow(
            `clonesize --bigfiles exited with 2: clonesize: more than ${MAX_PRUNE_NAMES} --prune-name names`
        );
    });

    it("library: clonesize_bigfiles_json honors the 64th prune name", () => {
        const r = bigfilesFfi(pruneNames(MAX_PRUNE_NAMES));
        expect(r?.files.map((f) => f.path)).toEqual([join(outer, "keep", "a.bin")]);
        expect(r?.files_listed).toBe(1);
    });

    it("library: clonesize_bigfiles_json returns NULL for 65 prune names", () => {
        expect(bigfilesFfi(pruneNames(MAX_PRUNE_NAMES + 1))).toBeNull();
    });
});
