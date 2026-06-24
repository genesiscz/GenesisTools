#!/usr/bin/env bun
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { applyCommand } from "./commands/apply";
import { dropCommand } from "./commands/drop";
import { listCommand } from "./commands/list";
import { saveCommand } from "./commands/save";
import { showCommand } from "./commands/show";
import { unapplyCommand } from "./commands/unapply";
import { updateCommand } from "./commands/update";
import { versionsCommand } from "./commands/versions";
import { whereCommand } from "./commands/where";

const program = new Command();
program.name("tools stash").description("Global cross-project code-overlay manager").version("0.1.0");

program
    .command("save <name>")
    .description("Capture working-tree changes as a named stash")
    .option("--staged", "save staged changes only")
    .option("--unstaged", "save unstaged tracked changes only")
    .option("--all", "save staged + unstaged + untracked")
    .option("-t, --tag <tag>", "add a tag (repeatable)", (val, prev: string[] = []) => [...prev, val], [])
    .option("-d, --desc <description>", "human-readable description")
    .action(
        async (
            name: string,
            opts: { staged?: boolean; unstaged?: boolean; all?: boolean; tag: string[]; desc?: string }
        ) => {
            const mode = opts.staged ? "staged" : opts.unstaged ? "unstaged" : opts.all ? "all" : undefined;
            await saveCommand({ name, mode, tags: opts.tag, description: opts.desc });
        }
    );

program
    .command("apply <name>")
    .description("Apply a stash into the current project")
    .option("--at <version>", "pin to specific version (default: latest)", (v) => Number(v))
    .option("--verbose-markers", "include source/applied metadata in markers")
    .action(async (name: string, opts: { at?: number; verboseMarkers?: boolean }) => {
        await applyCommand({ name, version: opts.at, verboseMarkers: !!opts.verboseMarkers });
    });

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
    .command("show <name>")
    .description("Show stash details")
    .option("--at <version>", "specific version", (v) => Number(v))
    .option("--diff", "show patch content")
    .option("--meta", "show only metadata")
    .option("--regions", "show region inventory")
    .action(async (name: string, opts: { at?: number; diff?: boolean; meta?: boolean; regions?: boolean }) => {
        const mode: "diff" | "meta" | "regions" = opts.diff ? "diff" : opts.meta ? "meta" : "regions";
        await showCommand({ name, version: opts.at, mode });
    });

program
    .command("update <name>")
    .description("Capture the current working tree as a new version of a currently-applied stash")
    .option("--staged", "save staged only")
    .option("--unstaged", "save unstaged only")
    .option("--all", "save everything (default)")
    .action(async (name: string, opts: { staged?: boolean; unstaged?: boolean; all?: boolean }) => {
        const mode = opts.staged ? "staged" : opts.unstaged ? "unstaged" : "all";
        await updateCommand({ name, mode });
    });

program
    .command("versions <name>")
    .description("List versions of a stash")
    .action(async (name: string) => {
        await versionsCommand(name);
    });

program
    .command("drop <name>")
    .description("Delete a stash version")
    .option("--at <version>", "specific version", (v) => Number(v))
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
    .command("where <name>")
    .description("Show projects where this stash is currently applied")
    .action(async (name: string) => {
        await whereCommand(name);
    });

await runTool(program, { tool: "stash" });
