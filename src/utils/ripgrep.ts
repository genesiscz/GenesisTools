import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";

/**
 * Where `rg` is. GitHub's hosted runners ship no ripgrep (actions/runner-images
 * #12179, closed NOT_PLANNED), so CI installs one onto PATH with
 * taiki-e/install-action and that copy wins. When nothing is on PATH, the
 * fallback is the binary `@anthropic-ai/claude-code` vendors for every
 * platform this repo runs on; it is a direct dependency, so `bun install`
 * puts it there. Fallback only: a layout inside someone else's package is
 * not something to lean on first.
 */
export function ripgrepBinary(): string | null {
    const onPath = Bun.which("rg");
    if (onPath) {
        return onPath;
    }

    return vendoredRipgrep();
}

export function vendoredRipgrep(root = findProjectRoot(import.meta.dir)): string | null {
    if (!root) {
        return null;
    }

    const name = process.platform === "win32" ? "rg.exe" : "rg";
    const candidate = join(
        root,
        "node_modules/@anthropic-ai/claude-code/vendor/ripgrep",
        `${process.arch}-${process.platform}`,
        name
    );

    return existsSync(candidate) ? candidate : null;
}
