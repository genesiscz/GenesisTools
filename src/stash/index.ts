#!/usr/bin/env bun
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { applyCommand } from "./commands/apply";
import { diffCommand } from "./commands/diff";
import { doctorCommand } from "./commands/doctor";
import { dropCommand } from "./commands/drop";
import { listCommand } from "./commands/list";
import { saveCommand } from "./commands/save";
import { showCommand } from "./commands/show";
import { unapplyCommand } from "./commands/unapply";
import { updateCommand } from "./commands/update";
import { versionsCommand } from "./commands/versions";
import { whereCommand } from "./commands/where";
import { parsePositiveInt, pickExclusive } from "./lib/options";
import type { SaveMode } from "./lib/patch";

const SAVE_MODES: SaveMode[] = ["staged", "unstaged", "all", "regions", "patch"];

function parseSaveMode(value: string): SaveMode {
    if ((SAVE_MODES as string[]).includes(value)) {
        return value as SaveMode;
    }
    throw new Error(`--mode must be one of: ${SAVE_MODES.join(" | ")} (got "${value}")`);
}

const program = new Command();
program.name("tools stash").description("Global cross-project code-overlay manager").version("0.1.0");

const saveCmd = program
    .command("save [name]")
    .description("Capture working-tree changes as a named stash")
    .option(
        "-m, --mode <mode>",
        "what to save: staged | unstaged | all | regions | patch (mutually exclusive)",
        parseSaveMode
    )
    .option(
        "--regions <names...>",
        "save only hunks overlapping with these author `// #region @stash:<name>` blocks (variadic)"
    )
    .option("-t, --tag <tag>", "add a tag (repeatable)", (val, prev: string[] = []) => [...prev, val], [])
    .option("-d, --desc <description>", "human-readable description")
    .option("--force-bump", "when <name> already exists, write v_next without prompting")
    .action(
        async (
            name: string | undefined,
            opts: { mode?: SaveMode; regions?: string[]; tag: string[]; desc?: string; forceBump?: boolean }
        ) => {
            // Bare `tools stash save` prints subcommand help instead of commander's default
            // "error: missing required argument" one-liner — easier on first contact, and tells the
            // user about the modes they didn't know existed.
            if (!name) {
                saveCmd.help();
                // saveCmd.help() exits, but commander's help() is typed `void` (not `never`),
                // so without this return TS can't narrow `name` to `string` for saveCommand below.
                return;
            }
            if (opts.mode === "regions" && (!opts.regions || opts.regions.length === 0)) {
                process.stderr.write("✗ --mode regions requires --regions <names> (one or more author marker names)\n");
                process.exit(2);
            }
            // Require explicit `--mode regions` alongside `--regions <names>`. The implicit
            // inference was rejected — explicitness wins: it forces callers to acknowledge
            // they're choosing region-filtered mode and not, say, expecting --mode all to
            // still apply.
            if (opts.regions && opts.mode !== "regions") {
                process.stderr.write(`✗ --regions requires --mode regions (got --mode ${opts.mode ?? "(none)"})\n`);
                process.exit(2);
            }
            await saveCommand({
                name,
                mode: opts.mode,
                regions: opts.regions,
                tags: opts.tag,
                description: opts.desc,
                forceBump: opts.forceBump,
            });
        }
    );

program
    .command("apply <name>")
    .description("Apply a stash into the current project")
    .option("--at <version>", "pin to specific version (default: latest)", parsePositiveInt)
    .option("--verbose-markers", "include source/applied metadata in markers")
    .option("--resume", "continue after manually resolving 3-way merge conflicts")
    .option("--abort", "reverse a conflict-failed apply and drop the session")
    .action(
        async (name: string, opts: { at?: number; verboseMarkers?: boolean; resume?: boolean; abort?: boolean }) => {
            const action = opts.abort ? "abort" : opts.resume ? "resume" : "start";
            await applyCommand({ name, version: opts.at, verboseMarkers: !!opts.verboseMarkers, action });
        }
    );

