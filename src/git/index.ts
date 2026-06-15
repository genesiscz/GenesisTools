#!/usr/bin/env bun

/**
 * Git Analysis CLI Tool
 *
 * Usage:
 *   tools git commits --from <date> --to <date> [options]
 *   tools git configure-authors [--add|--remove|--list]
 *   tools git configure-workitem-patterns [--list|--add|--remove|--suggest]
 */

import { registerBranchGcCommand } from "@app/git/commands/branch-gc";
import { registerCommitsCommand } from "@app/git/commands/commits";
import { registerConfigureAuthorsCommand } from "@app/git/commands/configure-authors";
import { registerConfigureWorkitemPatternsCommand } from "@app/git/commands/configure-workitem-patterns";
import { registerMonsterCommand } from "@app/git/commands/monster";
import { logger, out } from "@app/logger";
import { enhanceHelp, runTool } from "@app/utils/cli";
import { Storage } from "@app/utils/storage";
import { Command } from "commander";

const storage = new Storage("git");

const program = new Command();

program
    .name("git")
    .description("Git analysis tool — commits, authors, workitem patterns, and branch cleanup")
    .version("1.0.0")
    .option("-v, --verbose", "Enable verbose debug logging")
    .option("-?, --help-full", "Show detailed help with examples")
    .on("option:help-full", () => {
        showHelpFull();
        process.exit(0);
    });

// Register all commands
registerCommitsCommand(program, storage);
registerConfigureAuthorsCommand(program, storage);
registerConfigureWorkitemPatternsCommand(program, storage);
registerMonsterCommand(program, storage);
registerBranchGcCommand(program, storage);
enhanceHelp(program);

function showHelpFull(): void {
    out.println(`
Git Analysis Tool

Usage:
  tools git <command> [options]

Commands:
  commits                      Query commits by date range with workitem extraction
  configure-authors            Manage author identities for commit filtering
  configure-workitem-patterns  Manage regex patterns for workitem ID extraction
  monster                      Repo health as a feedable ASCII monster (scariest file leaderboard)
  branch-gc                    Clean up stale & merged local branches (squash-aware)

Commits Options:
  --from <YYYY-MM-DD>          Start date (required)
  --to <YYYY-MM-DD>            End date (required)
  --author <name>              Override: search only this author (repeatable)
  --with-author <name>         Append to configured authors (repeatable)
  --format <json|table>        Output format (default: table)
  --stat                       Include line change stats

Configure-Authors Options:
  --add <name>                 Add author(s) (repeatable)
  --remove <name>              Remove an author
  --list                       List configured authors
  (no flags)                   Interactive multiselect from git history

Configure-Workitem-Patterns Options:
  --list                       List current patterns
  --add '<regex>'              Add a new regex pattern
  --remove <index>             Remove pattern by index
  --suggest                    Suggest patterns from repo history
  --repo <path>                Repository path for suggest (default: cwd)
  (no flags)                   Interactive management

Branch-GC Options:
  -b, --base <branch>          Branch to measure 'merged into' against (auto-detect master/main)
  -d, --stale-days <n>         Stale threshold in days (default: 90)
  --no-dry-run                 Opt into interactive deletion in a TTY (default: list only)
  --yes                        Non-interactive: delete every merged + squash-merged + gone branch
  --json                       Emit the classification array as JSON (implies no deletion)
  -C, --cwd <path>             Run against the git repo at this path

Examples:
  # Query commits for a date range
  tools git commits --from 2026-02-01 --to 2026-02-08

  # With stats and specific author
  tools git commits --from 2026-02-01 --to 2026-02-08 --stat --author "Your Name"

  # JSON output for piping
  tools git commits --from 2026-02-01 --to 2026-02-08 --format json

  # Configure authors interactively
  tools git configure-authors

  # Quick add/remove authors
  tools git configure-authors --add "Your Name" --add "username"
  tools git configure-authors --remove "old-name"

  # Suggest workitem patterns from a repo
  tools git configure-workitem-patterns --suggest --repo /path/to/repo

  # Add a custom pattern
  tools git configure-workitem-patterns --add 'col-(\\d+)'

  # Show the repo's scariest files as an ASCII monster
  tools git monster src --top 10

  # List stale & merged local branches (no deletion)
  tools git branch-gc

  # Delete all merged + squash-merged + gone branches non-interactively
  tools git branch-gc --yes

Storage:
  Config: ~/.genesis-tools/git/config.json
`);
}

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "git" });
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
