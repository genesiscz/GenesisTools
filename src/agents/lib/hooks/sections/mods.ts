import {
    asBoolean,
    asCount,
    boolOr,
    countOr,
    type HookConfigSection,
    listed,
    oneOf,
    partOf,
} from "@genesiscz/utils/agents/hooks/config-section";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ModsConfig } from "../config";

// Every mod past the full diff and the idle compaction starts off: `tools agents hooks mods enable <name> --write`.
const DEFAULT_MODS: ModsConfig = {
    diff: { fullDiff: true, collapseGitSync: true },
    idleCompact: { enabled: true, minutes: 56, minTokens: 200_000 },
    agentModel: { enabled: false, format: "label" },
    agentRow: { enabled: false, format: "version", effort: true },
    decisions: { enabled: false, chip: "any", expand: "waiting", history: "collapsed", enter: "stage-then-send" },
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
    log: { readings: false },
    sidebar: { hints: true, feedback: "line", focus: "command" },
    stall: { enabled: false, action: "button", minutes: 5 },
};

/**
 * Field by field, like `diff`: a stored value of the wrong type falls back to the default. The flat keys of before
 * 2026-10-23 (`mods.fullDiff`, `mods.collapseGitSync`, `mods.idleCompact` as a boolean, `mods.idleCompactMinutes`,
 * `mods.idleCompactMinTokens`) still count where the object leaves a field out; the next write stores the objects.
 */
