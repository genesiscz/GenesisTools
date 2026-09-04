import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { defaultWorkerHome } from "@genesiscz/utils/grok/worker-paths";

export type NativeSessionProvider = "claude" | "grok" | "codex";

/**
 * On-disk CLI session stores. Claude: `~/.claude/projects`. Grok:
 * `~/.grok/sessions`. Codex: `~/.codex/sessions` plus `archived_sessions`.
 * `CLAUDE_CONFIG_DIR`, `GROK_HOME`, and `CODEX_HOME` (comma list) override.
 *
 * Grok also gets the headless worker home. `tools grok run` pins GROK_HOME to an
 * isolated directory — a security control, because a shared home hands the
 * worker the user's personal rules, skills and hooks (src/grok/lib/worker.ts,
 * asserted by worker.isolation.test.ts). That home is never exported to the
 * user's shell, so without listing it here a worker's sessions are invisible to
 * every reader, which is the wrong trade: isolate what the worker READS, not
 * what we can find afterwards.
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
    const roots = [join(grokHome, "sessions")];
    const workerRoot = join(defaultWorkerHome(), "sessions");

    if (!roots.includes(workerRoot)) {
        roots.push(workerRoot);
    }

    return roots;
}

/**
 * Session roots of ONE provider home, e.g. `~/.codex-work` or a grok
 * `GROK_HOME`. The argument is a provider home, not the user's home directory
 * that `nativeSessionRoots` takes.
 *
 * Deliberately narrower than `nativeSessionRoots`: no `CODEX_HOME` /
 * `GROK_HOME` / `CLAUDE_CONFIG_DIR` lookup and no headless worker home. The
 * caller already knows which home it is asking about — an account's
 * `spendScope`, or a home `discoverHomes` found — and folding the ambient
 * overrides back in would attribute another home's transcripts to it.
 */
export function nativeSessionRootsForHome(kind: NativeSessionProvider, home: string): string[] {
    if (kind === "claude") {
        return [join(home, "projects")];
    }

    if (kind === "codex") {
        return [join(home, "sessions"), join(home, "archived_sessions")];
    }

    return [join(home, "sessions")];
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
