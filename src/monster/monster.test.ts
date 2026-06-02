import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "./lib/analyze";
import { parseImports } from "./lib/imports";
import { render } from "./lib/render";
import { roar } from "./lib/roar";
import { scariness } from "./lib/score";
import { faceForTier, tierForScore, tierName } from "./lib/tier";

describe("scariness", () => {
    const base = { lines: 100, ageDays: 30, fanIn: 2, fanOut: 3 };

    it("is strictly increasing in each dimension, holding the others fixed", () => {
        const b = scariness(base);
        expect(scariness({ ...base, lines: base.lines + 50 })).toBeGreaterThan(b);
        expect(scariness({ ...base, ageDays: base.ageDays + 10 })).toBeGreaterThan(b);
        expect(scariness({ ...base, fanIn: base.fanIn + 1 })).toBeGreaterThan(b);
        expect(scariness({ ...base, fanOut: base.fanOut + 1 })).toBeGreaterThan(b);
    });

    it("is non-negative and corpus-independent (same inputs → same score)", () => {
        expect(scariness({ lines: 0, ageDays: 0, fanIn: 0, fanOut: 0 })).toBe(0);
        expect(scariness(base)).toBe(scariness({ ...base }));
    });
});

describe("tierForScore", () => {
    it("maps scores to the pinned tiers at boundaries", () => {
        expect(tierForScore(0)).toBe(0);
        expect(tierForScore(14.9)).toBe(0);
        expect(tierForScore(15)).toBe(1);
        expect(tierForScore(39.9)).toBe(1);
        expect(tierForScore(40)).toBe(2);
        expect(tierForScore(79.9)).toBe(2);
        expect(tierForScore(80)).toBe(3);
        expect(tierForScore(9999)).toBe(3);
    });
});

describe("faceForTier", () => {
    it("returns a non-empty, distinct face per tier", () => {
        const faces = [faceForTier(0), faceForTier(1), faceForTier(2), faceForTier(3)];
        for (const f of faces) {
            expect(f.length).toBeGreaterThan(0);
        }

        expect(new Set(faces).size).toBe(4);
    });

    it("names the tiers", () => {
        expect(tierName(0)).toBe("slime");
        expect(tierName(3)).toBe("kraken");
    });
});

describe("parseImports", () => {
    it("extracts the five live specifier forms", () => {
        const src = [
            `import foo from "./foo";`,
            `import "./side-effect";`,
            `export { bar } from "../bar";`,
            `const baz = require("./baz");`,
            `const lazy = import("./lazy");`,
            `import react from "react";`,
        ].join("\n");

        const specs = parseImports(src);
        expect(specs).toContain("./foo");
        expect(specs).toContain("./side-effect");
        expect(specs).toContain("../bar");
        expect(specs).toContain("./baz");
        expect(specs).toContain("./lazy");
        expect(specs).toContain("react");
    });

    it("returns an empty array when there are no imports", () => {
        expect(parseImports("const x = 1;\nconsole.log(x);")).toEqual([]);
    });
});

describe("roar", () => {
    const base = {
        path: "a.ts",
        score: 50,
        tier: 2 as const,
        tierName: "ogre",
        lines: 1412,
        ageDays: 246,
        fanIn: 18,
        fanOut: 7,
    };

    it("includes formatted lines, fan-in, and rounded age", () => {
        const line = roar({ ...base, gitAvailable: true });
        expect(line).toContain("1,412 lines");
        expect(line).toContain("18 modules depend on me");
        expect(line).toContain("246 days");
    });

    it("handles zero fan-in", () => {
        const line = roar({ ...base, fanIn: 0, gitAvailable: true });
        expect(line).toContain("nobody depends on me");
    });

    it("omits the age clause when git is unavailable", () => {
        const line = roar({ ...base, gitAvailable: false });
        expect(line).not.toContain("days");
    });
});

