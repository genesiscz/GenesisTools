#!/usr/bin/env bun
/**
 * Codemod 4b — append a `runTool` bootstrap wiring to every commander tool
 * entrypoint. Intentionally DUMB & consistent — collisions (main().catch /
 * parseAsync / handleReadme / addGlobalVerboseOption) are folded by hand in
 * the next (revise) commit (Task 20).
 *
 * Coverage note: like import-rewrite (4a), we explicitly
 * addSourceFilesAtPaths the entrypoint glob — `tsConfigFilePath` honors
 * tsconfig `exclude` (src/dashboard, src/shops/ui, src/dev-dashboard/ui,
 * src/fsevents-profile), and getSourceFiles() would silently miss any
 * excluded entrypoint. The glob-add makes coverage tsconfig-independent.
 */
import { basename, dirname } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { Project } from "ts-morph";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });
project.addSourceFilesAtPaths("src/*/index.{ts,tsx}");
let changed = 0;
const touched: string[] = [];

for (const sf of project.getSourceFiles("src/*/index.{ts,tsx}")) {
    const text = sf.getFullText();
    if (text.includes("runTool(")) {
        continue;
    }

    if (!/new Command\(|program\b/.test(text)) {
        continue;
    }

    const tool = basename(dirname(sf.getFilePath()));
    sf.addImportDeclaration({ moduleSpecifier: "@app/utils/cli", namedImports: ["runTool"] });
    sf.addStatements(
        `\n// CODEMOD-4b: review & fold existing parse/readme/verbose into this\nawait runTool(program, { tool: ${SafeJSON.stringify(tool)} });\n`
    );
    changed++;
    touched.push(sf.getFilePath());
}

project.saveSync();
console.log(`runtool-append: touched ${changed} entrypoints`);
for (const p of touched) {
    console.log(`  ${p}`);
}
