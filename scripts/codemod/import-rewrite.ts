#!/usr/bin/env bun
/**
 * Codemod 4a — rewrite `import logger from "@app/logger"` (default) to the
 * named `import { logger }`. Type-only default imports become
 * `import type { Logger as <local> }`. Purely mechanical; collisions
 * (typeof logger, consoleLog aliasing, D11 bespoke -v) are fixed by hand in
 * the Task 17 revise commit. Run with `--dry-run` to preview without writing.
 */
import { Project } from "ts-morph";

const dryRun = process.argv.includes("--dry-run");
const project = new Project({ tsConfigFilePath: "tsconfig.json" });
// tsconfig.json EXCLUDES the vite sub-apps (src/dashboard, src/shops/ui,
// src/dev-dashboard/ui, src/fsevents-profile, …). Their *server-side* files
// (routes/api/**, vite-middleware, tool entrypoints) still default-import
// @app/logger and MUST be migrated for the Task 21 gate. Explicitly add all
// src ts/tsx so coverage does not depend on tsconfig scoping.
project.addSourceFilesAtPaths("src/**/*.{ts,tsx}");
let changed = 0;
const touched: string[] = [];

for (const sf of project.getSourceFiles("src/**/*.{ts,tsx}")) {
    let fileChanged = false;

    for (const imp of sf.getImportDeclarations()) {
        if (imp.getModuleSpecifierValue() !== "@app/logger") {
            continue;
        }

        const def = imp.getDefaultImport();
        if (!def) {
            continue;
        }

        const local = def.getText();
        const isTypeOnly = imp.isTypeOnly();
        imp.removeDefaultImport();

        if (isTypeOnly) {
            // `import type logger` → `import type { Logger as <local> }`;
            // callers using `typeof logger` still resolve to the type.
            imp.addNamedImport({ name: "Logger", alias: local });
        } else {
            imp.addNamedImport(local === "logger" ? { name: "logger" } : { name: "logger", alias: local });
        }

        fileChanged = true;
    }

    if (fileChanged) {
        changed++;
        touched.push(sf.getFilePath());
    }
}

if (dryRun) {
    console.log(`import-rewrite [DRY RUN]: would change ${changed} files`);
    for (const p of touched) {
        console.log(`  ${p}`);
    }
} else {
    project.saveSync();
    console.log(`import-rewrite: changed ${changed} files`);
}
