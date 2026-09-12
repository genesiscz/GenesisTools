/**
 * Where `rg` is, or null when it is not installed.
 *
 * This used to fall back to the copy `@anthropic-ai/claude-code` vendored for every platform, and
 * that fallback was the ONLY reason the package was a dependency of this repo. It stopped shipping
 * one at 2.1.113, where the package became a 132 KB wrapper with a postinstall downloader, so the
 * fallback was frozen at 2.1.112 and roughly 75 MB of node_modules bought a single binary. It also
 * put a stale `claude` first on PATH under `bun run`, which `src/claude/lib/worker/worker.ts` and
 * the teammate resolver each had to work around.
 *
 * CI installs ripgrep explicitly (`.github/workflows/ci.yml`, taiki-e/install-action), because the
 * hosted images ship none (actions/runner-images#12179, closed NOT_PLANNED). If this returns null
 * on a developer machine: `brew install ripgrep`.
 */
export function ripgrepBinary(): string | null {
    return Bun.which("rg");
}
