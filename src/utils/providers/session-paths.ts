import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
    ACCOUNT_PROVIDER_ALIASES,
    type AccountProviderAlias,
    type PerHarness,
} from "@genesiscz/utils/ai/providers/alias-list";
import { env } from "@genesiscz/utils/env";
import { defaultWorkerHome } from "@genesiscz/utils/grok/worker-paths";

/**
 * Every home `CODEX_HOME` names, in order. Codex accepts a comma-separated LIST and writes to
 * the first entry, so `codexHomeOverrides()[0]` is the primary home and the rest are read-only
 * companions. Empty when the variable is unset.
 *
 * One reader, because three call sites split it their own way while two more read the whole
 * string as a single path: with `CODEX_HOME=~/.codex-work,~/.codex` those two resolved one
 * directory named `…/.codex-work,~/.codex`, which nothing on disk answers to.
 */
export function codexHomeOverrides(): string[] {
    return parseCodexHomeList(env.codex.getHomeOverride());
}

/**
 * The homes one `CODEX_HOME` value names, in order, for a caller that holds another process's environment (a failed
 * tool's caller, a spawned child). Codex writes to the first entry.
 */
export function parseCodexHomeList(value: string | undefined): string[] {
    if (!value) {
        return [];
    }

    return value
        .split(",")
        .map((path) => path.trim())
        .filter((path) => path.length > 0);
}

/** The home Codex itself writes to, or `undefined` when `CODEX_HOME` is unset. */
export function primaryCodexHome(): string | undefined {
    return codexHomeOverrides()[0];
}

export type NativeSessionProvider = AccountProviderAlias;

/**
 * Where one coding agent keeps its home and its transcripts on disk. Each harness has one layout in
 * `NATIVE_LAYOUTS`, and every function below reads it. The layouts stay in this file because lint-rules
 * `no-hand-built-claude-home` and `no-hand-built-codex-grok-home` allow the home folder names here only; a new
 * harness adds its layout to the table, and the compiler names the table until it does.
 */
interface NativeHomeLayout {
    /** The folder under a user's home when no override names another one. */
    readonly defaultFolder: string;
    /** The home an environment variable names (`CLAUDE_CONFIG_DIR`, the primary `CODEX_HOME`, `GROK_HOME`). */
    homeOverride(): string | undefined;
    /** The name of that environment variable. */
    readonly overrideVariable: string;
    /** Every session root under a user's home, the overrides and the headless worker home included. */
    sessionRoots(home: string): string[];
    /** The session roots of ONE provider home, with no environment lookup. */
    sessionRootsForHome(providerHome: string): string[];
    isTranscript(fileName: string): boolean;
    /** How deep under a session root a transcript can sit. */
    readonly transcriptMaxDepth: number;
    /** The session roots of legacy profile homes beside the default one (`~/.codex-work`). */
    legacyRoots(root: string): string[];
}

/** Codex CLI 0.164 compresses its old rollouts to `rollout-….jsonl.zst` (single-frame zstd). */
const CODEX_COMPRESSED_SUFFIX = ".jsonl.zst";

