#!/usr/bin/env bun
/**
 * console-sweep.ts — codemod: console.* → out.X / logger.X (ts-morph, NOT YET APPLIED)
 *
 * Transforms:
 *   console.log(...)   → out.print(...)
 *   console.info(...)  → out.info(...)
 *   console.warn(...)  → out.warn(...)
 *   console.error(...) → out.error(...)
 *   console.debug(...) → logger.debug(...)
 *
 * Inserts missing @app/logger imports (merges into existing if present).
 *
 * Safety guards:
 *   - Skips shadowed `console` (local binding in call scope)
 *   - Skips .tsx files (manual migration via COS-T5)
 *   - Skips .test.ts files (console.* is legitimate in tests)
 *   - Skips src/logger.ts and src/logger/**
 *   - Skips already-migrated MCP servers (d8facc72)
 *   - Skips scripts/** (out of scope)
 *
 * CLI:
 *   bun run scripts/codemod/console-sweep.ts              # write changes
 *   bun run scripts/codemod/console-sweep.ts --dry-run    # emit manifest, no writes
 *   bun run scripts/codemod/console-sweep.ts --diff       # unified diff to stdout
 *
 * Manifest: /tmp/console-sweep-manifest.json
 *   Array of { file, line, before, after }
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
    type CallExpression,
    type ImportDeclaration,
    type SourceFile,
    Node,
    Project,
    SyntaxKind,
} from "ts-morph";

// ─── Config ──────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const MAPPING: Record<string, { target: "out" | "logger"; method: string }> = {
    log: { target: "out", method: "print" },
    info: { target: "out", method: "info" },
    warn: { target: "out", method: "warn" },
    error: { target: "out", method: "error" },
    debug: { target: "logger", method: "debug" },
};

function shouldSkip(relPath: string): boolean {
    if (relPath.endsWith(".tsx")) {
        return true; // COS-T5 handles manually
    }

    if (relPath.endsWith(".test.ts")) {
        return true; // console.* is legitimate in tests
    }

    if (relPath === "src/logger.ts") {
        return true;
    }

    if (relPath.startsWith("src/logger/")) {
        return true;
    }

    if (relPath === "src/mcp-ripgrep/index.ts") {
        return true; // already migrated in d8facc72
    }

    if (relPath === "src/mcp-web-reader/index.ts") {
        return true; // already migrated in d8facc72
    }

    if (relPath.startsWith("scripts/")) {
        return true;
    }

    return false;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface RewriteEntry {
    file: string;
    line: number;
    before: string;
    after: string;
}

// ─── Core transform ───────────────────────────────────────────────────────────

/**
 * Returns true if `console` is shadowed by a local binding in the call's scope.
 * ts-morph symbol resolution: if the call's `console` identifier resolves to a
 * local declaration (not the global), we skip the rewrite.
 */
function isConsoleShadowed(call: CallExpression): boolean {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) {
        return false;
    }

    const obj = expr.getExpression();
    const sym = obj.getSymbol();
    if (!sym) {
        return false;
    }

    // If the symbol has declarations in this file (i.e. a local binding), skip.
    const decls = sym.getDeclarations();
    return decls.length > 0 && decls.some((d) => d.getSourceFile() === call.getSourceFile());
}

interface FileChanges {
    needsOut: boolean;
    needsLogger: boolean;
    rewrites: RewriteEntry[];
}

function transformFile(sf: SourceFile, dryRun: boolean, diff: boolean): FileChanges {
    const relPath = relative(REPO_ROOT, sf.getFilePath());
    const changes: FileChanges = { needsOut: false, needsLogger: false, rewrites: [] };

    // Two-pass: collect first, apply after. Single-pass mutation invalidates
    // sibling/descendant nodes — e.g. `console.error(pc.red("..."))` enumerates
    // BOTH the outer console.error CallExpression AND the inner pc.red
    // CallExpression. Replacing the outer one forgets the inner one, and any
    // subsequent .getText()/.getExpression() on it throws "node removed or
    // forgotten." Collect, sort by start position descending, then replace.
    const pending: { call: CallExpression; after: string; start: number; line: number; before: string }[] = [];

    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of calls) {
        // A prior iteration in this same loop may have replaced an ancestor;
        // skip orphaned nodes defensively (belt + braces with the two-pass below).
        if (call.wasForgotten()) {
            continue;
        }

        const expr = call.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) {
            continue;
        }

        const obj = expr.getExpression();
        if (obj.getText() !== "console") {
            continue;
        }

        const method = expr.getName();
        const mapping = MAPPING[method];
        if (!mapping) {
            continue;
        }

        if (isConsoleShadowed(call)) {
            continue;
        }

        const before = call.getText();
        const args = call.getArguments().map((a) => a.getText()).join(", ");
        const after = `${mapping.target}.${mapping.method}(${args})`;

        const line = call.getStartLineNumber();
        const start = call.getStart();
        changes.rewrites.push({ file: relPath, line, before, after });
        pending.push({ call, after, start, line, before });

        if (mapping.target === "out") {
            changes.needsOut = true;
        } else {
            changes.needsLogger = true;
        }
    }

    // Apply replacements end-first so earlier positions stay valid. Also a
    // defensive wasForgotten() check in case an earlier-positioned replacement
    // (a parent of one we already enqueued) eats a later one.
    if (!dryRun && !diff) {
        pending.sort((a, b) => b.start - a.start);
        for (const r of pending) {
            if (r.call.wasForgotten()) {
                continue;
            }

            r.call.replaceWithText(r.after);
        }
    }

    return changes;
}

