import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

export type NativeSessionProvider = "claude" | "grok" | "codex";

/**
 * On-disk CLI session stores. Claude: `~/.claude/projects`. Grok:
 * `~/.grok/sessions`. Codex: `~/.codex/sessions` plus `archived_sessions`.
 * `CLAUDE_CONFIG_DIR`, `GROK_HOME`, and `CODEX_HOME` (comma list) override.
 */
export function nativeSessionRoots(kind: NativeSessionProvider, home = homedir()): string[] {
    if (kind === "claude") {
        const roots = [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
        const configDir = env.paths.getClaudeConfigDir();
        if (configDir) {
            const extra = join(configDir, "projects");
            if (!roots.includes(extra)) {
                roots.push(extra);
            }
        }
        return roots;
    }

    if (kind === "codex") {
        const override = env.codex.getHomeOverride();
        const homes = override
            ? override
                  .split(",")
                  .map((path) => path.trim())
                  .filter((path) => path.length > 0)
            : [];
        const bases = homes.length > 0 ? homes : [join(home, ".codex")];
        const roots: string[] = [];
        for (const base of bases) {
            for (const dir of [join(base, "sessions"), join(base, "archived_sessions")]) {
                if (!roots.includes(dir)) {
                    roots.push(dir);
                }
            }
        }
        return roots;
    }

    const grokHome = env.grok.getHomeOverride() ?? join(home, ".grok");
    return [join(grokHome, "sessions")];
}

export function isNativeTranscript(kind: NativeSessionProvider, fileName: string): boolean {
    if (kind === "grok") {
        return fileName === "updates.jsonl";
    }
    return fileName.endsWith(".jsonl");
}

export function nativeTranscriptMaxDepth(kind: NativeSessionProvider): number {
    if (kind === "claude") {
        return 6;
    }
    if (kind === "grok") {
        return 3;
    }
    return 4;
}