const claudeLayout: NativeHomeLayout = {
    defaultFolder: ".claude",
    homeOverride: () => env.paths.getClaudeConfigDir(),
    overrideVariable: "CLAUDE_CONFIG_DIR",
    sessionRoots: (home) => {
        const roots = [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
        const configDir = env.paths.getClaudeConfigDir();
        if (configDir) {
            const extra = join(configDir, "projects");
            if (!roots.includes(extra)) {
                roots.push(extra);
            }
        }
        return roots;
    },
    sessionRootsForHome: (providerHome) => [join(providerHome, "projects")],
    isTranscript: (fileName) => fileName.endsWith(".jsonl"),
    transcriptMaxDepth: 6,
    legacyRoots: () => [],
};

const codexLayout: NativeHomeLayout = {
    defaultFolder: ".codex",
    homeOverride: () => primaryCodexHome(),
    overrideVariable: "CODEX_HOME",
    sessionRoots: (home) => {
        const homes = codexHomeOverrides();
        const bases = homes.length > 0 ? homes : [join(home, ".codex")];
        const roots: string[] = [];
        for (const base of bases) {
            for (const dir of codexLayout.sessionRootsForHome(base)) {
                if (!roots.includes(dir)) {
                    roots.push(dir);
                }
            }
        }
        return roots;
    },
    sessionRootsForHome: (providerHome) => [join(providerHome, "sessions"), join(providerHome, "archived_sessions")],
    isTranscript: (fileName) => fileName.endsWith(CODEX_COMPRESSED_SUFFIX) || fileName.endsWith(".jsonl"),
    transcriptMaxDepth: 4,
    legacyRoots: (root) => codexHomesIn(root).flatMap((home) => codexLayout.sessionRootsForHome(home)),
};

const grokLayout: NativeHomeLayout = {
    defaultFolder: ".grok",
    homeOverride: () => env.grok.getHomeOverride(),
    overrideVariable: "GROK_HOME",
    sessionRoots: (home) => {
        const grokHome = env.grok.getHomeOverride() ?? join(home, ".grok");
        const roots = [join(grokHome, "sessions")];
        const workerRoot = join(defaultWorkerHome(), "sessions");

        if (!roots.includes(workerRoot)) {
            roots.push(workerRoot);
        }

        return roots;
    },
    sessionRootsForHome: (providerHome) => [join(providerHome, "sessions")],
    isTranscript: (fileName) => fileName === "updates.jsonl",
    transcriptMaxDepth: 3,
    legacyRoots: () => [],
};

const NATIVE_LAYOUTS = {
    claude: claudeLayout,
    codex: codexLayout,
    grok: grokLayout,
} satisfies PerHarness<NativeHomeLayout>;

/**
 * The agent's folder under a user's home, `~/.claude`, `~/.codex` or `~/.grok`, whatever `CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME` or `GROK_HOME` say. Only for a caller that means that folder on purpose: the shared Codex home
 * `tools codex run` starts accounts from, the home `tools codex migrate-home` merges its siblings into. Every other
 * caller asks `nativeHome`, which honours the overrides.
 */
export function defaultNativeHome(kind: NativeSessionProvider, home = homedir()): string {
    return join(home, NATIVE_LAYOUTS[kind].defaultFolder);
}

/**
 * A coding agent's own home folder: `CLAUDE_CONFIG_DIR` or `~/.claude`, the primary `CODEX_HOME` or `~/.codex`,
 * `GROK_HOME` or `~/.grok`. The one place that builds these roots; lint-rules `no-hand-built-claude-home` and
 * `no-hand-built-codex-grok-home` point here.
 */
/** The environment variable that moves an agent's home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`). */
export function nativeHomeOverrideVariable(kind: NativeSessionProvider): string {
    return NATIVE_LAYOUTS[kind].overrideVariable;
}

export function nativeHome(kind: NativeSessionProvider, home = homedir()): string {
    return NATIVE_LAYOUTS[kind].homeOverride() ?? defaultNativeHome(kind, home);
}

/**
 * A path inside the agent's home: `nativeHomePath("claude", "teams")` is `$CLAUDE_CONFIG_DIR/teams` or
 * `~/.claude/teams`, `nativeHomePath("codex", "config.toml")` the primary Codex home's config. Every hand-joined
 * `join(homedir(), ".claude", …)` becomes a call here, so an override reaches each reader (lint-rules
 * `no-hand-built-claude-home`, `no-hand-built-codex-grok-home`).
 */
export function nativeHomePath(kind: NativeSessionProvider, ...segments: string[]): string {
    return join(nativeHome(kind), ...segments);
}

/** The default keychain service belongs to the default home, regardless of overrides. */
export function defaultClaudeJsonPath(home = homedir()): string {
    return join(home, ".claude.json");
}

/**
 * Claude Code's `.claude.json` (accounts, MCP servers, project trust). Claude Code reads it from
 * `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set (`src/claude/lib/launch-env.ts`), else from the home
 * folder. On 2026-10-25 `src/utils/claude/auth.ts` read `~/.claude.json` while `launch-env.ts` honoured the
 * variable, so with it set the two read different files; this is the one answer.
 */
export function claudeJsonPath(home = homedir()): string {
    const configDir = env.paths.getClaudeConfigDir();
    return configDir ? claudeJsonPathInConfigDir(configDir) : defaultClaudeJsonPath(home);
}

/**
 * The `.claude.json` of one given Claude config dir, for a caller that already knows it (a launched child's own
 * `CLAUDE_CONFIG_DIR`). No env lookup, the same reason `nativeSessionRootsForHome` has none.
 */
export function claudeJsonPathInConfigDir(configDir: string): string {
    return join(configDir, ".claude.json");
}

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
    return NATIVE_LAYOUTS[kind].sessionRoots(home);
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
    return NATIVE_LAYOUTS[kind].sessionRootsForHome(home);
}

