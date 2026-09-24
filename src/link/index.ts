#!/usr/bin/env bun

/**
 * `tools link` — make `@genesiscz/utils` resolvable outside this checkout.
 *
 * A TypeScript file the user writes — a generated document module, a resolver script, a
 * codemod, a config that is code rather than data — cannot import `@genesiscz/utils` when it
 * lives anywhere but inside this repo. Bun resolves a bare specifier from the IMPORTING
 * file's folder, so no tool can fix it at call time.
 *
 * One `tsconfig.json` with a `paths` mapping at an ancestor directory answers for every file
 * beneath it, under plain `bun file.ts` exactly as under a tool. This writes that one file.
 *
 *   tools link status              is it installed, and does the import actually resolve
 *   tools link install             map it under the home directory
 *   tools link install --root DIR  map it under a narrower root
 *   tools link uninstall           remove the mapping
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { runTool, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import {
    linkStatusFor,
    linkUtilsPackage,
    PACKAGE_NAME,
    unlinkUtilsPackage,
    utilsPackageDir,
} from "@genesiscz/utils/package-link";
import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";

const program = new Command();

program.name("link").description(`Make ${PACKAGE_NAME} resolvable for TypeScript files outside this checkout`);

function absolute(path: string): string {
    return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

program
    .command("status", { isDefault: true })
    .description("Show whether the mapping is installed and whether the import resolves")
    .option("--root <dir>", "root to report on; defaults to the home directory and the current one")
    .action((flags: { root?: string }) => {
        const roots = flags.root ? [absolute(flags.root)] : [homedir(), process.cwd()];

        renderCliHeader("package link", `${PACKAGE_NAME} → ${utilsPackageDir()}`);

        const table = createBoxTable(["ROOT", "MAPPING", "RESOLVES", "POINTS AT"]);

        for (const root of roots) {
            const status = linkStatusFor(root);
            const mapping = status.occupied
                ? formatDotStatus("err", "unreadable")
                : status.pointsAt === null
                  ? formatDotStatus("dim", "absent")
                  : status.dangling
                    ? formatDotStatus("warn", "dangling")
                    : status.current
                      ? formatDotStatus("ok", "current")
                      : formatDotStatus("warn", "other checkout");

            table.push([
                // Always absolute. A cwd-relative form rendered the home directory as
                // `../../..` when run from inside the repo, which names nothing actionable.
                pc.white(root),
                mapping,
                // ⚠️ These two are independent on purpose. A repo with its own node_modules
                // resolves with no mapping at all, and a mapping can exist while a nearer
                // tsconfig shadows it. Reporting only one of them would be true and useless.
                status.resolves ? formatDotStatus("ok", "yes") : formatDotStatus("err", "no"),
                status.pointsAt === null ? pc.dim("—") : pc.dim(status.pointsAt),
            ]);
        }

        out.println(table.toString());

        // 🛑 The one way this mechanism fails, and it is otherwise silent: Bun reads only the
        // NEAREST tsconfig, so a project carrying its own hides an ancestor mapping entirely.
        // Without naming the file, it looks like a broken install rather than a shadowed one.
        for (const root of roots) {
            const status = linkStatusFor(root);

            if (status.shadowedBy === null) {
                continue;
            }

            out.log.warn(`${status.shadowedBy} is nearer, and carries no mapping of ours.`);
            out.log.info("Bun reads only the nearest tsconfig, so that file hides the one above it.");
            out.log.info(
                suggestCommand("tools link", {
                    replaceCommand: ["install", "--root", dirname(status.shadowedBy)],
                })
            );
        }

        renderCliSection("Columns");
        out.println(`  ${pc.dim("MAPPING")}   whether this root's tsconfig.json maps the package`);
        out.println(`  ${pc.dim("RESOLVES")}  whether a bare import actually works from that root`);
        out.println("");
        out.println(`  ${pc.dim("Install with")}  tools link install`);
    });

program
    .command("install")
    .description("Write the tsconfig paths mapping so files under the root can import the package")
    .option("--root <dir>", "directory to map under; everything beneath it resolves", homedir())
    .option("--force", "replace a mapping that points at a different checkout")
    .action((flags: { root: string; force?: boolean }) => {
        const root = absolute(flags.root);
        const result = linkUtilsPackage({ root, force: flags.force === true });

        logger.debug({ root, outcome: result.outcome, target: result.target }, "link: install");

        if (result.outcome === "occupied") {
            out.log.error(`${result.configPath} is not a JSON object (${result.existing}). Leaving it alone.`);
            process.exitCode = 1;

            return;
        }

        if (result.outcome === "points-elsewhere") {
            out.log.error(`${result.configPath} maps the package to ${result.existing ?? "?"}.`);
            out.log.info("That belongs to another checkout. Re-run with --force to repoint it.");
            process.exitCode = 1;

            return;
        }

        if (result.outcome === "inherits-paths") {
            out.log.error(`${result.configPath} extends another config and gets its \`paths\` from there.`);
            out.log.info(
                "A `paths` written here would replace the inherited map and break those aliases. Add the mapping to the config that defines `paths`, or copy its `paths` into this file first and re-run."
            );
            process.exitCode = 1;

            return;
        }

        const verb =
            result.outcome === "created"
                ? "Wrote"
                : result.outcome === "merged"
                  ? "Added the mapping to"
                  : result.outcome === "repaired"
                    ? "Repaired a stale mapping in"
                    : "Already mapped in";

        out.log.success(`${verb} ${result.configPath} → ${result.target}`);

        // Writing a file proves nothing; resolving through it does.
        if (result.resolves) {
            out.log.info(`Files under ${root} with no tsconfig of their own can now import ${PACKAGE_NAME}.`);
        } else {
            out.log.error("The mapping exists but its target is not a valid package directory.");
            process.exitCode = 1;
        }
    });

program
    .command("uninstall")
    .description("Remove the mapping")
    .option("--root <dir>", "directory it was mapped under", homedir())
    .option("--force", "remove even when it points at a different checkout")
    .action((flags: { root: string; force?: boolean }) => {
        const root = absolute(flags.root);
        const result = unlinkUtilsPackage({ root, force: flags.force === true });

        if (result.legacyRemoved) {
            // Worth its own line: an empty node_modules left behind disables Bun's
            // auto-install for every file under this root.
            out.log.success("Removed the node_modules symlink from the earlier mechanism, and its empty folders.");
        }

        if (result.outcome === "occupied") {
            out.log.error(`${result.configPath} is not a JSON object (${result.existing}). Leaving it alone.`);
            process.exitCode = 1;

            return;
        }

        if (result.outcome === "points-elsewhere") {
            out.log.error(`${result.configPath} maps the package to ${result.existing ?? "?"}, another checkout.`);
            out.log.info("Re-run with --force if you are sure.");
            process.exitCode = 1;

            return;
        }

        if (result.outcome === "absent") {
            out.log.info(`Nothing of ours to remove at ${result.configPath}.`);

            return;
        }

        out.log.success(
            result.configRemoved
                ? `Removed ${result.configPath}; it held nothing else.`
                : `Removed the mapping from ${result.configPath}; its other settings are untouched.`
        );
    });

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "link" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error: ${message}`);

        if (error instanceof Error && error.stack) {
            logger.debug(error.stack);
        }

        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