function ensureImport(sf: SourceFile, needsOut: boolean, needsLogger: boolean): void {
    if (!needsOut && !needsLogger) {
        return;
    }

    // Find existing @app/logger import
    let existing: ImportDeclaration | undefined;
    for (const imp of sf.getImportDeclarations()) {
        if (imp.getModuleSpecifierValue() === "@app/logger") {
            existing = imp;
            break;
        }
    }

    if (existing) {
        // Merge into existing import
        const namedImports = existing.getNamedImports().map((n) => n.getName());
        if (needsOut && !namedImports.includes("out")) {
            existing.addNamedImport("out");
        }

        if (needsLogger && !namedImports.includes("logger")) {
            existing.addNamedImport("logger");
        }
    } else {
        // Add new import at top (after any 'use strict' or blank lines)
        const names: string[] = [];
        if (needsLogger) {
            names.push("logger");
        }

        if (needsOut) {
            names.push("out");
        }

        sf.addImportDeclaration({
            moduleSpecifier: "@app/logger",
            namedImports: names,
        });
    }
}

// ─── Diff output ─────────────────────────────────────────────────────────────

function generateDiff(original: string, modified: string, label: string): string {
    const origLines = original.split("\n");
    const modLines = modified.split("\n");
    const lines: string[] = [`--- ${label}`, `+++ ${label} (modified)`];

    const maxLen = Math.max(origLines.length, modLines.length);
    for (let i = 0; i < maxLen; i++) {
        const o = origLines[i];
        const m = modLines[i];
        if (o !== m) {
            if (o !== undefined) {
                lines.push(`-${o}`);
            }

            if (m !== undefined) {
                lines.push(`+${m}`);
            }
        } else {
            lines.push(` ${o ?? ""}`);
        }
    }

    return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const diff = args.includes("--diff");

    const project = new Project({
        tsConfigFilePath: join(REPO_ROOT, "tsconfig.json"),
        skipAddingFilesFromTsConfig: false,
    });

    const manifest: RewriteEntry[] = [];
    const diffs: string[] = [];

    const sourceFiles = project.getSourceFiles();
    let processed = 0;
    let changed = 0;

    for (const sf of sourceFiles) {
        const relPath = relative(REPO_ROOT, sf.getFilePath());

        if (shouldSkip(relPath)) {
            continue;
        }

        if (!relPath.startsWith("src/")) {
            continue;
        }

        processed++;
        const originalText = sf.getFullText();
        const fileChanges = transformFile(sf, dryRun, diff);

        if (fileChanges.rewrites.length === 0) {
            continue;
        }

        changed++;
        manifest.push(...fileChanges.rewrites);

        if (!dryRun && !diff) {
            // Apply import additions after all rewrites in this file
            ensureImport(sf, fileChanges.needsOut, fileChanges.needsLogger);
        }

        if (diff) {
            // Re-apply rewrites to a clone to generate diff
            const cloneProject = new Project({ useInMemoryFileSystem: true });
            const cloneSf = cloneProject.createSourceFile(sf.getFilePath(), originalText);
            transformFile(cloneSf, false, false);
            ensureImport(cloneSf, fileChanges.needsOut, fileChanges.needsLogger);
            diffs.push(generateDiff(originalText, cloneSf.getFullText(), relPath));
        }
    }

    if (!dryRun && !diff) {
        await project.save();
    }

    // Emit manifest
    const manifestPath = "/tmp/console-sweep-manifest.json";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    if (diff) {
        process.stdout.write(diffs.join("\n\n") + "\n");
    }

    const mode = dryRun ? "dry-run" : diff ? "diff" : "applied";
    process.stderr.write(
        `console-sweep [${mode}]: scanned ${processed} files, ${changed} files with console.* calls, ${manifest.length} rewrites\n`
    );
    process.stderr.write(`manifest: ${manifestPath}\n`);
}

main().catch((err) => {
    process.stderr.write(`console-sweep error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
