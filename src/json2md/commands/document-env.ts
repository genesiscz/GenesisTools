import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { json2mdBuild, transclusionHints } from "@genesiscz/utils/genesis-tools/tools/hints";
import type { DocumentHints } from "@genesiscz/utils/json2md/document-file";
import { type DocumentEnvironment, shortPath } from "@genesiscz/utils/json2md/environment";
import { out } from "@genesiscz/utils/logger";
import {
    nearestConfigFor,
    PACKAGE_NAME,
    packageImporterDirs,
    packageResolvesFrom,
    shadowedByFor,
} from "@genesiscz/utils/package-link";
import { defaultTransclusionRegistry } from "@genesiscz/utils/transclude";

/*
 * GenesisTools' environment for the json2md document verbs: the `tools json2md build` stamp, the GenesisTools
 * transclusion hints, and the `@genesiscz/utils` link check with its `tools link install` advice. A program that
 * ships the verbs without these keeps its own copy of this file and returns its own environment.
 */

/** Whether `root` is `path` itself or an ancestor of it. */
function within(root: string, path: string): boolean {
    const rel = relative(root, path);

    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Prints why `@genesiscz/utils` does not resolve from `moduleDir`, and the one command that
 * fixes it.
 *
 * Two different causes, two different fixes: a home-directory install cannot reach a folder
 * whose own tsconfig shadows it, so suggesting one there sends the user to a command that will
 * report success and change nothing.
 */
function reportPackageNotLinked(moduleDir: string, severity: "warn" | "error"): void {
    out.log[severity](`${PACKAGE_NAME} does not resolve from ${shortPath(moduleDir)} yet.`);

    const underHome = within(homedir(), moduleDir);
    // `shadowedByFor` only sees a mapping that ALREADY exists above a nearer config. On a
    // first setup nothing carries one yet, but a project tsconfig between the module and
    // home still hides the future `~/tsconfig.json`. A config above home does not.
    const nearest = nearestConfigFor(moduleDir);
    const projectConfig =
        nearest !== null &&
        nearest !== join(homedir(), "tsconfig.json") &&
        (!underHome || within(homedir(), dirname(nearest)))
            ? nearest
            : null;
    const shadowedBy = shadowedByFor(moduleDir) ?? projectConfig;

    if (shadowedBy === null && underHome) {
        out.log.info("One command fixes it for every file under your home directory:");
        out.log.info(suggestCommand("tools link", { replaceCommand: ["install"] }));
    } else if (shadowedBy === null) {
        // The home install writes `~/tsconfig.json`, which Bun never reads for a file
        // outside home, so suggesting it here reported success and changed nothing.
        out.log.info(`${moduleDir} is outside your home directory. Map it directly:`);
        out.log.info(suggestCommand("tools link", { replaceCommand: ["install", "--root", moduleDir] }));
    } else {
        // Absolute, not `shortPath()`: this names a place the user has to go and act
        // on, and a cwd-relative form renders it as `../../..`, which tells them
        // nothing. The same reasoning governs every path `tools link` prints.
        out.log.info(`${shadowedBy} is nearer, and Bun reads only the nearest tsconfig.`);
        out.log.info("So it hides any mapping above it. Install into that project instead:");
        out.log.info(
            suggestCommand("tools link", {
                replaceCommand: ["install", "--root", dirname(shadowedBy)],
            })
        );
    }
}

/**
 * Whether loading `modulePath` would need `@genesiscz/utils` and fail to find it.
 *
 * 🛑 Checked on the module's import graph first, not by always calling `packageResolvesFrom`: a
 * module that never imports the package (a hand-written throw, data with no helpers) must still
 * fail exactly as it always has when it is broken for some OTHER reason, not read "not linked
 * yet" guidance about a package it never needed. The graph includes local helpers, so a package
 * import one file away is caught here before Bun's resolver or its auto-installer sees it. The
 * package must resolve from each importing module's own folder, not the document's: a helper in a
 * linked project serves a document that sits outside it. Returns the first folder the package
 * does not resolve from, or null when every importer resolves it.
 */
async function unlinkedImporterDir(modulePath: string): Promise<string | null> {
    return (await packageImporterDirs(modulePath)).find((dir) => !packageResolvesFrom(dir)) ?? null;
}

/** The GenesisTools commands a document's stamp and its `{{kind …}}` tokens name. */
function documentHints(): DocumentHints {
    return { rebuildCommand: json2mdBuild, transclusions: defaultTransclusionRegistry(transclusionHints()) };
}

export function documentEnvironment(): DocumentEnvironment {
    return {
        hints: documentHints,
        unresolvedImporterDir: unlinkedImporterDir,
        reportUnresolved: reportPackageNotLinked,
        scaffoldSpecifier: "@genesiscz/utils/json2md/document-file",
        checkCommand: (modulePath) => toolCommand("json2md check", modulePath),
        forceBuildCommand: (modulePath) => toolCommand("json2md build", modulePath, "--force"),
    };
}