function mergeMods(stored: unknown, problems: string[]): ModsConfig {
    const base = DEFAULT_MODS;
    const held = partOf(stored);
    const diff = partOf(held.diff);
    const idle = partOf(held.idleCompact);
    const legacyIdle = typeof held.idleCompact === "boolean" ? held.idleCompact : undefined;
    const model = partOf(held.agentModel);
    const row = partOf(held.agentRow);
    const cache = partOf(held.cacheBand);
    const tmp = partOf(held.tmpUsage);
    const agents = partOf(held.agentsBand);
    const hooks = partOf(held.hooks);
    const log = partOf(held.log);
    const sidebar = partOf(held.sidebar);
    const stall = partOf(held.stall);
    const enabled = (key: string, fallback: boolean) => boolOr(partOf(held[key]).enabled, fallback);
    const git = partOf(held.git);
    const decisions = partOf(held.decisions);
    const inbox = partOf(held.inbox);
    const minutes = countOr(problems, {
        field: "mods.idleCompact.minutes",
        value: idle.minutes ?? held.idleCompactMinutes,
        fallback: base.idleCompact.minutes,
    });

    return {
        diff: {
            fullDiff: boolOr(diff.fullDiff, boolOr(held.fullDiff, base.diff.fullDiff)),
            collapseGitSync: boolOr(diff.collapseGitSync, boolOr(held.collapseGitSync, base.diff.collapseGitSync)),
        },
        idleCompact: {
            enabled: boolOr(idle.enabled, legacyIdle ?? base.idleCompact.enabled),
            // The mod reads the file itself and drops 60 or more the same way.
            minutes: minutes < 60 ? minutes : base.idleCompact.minutes,
            minTokens: countOr(problems, {
                field: "mods.idleCompact.minTokens",
                value: idle.minTokens ?? held.idleCompactMinTokens,
                fallback: base.idleCompact.minTokens,
                min: 0,
            }),
        },
        agentModel: {
            enabled: boolOr(model.enabled, base.agentModel.enabled),
            format: oneOf(model.format, ["label", "short", "version"], base.agentModel.format),
        },
        agentRow: {
            enabled: boolOr(row.enabled, base.agentRow.enabled),
            format: oneOf(row.format, ["label", "short", "version"], base.agentRow.format),
            effort: boolOr(row.effort, base.agentRow.effort),
        },
        decisions: {
            enabled: enabled("decisions", base.decisions.enabled),
            chip: oneOf(decisions.chip, ["any", "waiting", "off"], base.decisions.chip),
            expand: oneOf(decisions.expand, ["waiting", "all", "none"], base.decisions.expand),
            history: oneOf(decisions.history, ["collapsed", "shown"], base.decisions.history),
            enter: oneOf(decisions.enter, ["stage-then-send", "stage"], base.decisions.enter),
        },
        inbox: {
            enabled: enabled("inbox", base.inbox.enabled),
            chip: oneOf(inbox.chip, ["any", "unread", "off"], base.inbox.chip),
            expand: oneOf(inbox.expand, ["unread", "all", "none"], base.inbox.expand),
        },
        links: { enabled: enabled("links", base.links.enabled) },
        git: {
            enabled: enabled("git", base.git.enabled),
            labels: git.labels === "full" || git.labels === "minimal" ? git.labels : base.git.labels,
            checkouts: minutesOr(problems, "mods.git.checkouts", git.checkouts, base.git.checkouts, 6),
            cwd: git.cwd === "touched" || git.cwd === "always" ? git.cwd : base.git.cwd,
            expand:
                git.expand === "first" || git.expand === "all" || git.expand === "none" ? git.expand : base.git.expand,
            name: git.name === "repo-folder" || git.name === "repo" || git.name === "folder" ? git.name : base.git.name,
            earlier: git.earlier === "show" || git.earlier === "hide" ? git.earlier : base.git.earlier,
        },
        askRow: { enabled: enabled("askRow", base.askRow.enabled) },
        spinner: { enabled: enabled("spinner", base.spinner.enabled) },
        cacheBand: {
            enabled: boolOr(cache.enabled, base.cacheBand.enabled),
            warnMinutes: minutesOr(
                problems,
                "mods.cacheBand.warnMinutes",
                cache.warnMinutes,
                base.cacheBand.warnMinutes,
                59
            ),
            cautionMinutes: minutesOr(
                problems,
                "mods.cacheBand.cautionMinutes",
                cache.cautionMinutes,
                base.cacheBand.cautionMinutes,
                59
            ),
            others: boolOr(cache.others, base.cacheBand.others),
        },
        tmpUsage: {
            enabled: boolOr(tmp.enabled, base.tmpUsage.enabled),
            minutes: minutesOr(problems, "mods.tmpUsage.minutes", tmp.minutes, base.tmpUsage.minutes, 120),
        },
        agentsBand: {
            enabled: boolOr(agents.enabled, base.agentsBand.enabled),
            warnMinutes: minutesOr(
                problems,
                "mods.agentsBand.warnMinutes",
                agents.warnMinutes,
                base.agentsBand.warnMinutes,
                24 * 60
            ),
        },
        hooks: { tokens: boolOr(hooks.tokens, base.hooks.tokens), dedupe: boolOr(hooks.dedupe, base.hooks.dedupe) },
        log: { readings: boolOr(log.readings, base.log.readings) },
        sidebar: {
            hints: boolOr(sidebar.hints, base.sidebar.hints),
            feedback:
                sidebar.feedback === "line" || sidebar.feedback === "toast" || sidebar.feedback === "both"
                    ? sidebar.feedback
                    : base.sidebar.feedback,
            focus:
                sidebar.focus === "command" || sidebar.focus === "always" || sidebar.focus === "never"
                    ? sidebar.focus
                    : base.sidebar.focus,
        },
        stall: {
            enabled: boolOr(stall.enabled, base.stall.enabled),
            action: stall.action === "button" || stall.action === "auto" ? stall.action : base.stall.action,
            minutes: minutesOr(problems, "mods.stall.minutes", stall.minutes, base.stall.minutes, 120),
        },
    };
}

/** A whole number of minutes from 1 to `max`, as the plugin reads it; else the default. */
function minutesOr(problems: string[], field: string, value: unknown, fallback: number, max: number): number {
    const minutes = countOr(problems, { field, value, fallback });

    return minutes <= max ? minutes : fallback;
}

/** The flat keys of before 2026-10-23, still taken; `mods.<feature>` alone means its `enabled`. */
const MOD_ALIASES: Record<string, string> = {
    "mods.fullDiff": "mods.diff.fullDiff",
    "mods.collapseGitSync": "mods.diff.collapseGitSync",
    "mods.idleCompactMinutes": "mods.idleCompact.minutes",
    "mods.idleCompactMinTokens": "mods.idleCompact.minTokens",
};

/** The highest whole number each numeric mods field takes, and the lowest when it is not 1. */
const MOD_NUMBER_LIMITS: Record<string, { max: number; min?: number; why: string }> = {
    "idleCompact.minutes": { max: 59, why: "at 60 the 1-hour prompt cache has expired" },
    "idleCompact.minTokens": { max: Number.MAX_SAFE_INTEGER, min: 0, why: "" },
    "cacheBand.warnMinutes": { max: 59, why: "the cache lives 60 minutes" },
    "cacheBand.cautionMinutes": { max: 59, why: "the cache lives 60 minutes" },
    "tmpUsage.minutes": { max: 120, why: "a reading older than 2 hours says little" },
    "git.checkouts": { max: 6, why: "each checkout takes a row above the prompt" },
    "agentsBand.warnMinutes": { max: 24 * 60, why: "a day" },
    "stall.minutes": { max: 120, why: "a reply left two hours is no longer a stall to resume" },
};

