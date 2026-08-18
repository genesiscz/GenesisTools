import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_DIR } from "@genesiscz/utils/claude/projects";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** The command Claude Code runs on every SessionStart to record the account pin. */
export const HOOK_COMMAND = "tools claude cmux record";

/** Generous: the hook boots bun, and a missed pin means a session with no account. */
export const HOOK_TIMEOUT_SECONDS = 10;

export function settingsPath(): string {
    return join(CLAUDE_DIR, "settings.json");
}

interface HookCommand {
    type?: string;
    command?: string;
    timeout?: number;
}

interface HookMatcher {
    matcher?: string;
    hooks?: HookCommand[];
}

interface ClaudeSettings {
    hooks?: Record<string, HookMatcher[]>;
}

export type HookState = "installed" | "missing";

export async function hookState(path = settingsPath()): Promise<HookState> {
    const settings = await readSettings(path);

    return findEntry(settings) ? "installed" : "missing";
}

/**
 * Add the SessionStart hook, preserving everything else in settings.json — including
 * comments, which is why this goes through SafeJSON (comment-json) rather than a plain
 * parse/stringify round trip. Idempotent: a settings file that already has the hook is
 * left untouched. The previous file is copied to settings.json.bak-<epoch> first,
 * because this rewrites a config the user hand-maintains.
 */
export async function installHook(path = settingsPath()): Promise<{ changed: boolean; backup?: string }> {
    const settings = await readSettings(path);

    if (findEntry(settings)) {
        return { changed: false };
    }

    const backup = `${path}.bak-${Date.now()}`;
    await copyFile(path, backup).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    });

    settings.hooks ??= {};
    settings.hooks.SessionStart ??= [];
    settings.hooks.SessionStart.push({
        hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
    });

    await writeFile(path, `${SafeJSON.stringify(settings, null, 2)}\n`, "utf8");
    logger.debug({ path, backup }, "[claude-cmux] SessionStart hook installed");

    return { changed: true, backup };
}

export async function removeHook(path = settingsPath()): Promise<{ changed: boolean; backup?: string }> {
    const settings = await readSettings(path);
    const entries = settings.hooks?.SessionStart;

    if (!entries || !findEntry(settings)) {
        return { changed: false };
    }

    const backup = `${path}.bak-${Date.now()}`;
    await copyFile(path, backup);

    for (const entry of entries) {
        entry.hooks = entry.hooks?.filter((hook) => hook.command !== HOOK_COMMAND);
    }

    // An entry whose only hook was ours would otherwise linger as an empty matcher.
    settings.hooks!.SessionStart = entries.filter((entry) => (entry.hooks?.length ?? 0) > 0);

    await writeFile(path, `${SafeJSON.stringify(settings, null, 2)}\n`, "utf8");
    logger.debug({ path, backup }, "[claude-cmux] SessionStart hook removed");

    return { changed: true, backup };
}

function findEntry(settings: ClaudeSettings): HookCommand | undefined {
    for (const entry of settings.hooks?.SessionStart ?? []) {
        const hook = entry.hooks?.find((h) => h.command === HOOK_COMMAND);

        if (hook) {
            return hook;
        }
    }

    return undefined;
}

async function readSettings(path: string): Promise<ClaudeSettings> {
    try {
        return SafeJSON.parse(await readFile(path, "utf8")) as ClaudeSettings;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return {};
        }

        throw err;
    }
}

export interface HookPayload {
    session_id?: string;
    cwd?: string;
    source?: string;
}

/** Parse a SessionStart hook payload; anything unusable yields null rather than throwing. */
export function parseHookPayload(raw: string): HookPayload | null {
    if (!raw.trim()) {
        return null;
    }

    try {
        const payload = SafeJSON.parse(raw, { strict: true }) as HookPayload;

        return typeof payload?.session_id === "string" ? payload : null;
    } catch (err) {
        logger.debug({ err }, "[claude-cmux] hook payload was not JSON");
        return null;
    }
}
