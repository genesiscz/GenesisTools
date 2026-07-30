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
export function isWorktreeCheckout(cwd: string = process.cwd()): boolean {
    return cwd.includes("/.worktrees/") || cwd.includes("/.claude/worktrees/");
}

/**
 * The write-side twin of `migrationAllowedHere`. Any code about to persist the
 * new config shape asks this, so a bug in one migration's own gate cannot reach
 * the user's real file.
 */
export function assertSafeToWriteRealConfig(): void {
    if (env.tools.hasExplicitHome() || env.tools.allowsRealMigration()) {
        return;
    }

    if (!isWorktreeCheckout()) {
        return;
    }

    throw new Error(
        "Refusing to write the v4 AI config from a worktree build into the real ~/.genesis-tools: " +
            "the installed tools still read v3 and would break. Set GENESIS_TOOLS_HOME to a sandbox, " +
            "or GENESIS_TOOLS_ALLOW_REAL_MIGRATION=1 if this is the deliberate post-merge run."
    );
}

export function migrationAllowedHere(): boolean {
    // env.tools.getHome() falls back to homedir(), so it is NEVER falsy — using it
    // here made this guard a no-op and let worktree runs migrate the real config
    // anyway. hasExplicitHome() asks the actual question.
    if (env.tools.hasExplicitHome()) {
        // A sandboxed root (tests, rehearsals) is always safe to migrate.
        return true;
    }

    if (env.tools.allowsRealMigration()) {
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