program
    .command("unapply <name>")
    .description("Surgically remove an applied stash with diff review")
    .option("--continue", "resume from last checkpoint")
    .option("--skip", "decide current region as 'skip'")
    .option("--abort", "abandon in-progress session, restore state")
    .option("--status", "show progress of in-progress session")
    .option(
        "--decision <d>",
        "decide current region: update | discard | skip | discard-all-dangerous | update-stash-all-dangerous"
    )
    .action(
        async (
            name: string,
            opts: { continue?: boolean; skip?: boolean; abort?: boolean; status?: boolean; decision?: string }
        ) => {
            const action = opts.abort
                ? "abort"
                : opts.status
                  ? "status"
                  : opts.skip
                    ? "skip"
                    : opts.continue
                      ? "continue"
                      : "start";
            await unapplyCommand({ name, action, decision: opts.decision as never });
        }
    );

program
    .command("list")
    .description("List stashes")
    .option("--project", "only stashes related to the current project")
    .option("--tag <tag>", "filter by tag")
    .option("--applied", "only stashes currently applied to this project")
    .action(async (opts: { project?: boolean; tag?: string; applied?: boolean }) => {
        await listCommand({ project: !!opts.project, tag: opts.tag, applied: !!opts.applied });
    });

program
    .command("show [name]")
    .description("Show stash details (or, with no <name>, behave like `tools stash list`)")
    .option("--at <version>", "specific version", parsePositiveInt)
    .option("--diff", "show patch content")
    .option("--meta", "show only metadata")
    .option("--regions", "show region inventory")
    .action(
        async (name: string | undefined, opts: { at?: number; diff?: boolean; meta?: boolean; regions?: boolean }) => {
            // Bare `tools stash show` (no name) dispatches to listCommand for parity with how
            // users naturally reach for `show` when they actually meant `list`.
            if (!name) {
                await listCommand({ project: false, tag: undefined, applied: false });
                return;
            }
            // pickExclusive throws InvalidArgumentError on `--diff --meta` (etc.) — catch it so
            // the user sees a clean ✗ message, not a bun stack trace.
            let picked: string | undefined;
            try {
                picked = pickExclusive(opts, ["diff", "meta", "regions"]);
            } catch (err) {
                process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
                process.exit(2);
            }
            const mode: "diff" | "meta" | "regions" = (picked as "diff" | "meta" | "regions" | undefined) ?? "regions";
            await showCommand({ name, version: opts.at, mode });
        }
    );

program
    .command("update <name>")
    .description("Capture current code as a new version of an applied stash via per-region decision walk")
    .option("--continue", "resume from last checkpoint")
    .option("--skip", "decide current region as 'skip'")
    .option("--abort", "abandon in-progress session")
    .option("--status", "show progress of in-progress session")
    .option(
        "--decision <d>",
        "decide current region: capture | restore | skip | capture-all-dangerous | restore-all-dangerous"
    )
    .action(
        async (
            name: string,
            opts: { continue?: boolean; skip?: boolean; abort?: boolean; status?: boolean; decision?: string }
        ) => {
            const action = opts.abort
                ? "abort"
                : opts.status
                  ? "status"
                  : opts.skip
                    ? "skip"
                    : opts.continue
                      ? "continue"
                      : "start";
            await updateCommand({ name, action, decision: opts.decision });
        }
    );

program
    .command("versions <name>")
    .description("List versions of a stash")
    .action(async (name: string) => {
        await versionsCommand(name);
    });

program
    .command("drop <name>")
    .description("Delete a stash version")
    .option("--at <version>", "specific version", parsePositiveInt)
    .option("--all-versions", "delete all versions")
    .option("--orphan-active", "drop even with active applications")
    .action(async (name: string, opts: { at?: number; allVersions?: boolean; orphanActive?: boolean }) => {
        await dropCommand({
            name,
            version: opts.at,
            allVersions: !!opts.allVersions,
            orphanActive: !!opts.orphanActive,
        });
    });

program
    .command("diff <name>")
    .description("Show per-region diff between stored stash content and current applied code")
    .option("--at <version>", "pin to specific version (default: applied version)", parsePositiveInt)
    .action(async (name: string, opts: { at?: number }) => {
        await diffCommand({ name, at: opts.at });
    });

program
    .command("where <name>")
    .description("Show projects where this stash is currently applied")
    .action(async (name: string) => {
        await whereCommand(name);
    });

program
    .command("doctor")
    .description("Verify store + sqlite consistency; --rebuild regenerates regions table")
    .option("--rebuild", "regenerate the regions table from stored patches")
    .action(async (opts: { rebuild?: boolean }) => {
        await doctorCommand({ rebuild: !!opts.rebuild });
    });

await runTool(program, { tool: "stash" });
