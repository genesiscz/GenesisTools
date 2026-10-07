/**
 * `~/.genesis-tools/gitlab/config.json`. Every field is optional; a missing file means the defaults.
 * Nothing here names a host or a project: those come from flags, the environment, glab and git.
 * `defaults.ts` can lay company-specific values over the neutral ones; the user's file wins over both.
 */

import { DATE_STYLES, type DateStyle, setDateStyle } from "@app/gitlab/lib/dates";
import { defaults } from "@app/gitlab/lib/defaults";
import {
    createMessages,
    MESSAGE_KEYS,
    MESSAGE_LANGUAGES,
    type MessageKey,
    type MessageLanguage,
    type Messages,
} from "@app/gitlab/lib/messages";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";

/** Where the content check looks for an MR's lines, by environment. Branch names, without `origin/`. */
export interface EnvironmentBranches {
    /** Branch deployed to UAT or staging. Null when there is no such environment. */
    uat: string | null;
    /** Branch that is production. Null means the project's default branch. */
    production: string | null;
    /**
     * Prefix of dated release branches, for example `release/`: the newest `release/<YYYY-MM-DD>`
     * whose date is not in the future is production, and wins over `production`.
     */
    releasePrefix: string | null;
    /** Branch deployed to the test environment. Null when there is no such environment. */
    test: string | null;
}

export interface WorkItemConfig {
    /**
     * Regular expression with one capture group that finds an Azure DevOps work-item id in an MR
     * title, branch name or description. Null turns work-item lookups off.
     */
    idPattern: string | null;
    /** Web URL of a work item with `{id}` in it, for items that cannot be read. */
    urlTemplate: string | null;
    /** Reference name of a custom field holding the environment the item was tested on. */
    environmentField: string | null;
    /** Reference name of a custom field holding the MR URL somebody typed into the item. */
    mergeRequestField: string | null;
}

export interface StaleConfig {
    /** The label `stale-branches` puts on MRs it notified. */
    label: string;
    /** Labels that claim a merge state (`NOT merged into develop`), checked against the content; case-insensitive. */
    mergeLabelPattern: string;
    environments: EnvironmentBranches;
    /** Replaces the default guidance for `review.draftComment` in the preflight JSON instructions. */
    draftCommentGuide: string | null;
    /** Appended to the preflight JSON instructions: house style for the drafted comment, where evidence lives. */
    instructionsExtra: string | null;
    /** Extra front-matter tags of the rendered note. */
    noteTags: string[];
    /** Appended to the note's explanation of the content check, for facts about the branches it searched. */
    contentCheckNote: string | null;
}

/** One check a reviewer runs in the MR checkout before calling it clean, listed by `pr review`. */
export interface ReviewGate {
    label: string;
    /**
     * Shell command. `{files}` is replaced by the changed files the gate applies to, `{tests}` by the
     * changed test files plus the test file next to each changed source file, within `when`.
     */
    command: string;
    /** Glob over changed paths (`*.ts`, `app/**`); the gate is listed only when a changed file matches. Null = always. */
    when: string | null;
    /** Glob of paths removed from `{files}` and `{tests}` (and from what `when` matches). Null = none. */
    exclude: string | null;
}

export const GATE_RUNNERS = ["list", "parallel"] as const;
/** `list`: the commands one after another. `parallel`: each gate as a background `tools task` session, then every exit code. */
export type GateRunner = (typeof GATE_RUNNERS)[number];

export const IMPACT_SOURCES = ["api", "git"] as const;
/** `api`: one diffs request per other MR, capped. `git`: fetch every open branch and diff locally, no cap. */
export type ImpactSource = (typeof IMPACT_SOURCES)[number];

export const FETCH_FORMATS = ["json", "md", "both"] as const;
export type FetchFormat = (typeof FETCH_FORMATS)[number];

/** Defaults of `fetch-review` when its flags are not given. */
export interface FetchReviewConfig {
    format: FetchFormat;
    contextLines: number;
}

export interface ReviewConfig {
    gates: ReviewGate[];
    runner: GateRunner;
    fetch: FetchReviewConfig;
    /** Extra bullets under "Next steps" in the receive report. */
    nextSteps: string[];
    /** How `review --give` scans the other open MRs when `--impact-source` is not given. */
    impactSource: ImpactSource;
    /** Replaces the "create a worktree" advice when no worktree has the MR branch; `{branch}` and `{iid}` are filled in. */
    worktreeHint: string | null;
}

export interface GitLabToolConfig {
    /** Language of the texts `stale-branches` writes onto merge requests. */
    language: MessageLanguage;
    dateStyle: DateStyle;
    /** Per-key text overrides; see `MESSAGE_KEYS`. */
    messages: Partial<Record<MessageKey, string>>;
    workItems: WorkItemConfig;
    stale: StaleConfig;
    review: ReviewConfig;
}

