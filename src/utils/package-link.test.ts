import { afterEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
    linkIsSound,
    linkStatusFor,
    linkUtilsPackage,
    PACKAGE_NAME,
    unlinkUtilsPackage,
    utilsPackageDir,
} from "./package-link";

/**
 * Every test works against a temp root. Nothing here may touch the real home directory: the
 * function under test creates and removes symlinks, and a default-argument slip would do it
 * in the developer's own `~/node_modules`.
 */
const roots: string[] = [];

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "gt-link-"));
    roots.push(dir);

    return dir;
}

/** The path the link is created at, for assertions that read the filesystem directly. */
function linkPathIn(root: string): string {
    return join(root, "node_modules", ...PACKAGE_NAME.split("/"));
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("linkUtilsPackage", () => {
    test("creates the symlink and points it at this checkout", () => {
        const root = scratch();
        const result = linkUtilsPackage({ root });

        expect(result.outcome).toBe("created");
        expect(result.target).toBe(utilsPackageDir());
        expect(lstatSync(result.linkPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(result.linkPath)).toBe(utilsPackageDir());
        expect(result.resolves).toBe(true);
    });

    test("is idempotent: a second run reports already, and changes nothing", () => {
        const root = scratch();
        const first = linkUtilsPackage({ root });
        const second = linkUtilsPackage({ root });

        expect(first.outcome).toBe("created");
        expect(second.outcome).toBe("already");
        expect(readlinkSync(second.linkPath)).toBe(utilsPackageDir());
    });

    test("🛑 never replaces a real directory", () => {
        const root = scratch();
        const linkPath = linkPathIn(root);
        mkdirSync(linkPath, { recursive: true });
        writeFileSync(join(linkPath, "package.json"), '{ "name": "someone-elses" }');

        const result = linkUtilsPackage({ root });

        expect(result.outcome).toBe("occupied");
        expect(lstatSync(linkPath).isDirectory()).toBe(true);
        expect(existsSync(join(linkPath, "package.json"))).toBe(true);
    });

    test("🛑 never repoints a LIVE link to another checkout without force", () => {
        const root = scratch();
        const other = scratch();
        const linkPath = linkPathIn(root);
        mkdirSync(join(root, "node_modules", "@genesiscz"), { recursive: true });
        symlinkSync(other, linkPath, "dir");

        const result = linkUtilsPackage({ root });

        expect(result.outcome).toBe("points-elsewhere");
        expect(result.existing).toBe(other);
        expect(readlinkSync(linkPath)).toBe(other);
    });

    test("force repoints a live link to another checkout", () => {
        const root = scratch();
        const other = scratch();
        const linkPath = linkPathIn(root);
        mkdirSync(join(root, "node_modules", "@genesiscz"), { recursive: true });
        symlinkSync(other, linkPath, "dir");

        const result = linkUtilsPackage({ root, force: true });

        expect(result.outcome).toBe("created");
        expect(readlinkSync(linkPath)).toBe(utilsPackageDir());
    });

    test("repairs a DANGLING link without force, because nothing can depend on a missing path", () => {
        const root = scratch();
        const gone = join(tmpdir(), `gt-link-moved-${process.pid}-${Date.now()}`);
        const linkPath = linkPathIn(root);
        mkdirSync(join(root, "node_modules", "@genesiscz"), { recursive: true });
        symlinkSync(gone, linkPath, "dir");

        expect(existsSync(gone)).toBe(false);

        const result = linkUtilsPackage({ root });

        expect(result.outcome).toBe("repaired");
        expect(readlinkSync(linkPath)).toBe(utilsPackageDir());
    });

    test("reads a RELATIVE link as an absolute path", () => {
        // `readlinkSync` returns the link exactly as stored. Comparing that raw string against
        // an absolute target reported the repo's own relative link as another checkout.
        const root = scratch();
        const scopeDir = join(root, "node_modules", "@genesiscz");
        mkdirSync(scopeDir, { recursive: true });
        // Exactly how a package manager stores it: relative to the link's OWN directory.
        symlinkSync(relative(scopeDir, utilsPackageDir()), linkPathIn(root), "dir");

        const status = linkStatusFor(root);

        expect(status.pointsAt).toBe(utilsPackageDir());
        expect(status.current).toBe(true);
    });
});

describe("linkStatusFor", () => {
    test("reports an absent link without creating one", () => {
        const root = scratch();
        const status = linkStatusFor(root);

        expect(status.pointsAt).toBeNull();
        expect(status.occupied).toBe(false);
        expect(status.current).toBe(false);
        expect(existsSync(join(root, "node_modules"))).toBe(false);
    });

    test("reports a dangling link as dangling, not as another checkout", () => {
        const root = scratch();
        mkdirSync(join(root, "node_modules", "@genesiscz"), { recursive: true });
        symlinkSync(join(tmpdir(), "gt-link-nowhere-at-all"), linkPathIn(root), "dir");

        const status = linkStatusFor(root);

        expect(status.dangling).toBe(true);
        expect(status.current).toBe(false);
    });

    test("reports a real directory as occupied", () => {
        const root = scratch();
        mkdirSync(linkPathIn(root), { recursive: true });

        expect(linkStatusFor(root).occupied).toBe(true);
    });
});

describe("linkIsSound", () => {
    test("accepts the real package directory", () => {
        expect(linkIsSound(utilsPackageDir())).toBe(true);
    });

    test("rejects a directory with no manifest, or one naming a different package", () => {
        const root = scratch();

        expect(linkIsSound(root)).toBe(false);

        writeFileSync(join(root, "package.json"), '{ "name": "not-ours" }');
        expect(linkIsSound(root)).toBe(false);
    });

    test("rejects a path that does not exist", () => {
        expect(linkIsSound(join(tmpdir(), "gt-link-absent-dir"))).toBe(false);
    });
});

describe("unlinkUtilsPackage", () => {
    test("removes our own link", () => {
        const root = scratch();
        linkUtilsPackage({ root });

        const result = unlinkUtilsPackage({ root });

        expect(result.outcome).toBe("removed");
        expect(existsSync(linkPathIn(root))).toBe(false);
    });

    test("says absent when there is nothing to remove", () => {
        expect(unlinkUtilsPackage({ root: scratch() }).outcome).toBe("absent");
    });

    test("🛑 never removes a real directory", () => {
        const root = scratch();
        const linkPath = linkPathIn(root);
        mkdirSync(linkPath, { recursive: true });

        expect(unlinkUtilsPackage({ root }).outcome).toBe("occupied");
        expect(existsSync(linkPath)).toBe(true);
    });

    test("🛑 never removes another checkout's link without force", () => {
        const root = scratch();
        const other = scratch();
        const linkPath = linkPathIn(root);
        mkdirSync(join(root, "node_modules", "@genesiscz"), { recursive: true });
        symlinkSync(other, linkPath, "dir");

        expect(unlinkUtilsPackage({ root }).outcome).toBe("points-elsewhere");
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

        expect(unlinkUtilsPackage({ root, force: true }).outcome).toBe("removed");
        expect(existsSync(linkPath)).toBe(false);
        // The target itself is untouched: only the link was ever ours to remove.
        expect(existsSync(other)).toBe(true);
    });
});
