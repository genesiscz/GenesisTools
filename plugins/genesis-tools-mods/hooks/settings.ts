// The `mods` section of the hooks file as this plugin reads it. No engine types here: the CLI's own tests import
// this file to hold its defaults equal to `src/agents/lib/hooks/config.ts`, outside the plugin's type world.

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `mods` section of the hooks file, one object per feature (`tools agents hooks config set mods.<feature>.<field>`).
 * The CLI keeps the same shape and defaults in `src/agents/lib/hooks/config.ts` (`ModsConfig`); a test holds the two
 * equal, since this plugin runs outside the repository and cannot import it.
 */
export interface ModsSettings {
    diff: { fullDiff: boolean; collapseGitSync: boolean };
    idleCompact: { enabled: boolean; minutes: number; minTokens: number };
    agentModel: { enabled: boolean; format: "label" | "short" };
    /** Read by the CLI's agents panel command (`hooks/agent-row.ts`), not by a hook of this plugin. */
    agentRow: { enabled: boolean; format: "label" | "short" };
    decisions: { enabled: boolean; chip: "any" | "waiting" | "off"; expand: "waiting" | "all" | "none" };
    inbox: { enabled: boolean; chip: "any" | "unread" | "off"; expand: "unread" | "all" | "none" };
    links: { enabled: boolean };
    git: {
        enabled: boolean;
        labels: "full" | "minimal";
        checkouts: number;
        cwd: "touched" | "always";
        expand: "first" | "all" | "none";
        name: "repo-folder" | "repo" | "folder";
        earlier: "show" | "hide";
    };
    askRow: { enabled: boolean };
    spinner: { enabled: boolean };
    cacheBand: { enabled: boolean; warnMinutes: number; cautionMinutes: number; others: boolean };
    tmpUsage: { enabled: boolean; minutes: number };
    agentsBand: { enabled: boolean; warnMinutes: number };
    hooks: { tokens: boolean; dedupe: boolean };
    sidebar: { hints: boolean; feedback: "line" | "toast" | "both"; focus: "command" | "always" | "never" };
    stall: { enabled: boolean; action: "button" | "auto"; minutes: number };
}

/** Every mod past the full diff and the idle compaction starts off: `tools agents hooks mods enable <name> --write`. */
export const MODS_DEFAULTS: ModsSettings = {
    diff: { fullDiff: true, collapseGitSync: true },
    idleCompact: { enabled: true, minutes: 56, minTokens: 200_000 },
    agentModel: { enabled: false, format: "label" },
    agentRow: { enabled: false, format: "label" },
    decisions: { enabled: false, chip: "any", expand: "waiting" },
    inbox: { enabled: false, chip: "any", expand: "none" },
    links: { enabled: false },
    git: {
        enabled: false,
        labels: "full",
        checkouts: 3,
        cwd: "touched",
        expand: "first",
        name: "repo-folder",
        earlier: "show",
    },
    askRow: { enabled: false },
    spinner: { enabled: false },
    cacheBand: { enabled: false, warnMinutes: 10, cautionMinutes: 20, others: true },
    tmpUsage: { enabled: false, minutes: 5 },
    agentsBand: { enabled: false, warnMinutes: 60 },
    hooks: { tokens: false, dedupe: false },
    sidebar: { hints: true, feedback: "line", focus: "command" },
    stall: { enabled: false, action: "button", minutes: 5 },
};

