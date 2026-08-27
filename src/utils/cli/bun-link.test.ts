import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { namedBunExecPath } from "./bun-link";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("namedBunExecPath", () => {
    let home: string;
    let fakeBun: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "bun-link-test-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        fakeBun = join(home, "bun");
        writeFileSync(fakeBun, "#!/bin/sh\n");
    });

    it("creates a hardlink named after the tool", () => {
        const linkPath = namedBunExecPath("youtube", fakeBun);

        expect(linkPath).toBe(join(home, ".genesis-tools", "bin", "gt-youtube"));
        expect(statSync(linkPath).ino).toBe(statSync(fakeBun).ino);
    });

    it("reuses an existing link whose inode still matches", () => {
        const first = namedBunExecPath("du", fakeBun);
        const firstIno = statSync(first).ino;
        const second = namedBunExecPath("du", fakeBun);

        expect(second).toBe(first);
        expect(statSync(second).ino).toBe(firstIno);
    });

    it("re-links when the bun binary was replaced with a new inode", () => {
        const linkPath = namedBunExecPath("du", fakeBun);
        const staleIno = statSync(linkPath).ino;

        unlinkSync(fakeBun);
        writeFileSync(fakeBun, "#!/bin/sh\n# upgraded\n");

        const relinked = namedBunExecPath("du", fakeBun);

        expect(relinked).toBe(linkPath);
        expect(statSync(relinked).ino).toBe(statSync(fakeBun).ino);
        expect(statSync(relinked).ino).not.toBe(staleIno);
    });

    it("sanitizes names that are not safe file names", () => {
        const linkPath = namedBunExecPath("you tube/x", fakeBun);

        expect(linkPath).toBe(join(home, ".genesis-tools", "bin", "gt-you-tube-x"));
        expect(statSync(linkPath).ino).toBe(statSync(fakeBun).ino);
    });

    it("falls back to the bun binary when linking fails", () => {
        const missing = join(home, "does-not-exist");

        expect(namedBunExecPath("broken", missing)).toBe(missing);
    });
});
