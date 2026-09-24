/**
 * The project-to-vault-folder registry, and the matching every skill must do the same way.
 *
 *   ~/.genesis-tools/plugins/vault-registry.json
 *     { "entries": [ { projectDir, branch?, worktreeDir?, obsidianDir, docPath? }, … ] }
 *
 * An entry pins a FOLDER for a project, optionally narrowed to one branch or one worktree. It
 * never pins a filename: wrap-up derives a per-branch default and research writes dated topic
 * files, both into the same folder.
 *
 * It lived at `~/.claude/handoff-registry.json` and was read only by wrap-up, which is why
 * research could not see the mappings that already existed. `~/.claude` is also Claude-only
 * while these skills are read by Codex and Grok, so the move out of it is part of the fix.
 */

import type { Ctx } from "./git-context.ts";
import { ensureDir, expandHome, LEGACY_PATHS, migrateOnce, VAULT_REGISTRY_PATH, writeAtomic } from "./plugin-config.ts";

export interface Entry {
    projectDir: string;
    branch?: string;
    worktreeDir?: string;
    /** The folder for this project, used by every consumer that has no entry in `dirs`. */
    obsidianDir: string;
    /**
     * Per-consumer folders, keyed by plugin name: `{ "research": "…", "wrap-up": "…" }`.
     *
     * Sharing the registry must not mean sharing one directory. A project can perfectly well
     * want its wrap-up log in `Work/Logs` and its research files in `Work/ticket-4821/`, and the
     * flat `obsidianDir` alone could not say so. Absent key means "use `obsidianDir`", so every
     * existing entry keeps working untouched.
     */
    dirs?: Record<string, string>;
    docPath?: string;
}

export interface Registry {
    entries: Entry[];
    /**
     * Set when the file exists but could not be read as a registry. Reads carry on with no
     * entries; `saveRegistry` refuses, so a corrupt file is never replaced by an empty one.
     */
    unreadable?: true;
}

export interface Ranked {
    entry: Entry;
    score: number;
}

let migration: Promise<unknown> | undefined;

/** One migration per install, before the first read or write of either path. */
export async function migrateRegistry(label: string): Promise<void> {
    migration ??= migrateOnce({
        from: LEGACY_PATHS.registry,
        to: VAULT_REGISTRY_PATH,
        label,
        targetPresent: () => Bun.file(VAULT_REGISTRY_PATH).exists(),
        write: async (legacy) => {
            const entries = Array.isArray(legacy.entries) ? legacy.entries : [];

            await ensureDir(VAULT_REGISTRY_PATH);
            await writeAtomic(VAULT_REGISTRY_PATH, `${JSON.stringify({ entries }, null, 2)}\n`);
        },
    });

    await migration;
}

/** An explicit `registryPath` in the shared config is the user's choice and is never migrated over. */
export async function registryPath(configured: string | undefined, label: string): Promise<string> {
    if (configured) {
        return expandHome(configured);
    }

    await migrateRegistry(label);

    return VAULT_REGISTRY_PATH;
}

export async function loadRegistry(path: string, label: string): Promise<Registry> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
        return { entries: [] };
    }

    try {
        const parsed = JSON.parse(await file.text());

        if (Array.isArray(parsed?.entries)) {
            return parsed;
        }

        console.error(`${label}: ignoring registry ${path}: it has no "entries" array`);
    } catch (err) {
        // A malformed registry must not masquerade as an empty one — that would silently drop
        // every registered target and resolve to found:false.
        console.error(`${label}: ignoring unreadable registry ${path}: ${String(err)}`);
    }

    return { entries: [], unreadable: true };
}

export async function saveRegistry(path: string, registry: Registry): Promise<void> {
    if (registry.unreadable) {
        // The entries in hand are an empty stand-in for a file we could not parse. Saving them
        // would replace every registered target with just the one being added.
        throw new Error(`refusing to overwrite unreadable registry ${path}; fix or move it aside first`);
    }

    await ensureDir(path);
    await writeAtomic(path, `${JSON.stringify(registry, null, 2)}\n`);
}

export function matches(entry: Entry, ctx: Ctx): number {
    // Higher score = more specific match. 0 = no match.
    // Do not prefix-match cwd against another repository: a nested git checkout at
    // /parent/child would otherwise steal the parent's target. Same-repo subdirectories still
    // match because gitContext sets toplevel to the root.
    const paths = [entry.worktreeDir, entry.projectDir].filter(Boolean) as string[];
    const direct = paths.some((path) => ctx.toplevel === path || ctx.cwd === path);
    // From a linked worktree, an entry registered against the main checkout is still this
    // project's entry — a sibling worktree shares no path prefix with it, so without this the
    // correct target resolves to found:false.
    const viaMain = !direct && Boolean(ctx.mainProject) && paths.some((path) => path === ctx.mainProject);

    if (!direct && !viaMain) {
        return 0;
    }

    if (entry.branch && entry.branch !== ctx.branch) {
        return 0;
    }

    const inWorktree =
        Boolean(entry.worktreeDir) &&
        (ctx.toplevel === entry.worktreeDir ||
            ctx.cwd === entry.worktreeDir ||
            ctx.cwd.startsWith(`${entry.worktreeDir}/`));

    // A worktree pin NARROWS the entry, as a branch pin does. Scoring it 1 from elsewhere tied it
    // with the project-wide entry, and the newest-first tie-break could hand worktree Y's folder
    // to work done in the main checkout or in a sibling worktree.
    if (entry.worktreeDir && !inWorktree) {
        return 0;
    }

    let score = 1;

    if (inWorktree) {
        score += 2;
    }

    if (entry.branch) {
        score += 1;
    }

    return score;
}

/**
 * Rank the matching entries, most specific first. Equal specificity is broken by registration
 * order, newest first: `register` appends, so the later entry is the one the user set up most
 * recently, and a months-old catch-all must not outrank it.
 */
export function rankEntries(entries: Entry[], ctx: Ctx): Ranked[] {
    return entries
        .map((entry, index) => ({ entry, score: matches(entry, ctx), index }))
        .filter((ranked) => ranked.score > 0)
        .sort((a, b) => b.score - a.score || b.index - a.index)
        .map(({ entry, score }) => ({ entry, score }));
}

/** This consumer's folder for an entry, falling back to the shared `obsidianDir`. */
export function dirFor(entry: Entry, consumer: string): string {
    return expandHome(entry.dirs?.[consumer] ?? entry.obsidianDir);
}

/**
 * The entry as one consumer sees it, with `obsidianDir` already resolved to that consumer's
 * folder. Callers downstream never have to remember which plugin they are.
 */
export function forConsumer(entry: Entry, consumer: string): Entry {
    return { ...entry, obsidianDir: dirFor(entry, consumer) };
}
