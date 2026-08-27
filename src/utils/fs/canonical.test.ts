import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalDir, isInsideDir } from "./canonical";

function tempRoot(prefix: string): string {
    return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("canonicalDir", () => {
    test("resolves a relative path and follows symlinks", () => {
        const root = tempRoot("canonical-real-");
        const real = join(root, "real");
        mkdirSync(real);
        const link = join(root, "link");
        symlinkSync(real, link);

        try {
            expect(canonicalDir(link)).toBe(real);
            expect(canonicalDir(root)).toBe(root);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a path that does not exist is returned resolved but uncanonicalized", () => {
        const missing = join(tempRoot("canonical-missing-"), "nope", "deeper");
        expect(canonicalDir(missing)).toBe(resolve(missing));
    });
});

describe("isInsideDir", () => {
    test("the root itself and a real child are inside", () => {
        const root = tempRoot("inside-real-");
        const child = join(root, "sub");
        mkdirSync(child);

        try {
            expect(isInsideDir(root, root)).toBe(true);
            expect(isInsideDir(root, child)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a sibling whose NAME shares the root's prefix is not inside", () => {
        // "/tmp/app-data" must not count as being under "/tmp/app".
        const parent = tempRoot("inside-prefix-");
        const root = join(parent, "app");
        const sibling = join(parent, "app-data");
        mkdirSync(root);
        mkdirSync(sibling);

        try {
            expect(isInsideDir(root, sibling)).toBe(false);
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    test("a symlink inside the root that points OUT of it is not inside", () => {
        // This is the case a string prefix check gets wrong: the path spelling
        // stays under the root while the real file lives somewhere else.
        const outside = tempRoot("inside-outside-");
        writeFileSync(join(outside, "secret.txt"), "top secret");
        const root = tempRoot("inside-root-");
        const planted = join(root, "escape.txt");
        symlinkSync(join(outside, "secret.txt"), planted);

        try {
            expect(planted.startsWith(root)).toBe(true);
            expect(isInsideDir(root, planted)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("a symlink inside the root that points back INSIDE it stays inside", () => {
        const root = tempRoot("inside-loop-");
        const real = join(root, "real");
        mkdirSync(real);
        writeFileSync(join(real, "page.md"), "# page");
        symlinkSync(join(real, "page.md"), join(root, "alias.md"));

        try {
            expect(isInsideDir(root, join(root, "alias.md"))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("../ traversal out of the root is not inside", () => {
        const root = tempRoot("inside-traversal-");

        try {
            expect(isInsideDir(root, join(root, "..", "..", "etc"))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
