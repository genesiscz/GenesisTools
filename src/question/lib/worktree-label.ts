/**
 * The worktree directory name, which is what tells two checkouts of one repo
 * apart when the branch names look alike.
 *
 * Dependency-free on purpose: the CLI renderer and the dev-dashboard browser
 * bundle both use it, so it must not reach for `node:path`.
 */
export function worktreeLabel(entry: { isWorktree: boolean; worktreePath: string | null }): string | null {
    if (!entry.isWorktree || !entry.worktreePath) {
        return null;
    }

    const segments = entry.worktreePath.split(/[/\\]/).filter((s) => s.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : null;
}