/**
 * Every provider's home and session roots as this process resolves them (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
 * `GROK_HOME`, the home folder), as one string. A resident process that reads transcripts for a caller (the hub
 * server) answers it only when both strings are equal: a caller with another root reads other transcripts.
 */
export function nativeRootsKey(home = homedir()): string {
    // Resolved against this process's folder: CODEX_HOME=./profile names another folder in another cwd.
    return ACCOUNT_PROVIDER_ALIASES.map((kind) =>
        [kind, ...[nativeHome(kind, home), ...nativeSessionRoots(kind, home)].map((path) => resolve(path))].join("\t")
    ).join("\n");
}

export function isNativeTranscript(kind: NativeSessionProvider, fileName: string): boolean {
    return NATIVE_LAYOUTS[kind].isTranscript(fileName);
}

/** A transcript file name without `.jsonl` or `.jsonl.zst`: the id part, the same for both forms of one file. */
export function transcriptStem(fileName: string): string {
    return fileName.replace(/\.jsonl(?:\.zst)?$/, "");
}

export function nativeTranscriptMaxDepth(kind: NativeSessionProvider): number {
    return NATIVE_LAYOUTS[kind].transcriptMaxDepth;
}

export function codexHomesIn(root: string): string[] {
    if (!existsSync(root)) {
        return [];
    }

    const homes: string[] = [];

    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }

        // The dot in a backup name is load-bearing. `.codex-` is the separator Codex itself uses
        // for a profile home, so `~/.codex-bak-2026-09-04` would be discovered as a real home and
        // its rollouts indexed as sessions distinct from the identical ones in `~/.codex`.
        // `~/.codex.bak-2026-09-04` is skipped only because a dot is not a hyphen.
        if (entry.name === ".codex" || entry.name.startsWith(".codex-")) {
            homes.push(join(root, entry.name));
        }
    }

    return homes.sort();
}

/**
 * Every Codex home this machine has: the `CODEX_HOME` list (else `~/.codex`), then the legacy profile homes beside
 * it (`~/.codex-work`). The one root policy for Codex: history discovery (`nativeSessionRootsWithLegacyHomes`),
 * transcript lookup and title search all read these homes, so a session history lists is one `resolveTranscript`
 * finds. Only folder names are read, never a home's credentials.
 */
export function codexHomesWithLegacy(root = homedir()): string[] {
    const overrides = codexHomeOverrides();
    return [...new Set([...(overrides.length > 0 ? overrides : [nativeHome("codex", root)]), ...codexHomesIn(root)])];
}

/** History discovery includes legacy Codex profile homes without reading their credentials. */
export function nativeSessionRootsWithLegacyHomes(kind: NativeSessionProvider, root = homedir()): string[] {
    const roots = nativeSessionRoots(kind, root);
    const legacy = NATIVE_LAYOUTS[kind].legacyRoots(root);
    return legacy.length === 0 ? roots : [...new Set([...roots, ...legacy])];
}
