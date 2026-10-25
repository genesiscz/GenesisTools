import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { shellQuote } from "@genesiscz/utils/shell/quote";
import { agentsDataDir, decisionHooksWanted, diffFor, loadHooksConfig } from "./config";
import { hookDiag } from "./log";
import { writeJsonFile } from "./write-json";

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

/**
 * The Stop entry serves two features, the decision hub and the unpushed reminder, so it is wired
 * while either is on. UserPromptSubmit belongs to the decision hub alone.
 */
function stopEntries(
    script: (name: string) => string,
    options: { decisions?: boolean; unpushed?: boolean }
): { event: string; entry: HookEntry }[] {
    return [
        ...(options.decisions || options.unpushed
            ? [
                  {
                      event: "Stop",
                      entry: { hooks: [{ type: "command", command: script("hook-stop.ts"), timeout: 15 }] },
                  },
              ]
            : []),
        ...(options.decisions
            ? [
                  {
                      event: "UserPromptSubmit",
                      entry: { hooks: [{ type: "command", command: script("hook-prompt.ts"), timeout: 15 }] },
                  },
              ]
            : []),
    ];
}

export function entriesFor(
    dist: string,
    options: { decisions?: boolean; unpushed?: boolean } = {}
): { event: string; entry: HookEntry }[] {
    // The harness runs each command through a shell, so a `dist` under a home directory or a
    // `--dist` with a space in it split into two arguments and every hook call failed. The
    // quoted form still contains INSTALL_MARKER, so a re-install converges an older entry.
    const script = (name: string): string => `bun ${shellQuote(`${dist}/src/agents/bin/${name}`)}`;

    return [
        ...stopEntries(script, options),
        {
            // ONE process for the whole PreToolUse phase. Two entries cost a second bun
            // start and a second module graph, measured at about 10 ms, on every Bash call.
            // `hook-guard.ts` and `hook-diff-pre.ts` still exist for a harness that wants only
            // one half, and as the latency benchmark's guard-only stage.
            event: "PreToolUse",
            entry: {
                matcher: "Bash",
                hooks: [{ type: "command", command: script("hook-pre.ts"), timeout: 15 }],
            },
        },
        {
            // Bash for the diff; the file tools only for the session change log.
            event: "PostToolUse",
            entry: {
                matcher: "Bash|Edit|MultiEdit|Write",
                hooks: [{ type: "command", command: script("hook-diff-post.ts"), timeout: 15 }],
            },
        },
        {
            // A Bash call that FAILS gets no PostToolUse, so its edits were never shown: 98 failed
            // calls in a day, 48 of them editing files (2026-10-14). Same entry point, its own event.
            event: "PostToolUseFailure",
            entry: {
                matcher: "Bash",
                hooks: [{ type: "command", command: script("hook-diff-post.ts"), timeout: 15 }],
            },
        },
        {
            // The pre phase writes a capture per Bash call; the post phase deletes it. A
            // denied command, an interrupted turn or a crash leaves one behind, so the
            // session's own sweep runs when the session ends.
            event: "SessionEnd",
            entry: {
                hooks: [{ type: "command", command: script("hook-session-end.ts"), timeout: 15 }],
            },
        },
    ];
}

/** Claude Code's command for the agents panel rows (`mods.agentRow`, `plugins/genesis-tools-mods/hooks/agent-row.ts`). */
export function subagentLineFor(dist: string): { type: "command"; command: string } {
    return { type: "command", command: `bun ${shellQuote(`${dist}/src/agents/bin/hook-subagent-line.ts`)}` };
}

/**
 * What an install does to `subagentStatusLine`. `theirs`: `mods.agentRow` is on, but the setting holds a command this
 * installer did not write, which stays (the agents panel rows stay the engine's) unless `replace` is asked for.
 * `replaced`: that command was kept beside the settings file and ours took its place. `restored`: the mod went off and
 * the kept command came back. `absent`: the mod is off and no command of ours is there.
 */
export type SubagentLinePlan =
    | "added"
    | "updated"
    | "unchanged"
    | "replaced"
    | "removed"
    | "restored"
    | "absent"
    | "theirs";

/** The `subagentStatusLine` that `replace` took out, kept beside the settings file so turning the mod off restores it. */
function subagentLineOwnedPath(settingsPath: string): string {
    return `${settingsPath}.subagent-line-owned`;
}

/** The command `replace` kept; `undefined` when none was (or the file does not parse, so nothing is guessed). */
function savedSubagentLine(settingsPath: string): unknown {
    const path = subagentLineOwnedPath(settingsPath);

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        return readSettings(path).previous;
    } catch (err) {
        hookDiag("Could not read the kept subagentStatusLine", { err, path });

        return undefined;
    }
}

