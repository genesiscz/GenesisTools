import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevCachesAnalyzer } from "@app/doctor/analyzers/dev-caches";
import * as roots from "@app/doctor/lib/dev-roots";
import { devRoots, discoverDevRoots } from "@app/doctor/lib/dev-roots";

const home = mkdtempSync(join(tmpdir(), "doctor-dev-roots-"));
const repo = (...parts: string[]) => mkdirSync(join(home, ...parts, ".git"), { recursive: true });

repo("Work", "app");
repo("Clients", "acme", "site");
repo("Library", "Caches", "tool");
repo(".hidden", "thing");
repo("standalone");
repo("Documents", "projects", "x");
repo("Old.photoslibrary", "inner");
mkdirSync(join(home, "Documents", "notes"), { recursive: true });
symlinkSync(join(home, "Work"), join(home, "WorkLink"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("dev roots", () => {
    it("discovers roots once per analyzer, retaining a stable allowlist while checking existence", () => {
        const found = join(home, "cached-root");
        mkdirSync(found);
        const discover = spyOn(roots, "devRoots").mockReturnValueOnce([found]).mockReturnValue([]);
        try {
            const analyzer = new DevCachesAnalyzer({ home });
            expect(analyzer.allowRoots()).toContain(found);
            expect(analyzer.allowRoots()).toContain(found);
            expect(discover).toHaveBeenCalledTimes(1);
            rmSync(found, { recursive: true });
            expect(analyzer.allowRoots()).not.toContain(found);
            expect(discover).toHaveBeenCalledTimes(1);
            expect(new DevCachesAnalyzer({ home, roots: [join(home, "Work")] }).allowRoots()).toContain(
                join(home, "Work")
            );
            expect(discover).toHaveBeenCalledTimes(1);
        } finally {
            discover.mockRestore();
        }
    });

    it("finds the folders that hold checkouts, one and two levels down, and nothing by name", () => {
        expect(discoverDevRoots(home).sort()).toEqual([join(home, "Clients", "acme"), join(home, "Work")]);
    });

    it("never enters Library, hidden folders or symlinks, and never makes the home itself a root", () => {
        const roots = devRoots(home);
        expect(
            roots.some((root) => /Library|\.hidden|WorkLink|Documents|photoslibrary/.test(root)),
            "protected, hidden, package and linked folders are not entered"
        ).toBe(false);
        expect(roots).not.toContain(home);
    });

    it("has no root on a machine without checkouts", () => {
        const empty = mkdtempSync(join(tmpdir(), "doctor-dev-roots-empty-"));
        mkdirSync(join(empty, "Projects"));
        expect(discoverDevRoots(empty)).toEqual([]);
        rmSync(empty, { recursive: true, force: true });
    });
});
