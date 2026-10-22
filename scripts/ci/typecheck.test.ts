import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { type Changes, type Project, reasonToRun } from "./typecheck";

const PROJECTS: Project[] = [
    { name: "root", tsconfig: "tsconfig.json" },
    { name: "ui", tsconfig: "src/app/ui/tsconfig.json" },
];

const key = (file: string) => resolve(file).toLowerCase();
const programs = new Map<string, Set<string> | null>([
    ["root", new Set(["src/utils/date.ts", "src/app/index.ts"].map(key))],
    ["ui", new Set(["src/app/ui/Page.tsx", "src/utils/date.ts"].map(key))],
]);

function reasons(changes: Changes, known = programs): Array<string | null> {
    return PROJECTS.map((project) => reasonToRun({ project, changes, programs: known }));
}

describe("reasonToRun", () => {
    it("runs every project a changed file is part of, and skips the others", () => {
        expect(reasons({ files: ["src/utils/date.ts"], added: [] })).toEqual(["in its program", "in its program"]);
        expect(reasons({ files: ["src/app/ui/Page.tsx"], added: [] })).toEqual([null, "in its program"]);
        expect(reasons({ files: ["README.md", "src/macos/App.swift"], added: [] })).toEqual([null, null]);
    });

    it("runs everything for shared config, and a project with no build info", () => {
        expect(reasons({ files: ["bun.lock"], added: [] })).toEqual(["shared config", "shared config"]);
        expect(reasons({ files: ["src/app/ui/tsconfig.json"], added: [] })).toEqual(["shared config", "shared config"]);
        const partial = new Map(programs);
        partial.set("ui", null);
        expect(reasons({ files: [], added: [] }, partial)).toEqual([null, "no build info"]);
    });

    it("runs everything for an added TypeScript file no program knows, but not for an added doc", () => {
        expect(reasons({ files: ["src/app/lib/new.ts"], added: ["src/app/lib/new.ts"] })).toEqual([
            "new file",
            "new file",
        ]);
        expect(reasons({ files: ["docs/new.md"], added: ["docs/new.md"] })).toEqual([null, null]);
        expect(reasons({ files: ["src/utils/new.js"], added: ["src/utils/new.js"] })).toEqual(["new file", "new file"]);
    });

    it("runs a project for an added file another project's cache already holds, since its own may take it too", () => {
        const rootSawIt = new Map(programs);
        rootSawIt.set("root", new Set([...(programs.get("root") ?? []), key("src/app/ui/new.ts")]));
        expect(reasons({ files: ["src/app/ui/new.ts"], added: ["src/app/ui/new.ts"] }, rootSawIt)).toEqual([
            "in its program",
            "new file",
        ]);
    });

    it("a deleted file still counts for the programs that held it", () => {
        expect(reasons({ files: ["src/app/index.ts"], added: [] })).toEqual(["in its program", null]);
    });
});
