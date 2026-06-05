import { logger } from "@app/logger";
import { captureTmuxSnapshot, restoreTmuxSession, SNAPSHOT_VERSION, type TmuxPreset } from "@app/utils/tmux/snapshot";
import { TmuxPresetStore, type TmuxPresetSummary } from "@app/utils/tmux/snapshot-store";

export interface SavePresetInput {
    name: string;
    note?: string;
    /** Optional name-prefix filter (same as the CLI --prefix). */
    prefix?: string;
}

export interface TmuxRestoreOutcome {
    name: string;
    sessionName: string;
    created: boolean;
    skipped: boolean;
    reason?: string;
}

export interface RestorePresetResult {
    name: string;
    created: number;
    skipped: number;
    failed: number;
    outcomes: TmuxRestoreOutcome[];
}

function resolveStore(store?: TmuxPresetStore): TmuxPresetStore {
    return store ?? new TmuxPresetStore();
}

export function listPresets(store?: TmuxPresetStore): TmuxPresetSummary[] {
    return resolveStore(store).list();
}

export function savePreset(input: SavePresetInput, store?: TmuxPresetStore): TmuxPresetSummary {
    const s = resolveStore(store);
    const name = input.name.trim();

    if (!name) {
        throw new Error("Preset name is required.");
    }

    const sessions = captureTmuxSnapshot({ prefix: input.prefix });

    if (sessions.length === 0) {
        throw new Error(
            input.prefix
                ? `No tmux sessions match prefix "${input.prefix}".`
                : "No tmux sessions to capture (is tmux running?)."
        );
    }

    const preset: TmuxPreset = {
        version: SNAPSHOT_VERSION,
        name,
        capturedAt: new Date().toISOString(),
        note: input.note?.trim() || undefined,
        sessions,
    };

    // force:true — saving from the phone overwrites a same-named preset by design
    // (the UI confirms before calling; no second "already exists" round-trip).
    s.write(name, preset, { force: true });
    logger.info({ name, sessions: preset.sessions.length }, "[tmux-presets] saved preset");
    return s.summarize(preset);
}

export function restorePreset(name: string, store?: TmuxPresetStore): RestorePresetResult {
    const s = resolveStore(store);
    const preset = s.read(name);

    const outcomes: TmuxRestoreOutcome[] = [];
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const session of preset.sessions) {
        try {
            const outcome = restoreTmuxSession(session);
            outcomes.push(outcome);

            if (outcome.created) {
                created += 1;
            } else if (outcome.skipped) {
                skipped += 1;
            }
        } catch (error) {
            failed += 1;
            logger.error({ error, sessionName: session.name }, "[tmux-presets] restore failed");
            outcomes.push({
                name: session.name,
                sessionName: session.name,
                created: false,
                skipped: false,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { name, created, skipped, failed, outcomes };
}

export function deletePreset(name: string, store?: TmuxPresetStore): { removed: boolean } {
    return { removed: resolveStore(store).delete(name) };
}
