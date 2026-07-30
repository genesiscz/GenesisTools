import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

/**
 * Refuse to migrate the user's REAL config from a development checkout.
 *
 * `tools` on PATH runs the main repo, which still speaks v3. If a worktree build
 * migrates the shared `~/.genesis-tools/ai/config.json` to v4, every main-repo
 * invocation suddenly reads a config it does not understand. That happened on
 * 2026-07-29 from a single `bun run tools ai --help` in the worktree, leaving a
 * hybrid config behind.
 *
 * The migration is therefore gated: it runs against a sandboxed root freely, and
 * against the real home only when this build is the installed one, or the user
 * opts in explicitly.
 */
export function migrationAllowedHere(): boolean {
    if (env.tools.getHome()) {
        // A sandboxed root (tests, rehearsals) is always safe to migrate.
        return true;
    }

    if (process.env.GENESIS_TOOLS_ALLOW_REAL_MIGRATION === "1") {
        return true;
    }

    const cwd = process.cwd();
    if (!cwd.includes("/.worktrees/") && !cwd.includes("/.claude/worktrees/")) {
        return true;
    }

    logger.warn(
        { cwd },
        "skipping AI config migration: this is a worktree build and the real config is shared with the installed tools. Set GENESIS_TOOLS_ALLOW_REAL_MIGRATION=1 to override."
    );
    return false;
}