/**
 * Puts the agents panel command into `settings` (changed in place) while `on`, and takes our own out while off, putting
 * back `saved` (the command `replace` took out) when there is one. A command of someone else's is replaced only with
 * `replace`.
 */
export function planSubagentLine(
    settings: SettingsShape,
    options: { dist: string; on: boolean; replace?: boolean; saved?: unknown }
): SubagentLinePlan {
    const held = settings.subagentStatusLine;
    const ours =
        typeof held === "object" &&
        held !== null &&
        "command" in held &&
        typeof held.command === "string" &&
        held.command.includes(INSTALL_MARKER);

    if (!options.on) {
        if (!ours) {
            return "absent";
        }

        if (options.saved !== undefined) {
            settings.subagentStatusLine = options.saved;
            return "restored";
        }

        delete settings.subagentStatusLine;
        return "removed";
    }

    const wanted = subagentLineFor(options.dist);

    if (held !== undefined && !ours) {
        if (!options.replace) {
            return "theirs";
        }

        settings.subagentStatusLine = wanted;
        return "replaced";
    }

    if (SafeJSON.stringify(held) === SafeJSON.stringify(wanted)) {
        return "unchanged";
    }

    settings.subagentStatusLine = wanted;
    return held === undefined ? "added" : "updated";
}

/** Whether a plan changed the settings, so they must be written. */
function subagentLineChanged(plan: SubagentLinePlan): boolean {
    return plan !== "unchanged" && plan !== "absent" && plan !== "theirs";
}

/**
 * The bookkeeping beside a written plan: `replaced` keeps the command it took out, and a plan that took ours out
 * drops the kept copy, which is back in the settings or no longer wanted.
 */
function keepSubagentLine(settingsPath: string, plan: SubagentLinePlan, previous: unknown): void {
    if (plan === "replaced") {
        writeJsonFile(subagentLineOwnedPath(settingsPath), { previous });
    } else if (plan === "restored" || plan === "removed") {
        rmSync(subagentLineOwnedPath(settingsPath), { force: true });
    }
}

/**
 * `mods enable|disable agentRow`: the `subagentStatusLine` part of an install alone, so switching the mod does not
 * also rewire every hook. Writes only when the plan changed something and `write` is set.
 */
export function wireSubagentLine(options: {
    on: boolean;
    write: boolean;
    replace?: boolean;
    dist?: string;
    settingsPath?: string;
}): SubagentLinePlan {
    const settingsPath = options.settingsPath ?? claudeSettingsPath();
    const settings = readSettings(settingsPath);
    const previous = settings.subagentStatusLine;
    const plan = planSubagentLine(settings, {
        dist: options.dist ?? hooksDistPath(),
        on: options.on,
        replace: options.replace,
        saved: savedSubagentLine(settingsPath),
    });

    if (options.write && subagentLineChanged(plan)) {
        writeJsonFile(settingsPath, settings);
        keepSubagentLine(settingsPath, plan, previous);
    }

    return plan;
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

    const stat = lstatSafe(dist);

    if (stat && !stat.isSymbolicLink()) {
        throw new Error(`${dist} exists and is not a symlink; refusing to replace it`);
    }

    // A new link beside the old one, renamed over it. Every hook process sees the old checkout or
    // the new one; removing first left a moment with no link, and a hook started then failed.
    const staged = `${dist}.${process.pid}.tmp`;

    rmSync(staged, { force: true });
    symlinkSync(target, staged);
    renameSync(staged, dist);
}

/** Where the dist link points now, or `null` when there is no link. */
function linkTarget(dist: string): string | null {
    const stat = lstatSafe(dist);

    return stat?.isSymbolicLink() ? readlinkSync(dist) : null;
}

export interface InstallAndPointResult extends InstallResult {
    /** Whether the machine-wide dist link was repointed at the target. */
    repointed: boolean;
}

/**
 * `hooks install`: repoint the dist link and wire `settings.json` as ONE step.
 *
 * The link is machine-wide, so it moves only after the settings are known to be writable. The
 * settings are planned first as a dry run (a malformed `settings.json` throws there, before
 * anything moves), and a settings write that fails puts the link back where it was. Repointing
 * first used to switch every session to the new checkout and then report the install as failed.
 *
 * Only the default dist is ours to repoint. A `--dist` pointing elsewhere is the caller's path.
 */
