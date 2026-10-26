/**
 * Claude Code saves a `/model` pick as `model` in the settings of its config folder, and every Claude Code that reads
 * that folder takes it as its default on its next settings reload. A `tools claude codex` session shares ~/.claude
 * (P15), so `/model codex/gpt-6-astra` there became the default of every other session, which sent the id straight to
 * Anthropic: "automatic compaction failed … codex/gpt-6-astra … may not exist" (2026-10-25 23:25 to 2026-10-26 00:39).
 * While the session runs, this guard puts back the model the file had at launch whenever a session-only id lands
 * there. The session keeps its own pick in memory.
 */
import {
    chmodSync,
    existsSync,
    type FSWatcher,
    readFileSync,
    renameSync,
    statSync,
    watch,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { nativeHome } from "@genesiscz/utils/providers/session-paths";

/** A model id only a proxy session can run: `codex/…` and `grok/…` mean nothing to Anthropic's API. */
export function isSessionOnlyModel(model: unknown): model is string {
    return typeof model === "string" && /^(codex|grok)\//i.test(model.trim());
}

/** The settings file every Claude Code on this machine shares (the config folder without CLAUDE_CONFIG_DIR). */
export function sharedClaudeSettingsPath(): string {
    return join(nativeHome("claude", env.paths.getHome()), "settings.json");
}

function readSettings(path: string): Record<string, unknown> | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        return isObject(parsed) ? parsed : undefined;
    } catch (err) {
        // Caught mid-write: the next change event reads it again.
        logger.debug(
            { err, path },
            "[codex] settings unreadable for the model guard; checked again on the next change"
        );
        return undefined;
    }
}

/**
 * One check: when the file's `model` is a session-only id, write back `launchModel` (or drop the key when the file
 * had none), changing nothing else. Returns the id it removed.
 */
export function restoreSharedModel(path: string, launchModel: string | undefined): string | undefined {
    const settings = readSettings(path);

    if (!settings || !isSessionOnlyModel(settings.model)) {
        return undefined;
    }

    const removed = settings.model;

    if (launchModel === undefined) {
        delete settings.model;
    } else {
        settings.model = launchModel;
    }

    const mode = statSync(path).mode & 0o777;
    const tmp = join(dirname(path), `.${basename(path)}.model-guard-${process.pid}`);
    writeFileSync(tmp, `${SafeJSON.stringify(settings, null, 2)}\n`, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
    logger.warn(
        { path, removed, restored: launchModel ?? "(no model key)" },
        "[codex] a session-only model reached the shared Claude settings; put back the launch value"
    );
    return removed;
}

/**
 * How often the guard re-checks the settings without an event. On Bun 1.3.13 an `fs.watch` created after another
 * watcher closed in the same process can go deaf (.claude/rules/code.md), and a missed save would leave a session-only
 * model in every other session's default.
 */
export const SETTINGS_GUARD_POLL_MS = 5_000;

export interface SharedModelGuardOptions {
    pollMs?: number;
    /** The folder watch; a test passes one that never fires, as a deaf `fs.watch` would. */
    watchFolder?: (folder: string, onChange: (name: string | null) => void) => Pick<FSWatcher, "close">;
}

function watchFolder(folder: string, onChange: (name: string | null) => void): Pick<FSWatcher, "close"> {
    return watch(folder, (_event, name) => onChange(name));
}

/** Watch the shared settings for the session's lifetime; `stop()` ends the watch after one last check. */
export function guardSharedModel(
    path: string = sharedClaudeSettingsPath(),
    options: SharedModelGuardOptions = {}
): { launchModel?: string; stop(): void } {
    const atLaunch = readSettings(path)?.model;
    // A file that already holds a session-only id is broken for every other session: repaired, not kept.
    const launchModel = typeof atLaunch === "string" && !isSessionOnlyModel(atLaunch) ? atLaunch : undefined;
    restoreSharedModel(path, launchModel);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: Pick<FSWatcher, "close"> | undefined;
    // A timer callback that throws would end the launcher mid-session: a failed check is logged and the next one retries.
    const check = (): void => {
        try {
            restoreSharedModel(path, launchModel);
        } catch (err) {
            logger.warn({ err, path }, "[codex] the shared-settings model check failed; the next check retries");
        }
    };

    try {
        // The folder, not the file: an atomic save replaces the file, which ends a watch on the old one.
        watcher = (options.watchFolder ?? watchFolder)(dirname(path), (name) => {
            if (name !== basename(path)) {
                return;
            }

            clearTimeout(timer);
            timer = setTimeout(check, 50);
        });
    } catch (err) {
        logger.warn({ err, path }, "[codex] cannot watch the shared Claude settings; the slow check still runs");
    }

    // The safety check behind the watch: cheap (one small read), and it catches a save the watch missed.
    const poll = setInterval(check, options.pollMs ?? SETTINGS_GUARD_POLL_MS);
    poll.unref();

    return {
        ...(launchModel === undefined ? {} : { launchModel }),
        stop() {
            clearTimeout(timer);
            clearInterval(poll);
            watcher?.close();
            restoreSharedModel(path, launchModel);
        },
    };
}
