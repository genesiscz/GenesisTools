import { gitMode } from "./git";
import type { DiffStatusConfig, StatusArm, StatusModeId, StatusModeModule, StatusModeSettings } from "./types";

type ModeTable = { readonly [Id in StatusModeId]: { load(): Promise<StatusModeModule<StatusModeSettings[Id]>> } };

/** One row per mode. Only `./git` is a static import: a mode module loads when the config names it. */
export const STATUS_MODES: ModeTable = {
    git: { load: async () => gitMode },
    snapshot: { load: () => import("./snapshot").then((module) => module.snapshotMode) },
    "narrow-git": { load: () => import("./narrow-git").then((module) => module.narrowGitMode) },
};

/** True when the hooks use Git for this command shape (every shape when absent) and no mode runs in shadow. */
export function gitOnly(config: DiffStatusConfig, shape?: "read" | "write"): boolean {
    if (config.shadow.modes.length > 0) {
        return false;
    }

    const reference = gitMode.primary({}).mode;
    return shape
        ? config.active[shape] === reference
        : config.active.read === reference && config.active.write === reference;
}

async function modeArms<Id extends StatusModeId>(id: Id, settings: StatusModeSettings[Id]) {
    const module = await STATUS_MODES[id].load();
    return { primary: module.primary(settings), variants: module.variants(settings) };
}

/**
 * The one place that turns config into arms. `reference` is always the `git` arm; `active` is the primary arm of the
 * mode for this command shape; `shadow` holds every arm of the shadow modes but the reference and the active one.
 */
export async function armsFor(
    config: DiffStatusConfig,
    shape: "read" | "write"
): Promise<{ active: StatusArm; reference: StatusArm; shadow: StatusArm[] }> {
    const reference = gitMode.primary({});
    const activeId = config.active[shape];
    const active = activeId === reference.mode ? reference : (await modeArms(activeId, config.modes[activeId])).primary;
    const shadow: StatusArm[] = [];
    const seen = new Set([reference.id, active.id]);

    for (const id of config.shadow.modes) {
        const arms = await modeArms(id, config.modes[id]);

        for (const arm of [arms.primary, ...arms.variants]) {
            if (!seen.has(arm.id)) {
                seen.add(arm.id);
                shadow.push(arm);
            }
        }
    }

    return { active, reference, shadow };
}