export function installAndPoint(options: {
    dist?: string;
    target: string;
    settingsPath?: string;
    write: boolean;
    decisions?: boolean;
    replaceSubagentLine?: boolean;
}): InstallAndPointResult {
    const dist = options.dist ?? hooksDistPath();
    const repoint = options.write && dist === hooksDistPath();
    const { decisions, replaceSubagentLine } = options;
    const planned = installHooks({
        dist,
        settingsPath: options.settingsPath,
        write: false,
        decisions,
        replaceSubagentLine,
    });

    if (!options.write) {
        return { ...planned, repointed: false };
    }

    const previous = repoint ? linkTarget(dist) : null;

    if (repoint) {
        pointDist(options.target, dist);
    }

    try {
        return {
            ...installHooks({ dist, settingsPath: options.settingsPath, write: true, decisions, replaceSubagentLine }),
            repointed: repoint,
        };
    } catch (err) {
        if (repoint) {
            // The rollback can fail too (a full disk, a permission change). Its error must not
            // replace the settings failure that caused it, and the user must learn that the
            // machine-wide link still points at the new checkout.
            try {
                if (previous === null) {
                    rmSync(dist, { force: true });
                } else {
                    pointDist(previous, dist);
                }
            } catch (rollbackErr) {
                throw new Error(
                    `settings.json was not written (${messageOf(err)}), and the dist link could not be put back: ` +
                        `${dist} still points at ${options.target} (${messageOf(rollbackErr)})`,
                    { cause: err }
                );
            }
        }

        throw err;
    }
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
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
    /** Events whose entry of ours is no longer wanted (a decision hook turned off). */
    removed: string[];
    /** Whether the settings file needs writing at all. */
    changed: boolean;
    backup?: string;
    dist: string;
    /** What became of Claude Code's own Bash diff; see `diff.replaceNative`. */
    nativeDiff?: "turned-off" | "already-off" | "kept";
    /** `theirs`: `subagentStatusLine` holds a command of the user's, so the agents panel rows were not wired. */
    subagentLine?: SubagentLinePlan;
}

/** Does this entry belong to this installer? */
export function isOurs(entry: HookEntry): boolean {
    return Boolean(entry.hooks?.some((hook) => hook.command?.includes(INSTALL_MARKER)));
}

