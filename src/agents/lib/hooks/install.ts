import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { agentsDataDir } from "./config";
import { hookDiag } from "./log";

/**
 * 🛑 `settings.json` is machine-wide. An absolute path into a branch worktree makes every
 * session on this machine run branch code, and deleting that worktree breaks every Bash
 * call until the file is edited back. So the entries point at a symlink WE own, and
 * repointing it is the one edit that moves every session to another checkout.
 */
export function hooksDistPath(): string {
    return join(agentsDataDir(), "hooks-dist");
}

export function repoRoot(): string {
    return resolve(import.meta.dir, "..", "..", "..", "..");
}

export function claudeSettingsPath(): string {
    return join(homedir(), ".claude", "settings.json");
}

export interface HookEntry {
    matcher?: string;
    hooks: { type: string; command: string; timeout?: number }[];
}

export interface SettingsShape {
    hooks?: Record<string, HookEntry[]>;
    [key: string]: unknown;
}

/** Every command string this installer writes carries this, so uninstall is exact. */
export const INSTALL_MARKER = "src/agents/bin/hook-";

export function entriesFor(dist: string): { event: string; entry: HookEntry }[] {
    return [
        {
            // ONE process for the whole PreToolUse phase. Two entries cost a second bun
            // start and a second module graph, measured at about 10 ms, on every Bash call.
            // `hook-guard.ts` and `hook-diff-pre.ts` still exist for the parity harnesses
            // and for a harness that wants only one half.
            event: "PreToolUse",
            entry: {
                matcher: "Bash",
                hooks: [{ type: "command", command: `bun ${dist}/src/agents/bin/hook-pre.ts`, timeout: 15 }],
            },
        },
        {
            event: "PostToolUse",
            entry: {
                matcher: "Bash",
                hooks: [{ type: "command", command: `bun ${dist}/src/agents/bin/hook-diff-post.ts`, timeout: 15 }],
            },
        },
        {
            // The pre phase writes a capture per Bash call; the post phase deletes it. A
            // denied command, an interrupted turn or a crash leaves one behind, so the
            // session's own sweep runs when the session ends.
            event: "SessionEnd",
            entry: {
                hooks: [{ type: "command", command: `bun ${dist}/src/agents/bin/hook-session-end.ts`, timeout: 15 }],
            },
        },
    ];
}

/**
 * A settings file that does not exist yet is an EMPTY one, not a crash: a fresh machine has
 * no `~/.claude/settings.json`, and `install` should write one rather than exit with a stack
 * trace. `doctor` already guarded this read; `install` and `uninstall` did not.
 */
export function readSettings(path = claudeSettingsPath()): SettingsShape {
    if (!existsSync(path)) {
        return {};
    }

    return SafeJSON.parse(readFileSync(path, "utf8")) as SettingsShape;
}

/** Points the stable symlink at `target`, replacing an existing link but never a real dir. */
export function pointDist(target: string, dist = hooksDistPath()): void {
    mkdirSync(dirname(dist), { recursive: true });

    if (existsSync(dist) || lstatSafe(dist)) {
        const stat = lstatSafe(dist);

        if (stat && !stat.isSymbolicLink()) {
            throw new Error(`${dist} exists and is not a symlink; refusing to replace it`);
        }

        rmSync(dist, { force: true });
    }

    symlinkSync(target, dist);
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
    try {
        return lstatSync(path);
    } catch (err) {
        hookDiag("No entry at the dist path yet", { err, path });
        return null;
    }
}

export interface InstallResult {
    /** Events that had no entry of ours and gained one. */
    added: string[];
    /** Events where a STALE entry of ours was replaced: a different dist, or an older shape. */
    updated: string[];
    /** Events already exactly right. */
    unchanged: string[];
    /** Whether the settings file needs writing at all. */
    changed: boolean;
    backup?: string;
    dist: string;
}

/** Does this entry belong to this installer? */
function isOurs(entry: HookEntry): boolean {
    return Boolean(entry.hooks?.some((hook) => hook.command?.includes(INSTALL_MARKER)));
}

/** Field-by-field, so a hand-reordered JSON key does not read as a difference. */
function sameEntry(a: HookEntry, b: HookEntry): boolean {
    if ((a.matcher ?? null) !== (b.matcher ?? null) || a.hooks.length !== b.hooks.length) {
        return false;
    }

    return a.hooks.every((hook, index) => {
        const other = b.hooks[index];

        return (
            other !== undefined &&
            hook.type === other.type &&
            hook.command === other.command &&
            (hook.timeout ?? null) === (other.timeout ?? null)
        );
    });
}

/**
 * CONVERGES on the desired wiring rather than bailing out when anything of ours is present.
 *
 * 🛑 The earlier version asked "is there already an entry carrying our marker?" and skipped
 * the event if so. Measured on 2026-09-20 that failed three ways, all of them silent:
 * `install --dist <new>` reported success while the entries still named the OLD dist; an
 * entry left over from an earlier layout (the two-command PreToolUse this port replaced with
 * one) was never migrated; and a run with nothing to do still rewrote the file.
 *
 * So: every entry of ours is replaced by the desired one, others are untouched and keep their
 * order, and the file is written ONLY when the result actually differs.
 */
export function installHooks(options: { dist?: string; settingsPath?: string; write: boolean }): InstallResult {
    const dist = options.dist ?? hooksDistPath();
    const settingsPath = options.settingsPath ?? claudeSettingsPath();
    const settings = readSettings(settingsPath);
    const before = SafeJSON.stringify(settings);
    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];

    settings.hooks ??= {};

    for (const { event, entry } of entriesFor(dist)) {
        settings.hooks[event] ??= [];

        const list = settings.hooks[event];
        const ours = list.filter(isOurs);

        if (ours.length === 1 && ours[0] !== undefined && sameEntry(ours[0], entry)) {
            // Already exactly right. The list is left ALONE, so an entry that sits in the
            // middle keeps its position and the file does not churn.
            unchanged.push(event);
            continue;
        }

        settings.hooks[event] = [...list.filter((existing) => !isOurs(existing)), entry];
        (ours.length === 0 ? added : updated).push(event);
    }

    const changed = SafeJSON.stringify(settings) !== before;

    if (!options.write || !changed) {
        return { added, updated, unchanged, changed, dist };
    }

    const backup = `${settingsPath}.pre-agents-hooks`;

    if (existsSync(settingsPath) && !existsSync(backup)) {
        copyFileSync(settingsPath, backup);
    }

    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${SafeJSON.stringify(settings, null, 2)}\n`);

    return { added, updated, unchanged, changed, backup, dist };
}

export interface UninstallResult {
    removed: number;
}

export function uninstallHooks(options: { settingsPath?: string; write: boolean }): UninstallResult {
    const settingsPath = options.settingsPath ?? claudeSettingsPath();
    const settings = readSettings(settingsPath);
    let removed = 0;

    for (const [event, list] of Object.entries(settings.hooks ?? {})) {
        const kept = list.filter((entry) => !isOurs(entry));

        removed += list.length - kept.length;

        if (settings.hooks && removed > 0) {
            settings.hooks[event] = kept;
        }
    }

    if (options.write && removed > 0) {
        writeFileSync(settingsPath, `${SafeJSON.stringify(settings, null, 2)}\n`);
    }

    return { removed };
}