/** The values each text mods field takes, as `--help` and an error list them. */
const MOD_CHOICES: Record<string, readonly string[]> = {
    "agentModel.format": ["label", "short", "version"],
    "agentRow.format": ["label", "short", "version"],
    "decisions.chip": ["any", "waiting", "off"],
    "decisions.expand": ["waiting", "all", "none"],
    "decisions.history": ["collapsed", "shown"],
    "decisions.enter": ["stage-then-send", "stage"],
    "inbox.chip": ["any", "unread", "off"],
    "inbox.expand": ["unread", "all", "none"],
    "git.labels": ["full", "minimal"],
    "git.cwd": ["touched", "always"],
    "git.expand": ["first", "all", "none"],
    "git.name": ["repo-folder", "repo", "folder"],
    "git.earlier": ["show", "hide"],
    "sidebar.feedback": ["line", "toast", "both"],
    "sidebar.focus": ["command", "always", "never"],
    "stall.action": ["button", "auto"],
};

function isFields(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One `mods.<feature>.<field>` key, checked against the type of the field's default. */
function withMods(mods: ModsConfig, key: string, value: string): ModsConfig {
    const path = MOD_ALIASES[key] ?? key;
    const [, feature = "", field = "enabled"] = path.split(".");
    const base = new Map<string, unknown>(Object.entries(DEFAULT_MODS)).get(feature);
    const held = new Map<string, unknown>(Object.entries(mods)).get(feature);

    if (!isFields(base) || !isFields(held) || !(field in base)) {
        throw new Error(`Unknown mods key ${SafeJSON.stringify(key)}; see the mods.* keys in --help`);
    }

    const part = { ...held };
    const sample = base[field];

    if (typeof sample === "boolean") {
        part[field] = asBoolean(key, value);
    } else if (typeof sample === "number") {
        const limit = MOD_NUMBER_LIMITS[`${feature}.${field}`];
        const count = asCount(key, value, limit?.min ?? 1);

        if (limit && count > limit.max) {
            throw new Error(`${key} takes ${limit.min ?? 1} to ${limit.max}: ${limit.why}`);
        }

        part[field] = count;
    } else {
        const choices = MOD_CHOICES[`${feature}.${field}`];

        if (choices && !choices.includes(value)) {
            throw new Error(`${key} takes ${listed(choices)}, not ${SafeJSON.stringify(value)}`);
        }

        if (choices) {
            part[field] = value;
        }
    }

    return mergeMods({ ...mods, [feature]: part }, []);
}

/** The Claude Code mods' part of `hooks.json`. The plugin reads it itself, so a change needs no reinstall. */
export const MODS_HOOK_SECTION: HookConfigSection<ModsConfig> = {
    key: "mods",
    defaults: () => structuredClone(DEFAULT_MODS),
    merge: mergeMods,
    settable: [
        "mods.diff.<fullDiff|collapseGitSync>",
        "mods.idleCompact.<enabled|minutes|minTokens>",
        "mods.agentModel.<enabled|format>",
        "mods.agentRow.<enabled|format|effort>",
        "mods.<decisions|inbox|links|git|askRow|spinner>.enabled",
        "mods.decisions.<chip|expand|history|enter>",
        "mods.inbox.<chip|expand>",
        "mods.git.<labels|checkouts|cwd|expand|name|earlier>",
        "mods.cacheBand.<enabled|warnMinutes|cautionMinutes|others>",
        "mods.tmpUsage.<enabled|minutes>",
        "mods.agentsBand.<enabled|warnMinutes>",
        "mods.hooks.<tokens|dedupe>",
        "mods.sidebar.<hints|feedback|focus>",
        "mods.stall.<enabled|action|minutes>",
        "mods.log.<readings>",
    ],
    owns: (key) => key.startsWith("mods."),
    set: withMods,
    // The mods plugin wires its own hooks (`tools agents hooks mods install`); `subagentStatusLine` for the agents
    // panel rows is wired by the installer beside the entries.
    entries: () => [],
    doctor: () => [],
};
