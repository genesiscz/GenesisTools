import { logger } from "@app/logger";
import { ensureTmuxServerPersists } from "@app/utils/tmux/sessions";
import {
    captureTmuxSnapshot,
    killTmuxSessionsMatching,
    type RestoreOutcome,
    restoreTmuxSession,
    SNAPSHOT_VERSION,
    type TmuxPreset,
    type TmuxSessionSnapshot,
} from "@app/utils/tmux/snapshot";
import { TmuxPresetStore } from "@app/utils/tmux/snapshot-store";

export interface ResetTargets {
    sessions: TmuxSessionSnapshot[];
    /** Descriptive label for the backup note / plan header, e.g. `session "foo"`. */
    label: string;
    /** Backup preset name without the timestamp suffix. */
    backupBase: string;
    /** True when targeting a single exact session (affects messaging only). */
    single: boolean;
}

export type ResetSelection = { ok: true; targets: ResetTargets } | { ok: false; error: string };

export interface ResetCoreOptions {
    skipReplay?: boolean;
    preset?: string;
    skipBackup?: boolean;
}

export interface ResetResult {
    presetName: string;
    presetPath?: string;
    /** Set when the backup write failed and the reset was aborted before killing. */
    backupError?: string;
    aborted: boolean;
    killed: string[];
    outcomes: RestoreOutcome[];
    failures: Array<{ name: string; error: unknown }>;
}

type CaptureFn = (prefix?: string) => TmuxSessionSnapshot[];

export function sanitize(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function backupStamp(now: Date): string {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    return `${yyyy}${mm}${dd}-${hh}${min}`;
}

/**
 * Resolve which sessions a `reset` targets. `<sessionId>` (exact, single) and
 * `--matching <pattern>` (prefix, many) are mutually exclusive; exactly one is
 * required. `capture` is injectable so resolution is unit-testable without tmux.
 */
export function selectResetTargets(
    opts: { sessionId?: string; matching?: string },
    capture: CaptureFn = (prefix) => captureTmuxSnapshot({ prefix })
): ResetSelection {
    const sessionId = opts.sessionId?.trim();
    const matching = opts.matching?.trim();

    if (sessionId && matching) {
        return { ok: false, error: "Pass either a <sessionId> or --matching <pattern>, not both." };
    }

    if (!sessionId && !matching) {
        return { ok: false, error: "Pass a <sessionId> to reset one session, or --matching <pattern> for many." };
    }

    if (matching) {
        const sessions = capture(matching);

        if (sessions.length === 0) {
            return { ok: false, error: `No tmux sessions match prefix "${matching}".` };
        }

        return {
            ok: true,
            targets: {
                sessions,
                label: `prefix "${matching}"`,
                backupBase: `reset-${sanitize(matching)}`,
                single: false,
            },
        };
    }

    const captured = capture(sessionId);
    const exact = captured.filter((s) => s.name === sessionId);

    if (exact.length === 0) {
        return { ok: false, error: `No tmux session named "${sessionId}".` };
    }

    return {
        ok: true,
        targets: {
            sessions: exact,
            label: `session "${sessionId}"`,
            backupBase: `reset-${sanitize(sessionId ?? "")}`,
            single: true,
        },
    };
}

/**
 * Non-interactive reset core: back up the targeted sessions, scrub + pin the tmux
 * server, kill them, then recreate from the snapshot. No prompts and no terminal
 * output — returns a result the caller renders. Reusable by the dev-dashboard
 * server (its "recycle dev-dashboard-* sessions" flow) without shelling out.
 */
export function resetSessions(opts: { targets: ResetTargets; options: ResetCoreOptions; now?: Date }): ResetResult {
    const { targets, options } = opts;
    const now = opts.now ?? new Date();
    const { sessions } = targets;
    const presetName = options.preset?.trim() || `${targets.backupBase}-${backupStamp(now)}`;
    const store = new TmuxPresetStore();
    const result: ResetResult = { presetName, aborted: false, killed: [], outcomes: [], failures: [] };

    if (!options.skipBackup) {
        const preset: TmuxPreset = {
            version: SNAPSHOT_VERSION,
            name: presetName,
            capturedAt: now.toISOString(),
            note: `reset backup for ${targets.label}`,
            sessions,
        };

        try {
            result.presetPath = store.write(presetName, preset, { force: true });
        } catch (error) {
            logger.error({ error, presetName }, "[tmux reset] backup failed");
            result.backupError = error instanceof Error ? error.message : String(error);
            result.aborted = true;
            return result;
        }
    }

    // Scrub the server's global env BEFORE killing so the recreated shells don't
    // re-inherit NO_COLOR / empty COLORTERM leaked by whichever process founded it.
    ensureTmuxServerPersists();

    result.killed = killTmuxSessionsMatching(sessions.map((s) => s.name));

    for (const session of sessions) {
        try {
            const outcome = restoreTmuxSession(session, { skipReplay: options.skipReplay });
            result.outcomes.push(outcome);
        } catch (error) {
            result.failures.push({ name: session.name, error });
            logger.error({ error, sessionName: session.name }, "[tmux reset] restore failed");
        }
    }

    return result;
}