/** Field-by-field, so a hand-reordered JSON key does not read as a difference. */
export function sameEntry(a: HookEntry, b: HookEntry): boolean {
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
export function installHooks(options: {
    dist?: string;
    settingsPath?: string;
    write: boolean;
    /** Wire the decision hub's Stop and UserPromptSubmit hooks. Omitted: whatever the hooks config asks for. */
    decisions?: boolean;
    /** Wire the Stop hook for the unpushed reminder. Omitted: `unpushed.enabled` from the hooks config. */
    unpushed?: boolean;
    /** Wire `subagentStatusLine` for the agents panel rows. Omitted: `mods.agentRow.enabled`. */
    agentRow?: boolean;
    /** Replace a `subagentStatusLine` of someone else's, kept for `disable` and `uninstall` to restore. */
    replaceSubagentLine?: boolean;
}): InstallResult {
    const dist = options.dist ?? hooksDistPath();
    const settingsPath = options.settingsPath ?? claudeSettingsPath();
    const settings = readSettings(settingsPath);
    const before = SafeJSON.stringify(settings);
    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const removed: string[] = [];
    const config = loadHooksConfig();
    const wanted = entriesFor(dist, {
        decisions: options.decisions ?? decisionHooksWanted(config),
        unpushed: options.unpushed ?? config.unpushed.enabled,
    });
    const wantedEvents = new Set(wanted.map((item) => item.event));

    settings.hooks ??= {};

    // An entry of ours on an event no longer wanted (the decision hooks turned off) goes, so
    // turning a feature off and re-running install converges instead of leaving it wired.
    for (const [event, list] of Object.entries(settings.hooks)) {
        if (!wantedEvents.has(event) && list.some(isOurs)) {
            settings.hooks[event] = list.filter((existing) => !isOurs(existing));
            removed.push(event);
        }
    }

    for (const { event, entry } of wanted) {
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

    const previousLine = settings.subagentStatusLine;
    const subagentLine = planSubagentLine(settings, {
        dist,
        on: options.agentRow ?? config.mods.agentRow.enabled,
        replace: options.replaceSubagentLine,
        saved: savedSubagentLine(settingsPath),
    });
    const lists: Partial<Record<SubagentLinePlan, string[]>> = {
        added,
        updated,
        replaced: updated,
        unchanged,
        removed,
        restored: removed,
    };

    lists[subagentLine]?.push("subagentStatusLine");

    // The hook replaces Claude Code's own Bash diff, in the same write as the wiring.
    // While `shadow` is on the hook prints nothing (`hook-diff-post`), so turning the native
    // diff off would remove the only diff the user sees. It stays until the hook speaks.
    // The value replaced here is remembered, so uninstall can put it back unless the user changed it.
    let nativeDiff: InstallResult["nativeDiff"] = "kept";
    const previousNative = settings.bashEditDiffEnabled;

    if (!config.shadow && config.diff.replaceNative && diffFor(config, "claude").enabled) {
        nativeDiff = previousNative === false ? "already-off" : "turned-off";
        settings.bashEditDiffEnabled = false;
    }

    const changed = SafeJSON.stringify(settings) !== before;

    if (!options.write || !changed) {
        return { added, updated, unchanged, removed, changed, dist, nativeDiff, subagentLine };
    }

    const backup = `${settingsPath}.pre-agents-hooks`;

    if (existsSync(settingsPath) && !existsSync(backup)) {
        copyFileSync(settingsPath, backup);
    }

    writeJsonFile(settingsPath, settings);
    keepSubagentLine(settingsPath, subagentLine, previousLine);

    if (nativeDiff === "turned-off") {
        rememberNativeDiff(settingsPath, previousNative);
    }

    return { added, updated, unchanged, removed, changed, backup, dist, nativeDiff, subagentLine };
}

/** The previous `bashEditDiffEnabled`, kept beside the settings file install rewrote. */
function nativeDiffOwnedPath(settingsPath: string): string {
    return `${settingsPath}.native-diff-owned`;
}

/** `true` when the key was on. `false` when it was absent, so uninstall deletes it. */
function rememberNativeDiff(settingsPath: string, previous: unknown): void {
    writeJsonFile(nativeDiffOwnedPath(settingsPath), { previous: previous === true });
}

/** A file that does not parse is left unread, so uninstall does not guess. */
function savedNativeDiff(settingsPath: string): { found: true; wasOn: boolean } | { found: false } {
    const path = nativeDiffOwnedPath(settingsPath);

    if (!existsSync(path)) {
        return { found: false };
    }

    try {
        return { found: true, wasOn: readSettings(path).previous === true };
    } catch (err) {
        hookDiag("Could not read the saved native diff setting", { err, path });

        return { found: false };
    }
}

export interface WiringStatus {
    /** `stale`: an entry of ours is there but differs from what this checkout installs. */
    state: "missing" | "installed" | "stale";
    /** The events an install would add, update or remove. */
    events: string[];
}

/**
 * Whether `settings.json` carries exactly this checkout's wiring. Read-only: a dry-run install.
 *
 * "Our marker is somewhere in the file" used to count as installed, so an entry from an older
 * install (the post hook on `Bash` only) read as fine while no Edit or Write call reached the
 * session change log.
 */
export function wiringStatus(
    options: { dist?: string; settingsPath?: string; decisions?: boolean; unpushed?: boolean } = {}
): WiringStatus {
    const settingsPath = options.settingsPath ?? claudeSettingsPath();

    if (!existsSync(settingsPath) || !SafeJSON.stringify(readSettings(settingsPath)).includes(INSTALL_MARKER)) {
        return { state: "missing", events: [] };
    }

    const plan = installHooks({ ...options, settingsPath, write: false });
    const events = [...plan.added, ...plan.updated, ...plan.removed];

    return events.length > 0 ? { state: "stale", events } : { state: "installed", events: [] };
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

    const line = planSubagentLine(settings, {
        dist: hooksDistPath(),
        on: false,
        saved: savedSubagentLine(settingsPath),
    });

    if (subagentLineChanged(line)) {
        removed++;
    }

    const saved = options.write ? savedNativeDiff(settingsPath) : { found: false as const };
    let restored = false;

    // Still the `false` install wrote: the user has not changed it. A later `true`, or a deleted
    // key, is theirs and stays.
    if (saved.found && settings.bashEditDiffEnabled === false) {
        if (saved.wasOn) {
            settings.bashEditDiffEnabled = true;
        } else {
            delete settings.bashEditDiffEnabled;
        }

        restored = true;
    }

    if (options.write && (removed > 0 || restored)) {
        writeJsonFile(settingsPath, settings);
        keepSubagentLine(settingsPath, line, undefined);
    }

    if (saved.found) {
        rmSync(nativeDiffOwnedPath(settingsPath), { force: true });
    }

    return { removed };
}
