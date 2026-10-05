#!/usr/bin/env bun

/**
 * Git CLI Tool
 *
 * Usage:
 *   tools git commits --from <date> --to <date> [options]
 *   tools git merged [refs...] [--all] [--prune <ref>]
 *   tools git rebase-cascade <parent>
 *   tools git rebranch [--dry-run]
 *   tools git rename-commits [--commits N]
 *   tools git config show|init|check
 *   tools git base [branch]
 *   tools git changes [--commits N]
 */

import { registerBaseCommand } from "@app/git/commands/base";
import { registerChangesCommand } from "@app/git/commands/changes";
import { registerCommitsCommand } from "@app/git/commands/commits";
import { registerConfigCommand } from "@app/git/commands/config";
import { registerConfigureAuthorsCommand } from "@app/git/commands/configure-authors";
import { registerConfigureWorkitemPatternsCommand } from "@app/git/commands/configure-workitem-patterns";
import { registerHealthCommand } from "@app/git/commands/health";
import { registerMergedCommand } from "@app/git/commands/merged";
import { registerMonsterCommand } from "@app/git/commands/monster";
import { registerRebaseCascadeCommand } from "@app/git/commands/rebase-cascade";
import { registerRebranchCommand } from "@app/git/commands/rebranch";
import { registerRenameCommitsCommand } from "@app/git/commands/rename-commits";
import { registerWorktreeCommand } from "@app/git/commands/worktree";
import { enhanceHelp, runTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { Command } from "commander";

const storage = new Storage("git");

const program = new Command();

program
    .name("git")
    .description("Git analysis and branch mechanics — commits, merged verdicts, cascade rebases, repo config")
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
registerHealthCommand(program, storage);
registerMergedCommand(program, storage);
registerRebaseCascadeCommand(program, storage);
registerRebranchCommand(program);
registerRenameCommitsCommand(program);
registerConfigCommand(program, storage);
registerBaseCommand(program, storage);
registerChangesCommand(program, storage);
registerWorktreeCommand(program, storage);
enhanceHelp(program);

function showHelpFull(): void {
    out.println(`
Git Tool

Usage:
  ${toolCommand("git")} <command> [options]

Commands:
  commits                      Query commits by date range with workitem extraction
  configure-authors            Manage author identities for commit filtering
  configure-workitem-patterns  Manage regex patterns for workitem ID extraction
  monster                      Repo health as a feedable ASCII monster (scariest file leaderboard)
  health                       Repo health as a clean report (ranked file leaderboard table)
  merged                       Is a branch or worktree already in the base? Verdict by content, not sha
  rebase-cascade               Rebase a parent and the child branches stacked on it, with backups
  rebranch                     Split a messy branch into clean branches by grouping its commits (interactive)
  rename-commits               Reword the last N commit messages one by one, with a confirmation (interactive)
  config                       Per-repo genesis-tools.config.json: show | init | check
  base                         Which branch is this one based on, and which rule decided
  changes                      Uncommitted changes (or the last N commits) grouped by file modification time

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

Merged Options:
  [refs...]                    Branch names or worktree paths to judge
  --all                        Every local branch except the base, plus detached worktrees
  -b, --base <ref>             Base to judge against (default: config mainPrBranch, else origin HEAD)
  --pr                         Corroborate with each branch's PR/MR (network)
  --json                       Full report as JSON (never deletes)
  --prune <ref>                Remove this ref (repeatable); only named refs, each re-verified
  --remote                     With --prune: also delete origin/<branch> when safe
  --yes                        With --prune: skip the confirmation
  -d, --stale-days <n>         Stale flag threshold in days (default: 90)
  -C, --cwd <path>             Run against the git repo at this path

Rebase-Cascade Options:
  <parent>                     Parent branch to rebase; children are detected by merge-base
  --onto <target>              Target (default: the parent's PR target, else config mainPrBranch)
  --child <branch>             Explicit child list (repeatable) instead of detection
  --dry-run                    Print the plan, move nothing
  --yes                        Skip the single confirmation
  --continue | --status | --abort | --restore <branch> | --cleanup

Changes Options:
  -c, --commits <n>            Show the files of the last N commits instead of uncommitted changes
  -C, --cwd <path>             Run against the git repo at this path

Examples:
  # Query commits for a date range
  ${toolCommand("git commits")} --from 2026-02-01 --to 2026-02-08

  # With stats and specific author
  ${toolCommand("git commits")} --from 2026-02-01 --to 2026-02-08 --stat --author "Your Name"

  # Is feat/x already in master? Which of my branches are done?
  ${toolCommand("git merged")} feat/x
  ${toolCommand("git merged")} --all

  # Remove two refs a plain run listed as MERGED
  ${toolCommand("git merged")} --prune feat/x --prune .worktrees/feat-y

  # Rebase feat/parent onto master and transplant its children
  ${toolCommand("git rebase-cascade")} feat/parent --dry-run
  ${toolCommand("git rebase-cascade")} feat/parent

  # Repo config and base detection
  ${toolCommand("git config show")}
  ${toolCommand("git config init")}
  ${toolCommand("git base")} feat/x

  # What did I touch, and when?
  ${toolCommand("git changes")}
  ${toolCommand("git changes")} --commits 5

  # Show the repo's scariest files as an ASCII monster
  ${toolCommand("git monster")} src --top 10

Storage:
  Config: ~/.genesis-tools/git/config.json
  Repo:   .claude/genesis-tools.config.json or <git-common-dir>/genesis-tools.config.json
`);
}

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "git" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(message);

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
