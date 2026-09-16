import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
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

describe("xlsx CE pin", () => {
    test("0.20.3 still reads a Uint8Array the way MfRentalClient does", () => {
        expect(XLSX.version).toBe("0.20.3");

        const ws = XLSX.utils.aoa_to_sheet([
            ["katastr", "obec"],
            ["Vinohrady", "Praha 3"],
        ]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Cenova mapa");
        const u8 = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
        const parsed = XLSX.read(u8);
        const sheet = parsed.Sheets[parsed.SheetNames.find((n) => n.includes("Cenov")) ?? parsed.SheetNames[0]];
        const range = XLSX.utils.decode_range(sheet["!ref"]!);
        const addr = XLSX.utils.encode_cell({ r: 1, c: 1 });

        expect(range.e.r).toBe(1);
        expect(String(sheet[addr].v)).toBe("Praha 3");
    });
});
