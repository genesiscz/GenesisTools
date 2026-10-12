import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { primaryCodexHome } from "@genesiscz/utils/providers/session-paths";
import { shellQuote } from "@genesiscz/utils/shell/quote";
import { diffFor, loadHooksConfig } from "./config";
import { type HookEntry, hooksDistPath, type InstallResult, isOurs, readSettings, sameEntry } from "./install";
import { writeJsonFile } from "./write-json";

/**
 * Codex wiring. Codex reads `<CODEX_HOME>/hooks.json`, which has Claude's shape (`hooks.<Event>[]`
 * with a `matcher` and command hooks), sends `tool_name: "Bash"` for a shell call, and honours
 * `permissionDecision: deny`, `additionalContext` and `systemMessage`.
 *
 * 🛑 Codex TRUSTS a hook per array position: `config.toml` holds
 * `[hooks.state."<hooks.json>:pre_tool_use:<entry>:<hook>"]` with a hash of that hook. So this
 * installer never moves an entry that is already there. A new entry is APPENDED, and an entry of
 * ours that changed is replaced IN PLACE; everything else keeps its index and its trust. A new or
 * changed hook is untrusted until the user approves it in Codex (it asks at the next start);
 * forging the hash would bypass that review, so the installer does not touch `config.toml`.
 */

export function codexHome(): string {
    return primaryCodexHome() ?? join(homedir(), ".codex");
}

export function codexHooksPath(): string {
    return join(codexHome(), "hooks.json");
}

export function codexConfigPath(): string {
    return join(codexHome(), "config.toml");
}

/** Codex keys its hook state by the snake_case event name. */
function codexEventKey(event: string): string {
    return event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * The guard and the pre-phase capture in one process, as for Claude. The post phase renders the
 * diff of a Bash call, so it is wired only while the diff is on for Codex: otherwise the pre phase
 * captures nothing (it reads the same per-harness setting) and the post phase has nothing to do.
 * Codex edits files through apply_patch, not Edit or Write, so only `Bash` is matched.
 */
export function codexEntriesFor(dist: string, options: { diff: boolean }): { event: string; entry: HookEntry }[] {
    const script = (name: string): string => `bun ${shellQuote(`${dist}/src/agents/bin/${name}`)}`;

    return [
        {
            event: "PreToolUse",
            entry: { matcher: "Bash", hooks: [{ type: "command", command: script("hook-pre.ts"), timeout: 15 }] },
        },
        ...(options.diff
            ? [
                  {
                      event: "PostToolUse",
                      entry: {
                          matcher: "Bash",
                          hooks: [{ type: "command", command: script("hook-diff-post.ts"), timeout: 15 }],
                      },
                  },
              ]
            : []),
    ];
}

/** Converges `hooks.json` on the wanted entries without moving any entry another hook owns. */
export function installCodexHooks(options: {
    dist?: string;
    path?: string;
    write: boolean;
    /** Wire the diff's post phase. Omitted: whether the diff is on for Codex in the hooks config. */
    diff?: boolean;
}): InstallResult {
    const dist = options.dist ?? hooksDistPath();
    const path = options.path ?? codexHooksPath();
    const settings = readSettings(path);
    const before = SafeJSON.stringify(settings);
    const wanted = codexEntriesFor(dist, { diff: options.diff ?? diffFor(loadHooksConfig(), "codex").enabled });
    const wantedEvents = new Set(wanted.map((item) => item.event));
    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const removed: string[] = [];

    settings.hooks ??= {};

    for (const [event, list] of Object.entries(settings.hooks)) {
        if (!wantedEvents.has(event) && list.some(isOurs)) {
            settings.hooks[event] = list.filter((existing) => !isOurs(existing));
            removed.push(event);
        }
    }

    for (const { event, entry } of wanted) {
        const list = settings.hooks[event] ?? [];
        const first = list.findIndex(isOurs);

        settings.hooks[event] = list;

        if (first === -1) {
            list.push(entry);
            added.push(event);
            continue;
        }

        const extra = list.filter((existing, index) => index !== first && isOurs(existing)).length;
        const current = list[first];

        if (extra === 0 && current !== undefined && sameEntry(current, entry)) {
            unchanged.push(event);
            continue;
        }

        // In place, and any duplicate of ours after it dropped: the entries before it keep their index.
        settings.hooks[event] = list
            .map((existing, index) => (index === first ? entry : existing))
            .filter((existing, index) => index === first || !isOurs(existing));
        updated.push(event);
    }

    const changed = SafeJSON.stringify(settings) !== before;

    if (!options.write || !changed) {
        return { added, updated, unchanged, removed, changed, dist };
    }

    const backup = `${path}.pre-agents-hooks`;

    if (existsSync(path) && !existsSync(backup)) {
        copyFileSync(path, backup);
    }

    writeJsonFile(path, settings);

    return { added, updated, unchanged, removed, changed, backup, dist };
}

export function uninstallCodexHooks(options: { path?: string; write: boolean }): { removed: number } {
    const path = options.path ?? codexHooksPath();
    const settings = readSettings(path);
    let removed = 0;

    for (const [event, list] of Object.entries(settings.hooks ?? {})) {
        const kept = list.filter((entry) => !isOurs(entry));

        if (kept.length !== list.length && settings.hooks) {
            removed += list.length - kept.length;
            settings.hooks[event] = kept;
        }
    }

    if (options.write && removed > 0) {
        writeJsonFile(path, settings);
    }

    return { removed };
}

export interface CodexTrust {
    event: string;
    /** The `hooks.state` key Codex stores the trust under. */
    key: string;
    /** A trust entry exists for that position. Its hash is not checked here. */
    recorded: boolean;
}

export interface CodexWiring {
    path: string;
    state: "missing" | "installed" | "stale";
    /** Events an install would add, update or remove. */
    events: string[];
    trust: CodexTrust[];
    /** Why `hooks.json` could not be read, when it could not. */
    error?: string;
}

/** Read-only: the dry-run install, plus which of our positions `config.toml` holds a trust entry for. */
export function codexWiring(
    options: { dist?: string; path?: string; configPath?: string; diff?: boolean } = {}
): CodexWiring {
    const path = options.path ?? codexHooksPath();
    let settings: ReturnType<typeof readSettings>;

    try {
        settings = existsSync(path) ? readSettings(path) : {};
    } catch (err) {
        return {
            path,
            state: "missing",
            events: [],
            trust: [],
            error: err instanceof Error ? err.message : String(err),
        };
    }

    const ours = Object.entries(settings.hooks ?? {}).flatMap(([event, list]) =>
        list.flatMap((entry, index) => (isOurs(entry) ? [{ event, index }] : []))
    );

    if (ours.length === 0) {
        return { path, state: "missing", events: [], trust: [] };
    }

    const plan = installCodexHooks({ dist: options.dist, path, write: false, diff: options.diff });
    const events = [...plan.added, ...plan.updated, ...plan.removed];
    const configPath = options.configPath ?? codexConfigPath();
    let toml = "";

    try {
        toml = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    } catch {
        // An unreadable config.toml reads as "no trust recorded", which is what Codex would do too.
    }

    const trust = ours.map(({ event, index }) => {
        const key = `${path}:${codexEventKey(event)}:${index}:0`;

        return { event, key, recorded: toml.includes(`[hooks.state."${key}"]`) };
    });

    return { path, state: events.length > 0 ? "stale" : "installed", events, trust };
}