/** The built-in defaults, before `defaults.ts` and the user's file. Tests assert against these. */
export const NEUTRAL_CONFIG: GitLabToolConfig = {
    language: "en",
    dateStyle: "iso",
    messages: {},
    workItems: {
        idPattern: null,
        urlTemplate: null,
        environmentField: null,
        mergeRequestField: null,
    },
    stale: {
        label: "Stale",
        mergeLabelPattern: "^(NOT\\s+)?merged into (\\S+)$",
        environments: { uat: null, production: null, releasePrefix: null, test: null },
        draftCommentGuide: null,
        instructionsExtra: null,
        noteTags: [],
        contentCheckNote: null,
    },
    review: {
        gates: [],
        runner: "list",
        fetch: { format: "json", contextLines: 3 },
        nextSteps: [],
        impactSource: "api",
        worktreeHint: null,
    },
};

/** `NEUTRAL_CONFIG` under `defaults.config`, checked like a config file. */
export const DEFAULT_CONFIG: GitLabToolConfig = mergeConfig(defaults.config, NEUTRAL_CONFIG);

export const storage = new Storage(defaults.storageName);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An absent section is the defaults; a present one must be an object. `"stale": false` used to
 * read as "no section" and silently threw away every stale setting the user had written.
 */
function section(value: unknown, field: string): Record<string, unknown> {
    if (value === undefined) {
        return {};
    }

    if (!isRecord(value)) {
        throw new Error(`gitlab config: ${field} must be an object, got ${SafeJSON.stringify(value)}`);
    }

    return value;
}

function stringOrNull(value: unknown, field: string, fallback: string | null): string | null {
    if (value === undefined) {
        return fallback;
    }

    if (value === null || typeof value === "string") {
        return value === "" ? null : value;
    }

    throw new Error(`gitlab config: ${field} must be a string or null, got ${typeof value}`);
}

function assertRegex(pattern: string | null, field: string): void {
    if (pattern === null) {
        return;
    }

    try {
        new RegExp(pattern);
    } catch (error) {
        throw new Error(`gitlab config: ${field} is not a valid regular expression: ${String(error)}`);
    }
}

