import type { RmConfig, RmProfile } from "./config";
import { isSameOrInside, realOrSelf } from "./paths";
import type { RmCaller } from "./rules";

/** The agent name a profile's `match.agent` compares with: `person` for a run outside any agent. */
export function callerAgentName(caller: RmCaller): string {
    return caller.isInAgent ? caller.agent : "person";
}

/**
 * Profiles shipped with tools rm. They apply before the user's own, so a user profile can override them, and each
 * can be turned off with `tools rm config set disable-profile <name>`.
 */
export const BUILTIN_PROFILES: readonly RmProfile[] = [
    {
        name: "person",
        builtin: true,
        match: { agent: "person" },
        // A person at a terminal confirms by typing; without a terminal the paths stay where they are, since no agent
        // is in the way that an aside move would protect them from.
        askAction: "request",
        note: "a run outside any agent leaves what needs confirmation in place",
    },
    {
        name: "workers",
        builtin: true,
        match: { agent: "codex,grok" },
        // Codex and Grok often run as unsupervised workers: their deletions keep a longer undo window.
        grace: { otherMinutes: 240 },
        note: "codex and grok workers: 4 h to undo instead of 1 h",
    },
];

/** The profiles that can apply, in order: the built-in ones not turned off, then the user's. */
export function profilesFor(config: Pick<RmConfig, "profiles" | "disabledProfiles">): RmProfile[] {
    const off = new Set(config.disabledProfiles);
    const own = new Set(config.profiles.map((p) => p.name));
    // A user profile with a built-in's name replaces it.
    return [...BUILTIN_PROFILES.filter((p) => !off.has(p.name) && !own.has(p.name)), ...config.profiles];
}

export function profileMatches(profile: RmProfile, caller: RmCaller, cwd: string): boolean {
    const { agent, session, project, cwd: folder } = profile.match;

    if (
        agent &&
        !agent
            .split(",")
            .map((a) => a.trim())
            .includes(callerAgentName(caller))
    ) {
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

    for (const profile of profilesFor(base)) {
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