describe("render", () => {
    it("renders the scariest file, leaderboard, and repo size", () => {
        const report = {
            dir: "/tmp/x",
            fileCount: 2,
            repoMonsterSize: 120.5,
            scariest: {
                path: "src/old.ts",
                score: 100,
                tier: 3 as const,
                tierName: "kraken",
                lines: 400,
                ageDays: 300,
                fanIn: 3,
                fanOut: 0,
                roar: "I am 400 lines old and 3 modules depend on me. I have not changed in 300 days.",
            },
            leaderboard: [
                {
                    path: "src/old.ts",
                    score: 100,
                    tier: 3 as const,
                    tierName: "kraken",
                    lines: 400,
                    ageDays: 300,
                    fanIn: 3,
                    fanOut: 0,
                },
                {
                    path: "src/a.ts",
                    score: 20.5,
                    tier: 1 as const,
                    tierName: "imp",
                    lines: 2,
                    ageDays: 0,
                    fanIn: 0,
                    fanOut: 1,
                },
            ],
        };

        const text = render(report);
        expect(text).toContain("src/old.ts");
        expect(text).toContain("KRAKEN");
        expect(text).toContain("modules depend on me");
        expect(text).toContain("Repo monster size");
    });

    it("renders a clean-repo message when there are no files", () => {
        const report = { dir: "/tmp/x", fileCount: 0, repoMonsterSize: 0, scariest: null, leaderboard: [] };
        expect(render(report)).toContain("No monsters here");
    });
});

function gitInit(dir: string): void {
    const run = (args: string[], env?: Record<string, string>) => {
        const r = spawnSync("git", args, { cwd: dir, env: { ...process.env, ...env } });
        if (r.status !== 0) {
            throw new Error(`git ${args.join(" ")} failed: ${r.stderr?.toString()}`);
        }
    };

    run(["init", "-q"]);
    run(["config", "user.email", "test@test.local"]);
    run(["config", "user.name", "Monster Test"]);
}

function commitAll(dir: string, message: string, isoDate: string): void {
    const env = { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
    spawnSync("git", ["add", "-A"], { cwd: dir });
    const r = spawnSync("git", ["commit", "-q", "-m", message], {
        cwd: dir,
        env: { ...process.env, ...env },
    });
    if (r.status !== 0) {
        throw new Error(`git commit failed: ${r.stderr?.toString()}`);
    }
}

describe("analyze (hermetic git repo)", () => {
    it("ranks the older, larger, more-depended-on file as scariest", async () => {
        const dir = mkdtempSync(join(tmpdir(), "monster-test-"));
        mkdirSync(join(dir, "src"), { recursive: true });

        const bigLines = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join("\n");
        writeFileSync(join(dir, "src", "old.ts"), bigLines);
        writeFileSync(join(dir, "src", "a.ts"), `import "./old";\nexport const a = 1;`);
        writeFileSync(join(dir, "src", "b.ts"), `import "./old";\nexport const b = 2;`);
        writeFileSync(join(dir, "src", "c.ts"), `import "./old";\nexport const c = 3;`);

        gitInit(dir);
        commitAll(dir, "add old", "2024-01-01T00:00:00Z");
        writeFileSync(join(dir, "src", "a.ts"), `import "./old";\nexport const a = 11;`);
        commitAll(dir, "touch a", "2024-10-27T00:00:00Z");

        const now = Date.parse("2024-10-27T00:00:00Z");
        const report = await analyze({ dir, now, top: 5 });

        expect(report.fileCount).toBe(4);
        expect(report.scariest).not.toBeNull();
        expect(report.scariest?.path).toBe("src/old.ts");
        expect(report.scariest?.fanIn).toBe(3);
        expect(report.scariest?.ageDays).toBeGreaterThan(295);
        expect(report.scariest?.ageDays).toBeLessThan(305);
        const aFile = report.leaderboard.find((f) => f.path === "src/a.ts");
        expect(aFile).toBeDefined();
        expect(aFile?.ageDays).toBeLessThan(1);
        expect(report.repoMonsterSize).toBeGreaterThan(report.scariest?.score ?? 0);
    });

    it("returns an empty report for a dir with no source files", async () => {
        const dir = mkdtempSync(join(tmpdir(), "monster-empty-"));
        writeFileSync(join(dir, "README.md"), "# nothing scary here");

        const report = await analyze({ dir, now: Date.now(), top: 5 });
        expect(report.fileCount).toBe(0);
        expect(report.repoMonsterSize).toBe(0);
        expect(report.scariest).toBeNull();
        expect(report.leaderboard).toEqual([]);
    });
});
