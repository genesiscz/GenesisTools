import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Changes, type Project, programFiles, readState, reasonToRun } from "./typecheck";

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

describe("build info and the CI step", () => {
    it("an unreadable state.json or build info counts as nothing known instead of crashing every later run", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-typecheck-cut-"));
        writeFileSync(join(dir, "state.json"), '{"passed":{"root":{"sha":"ab');
        writeFileSync(join(dir, "root.tsbuildinfo"), '{"fileNames":["a.ts"');
        expect(readState(dir)).toEqual({ passed: {} });
        expect(programFiles(join(dir, "root.tsbuildinfo"))).toBeNull();
    });

    it("the CI step passes --base only when the event has a base (a workflow_dispatch run has none)", () => {
        const workflow = readFileSync(resolve(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8");
        const step = workflow.slice(workflow.indexOf("- name: TypeScript check\n"));
        const run = /\n\s+run: (.+)/.exec(step)?.[1] ?? "";
        expect(run).toStartWith("bun scripts/ci/typecheck.ts");
        const argv = (base: string) =>
            Bun.spawnSync(["bash", "-c", run.replace("bun scripts/ci/typecheck.ts", "printf '[%s]'")], {
                env: { ...process.env, TYPECHECK_BASE: base },
            }).stdout.toString();
        expect(argv("")).toBe("[]");
        expect(argv("abc123")).toBe("[--base][abc123]");
    });
});
