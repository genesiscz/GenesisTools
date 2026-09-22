#!/usr/bin/env bun

/**
 * `tools link` — make `@genesiscz/utils` resolvable outside this checkout.
 *
 * A TypeScript file the user writes — a generated document module, a resolver script, a
 * codemod, a config that is code rather than data — cannot import `@genesiscz/utils` when it
 * lives anywhere but inside this repo. Bun resolves a bare specifier from the IMPORTING
 * file's folder, so no tool can fix it at call time.
 *
 * Resolution walks UP from that file looking for `node_modules/<package>`, so one symlink at
 * an ancestor directory answers for everything beneath it, under plain `bun file.ts` exactly
 * as under a tool. This installs that one symlink.
 *
 *   tools link status              is it installed, and does the import actually resolve
 *   tools link install             link under the home directory
 *   tools link install --root DIR  link under a narrower root
 *   tools link uninstall           remove it
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { runTool } from "@genesiscz/utils/cli";
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

/**
 * Absolute, always.
 *
 * This is a setup tool: every path it prints names a place the user may have to go and look
 * at. A cwd-relative form rendered the home directory as `../../..` when run from inside the
 * repo, which is shorter and tells the reader nothing.
 */
function short(path: string): string {
    return path;
}

program
    .command("status", { isDefault: true })
    .description("Show whether the link is installed and whether the import resolves")
    .option("--root <dir>", "root to report on, repeatable order: this one, then the home directory")
    .action((flags: { root?: string }) => {
        const roots = flags.root ? [absolute(flags.root)] : [homedir(), process.cwd()];

        renderCliHeader("package link", `${PACKAGE_NAME} → ${short(utilsPackageDir())}`);

        const table = createBoxTable(["ROOT", "LINK", "RESOLVES", "POINTS AT"]);

        for (const root of roots) {
            const status = linkStatusFor(root);
            const link = status.occupied
                ? formatDotStatus("err", "occupied")
                : status.pointsAt === null
                  ? formatDotStatus("dim", "absent")
                  : status.dangling
                    ? formatDotStatus("warn", "dangling")
                    : status.current
                      ? formatDotStatus("ok", "current")
                      : formatDotStatus("warn", "other checkout");

            table.push([
                // The root is always absolute here. `short()` would render the home directory
                // as `../../..` from inside the repo, which names nothing a reader can act on.
                pc.white(root),
                link,
                // ⚠️ These two are independent on purpose. A repo with its own node_modules
                // resolves with no link at all, and a link can exist while something nearer
                // shadows it. Reporting only one of them would be true and useless.
                status.resolves ? formatDotStatus("ok", "yes") : formatDotStatus("err", "no"),
                status.pointsAt === null ? pc.dim("—") : pc.dim(short(status.pointsAt)),
            ]);
        }

        out.println(table.toString());
        renderCliSection("Columns");
        out.println(`  ${pc.dim("LINK")}      whether this root has the node_modules symlink`);
        out.println(`  ${pc.dim("RESOLVES")}  whether a bare import actually works from that root`);
        out.println("");
        out.println(`  ${pc.dim("Install with")}  tools link install`);
    });

program
    .command("install")
    .description("Create the node_modules symlink so files under the root can import the package")
    .option("--root <dir>", "directory to link under; everything beneath it resolves", homedir())
    .option("--force", "replace a symlink that points at a different checkout")
    .action((flags: { root: string; force?: boolean }) => {
        const root = absolute(flags.root);
        const result = linkUtilsPackage({ root, force: flags.force === true });

        logger.debug({ root, outcome: result.outcome, target: result.target }, "link: install");

        if (result.outcome === "occupied") {
            out.log.error(`${short(result.linkPath)} exists and is not a symlink. Leaving it alone.`);
            process.exitCode = 1;

            return;
        }

        if (result.outcome === "points-elsewhere") {
            out.log.error(`${short(result.linkPath)} points at ${short(result.existing ?? "?")}.`);
            out.log.info("That belongs to another checkout. Re-run with --force to repoint it.");
            process.exitCode = 1;

            return;
        }

        const verb =
            result.outcome === "created"
                ? "Linked"
                : result.outcome === "repaired"
                  ? "Repaired a dangling link:"
                  : "Already linked";

        out.log.success(`${verb} ${short(result.linkPath)} → ${short(result.target)}`);

        // Creating a file proves nothing; resolving through it does.
        if (result.resolves) {
            out.log.info(`Files under ${short(root)} can now import ${PACKAGE_NAME} directly.`);
        } else {
            out.log.error("The link exists but the package still does not resolve from there.");
            process.exitCode = 1;
        }
    });

program
    .command("uninstall")
    .description("Remove the symlink")
    .option("--root <dir>", "directory it was linked under", homedir())
    .option("--force", "remove even when it points at a different checkout")
    .action((flags: { root: string; force?: boolean }) => {
        const root = absolute(flags.root);
        const result = unlinkUtilsPackage({ root, force: flags.force === true });

        if (result.outcome === "occupied") {
            out.log.error(`${short(result.linkPath)} is a real directory, not our symlink. Leaving it alone.`);
            process.exitCode = 1;

            return;
        }

        if (result.outcome === "points-elsewhere") {
            out.log.error(`${short(result.linkPath)} points at ${short(result.existing ?? "?")}, another checkout.`);
            out.log.info("Re-run with --force if you are sure.");
            process.exitCode = 1;

            return;
        }

        if (result.outcome === "absent") {
            out.log.info(`Nothing to remove at ${short(result.linkPath)}.`);

            return;
        }

        out.log.success(`Removed ${short(result.linkPath)}.`);
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
