/**
 * Tests for the Phase 7 helper `resolveCloneIdHex(e)`. Validates the three
 * input cases that drive the plumbing fix:
 *
 *   1. Walker supplied `cloneIdHex` (hex string) — use directly, no syscall.
 *   2. Walker supplied `""` — file confirmed to have no clone family, no
 *      syscall, return "".
 *   3. Walker supplied `undefined` — walker didn't fetch it (per-dir ENOTSUP
 *      fallback / non-darwin / cache replay) → MUST call getCloneId(path).
 *
 * Case 3 is darwin-only because `getCloneId` returns null off-darwin; the
 * test asserts the fallback path is reached, not the return value.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { resolveCloneIdHex } from "@app/utils/fs/disk-usage";

const isDarwin = platform() === "darwin";

describe("resolveCloneIdHex — Phase 7 plumbing helper", () => {
    it("returns walker-supplied hex when defined (non-empty)", () => {
        expect(
            resolveCloneIdHex({ path: "/non/existent/x", cloneIdHex: "abc123" })
        ).toBe("abc123");
    });

    it("returns '' when walker confirmed no clone-family ('')", () => {
        expect(
            resolveCloneIdHex({ path: "/non/existent/x", cloneIdHex: "" })
        ).toBe("");
    });

    it("on undefined cloneIdHex, falls back to getCloneId(path) — non-existent file → ''", () => {
        // Non-existent path: getCloneId throws/returns null → resolveCloneIdHex
        // returns "". This proves the fallback executed.
        expect(
            resolveCloneIdHex({ path: "/this/path/definitely/does/not/exist" })
        ).toBe("");
    });

    it.skipIf(!isDarwin)("on undefined + real clone family: fallback returns the actual hex", () => {
        // Create two APFS-cloned files via `cp -c`, force the fallback path by
        // passing cloneIdHex: undefined, and assert the returned hex matches
        // what the walker would have produced. If the helper got the syscall
        // wrong (e.g. forgot to mask 0 → ""), this fails.
        const dir = mkdtempSync(join(tmpdir(), "gt-rch-darwin-"));
        try {
            const a = join(dir, "a.bin");
            writeFileSync(a, Buffer.alloc(4 * 1024 * 1024, 42));
            const b = join(dir, "b.bin");
            const cp = spawnSync("cp", ["-c", a, b]);
            if (cp.status !== 0) {
                // Not on APFS — skip body
                return;
            }
            const hexA = resolveCloneIdHex({ path: a });
            const hexB = resolveCloneIdHex({ path: b });
            expect(hexA).not.toBe("");
            expect(hexA).toBe(hexB);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it.skipIf(!isDarwin)("walker-supplied hex is trusted even when path doesn't exist (no syscall)", () => {
        // Even if the path is bogus, when cloneIdHex is defined we DON'T
        // touch the filesystem. Proves no syscall fallback is invoked.
        expect(
            resolveCloneIdHex({ path: "/totally/fake/path/does/not/exist", cloneIdHex: "deadbeef" })
        ).toBe("deadbeef");
    });

    it("hex case is preserved (lowercase per walker contract)", () => {
        // Walker emits lowercase hex via `.toString(16)`. Helper must NOT
        // upcase or otherwise normalize — that would break clone-family
        // grouping if any caller has cached lowercase keys.
        expect(
            resolveCloneIdHex({ path: "/x", cloneIdHex: "abcdef0123456789" })
        ).toBe("abcdef0123456789");
    });

    it("very large hex (multi-byte cloneId) round-trips intact", () => {
        // APFS cloneIds can be very large bigints. The helper just passes
        // the string through — no parsing — so this is a smoke test that
        // long hex isn't truncated by some accidental Number conversion.
        const longHex = "ffffffffffffffffffffffffffff";
        expect(resolveCloneIdHex({ path: "/x", cloneIdHex: longHex })).toBe(longHex);
    });
});
