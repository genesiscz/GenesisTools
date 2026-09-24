/**
 * `~/.genesis-tools/gitlab/config.json`. Every field is optional; a missing file means the defaults.
 * Nothing here names a host or a project: those come from flags, the environment, glab and git.
 */

import { DATE_STYLES, type DateStyle, setDateStyle } from "@app/gitlab/lib/dates";
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
}

export interface GitLabToolConfig {
    /** Language of the texts `stale-branches` writes onto merge requests. */
    language: MessageLanguage;
    dateStyle: DateStyle;
    /** Per-key text overrides; see `MESSAGE_KEYS`. */
    messages: Partial<Record<MessageKey, string>>;
    workItems: WorkItemConfig;
    stale: StaleConfig;
}

export const DEFAULT_CONFIG: GitLabToolConfig = {
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
    },
};

export const storage = new Storage("gitlab");

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

/** Defaults under whatever the file sets. Unknown message keys and wrong types fail loudly. */
export function mergeConfig(raw: unknown): GitLabToolConfig {
    if (raw === null || raw === undefined) {
        return structuredClone(DEFAULT_CONFIG);
    }

    if (!isRecord(raw)) {
        throw new Error("gitlab config: the file must hold a JSON object");
    }

    const d = DEFAULT_CONFIG;
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

    const messages: Partial<Record<MessageKey, string>> = {};
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
    };
    assertRegex(stale.mergeLabelPattern, "stale.mergeLabelPattern");

    return {
        language: language as MessageLanguage,
        dateStyle: dateStyle as DateStyle,
        messages,
        workItems,
        stale,
    };
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
