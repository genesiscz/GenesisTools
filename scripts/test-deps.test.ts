import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANARY_PACKAGES, diagnose, lockStamp, missingCanaries } from "./test-deps";

const roots: string[] = [];

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "test-deps-"));
    roots.push(root);
    return root;
}

function withPackages(root: string, packages: readonly string[]): void {
    for (const pkg of packages) {
        mkdirSync(join(root, "node_modules", pkg), { recursive: true });
    }
}

afterEach(() => {
    while (roots.length > 0) {
        rmSync(roots.pop()!, { recursive: true, force: true });
    }
});

describe("diagnose", () => {
    test("a missing node_modules is reported", () => {
        expect(diagnose(makeRoot())).toBe("node_modules is missing");
    });

    test("a complete tree is healthy", () => {
        const root = makeRoot();
        withPackages(root, CANARY_PACKAGES);

        expect(diagnose(root)).toBeNull();
    });

    test("the worktree-shadowing case (partial tree) is caught and names what is missing", () => {
        // What `bunx` leaves behind inside a worktree: a node_modules holding
        // only whatever that one command needed.
        const root = makeRoot();
        withPackages(root, ["picocolors", ".bin"]);

        const verdict = diagnose(root);

        expect(verdict).toContain("incomplete");
        expect(verdict).toContain("parse5");
        expect(verdict).not.toContain("picocolors");
    });

    test("an empty node_modules is incomplete, not healthy", () => {
        const root = makeRoot();
        mkdirSync(join(root, "node_modules"), { recursive: true });

        expect(diagnose(root)).toContain("incomplete");
    });
});

describe("missingCanaries", () => {
    test("lists only the absent packages", () => {
        const root = makeRoot();
        withPackages(root, ["picocolors", "commander"]);

        expect(missingCanaries(root, ["picocolors", "commander", "parse5"])).toEqual(["parse5"]);
    });

    test("scoped package names resolve as directories", () => {
        const root = makeRoot();
        withPackages(root, ["@clack/prompts"]);

        expect(missingCanaries(root, ["@clack/prompts"])).toEqual([]);
    });
});

describe("lockStamp", () => {
    test("reports no-lockfile when none exists", () => {
        expect(lockStamp(makeRoot())).toBe("no-lockfile");
    });

    test("changes when the lockfile content changes", () => {
        const root = makeRoot();
        const lock = join(root, "bun.lock");

        writeFileSync(lock, "one");
        const before = lockStamp(root);

        writeFileSync(lock, "one plus more bytes");
        const after = lockStamp(root);

        expect(before).not.toBe(after);
        expect(after).toContain("bun.lock");
    });

    test("is stable across calls when nothing changes", () => {
        const root = makeRoot();
        writeFileSync(join(root, "bun.lock"), "stable");

        expect(lockStamp(root)).toBe(lockStamp(root));
    });
});
