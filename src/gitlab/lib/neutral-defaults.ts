/**
 * The shape of `defaults.ts` and its neutral values. A fork that always talks to one company
 * instance replaces `defaults.ts` with company-specific values; this file and every test read only
 * the neutral ones, so the fork's values never leak into an upstream assertion.
 */

import type { GitLabToolConfig } from "@app/gitlab/lib/config";

export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface GitLabTokenDefaults {
    /** Name suggested on the token creation page. */
    name: string;
    /** Replaces the built-in creation URL when set (the page moved between GitLab releases). */
    newTokenUrl: ((host: string) => string) | null;
    /** Extra token sources tried after the built-in glab commands, as argv arrays. */
    extraCommands: (hostname: string) => string[][];
    /** Extra "store it" lines in the setup help: [command, note]. */
    extraStoreHints: ReadonlyArray<readonly [command: string, note: string]>;
}

export interface GitLabDefaults {
    /** Host used after --host and GITLAB_HOST, before glab's default host. Null: no default. */
    host: string | null;
    /**
     * Project used after --project and GITLAB_PROJECT. A command that names no checkout uses it
     * before the origin remote; one that does reads the checkout's origin first. Null: no default.
     */
    project: string | null;
    /** Folder under ~/.genesis-tools that holds config.json and the ledgers. */
    storageName: string;
    token: GitLabTokenDefaults;
    /** Project that ledger lines written before the `project` field belong to. Null: none. */
    legacyLedgerProject: string | null;
    /** Laid over the built-in config defaults, under the user's config.json. */
    config: DeepPartial<GitLabToolConfig>;
}

export const NEUTRAL_DEFAULTS: GitLabDefaults = {
    host: null,
    project: null,
    storageName: "gitlab",
    token: { name: "genesis-tools", newTokenUrl: null, extraCommands: () => [], extraStoreHints: [] },
    legacyLedgerProject: null,
    config: {},
};
