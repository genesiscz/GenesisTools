import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    closeSync,
    constants,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    statSync,
    symlinkSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { skip } from "@genesiscz/utils/test/skip";
import { bunNameFor, namedBunExecPath, placeNamedBun } from "./bun-link";

const LOCK_FILE = ".names.lock";
/** As the code opens it: 0x20 is macOS's "also lock the file" flag, which node:fs has no name for. */
const LOCK_FLAGS = constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | 0x20;

// Nothing here starts a file it made: macOS checks every new executable at its first start, and a test home goes at
// exit (tests.md, "Test traps"). The fake bun is a plain file that is only cloned, linked and read.
describe.skipIf(skip.onWindows)("namedBunExecPath", () => {
    let home: string;
    let binDir: string;
    let fakeBun: string;
    let saved: ReturnType<typeof env.testing.snapshot>;

    beforeEach(() => {
        saved = env.testing.snapshot();
        home = mkdtempSync(join(tmpdir(), "bun-link-test-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        binDir = join(home, ".genesis-tools", "bin");
        fakeBun = join(home, "bun");
        writeFileSync(fakeBun, "#!/bin/sh\n", { mode: 0o755 });
    });

    afterEach(() => {
        env.testing.restore(saved);
    });

    /** Replaces the fake bun with a new file, as `bun upgrade` does: a new inode, new bytes, a new mtime. */
    function upgradeBun(): void {
        unlinkSync(fakeBun);
        writeFileSync(fakeBun, "#!/bin/sh\n# upgraded\n", { mode: 0o755 });
        const later = new Date(Date.now() + 60_000);
        utimesSync(fakeBun, later, later);
    }

    it("a test process gets the bun binary itself on macOS, and a hard link elsewhere", () => {
        const path = namedBunExecPath("youtube", fakeBun);

        if (process.platform === "darwin") {
            expect(path).toBe(fakeBun);
            expect(readdirSync(home)).not.toContain(".genesis-tools");
        } else {
            expect(path).toBe(join(binDir, "gt-youtube"));
            expect(statSync(path).ino).toBe(statSync(fakeBun).ino);
        }
    });

    it("sanitizes names that are not safe file names", () => {
        expect(bunNameFor("you tube/x")).toBe("gt-you-tube-x");
    });

    describe("as a hard link", () => {
        const link = (name: string) => placeNamedBun({ name, bunPath: fakeBun, binDir, kind: "link" });

        it("creates a hardlink named after the tool", () => {
            const linkPath = link("youtube");

            expect(linkPath).toBe(join(binDir, "gt-youtube"));
            expect(statSync(linkPath).ino).toBe(statSync(fakeBun).ino);
        });

        it("re-links when the bun binary was replaced with a new inode", () => {
            const linkPath = link("du");
            const staleIno = statSync(linkPath).ino;

            upgradeBun();
            const relinked = link("du");

            expect(relinked).toBe(linkPath);
            expect(statSync(relinked).ino).toBe(statSync(fakeBun).ino);
            expect(statSync(relinked).ino).not.toBe(staleIno);
            expect(readdirSync(binDir)).toEqual(["gt-du"]);
        });

        it("a name that is already a link of bun is kept, and no temporary file stays", () => {
            const first = link("du");

            expect(link("du")).toBe(first);
            expect(readdirSync(binDir)).toEqual(["gt-du"]);
        });

        it("falls back to the bun binary when linking fails", () => {
            const missing = join(home, "does-not-exist");

            expect(placeNamedBun({ name: "broken", bunPath: missing, binDir, kind: "link" })).toBe(missing);
        });
    });

    const clone = (name: string, extra: Partial<Parameters<typeof placeNamedBun>[0]> = {}) =>
        placeNamedBun({ name, bunPath: fakeBun, binDir, kind: "clone", ...extra });
    /** The names in the folder, without its lock file. */
    const names = () => readdirSync(binDir).filter((entry) => entry !== LOCK_FILE);

    describe("a worker that itself runs under a name", () => {
        const link = (name: string, bunPath = fakeBun) => placeNamedBun({ name, bunPath, binDir, kind: "link" });

        it("on an older bun: its own binary, and the upgraded name stays", () => {
            const worker = link("hub");
            upgradeBun();
            link("tools");

            expect(link("tools", worker)).toBe(worker);
            expect(statSync(join(binDir, "gt-tools")).ino).toBe(statSync(fakeBun).ino);
        });

        it("on the current bun: an older name is made again", () => {
            link("hub");
            upgradeBun();
            const worker = link("tools");

            expect(link("hub", worker)).toBe(join(binDir, "gt-hub"));
            expect(statSync(join(binDir, "gt-hub")).ino).toBe(statSync(fakeBun).ino);
        });
    });

    // These need no volume that can clone, so they also run on CI's Linux.
    describe("as a clone, on any volume", () => {
        it("a folder that another user can write to is never used: the bun binary", () => {
            mkdirSync(binDir, { recursive: true });
            chmodSync(binDir, 0o777);

            expect(clone("shared")).toBe(fakeBun);
            expect(readdirSync(binDir)).toEqual([]);
        });

        it("a folder above the names that another user can write to is never used: the bun binary", () => {
            mkdirSync(binDir, { recursive: true });
            chmodSync(join(home, ".genesis-tools"), 0o777);

            expect(clone("swap")).toBe(fakeBun);
            expect(readdirSync(binDir)).toEqual([]);
        });

        it("a symbolic link on the way that leads through a folder others can write to is never used", () => {
            const open = join(home, "open");
            mkdirSync(join(open, "tools", "bin"), { recursive: true });
            chmodSync(open, 0o777);
            symlinkSync(join(open, "tools"), join(home, ".genesis-tools"));

            expect(clone("via-link")).toBe(fakeBun);
            expect(readdirSync(binDir)).toEqual([]);
        });

        it("a volume that cannot clone gets a hard link", () => {
            const path = clone("nfs", {
                copyFile: () => {
                    throw Object.assign(new Error("clone unsupported"), { code: "ENOTSUP" });
                },
            });

            expect(statSync(path).ino).toBe(statSync(fakeBun).ino);
            expect(readdirSync(binDir)).toEqual(["gt-nfs"]);
        });

        it("falls back to the bun binary when the source is missing", () => {
            const missing = join(home, "does-not-exist");

            expect(placeNamedBun({ name: "broken", bunPath: missing, binDir, kind: "clone" })).toBe(missing);
        });
    });

    // An APFS clone needs macOS; CI's Linux volume would answer EXDEV or ENOTSUP and fall back to a hard link.
    describe.skipIf(skip.unlessMac)("as a clone on APFS", () => {
        it("a new name is a file of its own with bun's bytes, mode, size and mtime", () => {
            const path = clone("youtube");
            const own = statSync(path, { bigint: true });
            const bun = statSync(fakeBun, { bigint: true });

            expect(path).toBe(join(binDir, "gt-youtube"));
            expect(own.ino).not.toBe(bun.ino);
            expect(own.nlink).toBe(1n);
            expect(bun.nlink).toBe(1n);
            expect(Number(own.mode) & 0o777).toBe(0o755);
            expect(own.size).toBe(bun.size);
            expect(own.mtimeNs).toBe(bun.mtimeNs);
            expect(readFileSync(path, "utf8")).toBe(readFileSync(fakeBun, "utf8"));
        });

        it("keeps a current clone instead of making it again", () => {
            const first = statSync(clone("du")).ino;

            expect(statSync(clone("du")).ino).toBe(first);
        });

        it("replaces an old hard link with a clone, so bun is left with one name", () => {
            const target = join(binDir, "gt-hub");
            placeNamedBun({ name: "hub", bunPath: fakeBun, binDir, kind: "link" });
            expect(statSync(fakeBun).nlink).toBe(2);

            expect(clone("hub")).toBe(target);
            expect(statSync(target).ino).not.toBe(statSync(fakeBun).ino);
            expect(statSync(target).nlink).toBe(1);
            expect(statSync(fakeBun).nlink).toBe(1);
        });

        it("the first clone also turns every other hard link of bun into a clone", () => {
            placeNamedBun({ name: "claude", bunPath: fakeBun, binDir, kind: "link" });
            placeNamedBun({ name: "codex", bunPath: fakeBun, binDir, kind: "link" });
            writeFileSync(join(binDir, "codex-tools"), "#!/bin/zsh\n");
            expect(statSync(fakeBun).nlink).toBe(3);

            clone("hub");

            expect(statSync(fakeBun).nlink).toBe(1);
            for (const name of ["gt-claude", "gt-codex", "gt-hub"]) {
                expect(statSync(join(binDir, name)).nlink).toBe(1);
                expect(readFileSync(join(binDir, name), "utf8")).toBe(readFileSync(fakeBun, "utf8"));
            }
            expect(readFileSync(join(binDir, "codex-tools"), "utf8")).toBe("#!/bin/zsh\n");
            expect(names().sort()).toEqual(["codex-tools", "gt-claude", "gt-codex", "gt-hub"]);
        });

        it("makes the clone again after the bun binary changed", () => {
            const path = clone("du");
            const staleIno = statSync(path).ino;

            upgradeBun();

            expect(clone("du")).toBe(path);
            expect(statSync(path).ino).not.toBe(staleIno);
            expect(readFileSync(path, "utf8")).toContain("# upgraded");
            expect(statSync(path).mtimeMs).toBe(statSync(fakeBun).mtimeMs);
        });

        it("makes the clone again after bun was rewritten in place", () => {
            const path = clone("du");
            writeFileSync(fakeBun, "#!/bin/sh\n# rewritten in place, longer\n");

            clone("du");

            expect(readFileSync(path, "utf8")).toContain("rewritten in place");
        });

        it("two starts at once: the one that loses keeps the winner's clone and leaves no temp file", () => {
            let winner: bigint | undefined;
            const path = clone("race", {
                beforePublish: () => {
                    clone("race");
                    winner = statSync(join(binDir, "gt-race"), { bigint: true }).ino;
                },
            });

            expect(winner).toBeDefined();
            expect(statSync(path, { bigint: true }).ino).toBe(winner as bigint);
            expect(readFileSync(path, "utf8")).toBe(readFileSync(fakeBun, "utf8"));
            expect(names()).toEqual(["gt-race"]);
        });

        it("two starts at once over a stale file: the second keeps the first one's clone", () => {
            placeNamedBun({ name: "race", bunPath: fakeBun, binDir, kind: "link" });
            upgradeBun();
            let winner: bigint | undefined;
            const path = clone("race", {
                beforePublish: () => {
                    // The other start sees the stale hard link too and publishes first.
                    clone("race");
                    winner = statSync(join(binDir, "gt-race"), { bigint: true }).ino;
                },
            });

            expect(statSync(path, { bigint: true }).ino).toBe(winner as bigint);
            expect(statSync(path).nlink).toBe(1);
            expect(readFileSync(path, "utf8")).toBe(readFileSync(fakeBun, "utf8"));
            expect(names()).toEqual(["gt-race"]);
        });

        it("a name that another start is placing right now: the bun binary, and nothing is changed", () => {
            mkdirSync(binDir, { recursive: true });
            const held = openSync(join(binDir, LOCK_FILE), LOCK_FLAGS, 0o600);

            try {
                expect(clone("busy")).toBe(fakeBun);
                expect(names()).toEqual([]);
            } finally {
                closeSync(held);
            }
        });

        it("a lock file that a start left behind holds nothing: the kernel drops the lock with its process", () => {
            mkdirSync(binDir, { recursive: true });
            closeSync(openSync(join(binDir, LOCK_FILE), LOCK_FLAGS, 0o600));

            expect(clone("dead")).toBe(join(binDir, "gt-dead"));
            expect(names()).toEqual(["gt-dead"]);
        });

        it("a symbolic link under the name is not started: a clone replaces the link, not the file it names", () => {
            const planted = join(home, "planted");
            writeFileSync(planted, readFileSync(fakeBun), { mode: 0o755 });
            const bun = statSync(fakeBun);
            utimesSync(planted, bun.atime, bun.mtime);
            mkdirSync(binDir, { recursive: true });
            symlinkSync(planted, join(binDir, "gt-sym"));

            const path = clone("sym");

            expect(lstatSync(path).isSymbolicLink()).toBe(false);
            expect(statSync(path).ino).not.toBe(statSync(planted).ino);
            expect(readFileSync(planted, "utf8")).toBe(readFileSync(fakeBun, "utf8"));
        });

        it("a file under the name that the group can write to is made again", () => {
            const path = clone("open");
            const before = statSync(path).ino;
            chmodSync(path, 0o775);

            clone("open");

            expect(statSync(path).ino).not.toBe(before);
            expect(statSync(path).mode & 0o777).toBe(0o755);
        });

        it("a file under the name that cannot be run is made again", () => {
            const path = clone("plain");
            const before = statSync(path).ino;
            chmodSync(path, 0o644);

            clone("plain");

            expect(statSync(path).ino).not.toBe(before);
            expect(statSync(path).mode & 0o777).toBe(0o755);
        });

        it("a start that reuses its clone still turns a remaining hard link of bun into a clone", () => {
            const path = clone("hub");
            const before = statSync(path).ino;
            // A name that was busy during the first sweep, or that an older version made later.
            placeNamedBun({ name: "codex", bunPath: fakeBun, binDir, kind: "link" });
            expect(statSync(fakeBun).nlink).toBe(2);

            clone("hub");

            expect(statSync(path).ino).toBe(before);
            expect(statSync(join(binDir, "gt-codex")).nlink).toBe(1);
            expect(statSync(fakeBun).nlink).toBe(1);
        });

        it("the sweep leaves a symbolic link to bun as it is", () => {
            placeNamedBun({ name: "codex", bunPath: fakeBun, binDir, kind: "link" });
            symlinkSync(fakeBun, join(binDir, "gt-follow"));

            clone("hub");

            expect(lstatSync(join(binDir, "gt-follow")).isSymbolicLink()).toBe(true);
            expect(statSync(join(binDir, "gt-codex")).nlink).toBe(1);
        });

        it("a worker on an older bun uses its own clone and leaves the upgraded name alone", () => {
            const worker = clone("hub");
            upgradeBun();
            const upgraded = statSync(clone("tools")).ino;

            expect(placeNamedBun({ name: "tools", bunPath: worker, binDir, kind: "clone" })).toBe(worker);
            expect(statSync(join(binDir, "gt-tools")).ino).toBe(upgraded);
            expect(readFileSync(join(binDir, "gt-tools"), "utf8")).toContain("# upgraded");
        });
    });
});
