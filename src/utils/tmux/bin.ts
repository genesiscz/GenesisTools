import { existsSync } from "node:fs";
import { join } from "node:path";

const TMUX_SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

let cachedTmuxPath: string | null = null;
let testOverridePath: string | null = null;

export function setTmuxBinForTests(path: string | null): void {
    testOverridePath = path;
    cachedTmuxPath = path;
}

export function resolveTmuxBin(): string {
    if (testOverridePath) {
        return testOverridePath;
    }

    if (cachedTmuxPath) {
        return cachedTmuxPath;
    }

    const fromPath = Bun.which("tmux");
    if (fromPath) {
        cachedTmuxPath = fromPath;
        return fromPath;
    }

    for (const dir of TMUX_SYSTEM_DIRS) {
        const candidate = join(dir, "tmux");
        if (existsSync(candidate)) {
            cachedTmuxPath = candidate;
            return candidate;
        }
    }

    throw new Error("tmux not found (checked PATH and /opt/homebrew/bin, /usr/local/bin, /usr/bin)");
}

export function resetTmuxBinCache(): void {
    cachedTmuxPath = testOverridePath;
}
