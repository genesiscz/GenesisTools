import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { readParentPid, readProcessCwd, resolveAncestorCwd } from "./cwd";

const SUPPORTED = process.platform === "darwin" || process.platform === "linux";
const MODULE = resolve(import.meta.dir, "cwd.ts");

function spawnProbe(cwd: string): string {
    const code = `import { resolveAncestorCwd } from ${SafeJSON.stringify(MODULE, { strict: true })};
console.log(resolveAncestorCwd() ?? "");`;
    const proc = Bun.spawnSync([process.execPath, "-e", code], { cwd, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
        throw new Error(`probe failed: ${proc.stderr.toString()}`);
    }

    return proc.stdout.toString().trim();
}

describe.skipIf(!SUPPORTED)("process cwd", () => {
    it("reads our own live cwd", () => {
        expect(readProcessCwd(process.pid)).toBe(realpathSync(process.cwd()));
    });

    it("reads our own parent pid", () => {
        expect(readParentPid(process.pid)).toBe(process.ppid);
    });

    it("returns null for a pid that does not exist", () => {
        expect(readProcessCwd(0x7ffffff)).toBeNull();
        expect(readParentPid(0x7ffffff)).toBeNull();
    });

    it("walks up to the ancestor that moved: a child elsewhere reports OUR cwd", () => {
        // This is the MCP-server case. The child keeps the directory it was
        // spawned in; the truth lives one level up.
        expect(spawnProbe(realpathSync(tmpdir()))).toBe(realpathSync(process.cwd()));
    });

    it("a symlinked own cwd is not mistaken for a move", () => {
        // PR #343 review t33: the kernel returns resolved paths while
        // process.cwd() keeps symlinks, so comparing them raw invented an
        // adoption AND stopped the walk before a real move further up.
        const parent = readParentPid(process.pid);
        const parentCwd = parent === null ? null : readProcessCwd(parent);
        expect(parentCwd).not.toBeNull();

        const link = join(realpathSync(mkdtempSync(join(tmpdir(), "cwd-symlink-"))), "own");
        symlinkSync(parentCwd as string, link);

        expect(resolveAncestorCwd({ ownCwd: link, maxHops: 1 })).toBeNull();
    });

    it("stops at the first differing ancestor", () => {
        const parent = readParentPid(process.pid);
        expect(parent).not.toBeNull();
        const found = resolveAncestorCwd({ ownCwd: "/nowhere-this-cannot-be-a-cwd", maxHops: 1 });
        expect(found).toBe(readProcessCwd(parent as number));
    });
});

describe.skipIf(SUPPORTED)("process cwd on unsupported platforms", () => {
    it("returns null instead of guessing", () => {
        expect(readProcessCwd(process.pid)).toBeNull();
        expect(resolveAncestorCwd()).toBeNull();
    });
});
