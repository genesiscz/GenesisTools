import type { RmConfig, RmProfile } from "./config";
import { isSameOrInside, realOrSelf } from "./paths";
import type { RmCaller } from "./rules";

/** The agent name a profile's `match.agent` compares with: `person` for a run outside any agent. */
export function callerAgentName(caller: RmCaller): string {
    return caller.isInAgent ? caller.agent : "person";
}

export function profileMatches(profile: RmProfile, caller: RmCaller, cwd: string): boolean {
    const { agent, session, project, cwd: folder } = profile.match;

    if (agent && agent !== callerAgentName(caller)) {
        return false;
    }

    if (session && !caller.sessionId?.startsWith(session)) {
        return false;
    }

    if (project && project !== caller.project) {
        return false;
    }

    if (folder && !isSameOrInside(realOrSelf(cwd), realOrSelf(folder))) {
        return false;
    }

    return true;
}

export interface EffectiveConfig {
    config: RmConfig;
    /** The names of the profiles that matched, in the order they applied. */
    applied: string[];
}

/**
 * The config this caller runs under: the base settings, then each matching profile in order. A profile's lists
 * (roots, protect, disabled presets) add to the base; its scalars (ask action, grace, the scratch and own-file rules)
 * replace it. The trash root and the profiles themselves are never changed by a profile.
 */
export function effectiveConfig(base: RmConfig, caller: RmCaller, cwd: string): EffectiveConfig {
    const applied: string[] = [];
    let config: RmConfig = base;

    for (const profile of base.profiles) {
        if (!profileMatches(profile, caller, cwd)) {
            continue;
        }

        applied.push(profile.name);
        const addedAt = "";
        config = {
            ...config,
            askAction: profile.askAction ?? config.askAction,
            asideUnsaved: profile.asideUnsaved ?? config.asideUnsaved,
            allowSessionScratch: profile.allowSessionScratch ?? config.allowSessionScratch,
            allowOwnFiles: profile.allowOwnFiles ?? config.allowOwnFiles,
            grace: {
                presetMinutes: profile.grace?.presetMinutes ?? config.grace.presetMinutes,
                otherMinutes: profile.grace?.otherMinutes ?? config.grace.otherMinutes,
            },
            disabledPresets: [...config.disabledPresets, ...(profile.disabledPresets ?? [])],
            protect: [...config.protect, ...(profile.protect ?? [])],
            roots: [
                ...config.roots,
                ...(profile.roots ?? []).map((path) => ({ path, addedAt, via: `profile:${profile.name}` })),
            ],
        };
    }

    return { config, applied };
}