/** `base` (the defaults) under whatever the file sets. Unknown message keys and wrong types fail loudly. */
export function mergeConfig(raw: unknown, base: GitLabToolConfig = DEFAULT_CONFIG): GitLabToolConfig {
    if (raw === null || raw === undefined) {
        return structuredClone(base);
    }

    if (!isRecord(raw)) {
        throw new Error("gitlab config: the file must hold a JSON object");
    }

    const d = base;
    const language = raw.language ?? d.language;
    if (!MESSAGE_LANGUAGES.includes(language as MessageLanguage)) {
        throw new Error(
            `gitlab config: language must be one of ${MESSAGE_LANGUAGES.join(", ")}, got ${String(language)}`
        );
    }

    const dateStyle = raw.dateStyle ?? d.dateStyle;
    if (!DATE_STYLES.includes(dateStyle as DateStyle)) {
        throw new Error(`gitlab config: dateStyle must be one of ${DATE_STYLES.join(", ")}, got ${String(dateStyle)}`);
    }

    const messages: Partial<Record<MessageKey, string>> = { ...d.messages };
    if (raw.messages !== undefined) {
        if (!isRecord(raw.messages)) {
            throw new Error("gitlab config: messages must be an object of key to text");
        }

        for (const [key, value] of Object.entries(raw.messages)) {
            if (!MESSAGE_KEYS.includes(key as MessageKey)) {
                throw new Error(`gitlab config: unknown message key "${key}"; known keys: ${MESSAGE_KEYS.join(", ")}`);
            }

            if (typeof value !== "string") {
                throw new Error(`gitlab config: messages.${key} must be a string`);
            }

            messages[key as MessageKey] = value;
        }
    }

    const wi = section(raw.workItems, "workItems");
    const workItems: WorkItemConfig = {
        idPattern: stringOrNull(wi.idPattern, "workItems.idPattern", d.workItems.idPattern),
        urlTemplate: stringOrNull(wi.urlTemplate, "workItems.urlTemplate", d.workItems.urlTemplate),
        environmentField: stringOrNull(wi.environmentField, "workItems.environmentField", d.workItems.environmentField),
        mergeRequestField: stringOrNull(
            wi.mergeRequestField,
            "workItems.mergeRequestField",
            d.workItems.mergeRequestField
        ),
    };
    assertRegex(workItems.idPattern, "workItems.idPattern");

    const st = section(raw.stale, "stale");
    const envs = section(st.environments, "stale.environments");
    const stale: StaleConfig = {
        label: stringOrNull(st.label, "stale.label", d.stale.label) ?? d.stale.label,
        mergeLabelPattern:
            stringOrNull(st.mergeLabelPattern, "stale.mergeLabelPattern", d.stale.mergeLabelPattern) ??
            d.stale.mergeLabelPattern,
        environments: {
            uat: stringOrNull(envs.uat, "stale.environments.uat", d.stale.environments.uat),
            production: stringOrNull(envs.production, "stale.environments.production", d.stale.environments.production),
            releasePrefix: stringOrNull(
                envs.releasePrefix,
                "stale.environments.releasePrefix",
                d.stale.environments.releasePrefix
            ),
            test: stringOrNull(envs.test, "stale.environments.test", d.stale.environments.test),
        },
        draftCommentGuide: stringOrNull(st.draftCommentGuide, "stale.draftCommentGuide", d.stale.draftCommentGuide),
        instructionsExtra: stringOrNull(st.instructionsExtra, "stale.instructionsExtra", d.stale.instructionsExtra),
        noteTags: stringList(st.noteTags, "stale.noteTags", d.stale.noteTags),
        contentCheckNote: stringOrNull(st.contentCheckNote, "stale.contentCheckNote", d.stale.contentCheckNote),
    };
    assertRegex(stale.mergeLabelPattern, "stale.mergeLabelPattern");

    const review = section(raw.review, "review");
    const runner = review.runner ?? d.review.runner;

    if (!GATE_RUNNERS.includes(runner as GateRunner)) {
        throw new Error(
            `gitlab config: review.runner must be one of ${GATE_RUNNERS.join(", ")}, got ${String(runner)}`
        );
    }

    const fetch = section(review.fetch, "review.fetch");
    const fetchFormat = fetch.format ?? d.review.fetch.format;

    if (!FETCH_FORMATS.includes(fetchFormat as FetchFormat)) {
        throw new Error(
            `gitlab config: review.fetch.format must be one of ${FETCH_FORMATS.join(", ")}, got ${String(fetchFormat)}`
        );
    }

    const impactSource = review.impactSource ?? d.review.impactSource;

    if (!IMPACT_SOURCES.includes(impactSource as ImpactSource)) {
        throw new Error(
            `gitlab config: review.impactSource must be one of ${IMPACT_SOURCES.join(", ")}, got ${String(impactSource)}`
        );
    }

    const contextLines = fetch.contextLines ?? d.review.fetch.contextLines;

    if (typeof contextLines !== "number" || !Number.isInteger(contextLines) || contextLines < 0) {
        throw new Error(
            `gitlab config: review.fetch.contextLines must be a whole number, got ${SafeJSON.stringify(contextLines)}`
        );
    }

    return {
        language: language as MessageLanguage,
        dateStyle: dateStyle as DateStyle,
        messages,
        workItems,
        stale,
        review: {
            gates: parseGates(review.gates, d.review.gates),
            runner: runner as GateRunner,
            fetch: { format: fetchFormat as FetchFormat, contextLines },
            nextSteps: stringList(review.nextSteps, "review.nextSteps", d.review.nextSteps),
            impactSource: impactSource as ImpactSource,
            worktreeHint: stringOrNull(review.worktreeHint, "review.worktreeHint", d.review.worktreeHint),
        },
    };
}

function stringList(value: unknown, field: string, fallback: string[]): string[] {
    if (value === undefined) {
        return [...fallback];
    }

    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`gitlab config: ${field} must be an array of strings`);
    }

    return [...value];
}

function parseGates(value: unknown, fallback: ReviewGate[]): ReviewGate[] {
    if (value === undefined) {
        return fallback.map((gate) => ({ ...gate }));
    }

    if (!Array.isArray(value)) {
        throw new Error("gitlab config: review.gates must be an array of { label, command, when?, exclude? }");
    }

    return value.map((gate, index) => {
        const field = `review.gates[${index}]`;

        if (!isRecord(gate)) {
            throw new Error(`gitlab config: ${field} must be an object`);
        }

        const label = stringOrNull(gate.label, `${field}.label`, null);
        const command = stringOrNull(gate.command, `${field}.command`, null);

        if (!label || !command) {
            throw new Error(`gitlab config: ${field} needs a non-empty label and command`);
        }

        return {
            label,
            command,
            when: stringOrNull(gate.when, `${field}.when`, null),
            exclude: stringOrNull(gate.exclude, `${field}.exclude`, null),
        };
    });
}

let cached: Promise<GitLabToolConfig> | null = null;

/** Read once per process. Also applies the date style, so every renderer agrees with the file. */
export function loadConfig(): Promise<GitLabToolConfig> {
    cached ??= storage.getConfig<Record<string, unknown>>().then((raw) => {
        const config = mergeConfig(raw);
        setDateStyle(config.dateStyle);
        logger.debug(
            {
                path: storage.getConfigPath(),
                language: config.language,
                workItems: Boolean(config.workItems.idPattern),
            },
            "gitlab: config loaded"
        );

        return config;
    });

    return cached;
}

export function messagesOf(config: GitLabToolConfig): Messages {
    return createMessages(config.language, config.messages);
}