function whole(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

/**
 * The part of `value` that differs from `shipped`: how the CLI's `storedOverrides` (`src/agents/lib/hooks/config.ts`)
 * reads a hooks file. Its writer stores every setting plus the defaults of that day (`_shippedDefaults`), and only a
 * value that differs from that copy is the user's own; the rest follows today's default.
 */
function changedOnly(value: unknown, shipped: unknown): unknown {
    if (Array.isArray(value) || Array.isArray(shipped)) {
        return JSON.stringify(value) === JSON.stringify(shipped) ? undefined : value;
    }

    if (isRecord(value) && isRecord(shipped)) {
        const out: Record<string, unknown> = {};

        for (const [key, held] of Object.entries(value)) {
            const own = changedOnly(held, shipped[key]);

            if (own !== undefined) {
                out[key] = own;
            }
        }

        return Object.keys(out).length > 0 ? out : undefined;
    }

    return value === shipped ? undefined : value;
}

/**
 * The `mods` section of a hooks file, read as the CLI reads it (`changedOnly`), so the two never disagree: on
 * 2026-10-23 a file written while the new mods shipped on kept them on here, while the CLI read them as the new
 * default (off) and its next write turned them off. A missing or broken file, and a value of the wrong kind, keep the
 * default.
 * The flat keys of before 2026-10-23 (`mods.fullDiff`, `mods.collapseGitSync`, `mods.idleCompact` as a boolean,
 * `mods.idleCompactMinutes`, `mods.idleCompactMinTokens`) still count where the object leaves a field out.
 */
export function modsSettings(hooksFile: string | undefined): ModsSettings {
    let held: Record<string, unknown> = {};

    try {
        const stored: unknown = hooksFile === undefined ? undefined : JSON.parse(hooksFile);
        const mods = isRecord(stored) ? stored.mods : undefined;
        const shipped =
            isRecord(stored) && isRecord(stored._shippedDefaults) ? stored._shippedDefaults.mods : undefined;
        const own = shipped === undefined ? mods : changedOnly(mods, shipped);
        held = isRecord(own) ? own : {};
    } catch {
        held = {};
    }

    const part = (key: string): Record<string, unknown> => {
        const value = held[key];

        return isRecord(value) ? value : {};
    };
    const d = MODS_DEFAULTS;
    const diff = part("diff");
    const idle = part("idleCompact");
    const legacyIdle = typeof held.idleCompact === "boolean" ? held.idleCompact : undefined;
    const model = part("agentModel");
    const row = part("agentRow");
    const cache = part("cacheBand");
    const tmp = part("tmpUsage");
    const agents = part("agentsBand");
    const hooks = part("hooks");
    const sidebar = part("sidebar");
    const stall = part("stall");
    const enabled = (key: string, fallback: boolean) => bool(part(key).enabled, fallback);
    const git = part("git");
    const decisions = part("decisions");
    const inbox = part("inbox");

    return {
        diff: {
            fullDiff: bool(diff.fullDiff, bool(held.fullDiff, d.diff.fullDiff)),
            collapseGitSync: bool(diff.collapseGitSync, bool(held.collapseGitSync, d.diff.collapseGitSync)),
        },
        idleCompact: {
            enabled: bool(idle.enabled, legacyIdle ?? d.idleCompact.enabled),
            minutes: whole(idle.minutes, 1, 59, whole(held.idleCompactMinutes, 1, 59, d.idleCompact.minutes)),
            minTokens: whole(
                idle.minTokens,
                0,
                Number.MAX_SAFE_INTEGER,
                whole(held.idleCompactMinTokens, 0, Number.MAX_SAFE_INTEGER, d.idleCompact.minTokens)
            ),
        },
        agentModel: {
            enabled: bool(model.enabled, d.agentModel.enabled),
            format: model.format === "short" || model.format === "label" ? model.format : d.agentModel.format,
        },
        agentRow: {
            enabled: bool(row.enabled, d.agentRow.enabled),
            format: row.format === "short" || row.format === "label" ? row.format : d.agentRow.format,
        },
        decisions: {
            enabled: enabled("decisions", d.decisions.enabled),
            chip:
                decisions.chip === "any" || decisions.chip === "waiting" || decisions.chip === "off"
                    ? decisions.chip
                    : d.decisions.chip,
            expand:
                decisions.expand === "waiting" || decisions.expand === "all" || decisions.expand === "none"
                    ? decisions.expand
                    : d.decisions.expand,
        },
        inbox: {
            enabled: enabled("inbox", d.inbox.enabled),
            chip: inbox.chip === "any" || inbox.chip === "unread" || inbox.chip === "off" ? inbox.chip : d.inbox.chip,
            expand:
                inbox.expand === "unread" || inbox.expand === "all" || inbox.expand === "none"
                    ? inbox.expand
                    : d.inbox.expand,
        },
        links: { enabled: enabled("links", d.links.enabled) },
        git: {
            enabled: enabled("git", d.git.enabled),
            labels: git.labels === "full" || git.labels === "minimal" ? git.labels : d.git.labels,
            checkouts: whole(git.checkouts, 1, 6, d.git.checkouts),
            cwd: git.cwd === "touched" || git.cwd === "always" ? git.cwd : d.git.cwd,
            expand: git.expand === "first" || git.expand === "all" || git.expand === "none" ? git.expand : d.git.expand,
            name: git.name === "repo-folder" || git.name === "repo" || git.name === "folder" ? git.name : d.git.name,
            earlier: git.earlier === "show" || git.earlier === "hide" ? git.earlier : d.git.earlier,
        },
        askRow: { enabled: enabled("askRow", d.askRow.enabled) },
        spinner: { enabled: enabled("spinner", d.spinner.enabled) },
        cacheBand: {
            enabled: bool(cache.enabled, d.cacheBand.enabled),
            warnMinutes: whole(cache.warnMinutes, 1, 59, d.cacheBand.warnMinutes),
            cautionMinutes: whole(cache.cautionMinutes, 1, 59, d.cacheBand.cautionMinutes),
            others: bool(cache.others, d.cacheBand.others),
        },
        tmpUsage: {
            enabled: bool(tmp.enabled, d.tmpUsage.enabled),
            minutes: whole(tmp.minutes, 1, 120, d.tmpUsage.minutes),
        },
        agentsBand: {
            enabled: bool(agents.enabled, d.agentsBand.enabled),
            warnMinutes: whole(agents.warnMinutes, 1, 24 * 60, d.agentsBand.warnMinutes),
        },
        hooks: { tokens: bool(hooks.tokens, d.hooks.tokens), dedupe: bool(hooks.dedupe, d.hooks.dedupe) },
        sidebar: {
            hints: bool(sidebar.hints, d.sidebar.hints),
            feedback:
                sidebar.feedback === "line" || sidebar.feedback === "toast" || sidebar.feedback === "both"
                    ? sidebar.feedback
                    : d.sidebar.feedback,
            focus:
                sidebar.focus === "command" || sidebar.focus === "always" || sidebar.focus === "never"
                    ? sidebar.focus
                    : d.sidebar.focus,
        },
        stall: {
            enabled: bool(stall.enabled, d.stall.enabled),
            action: stall.action === "button" || stall.action === "auto" ? stall.action : d.stall.action,
            minutes: whole(stall.minutes, 1, 120, d.stall.minutes),
        },
    };
}
